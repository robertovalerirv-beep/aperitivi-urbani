export const prerender = false;

import type { APIRoute } from "astro";

function jsonResponse(status: number, body: object) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function gh(token: string, urlPath: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.github.com${urlPath}`, {
    ...init,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "content-type": "application/json",
      "User-Agent": "aperitivi-urbani/1.0",
      ...((init.headers as Record<string, string>) || {}),
    },
  });
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = (body as Record<string, string>)?.message || text || `HTTP ${res.status}`;
    throw new Error(`GitHub API ${res.status} (${urlPath}): ${msg}`);
  }
  return body as Record<string, unknown>;
}

function b64Decode(b64: string): string {
  const clean = b64.replace(/\n/g, "");
  const bytes = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function getRootFoto(md: string): string[] {
  const blockMatch = md.match(/^foto:\n((?:  - .*\n)*)/m);
  if (!blockMatch) return [];
  return blockMatch[1]
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^  - /, "").trim());
}

function setRootFoto(md: string, names: string[]): string {
  const blockRe = /^foto:\n(?:  - .*\n)*/m;
  const inlineRe = /^foto: \[\]$/m;
  const newBlock = names.length > 0
    ? `foto:\n  - ${names.join("\n  - ")}\n`
    : `foto: []\n`;
  if (blockRe.test(md)) {
    return md.replace(blockRe, newBlock);
  }
  if (inlineRe.test(md)) {
    return md.replace(inlineRe, newBlock.trimEnd());
  }
  return md.replace(/^visite:/m, `${newBlock}visite:`);
}

// Offset basato sul numero massimo realmente usato nei filename esistenti,
// non sulla lunghezza dell'array — dopo una rimozione, array.length non
// corrisponde più al massimo indice usato, e riusarlo causerebbe collisioni
// silenziose (sovrascrittura di foto ancora esistenti).
function nextFotoNames(existingNames: string[], slug: string, count: number): string[] {
  let maxN = 0;
  const re = new RegExp(`^${slug}-(\\d+)\\.[a-zA-Z0-9]+$`);
  for (const name of existingNames) {
    const m = name.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxN) maxN = n;
    }
  }
  const names: string[] = [];
  for (let i = 1; i <= count; i++) names.push(`${slug}-${maxN + i}.jpg`);
  return names;
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const runtime = (locals as Record<string, unknown>).runtime as { env?: Record<string, string> } | undefined;
    const env = runtime?.env ?? import.meta.env;
    const password = env.ADMIN_PASSWORD;
    const token = env.GITHUB_TOKEN_INTAKE;
    const owner = env.INTAKE_REPO_OWNER;
    const repo = env.INTAKE_REPO_NAME;

    if (!password || !token || !owner || !repo) {
      return jsonResponse(500, {
        error: "Env mancanti. Servono: ADMIN_PASSWORD, GITHUB_TOKEN_INTAKE, INTAKE_REPO_OWNER, INTAKE_REPO_NAME.",
      });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { error: "Body JSON invalido" });
    }

    if (body?.password !== password) {
      return jsonResponse(401, { error: "Password errata" });
    }

    const slug = body?.slug;
    if (typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug)) {
      return jsonResponse(400, { error: "Slug invalido o mancante" });
    }

    const addPhotos = Array.isArray(body?.add) ? (body.add as string[]) : [];
    const removeNames = Array.isArray(body?.remove) ? (body.remove as string[]) : [];
    if (addPhotos.length === 0 && removeNames.length === 0) {
      return jsonResponse(400, { error: "Nessuna modifica da applicare" });
    }

    const mdPath = `content/locali/${slug}.md`;

    let existingFile: Record<string, unknown> | null;
    try {
      existingFile = await gh(token, `/repos/${owner}/${repo}/contents/${mdPath}?ref=main`);
    } catch (e) {
      if (String((e as Error).message).includes("404")) {
        return jsonResponse(404, { error: "Locale non trovato" });
      }
      throw e;
    }
    const existingContent = b64Decode(existingFile.content as string).replace(/^﻿/, "");
    const originalFoto = getRootFoto(existingContent);
    let currentFoto = [...originalFoto];

    // Rimozione — solo nomi realmente presenti finiscono nel commit di eliminazione file
    const actuallyRemoved = removeNames.filter((n) => originalFoto.includes(n));
    if (actuallyRemoved.length > 0) {
      currentFoto = currentFoto.filter((f) => !actuallyRemoved.includes(f));
    }

    // Aggiunta — offset calcolato sull'array DOPO la rimozione, sul massimo reale
    const newBlobs: { path: string; sha: string }[] = [];
    if (addPhotos.length > 0) {
      const newNames = nextFotoNames(currentFoto, slug, addPhotos.length);
      for (let i = 0; i < addPhotos.length; i++) {
        const blobRes = await gh(token, `/repos/${owner}/${repo}/git/blobs`, {
          method: "POST",
          body: JSON.stringify({ content: addPhotos[i], encoding: "base64" }),
        });
        const blobSha = blobRes.sha as string;
        const fotoName = newNames[i];
        newBlobs.push({ path: `public/images/locali/${slug}/${fotoName}`, sha: blobSha });
        currentFoto.push(fotoName);
      }
    }

    const newContent = setRootFoto(existingContent, currentFoto);

    // SHA HEAD e tree root
    const refData = await gh(token, `/repos/${owner}/${repo}/git/ref/heads/main`);
    const commitSha = (refData.object as Record<string, string>).sha;
    const commitData = await gh(token, `/repos/${owner}/${repo}/git/commits/${commitSha}`);
    const treeSha = (commitData.tree as Record<string, string>).sha;

    const treeItems: Record<string, unknown>[] = [
      { path: mdPath, mode: "100644", type: "blob", content: newContent },
    ];
    for (const blob of newBlobs) {
      treeItems.push({ path: blob.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    for (const name of actuallyRemoved) {
      treeItems.push({ path: `public/images/locali/${slug}/${name}`, mode: "100644", type: "blob", sha: null });
    }

    const newTreeData = await gh(token, `/repos/${owner}/${repo}/git/trees`, {
      method: "POST",
      body: JSON.stringify({ base_tree: treeSha, tree: treeItems }),
    });
    const newTreeSha = newTreeData.sha as string;

    const newCommitData = await gh(token, `/repos/${owner}/${repo}/git/commits`, {
      method: "POST",
      body: JSON.stringify({
        message: `admin: aggiorna foto ${slug}`,
        tree: newTreeSha,
        parents: [commitSha],
      }),
    });
    const newCommitSha = newCommitData.sha as string;

    await gh(token, `/repos/${owner}/${repo}/git/refs/heads/main`, {
      method: "PATCH",
      body: JSON.stringify({ sha: newCommitSha, force: false }),
    });

    return jsonResponse(200, {
      ok: true,
      commit_url: `https://github.com/${owner}/${repo}/commit/${newCommitSha}`,
      foto: currentFoto,
    });
  } catch (e) {
    return jsonResponse(500, { error: (e as Error).message });
  }
};
