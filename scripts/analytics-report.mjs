#!/usr/bin/env node
// Report analytics: interroga la Cloudflare GraphQL Analytics API (Web Analytics
// via beacon token) per ciascun sito configurato, incrocia le pagine visitate
// coi locali pubblicati in content/locali/, e produce un report JSON + XLSX.
//
// Uso:
//   node scripts/analytics-report.mjs [--days=30] [--site=<slug>]
//
// Credenziali: scripts/.env (vedi scripts/.env.example) — CF_API_TOKEN e
// CF_ACCOUNT_ID. Il token deve avere il permesso "Account Analytics: Read"
// sull'account che possiede i siti Web Analytics.

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Loader minimale per scripts/.env (KEY=VALUE, una per riga, righe vuote e
// commenti # ignorati). Nessuna dipendenza esterna, coerente con l'approccio
// già usato nel repo (vedi parseYaml sotto, niente js-yaml).
async function loadEnvFile(envPath) {
  let src;
  try {
    src = await readFile(envPath, "utf8");
  } catch {
    return; // .env assente: le variabili verranno cercate comunque in process.env
  }
  for (const line of src.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

await loadEnvFile(path.join(__dirname, ".env"));

const REPO_ROOT = path.join(__dirname, "..");
const CONTENT_DIR = path.join(REPO_ROOT, "content", "locali");
const OUT_DIR = path.join(__dirname, "out");
const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

// siteTag = valore usato dall'API GraphQL Analytics per filtrare
// rumPageloadEventsAdaptiveGroups. NON è detto che coincida col beacon
// token incollato nello snippet <script> lato client (data-cf-beacon):
// per cami-mangia-cose i due valori sono diversi — verificato il 10 lug
// 2026 confrontando il traffico reale (path /locali/<slug> e
// /admin/<slug> corrispondenti ai locali pubblicati) associato a ciascun
// siteTag via query GraphQL con dimensions { siteTag }, senza filtro.
// Se un sito smette di restituire dati pur avendo traffico reale in
// dashboard, ripetere quella verifica prima di assumere che il siteTag
// sia ancora corretto.
//
// contentDir: cartella content/locali da cui fare il join con le pagine
// visitate. Ogni sito creator vive in un repo separato con la propria
// working copy locale; se omesso si usa CONTENT_DIR (repo corrente).
const SITES = [
  { slug: "aperitivi-urbani", siteTag: "483a9a30282c4fdb95a8bfde2de693cb" },
  {
    slug: "cami-mangia-cose",
    siteTag: "7fc32bfd6e294c139aa5df0ea9f8bbb0",
    contentDir: "C:\\Users\\RobertoVALERI\\Desktop\\cami-mangia-cose-tmp\\content\\locali",
  },
];

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { days: 30, site: null, since: null, until: null };
  for (const arg of argv) {
    const m = arg.match(/^--(\w+)=(.*)$/);
    if (!m) continue;
    if (m[1] === "days") out.days = parseInt(m[2], 10);
    if (m[1] === "site") out.site = m[2];
    if (m[1] === "since") out.since = m[2];
    if (m[1] === "until") out.until = m[2];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mini-parser YAML frontmatter — stesso subset/approccio di validate-locali.mjs
// (nessuna dipendenza js-yaml, coerente col resto del repo).
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
    return s;
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
      arr.push(parseScalar(itemContent));
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
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// STEP 3 — lookup contenuti reali (sostituisce simulate_content_lookup)
// ---------------------------------------------------------------------------
async function loadLocaliContent(contentDir) {
  const map = new Map();
  let files;
  try {
    files = (await readdir(contentDir)).filter((f) => f.endsWith(".md"));
  } catch {
    console.warn(`Attenzione: cartella ${contentDir} non trovata, join disabilitato.`);
    return map;
  }
  for (const file of files) {
    const src = await readFile(path.join(contentDir, file), "utf8");
    const fm = extractFrontmatter(src);
    if (!fm || !fm.slug) continue;
    map.set(fm.slug, {
      slug: fm.slug,
      nome: fm.nome ?? null,
      tipo: Array.isArray(fm.tipo) ? fm.tipo : [],
      zona: fm.zona ?? null,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------
// STEP 2 — chiamata reale GraphQL (sostituisce simulate_cloudflare_response)
// ---------------------------------------------------------------------------
async function fetchCloudflareAnalytics({ siteTag, sinceISO, untilISO, limit = 2000 }) {
  const token = process.env.CF_API_TOKEN;
  const accountId = process.env.CF_ACCOUNT_ID;
  if (!token || !accountId) {
    throw new Error(
      "CF_API_TOKEN o CF_ACCOUNT_ID mancanti. Copia scripts/.env.example in scripts/.env e compilalo."
    );
  }

  const query = `
    query ($accountTag: String!, $filter: AccountRumPageloadEventsAdaptiveGroupsFilter_InputObject!, $limit: Int!) {
      viewer {
        accounts(filter: { accountTag: $accountTag }) {
          byDate: rumPageloadEventsAdaptiveGroups(limit: $limit, filter: $filter) {
            count
            sum { visits }
            dimensions { date }
          }
          byPath: rumPageloadEventsAdaptiveGroups(limit: $limit, filter: $filter) {
            count
            sum { visits }
            dimensions { requestPath }
          }
          byReferer: rumPageloadEventsAdaptiveGroups(limit: $limit, filter: $filter) {
            count
            sum { visits }
            dimensions { refererHost }
          }
        }
      }
    }
  `;

  const variables = {
    accountTag: accountId,
    limit,
    filter: {
      siteTag,
      datetime_geq: sinceISO,
      datetime_leq: untilISO,
    },
  };

  const res = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const body = await res.json();

  if (!res.ok || body.errors) {
    const msg = body.errors ? JSON.stringify(body.errors, null, 2) : `HTTP ${res.status}`;
    throw new Error(`Cloudflare GraphQL API error (siteTag=${siteTag}): ${msg}`);
  }

  const accounts = body.data?.viewer?.accounts ?? [];
  const acc = accounts[0] ?? { byDate: [], byPath: [], byReferer: [] };

  return {
    byDate: (acc.byDate ?? []).map((r) => ({
      date: r.dimensions.date,
      count: r.count,
      visits: r.sum.visits,
    })),
    byPath: (acc.byPath ?? []).map((r) => ({
      requestPath: r.dimensions.requestPath,
      count: r.count,
      visits: r.sum.visits,
    })),
    byReferer: (acc.byReferer ?? []).map((r) => ({
      refererHost: r.dimensions.refererHost || "(diretto)",
      count: r.count,
      visits: r.sum.visits,
    })),
  };
}

// ---------------------------------------------------------------------------
// Join requestPath -> locale + bucketing
// ---------------------------------------------------------------------------
const LOCALE_PATH_RE = /^\/locali\/([a-z0-9-]+)\/?$/;

function joinPathsWithLocali(byPath, localiMap) {
  const resolved = [];
  const orphanSlugs = new Set();

  for (const row of byPath) {
    const m = row.requestPath.match(LOCALE_PATH_RE);
    if (!m) {
      resolved.push({ ...row, slug: null, nome: null, tipo: [], zona: null, tipo_pagina: "altra" });
      continue;
    }
    const slug = m[1];
    const locale = localiMap.get(slug);
    if (locale) {
      resolved.push({ ...row, slug, nome: locale.nome, tipo: locale.tipo, zona: locale.zona, tipo_pagina: "locale" });
    } else {
      orphanSlugs.add(slug);
      resolved.push({ ...row, slug, nome: null, tipo: [], zona: null, tipo_pagina: "locale_orfano" });
    }
  }

  resolved.sort((a, b) => b.count - a.count);
  return { resolved, orphanSlugs: [...orphanSlugs] };
}

// ---------------------------------------------------------------------------
// Output XLSX + JSON
// ---------------------------------------------------------------------------
function buildWorkbookSheet(rows) {
  return XLSX.utils.json_to_sheet(rows);
}

async function writeReport(siteSlug, report) {
  await writeFile(
    path.join(OUT_DIR, `${siteSlug}.json`),
    JSON.stringify(report, null, 2)
  );

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildWorkbookSheet(report.traffico_giornaliero), "Traffico giornaliero");
  XLSX.utils.book_append_sheet(wb, buildWorkbookSheet(report.top_pagine), "Top pagine");
  XLSX.utils.book_append_sheet(wb, buildWorkbookSheet(report.provenienza), "Provenienza");
  XLSX.writeFile(wb, path.join(OUT_DIR, `${siteSlug}.xlsx`));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const { days, site: siteFilter, since: sinceArg, until: untilArg } = parseArgs(process.argv.slice(2));

  const untilDate = untilArg ? new Date(untilArg) : new Date();
  const sinceDate = sinceArg ? new Date(sinceArg) : new Date(untilDate.getTime() - days * 24 * 60 * 60 * 1000);
  const sinceISO = sinceDate.toISOString();
  const untilISO = untilDate.toISOString();

  const sitesToRun = siteFilter ? SITES.filter((s) => s.slug === siteFilter) : SITES;
  if (sitesToRun.length === 0) {
    console.error(`Nessun sito trovato con slug "${siteFilter}". Siti disponibili: ${SITES.map((s) => s.slug).join(", ")}`);
    process.exit(1);
  }

  console.log(`Range: ${sinceISO} → ${untilISO} (${days} giorni)`);
  console.log(`Siti: ${sitesToRun.map((s) => s.slug).join(", ")}`);

  await import("node:fs").then((fs) => fs.mkdirSync(OUT_DIR, { recursive: true }));

  for (const site of sitesToRun) {
    console.log(`\n--- ${site.slug} ---`);
    const localiMap = await loadLocaliContent(site.contentDir ?? CONTENT_DIR);
    console.log(`  Locali pubblicati trovati: ${localiMap.size}`);

    let data;
    try {
      data = await fetchCloudflareAnalytics({ siteTag: site.siteTag, sinceISO, untilISO });
    } catch (e) {
      console.error(`Errore nel recupero dati per ${site.slug}:`);
      console.error(e.message);
      continue;
    }

    const { resolved, orphanSlugs } = joinPathsWithLocali(data.byPath, localiMap);

    if (orphanSlugs.length > 0) {
      console.warn(
        `  Attenzione: ${orphanSlugs.length} slug con traffico ma non più pubblicati: ${orphanSlugs.join(", ")}`
      );
    }

    const report = {
      sito: site.slug,
      range: { since: sinceISO, until: untilISO, giorni: days },
      traffico_giornaliero: data.byDate.sort((a, b) => (a.date > b.date ? 1 : -1)),
      top_pagine: resolved,
      provenienza: data.byReferer.sort((a, b) => b.count - a.count),
      slug_orfani: orphanSlugs,
    };

    await writeReport(site.slug, report);
    console.log(`  Report scritto in scripts/out/${site.slug}.json e .xlsx`);
    console.log(`  Pageview totali: ${data.byPath.reduce((s, r) => s + r.count, 0)}`);
  }
}

main().catch((e) => {
  console.error("Errore fatale:", e);
  process.exit(1);
});
