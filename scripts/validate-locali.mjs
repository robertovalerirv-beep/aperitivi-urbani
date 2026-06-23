#!/usr/bin/env node
// Valida tutti i file content/locali/*.md contro schemas/locale-schema.json.
// Estrae il frontmatter YAML con un mini-parser regex-based (no js-yaml)
// e lo valida con Ajv. Esce con codice != 0 se almeno un file è invalido.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { exit } from "node:process";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const SCHEMA_PATH = "schemas/locale-schema.json";
const CONTENT_DIR = "content/locali";

// ---------------------------------------------------------------------------
// Mini-parser YAML per il subset usato nei frontmatter dei locali:
//   - mapping top-level e annidati
//   - scalari: stringhe bare/quoted (', "), null, true/false, int, float
//   - block sequence: chiave + lista indentata con "- "
//   - flow sequence: [a, b, c]
//   - block scalar literal: "chiave: |" seguito da testo indentato
// Non supporta: anchors/aliases, folded scalar ">", tag espliciti.
// ---------------------------------------------------------------------------
function parseYaml(src) {
  const lines = src.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  let pos = 0;

  function skipBlanks() {
    while (pos < lines.length) {
      const t = lines[pos].trim();
      if (t === "" || t.startsWith("#")) { pos++; continue; }
      break;
    }
  }
  const indentOf = (l) => l.match(/^( *)/)[1].length;

  function findColon(s) {
    let q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) {
        if (c === "\\" && q === '"') { i++; continue; }
        if (c === q) q = null;
        continue;
      }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === ":" && (i === s.length - 1 || s[i + 1] === " ")) return i;
    }
    return -1;
  }

  function parseScalar(s) {
    s = s.trim();
    if (s === "" || s === "null" || s === "~") return null;
    if (s === "true") return true;
    if (s === "false") return false;
    if (/^-?\d+$/.test(s)) return parseInt(s, 10);
    if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
    if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
      return s.slice(1, -1).replace(/\\(["\\nrt/])/g, (_, c) =>
        ({ n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\", "/": "/" }[c])
      );
    }
    if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
      return s.slice(1, -1).replace(/''/g, "'");
    }
    if (s[0] === "[" && s[s.length - 1] === "]") {
      const inner = s.slice(1, -1).trim();
      if (inner === "") return [];
      return inner.split(",").map((x) => parseScalar(x.trim()));
    }
    return s; // bare string
  }

  function parseBlockScalar(baseInd) {
    const out = [];
    let minInd = null;
    while (pos < lines.length) {
      const l = lines[pos];
      if (l.trim() === "") { out.push(""); pos++; continue; }
      const ind = indentOf(l);
      if (ind <= baseInd) break;
      if (minInd === null || ind < minInd) minInd = ind;
      out.push(l);
      pos++;
    }
    while (out.length && out[out.length - 1] === "") out.pop();
    if (minInd === null) return "";
    return out.map((l) => (l.length === 0 ? "" : l.slice(minInd))).join("\n") + "\n";
  }

  function parseMapping(baseInd) {
    const obj = {};
    while (true) {
      skipBlanks();
      if (pos >= lines.length) break;
      const line = lines[pos];
      const ind = indentOf(line);
      if (ind !== baseInd) break;
      const rest = line.slice(ind);
      if (rest.startsWith("- ") || rest === "-") break;

      const ci = findColon(rest);
      if (ci === -1) { pos++; continue; }
      const key = rest.slice(0, ci).trim();
      const after = rest.slice(ci + 1);
      pos++;

      const trimmedAfter = after.trim();
      if (trimmedAfter === "") {
        skipBlanks();
        if (pos >= lines.length || indentOf(lines[pos]) <= baseInd) {
          obj[key] = null; continue;
        }
        const nx = lines[pos];
        const nxInd = indentOf(nx);
        const nxRest = nx.slice(nxInd);
        if (nxRest.startsWith("- ") || nxRest === "-") {
          obj[key] = parseSequence(nxInd);
        } else {
          obj[key] = parseMapping(nxInd);
        }
      } else if (trimmedAfter === "|" || trimmedAfter === "|-" || trimmedAfter === "|+") {
        obj[key] = parseBlockScalar(baseInd);
      } else {
        obj[key] = parseScalar(after);
      }
    }
    return obj;
  }

  function parseSequence(baseInd) {
    const arr = [];
    while (true) {
      skipBlanks();
      if (pos >= lines.length) break;
      const line = lines[pos];
      const ind = indentOf(line);
      if (ind !== baseInd) break;
      const rest = line.slice(ind);
      if (!(rest.startsWith("- ") || rest === "-")) break;

      const itemContent = rest === "-" ? "" : rest.slice(2);
      pos++;

      if (itemContent === "") {
        skipBlanks();
        if (pos >= lines.length || indentOf(lines[pos]) <= baseInd) { arr.push(null); continue; }
        arr.push(parseMapping(indentOf(lines[pos])));
        continue;
      }

      const ci = findColon(itemContent);
      if (ci === -1) { arr.push(parseScalar(itemContent)); continue; }

      // Item è un mapping che inizia sulla stessa riga del trattino
      const innerInd = baseInd + 2;
      const key = itemContent.slice(0, ci).trim();
      const after = itemContent.slice(ci + 1);
      const trimmedAfter = after.trim();
      const obj = {};

      if (trimmedAfter === "") {
        skipBlanks();
        if (pos < lines.length && indentOf(lines[pos]) > innerInd) {
          const nx = lines[pos];
          const nxInd = indentOf(nx);
          const nxRest = nx.slice(nxInd);
          if (nxRest.startsWith("- ") || nxRest === "-") obj[key] = parseSequence(nxInd);
          else obj[key] = parseMapping(nxInd);
        } else {
          obj[key] = null;
        }
      } else if (trimmedAfter === "|" || trimmedAfter === "|-" || trimmedAfter === "|+") {
        obj[key] = parseBlockScalar(innerInd);
      } else {
        obj[key] = parseScalar(after);
      }
      const more = parseMapping(innerInd);
      Object.assign(obj, more);
      arr.push(obj);
    }
    return arr;
  }

  return parseMapping(0);
}

function extractFrontmatter(src) {
  const cleaned = src.replace(/^﻿/, "");
  const m = cleaned.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  try {
    return parseYaml(m[1]);
  } catch (e) {
    return { __parse_error: e.message };
  }
}

const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

let files;
try {
  files = (await readdir(CONTENT_DIR)).filter((f) => f.endsWith(".md"));
} catch {
  console.log(`Nessuna cartella ${CONTENT_DIR}, niente da validare.`);
  exit(0);
}

if (files.length === 0) {
  console.log("Nessun file in content/locali/, niente da validare.");
  exit(0);
}

let failed = 0;
for (const file of files) {
  const full = path.join(CONTENT_DIR, file);
  const src = await readFile(full, "utf8");
  const fm = extractFrontmatter(src);
  if (!fm) {
    console.error(`✗ ${file}: frontmatter YAML mancante`);
    failed++; continue;
  }
  if (fm.__parse_error) {
    console.error(`✗ ${file}: errore parser YAML: ${fm.__parse_error}`);
    failed++; continue;
  }
  if (!validate(fm)) {
    console.error(`✗ ${file}:`);
    for (const err of validate.errors ?? []) {
      console.error(`  - ${err.instancePath || "/"} ${err.message}`);
    }
    failed++;
  } else {
    console.log(`✓ ${file}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} file invalidi su ${files.length}.`);
  exit(1);
}
console.log(`\nTutti i ${files.length} file sono validi.`);
