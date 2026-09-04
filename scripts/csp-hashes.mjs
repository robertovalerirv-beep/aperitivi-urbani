#!/usr/bin/env node
// Toglie 'unsafe-inline' da script-src mettendo al suo posto gli hash degli
// script inline realmente presenti nel sito buildato.
//
// Perche' serve: con 'unsafe-inline' qualunque XSS diventa codice eseguito, e
// il pannello admin tiene la password in sessionStorage. Gli hash dicono al
// browser esattamente quali script inline sono legittimi; tutto il resto non
// parte.
//
// Perche' funziona senza esplodere: gli script inline delle pagine sono
// identici da una pagina all'altra (le parti che cambiavano da pagina a
// pagina sono state spostate su attributi data-* e sul JSON di pagina), quindi
// gli hash distinti restano una manciata anche con centinaia di schede.
//
// In caso di dubbio NON tocca niente: se trova un handler inline (onclick=)
// o se l'header diventerebbe enorme, lascia la CSP com'e' e lo dice. Meglio
// una CSP piu' debole che un sito che non parte.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

const DIST = "dist";
const HEADERS_PATH = path.join(DIST, "_headers");
const MAX_LUNGHEZZA_RIGA = 3500; // oltre, meglio lasciar perdere

const RE_SCRIPT = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
// on… dentro un tag: onclick=, onchange=… Il match e' volutamente largo.
const RE_HANDLER_INLINE = /<[^>]+\son[a-z]+\s*=\s*["'][^"']/gi;

async function tutteLeHtml(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tutteLeHtml(full)));
    else if (entry.name.endsWith(".html")) out.push(full);
  }
  return out;
}

/** Un blocco <script> viene eseguito? I type json/importmap no. */
function eEseguibile(attributi) {
  if (/\ssrc\s*=/.test(attributi)) return false; // script esterno, non inline
  const tipo = /type\s*=\s*["']([^"']+)["']/.exec(attributi)?.[1];
  if (!tipo) return true;
  return /^(module|text\/javascript|application\/javascript)$/i.test(tipo.trim());
}

function rinuncia(motivo) {
  console.warn(`csp-hashes: ${motivo} — CSP lasciata invariata`);
  process.exit(0);
}

async function main() {
  let headers;
  try {
    headers = await readFile(HEADERS_PATH, "utf8");
  } catch {
    rinuncia("dist/_headers non trovato");
  }

  if (!headers.includes("'unsafe-inline'")) {
    console.log("csp-hashes: script-src non usa 'unsafe-inline', niente da fare");
    return;
  }

  const pagine = await tutteLeHtml(DIST);
  if (pagine.length === 0) rinuncia("nessuna pagina HTML nel dist");

  const hash = new Set();
  let conHandler = null;

  for (const f of pagine) {
    const html = await readFile(f, "utf8");
    if (RE_HANDLER_INLINE.test(html)) {
      RE_HANDLER_INLINE.lastIndex = 0;
      conHandler = path.relative(DIST, f);
      break;
    }
    RE_HANDLER_INLINE.lastIndex = 0;

    let m;
    RE_SCRIPT.lastIndex = 0;
    while ((m = RE_SCRIPT.exec(html))) {
      const [, attributi, corpo] = m;
      if (!corpo.trim() || !eEseguibile(attributi)) continue;
      hash.add("sha256-" + createHash("sha256").update(corpo, "utf8").digest("base64"));
    }
  }

  if (conHandler) {
    rinuncia(`handler inline (onclick=…) trovato in ${conHandler}: servirebbe 'unsafe-hashes'`);
  }
  if (hash.size === 0) rinuncia("nessuno script inline trovato, controllare");

  const lista = [...hash].sort().map((h) => `'${h}'`).join(" ");

  const righe = headers.split(/\r?\n/);
  let sostituite = 0;
  const nuove = righe.map((riga) => {
    if (!riga.includes("Content-Security-Policy")) return riga;
    const nuova = riga.replace(
      /script-src ([^;]*?)'unsafe-inline'/,
      (_, prima) => `script-src ${prima}${lista}`
    );
    if (nuova === riga) return riga;
    if (nuova.length > MAX_LUNGHEZZA_RIGA) {
      console.warn(
        `csp-hashes: la CSP con ${hash.size} hash sarebbe lunga ${nuova.length} caratteri — lascio 'unsafe-inline'`
      );
      return riga;
    }
    sostituite++;
    return nuova;
  });

  if (sostituite === 0) rinuncia("nessuna riga CSP con script-src 'unsafe-inline' da riscrivere");

  await writeFile(HEADERS_PATH, nuove.join("\n"), "utf8");
  console.log(
    `csp-hashes: ${hash.size} hash inseriti in ${sostituite} riga/e CSP, 'unsafe-inline' rimosso da script-src`
  );
}

main().catch((err) => {
  console.error("csp-hashes: errore", err);
  process.exit(1);
});
