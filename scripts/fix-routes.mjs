#!/usr/bin/env node
// Riscrive dist/_routes.json con la lista MINIMA di rotte che devono passare
// dalla Worker function di Cloudflare Pages.
//
// L'adapter genera include:["/*"] + una exclude gigante con ogni singolo
// asset statico. Due problemi seri:
//   1. il limite di 100 regole exclude di CF Pages veniva saturato dalle
//      immagini, quindi /locali/* NON era escluso: tutte le schede locale
//      passavano dalla Worker invece di essere servite dalla CDN;
//   2. qualsiasi URL inesistente finiva nella Worker, che rispondeva
//      200 + homepage. Per Google sono soft-404, cioe' migliaia di
//      duplicati della home — pessimo per l'indicizzazione.
//
// Invertendo la logica (include solo le rotte davvero dinamiche) il sito
// resta statico su CDN, dist/404.html torna a rispondere 404 vero, e non
// si tocca piu' il limite delle 100 regole.

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { exit } from "node:process";

const PAGES_DIR = "src/pages";
const ROUTES_PATH = "dist/_routes.json";
const MAX_RULES = 100;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

// src/pages/api/foo.ts -> /api/foo ; src/pages/admin/index.astro -> /admin
function fileToRoute(file) {
  let route = path
    .relative(PAGES_DIR, file)
    .split(path.sep)
    .join("/")
    .replace(/\.(astro|ts|js|mjs|md|mdx)$/, "");
  route = route.replace(/(^|\/)index$/, "");
  // I segmenti dinamici ([slug], [...rest]) diventano wildcard.
  route = route.replace(/\[\.{3}[^\]]+\]/g, "*").replace(/\[[^\]]+\]/g, "*");
  return `/${route}`.replace(/\/{2,}/g, "/");
}

async function main() {
  const files = await walk(PAGES_DIR);

  const dynamic = [];
  for (const file of files) {
    const src = await readFile(file, "utf8");
    if (/export\s+const\s+prerender\s*=\s*false/.test(src)) {
      dynamic.push(fileToRoute(file));
    }
  }

  // Le rotte /api/* sono tutte dinamiche: le collassiamo in un'unica regola
  // cosi' un nuovo endpoint non richiede di ricordarsi di questo script.
  const routes = new Set();
  let hasApi = false;
  for (const r of dynamic) {
    if (r.startsWith("/api/")) hasApi = true;
    else routes.add(r);
  }
  if (hasApi) routes.add("/api/*");

  const include = [...routes].sort();

  if (include.length === 0) {
    console.error(
      "fix-routes: nessuna rotta dinamica trovata — sospetto, non riscrivo _routes.json"
    );
    exit(1);
  }
  if (include.length > MAX_RULES) {
    console.error(
      `fix-routes: ${include.length} regole include, oltre il limite di ${MAX_RULES} di Cloudflare Pages`
    );
    exit(1);
  }

  await writeFile(
    ROUTES_PATH,
    JSON.stringify({ version: 1, include, exclude: [] }),
    "utf8"
  );
  console.log(`fix-routes: include = ${include.join(", ")}`);
}

main().catch((err) => {
  console.error("fix-routes: errore", err);
  exit(1);
});
