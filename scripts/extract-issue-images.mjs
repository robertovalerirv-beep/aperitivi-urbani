#!/usr/bin/env node
// Estrae gli allegati immagine da una GitHub Issue e li scarica in una cartella.
// Usage: node scripts/extract-issue-images.mjs --issue <N> --out <dir>
//
// Richiede env: GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo).
// Pensato per girare dentro GitHub Actions.

import { mkdir, writeFile } from "node:fs/promises";
import { argv, env, exit } from "node:process";
import path from "node:path";

function arg(name) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
}

const issueNumber = arg("issue");
const outDir = arg("out") ?? "public/img/locali/_tmp";

if (!issueNumber) {
  console.error("Manca --issue <N>");
  exit(1);
}

const token = env.GITHUB_TOKEN;
const repo = env.GITHUB_REPOSITORY;
if (!token || !repo) {
  console.error("Servono GITHUB_TOKEN e GITHUB_REPOSITORY nell'environment.");
  exit(1);
}

const [owner, repoName] = repo.split("/");

const apiRes = await fetch(
  `https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}`,
  {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  }
);

if (!apiRes.ok) {
  console.error(`GitHub API ${apiRes.status}: ${await apiRes.text()}`);
  exit(1);
}

const issue = await apiRes.json();
const body = issue.body ?? "";

// Match sia il vecchio formato user-images.githubusercontent.com sia il
// nuovo github.com/user-attachments/assets/<uuid>.
const urlRegex =
  /https:\/\/(?:user-images\.githubusercontent\.com\/[^\s)]+|github\.com\/user-attachments\/assets\/[a-f0-9-]+)/gi;

const urls = [...new Set(body.match(urlRegex) ?? [])];

if (urls.length === 0) {
  console.log("Nessun allegato immagine trovato nell'issue.");
  exit(0);
}

await mkdir(outDir, { recursive: true });

let i = 1;
for (const url of urls) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });
  if (!res.ok) {
    console.warn(`Skip ${url}: HTTP ${res.status}`);
    continue;
  }
  const ct = res.headers.get("content-type") ?? "";
  const ext = ct.includes("png")
    ? "png"
    : ct.includes("webp")
    ? "webp"
    : ct.includes("gif")
    ? "gif"
    : "jpg";
  const filename = `allegato-${String(i).padStart(2, "0")}.${ext}`;
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(path.join(outDir, filename), buf);
  console.log(`Salvato ${filename} (${buf.length} byte)`);
  i++;
}

console.log(`Done. ${i - 1} allegati in ${outDir}`);
