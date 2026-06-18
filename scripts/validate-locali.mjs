#!/usr/bin/env node
// Valida tutti i file content/locali/*.md contro schemas/locale-schema.json.
// Estrae il frontmatter YAML, lo valida con Ajv, esce con codice != 0 se almeno
// un file è invalido.

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { exit } from "node:process";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { load as parseYaml } from "js-yaml";

const SCHEMA_PATH = "schemas/locale-schema.json";
const CONTENT_DIR = "content/locali";

function extractFrontmatter(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return null;
  return parseYaml(m[1]);
}

const schema = JSON.parse(await readFile(SCHEMA_PATH, "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
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
    failed++;
    continue;
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
