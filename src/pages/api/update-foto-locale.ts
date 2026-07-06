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
    const b = body as Record<string, unknown>;
    const msg = (b?.message as string) || text || `HTTP ${res.status}`;
    const errArr = Array.isArray(b?.errors) ? (b.errors as Record<string, string>[]) : [];
    const errMsgs = errArr.map((e) => e?.message || e?.code || "").filter(Boolean).join("; ");
    const fullMsg = errMsgs ? `${msg} | errors: ${errMsgs}` : msg;
    console.error(`[gh] ${res.status} ${urlPath} full_body:`, JSON.stringify(body));
    throw new Error(`GitHub API ${res.status} (${urlPath}): ${fullMsg}`);
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

    // Rimozione — un nome viene tolto da foto[] se è presente nel frontmatter.
    const actuallyRemoved = removeNames.filter((n) => originalFoto.includes(n));
    if (actuallyRemoved.length > 0) {
      currentFoto = currentFoto.filter((f) => !actuallyRemoved.includes(f));
    }

    // La cancellazione del FILE (tree item con sha:null) va emessa SOLO per i file
    // che esistono davvero nel repo. Emettere un sha:null su un path non presente
    // nel tree fa restituire alla Trees API un 422 GitRPC::BadObjectState
    // PERSISTENTE (non il race transitorio GC/repack gestito dal retry sotto):
    // il retry non può risolverlo e l'utente resta bloccato sull'errore generico.
    // Se foto[] elenca un file assente, lo togliamo comunque dal frontmatter
    // (self-healing) ma senza tentarne la delete fisica.
    let filesToDelete: string[] = actuallyRemoved;
    if (actuallyRemoved.length > 0) {
      const existingImageNames = new Set<string>();
      try {
        const dirList = await gh(token, `/repos/${owner}/${repo}/contents/public/images/locali/${slug}?ref=main`);
        if (Array.isArray(dirList)) {
          for (const item of dirList as Array<Record<string, unknown>>) {
            if (item?.type === "file" && typeof item.name === "string") {
              existingImageNames.add(item.name as string);
            }
          }
        }
      } catch (e) {
        // 404 = cartella immagini inesistente -> nessun file fisico da eliminare.
        if (!String((e as Error).message).includes("404")) throw e;
      }
      filesToDelete = actuallyRemoved.filter((n) => existingImageNames.has(n));
    }

    // Aggiunta — offset dal frontmatter PRIMA della rimozione: nomi eliminati
    // in questa stessa chiamata non vengono mai riassegnati, evitando collisioni
    // di cache browser. Il risultato del calcolo offset non entra mai in foto[]:
    // foto[] deriva SEMPRE E SOLO da (frontmatter - rimossi + nuovi nomi).
    const newBlobs: { path: string; sha: string }[] = [];
    if (addPhotos.length > 0) {
      const newNames = nextFotoNames(originalFoto, slug, addPhotos.length);
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

    // Pre-compila tree items una volta sola (invarianti tra i retry — solo base_tree cambia).
    const treeItems: Record<string, unknown>[] = [
      { path: mdPath, mode: "100644", type: "blob", content: newContent },
    ];
    for (const blob of newBlobs) {
      treeItems.push({ path: blob.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    for (const name of filesToDelete) {
      treeItems.push({ path: `public/images/locali/${slug}/${name}`, mode: "100644", type: "blob", sha: null });
    }

    // Retry loop: il Trees API può restituire 422/BadObjectState dopo un ciclo
    // cancella-poi-ricrea mentre GitHub riorganizza internamente gli oggetti git
    // (GC/repack). Ad ogni tentativo si rilegge il ref per avere un base_tree
    // fresco. Max 2 retry (3 tentativi totali).
    let lastGitError: Error | null = null;
    for (let attempt = 0; attempt <= 2; attempt++) {
      try {
        const refData = await gh(token, `/repos/${owner}/${repo}/git/ref/heads/main`);
        const commitSha = (refData.object as Record<string, string>).sha;
        const commitData = await gh(token, `/repos/${owner}/${repo}/git/commits/${commitSha}`);
        const treeSha = (commitData.tree as Record<string, string>).sha;

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
        const msg = (e as Error).message;
        const isBadObjectState = msg.includes("BadObjectState") ||
          (msg.includes("422") && msg.includes("/git/trees"));
        if (attempt < 2 && isBadObjectState) {
          lastGitError = e as Error;
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
    throw lastGitError ?? new Error("Tree creation failed after retries");
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[update-foto-locale] error:", msg);
    const isBadObjectState = msg.includes("BadObjectState") ||
      (msg.includes("422") && msg.includes("/git/trees"));
    return jsonResponse(500, {
      error: isBadObjectState
        ? "Errore temporaneo durante il salvataggio. Riprova tra qualche secondo."
        : "Errore durante l'aggiornamento delle foto.",
    });
  }
};
