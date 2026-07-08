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

function b64Encode(str: string): string {
  return btoa(unescape(encodeURIComponent(str)));
}

const FASCIA_ENUM = ["€", "€€", "€€€", "€€€€", "€€€€€"] as const;

function makeSlug(nome: string): string {
  return nome
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .trim();
}

function getRootFoto(md: string): string[] {
  const blockMatch = md.match(/^foto:\n((?:  - .*\n)*)/m);
  if (!blockMatch) return [];
  return blockMatch[1]
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(/^  - /, "").trim());
}

// Offset basato sul numero massimo realmente usato nei filename esistenti,
// non sulla lunghezza dell'array — dopo una rimozione (via /admin/[slug]/),
// array.length non corrisponde più al massimo indice usato, e riusarlo
// causerebbe collisioni silenziose (sovrascrittura di foto ancora esistenti).
function nextFotoOffset(existingNames: string[], slug: string): number {
  let maxN = 0;
  const re = new RegExp(`^${slug}-(\\d+)\\.[a-zA-Z0-9]+$`);
  for (const name of existingNames) {
    const m = name.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxN) maxN = n;
    }
  }
  return maxN;
}

function mergeRootFoto(md: string, newNames: string[]): string {
  if (newNames.length === 0) return md;
  const existing = getRootFoto(md);
  const merged = [...existing];
  for (const n of newNames) {
    if (!merged.includes(n)) merged.push(n);
  }
  const blockRe = /^foto:\n(?:  - .*\n)*/m;
  const inlineRe = /^foto: \[\]$/m;
  if (blockRe.test(md)) {
    return md.replace(blockRe, `foto:\n  - ${merged.join("\n  - ")}\n`);
  }
  return md.replace(inlineRe, `foto:\n  - ${merged.join("\n  - ")}`);
}

function buildFrontmatter(params: {
  nome: string; slug: string; indirizzo: string; zona: string;
  tipo: string[]; fascia_prezzo: string | null; url_post: string;
  foto_names: string[]; data_visita: string; sentiment: string | null;
  voto: number | null; sponsorizzato: boolean; note_reel: string | null;
  caption: string; lat?: number; lng?: number;
}): string {
  const { nome, slug, indirizzo, zona, tipo, fascia_prezzo, url_post, foto_names,
    data_visita, sentiment, voto, sponsorizzato, note_reel, caption,
    lat, lng } = params;

  const tipoBlock = tipo.length > 0
    ? `tipo:\n  - ${tipo.join("\n  - ")}`
    : `tipo: []`;
  const fotoBlock = foto_names.length > 0
    ? `foto:\n  - ${foto_names.join("\n  - ")}`
    : `foto: []`;

  return `---
nome: "${nome.replace(/"/g, '\\"')}"
slug: "${slug}"
indirizzo: "${indirizzo.replace(/"/g, '\\"')}"
${lat !== undefined ? `lat: ${lat}\n` : ""}${lng !== undefined ? `lng: ${lng}\n` : ""}zona: ${zona ? `"${zona.replace(/"/g, '\\"')}"` : "null"}
${tipoBlock}
fascia_prezzo: ${fascia_prezzo ? `"${fascia_prezzo}"` : "null"}
instagram_url: "${url_post.replace(/"/g, '\\"')}"
${fotoBlock}
sponsorizzato: ${sponsorizzato}
sentiment: ${sentiment ? `"${sentiment}"` : "null"}
voto_dedotto: ${voto !== null ? voto : "null"}
visite:
  - data: "${data_visita}"
    sponsorizzato: ${sponsorizzato}
    note_reel: ${note_reel ? `"${note_reel.replace(/"/g, '\\"')}"` : "null"}
    caption: "${caption.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"
    post_url: "${url_post.replace(/"/g, '\\"')}"
    foto: []
---
`;
}

function appendVisita(existingMd: string, params: {
  data_visita: string; sentiment: string | null; voto: number | null;
  sponsorizzato: boolean; note_reel: string | null; caption: string;
  url_post: string; foto_names: string[];
}): string {
  const { data_visita, sentiment, voto, sponsorizzato, note_reel, caption, url_post, foto_names } = params;

  let md = existingMd;
  const sentimentValue = sentiment ? `"${sentiment}"` : "null";
  const votoValue = voto !== null ? String(voto) : "null";

  const sentimentRe = /^(sentiment:)[ \t]*.*$/m;
  if (sentimentRe.test(md)) {
    md = md.replace(sentimentRe, `$1 ${sentimentValue}`);
  } else {
    md = md.replace(/^visite:/m, `sentiment: ${sentimentValue}\nvisite:`);
  }

  const votoRe = /^(voto_dedotto:)[ \t]*.*$/m;
  if (votoRe.test(md)) {
    md = md.replace(votoRe, `$1 ${votoValue}`);
  } else {
    md = md.replace(/^visite:/m, `voto_dedotto: ${votoValue}\nvisite:`);
  }

  md = mergeRootFoto(md, foto_names);

  const fotoVisitaBlock = foto_names.length > 0
    ? `\n    foto:\n      - ${foto_names.join("\n      - ")}`
    : `\n    foto: []`;

  const nuovaVisita = `  - data: "${data_visita}"
    sponsorizzato: ${sponsorizzato}
    note_reel: ${note_reel ? `"${note_reel.replace(/"/g, '\\"')}"` : "null"}
    caption: "${caption.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"
    post_url: "${url_post.replace(/"/g, '\\"')}"${fotoVisitaBlock}`;

  const visisteRe = /^visite:\s*$/m;
  if (visisteRe.test(md)) {
    return md.replace(visisteRe, `visite:\n${nuovaVisita}`);
  }
  const lastVisitaRe = /^(visite:[\s\S]*?)(\n---\n|$)/m;
  const m = md.match(lastVisitaRe);
  if (m) {
    const insert = m[0].replace(m[2], `\n${nuovaVisita}${m[2]}`);
    return md.replace(lastVisitaRe, insert);
  }
  return md;
}

interface LocaleInput {
  nome: string;
  indirizzo: string;
  zona: string;
  tipo: string[];
  fascia_prezzo: string | null;
  sentiment: string | null;
  voto_dedotto: number | null;
  sponsorizzato: boolean;
  foto: string[];
  lat?: number;
  lng?: number;
}

interface InputBody {
  password: string;
  url_post: string;
  data_visita: string;
  caption: string;
  note_reel?: string;
  locali: LocaleInput[];
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

    let body: InputBody;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { error: "Body JSON invalido" });
    }

    if (body?.password !== password) {
      return jsonResponse(401, { error: "Password errata" });
    }

    const { url_post, data_visita, caption, note_reel, locali } = body;
    if (!url_post || typeof url_post !== "string" || !url_post.trim()) {
      return jsonResponse(400, { error: "URL post Instagram obbligatorio" });
    }
    if (!Array.isArray(locali) || locali.length === 0) {
      return jsonResponse(400, { error: "Nessun locale da salvare" });
    }

    const results: { slug: string; success: boolean; commit_url: string | null; foto_salvate: number; error?: string }[] = [];

    for (const locale of locali) {
      const nome = String(locale.nome ?? "").trim();
      const slug = makeSlug(nome);

      if (!slug) {
        results.push({ slug: nome || "(vuoto)", success: false, commit_url: null, foto_salvate: 0, error: "Nome non valido" });
        continue;
      }

      const fascia = locale.fascia_prezzo ?? null;
      if (fascia !== null && !(FASCIA_ENUM as readonly string[]).includes(fascia)) {
        results.push({ slug, success: false, commit_url: null, foto_salvate: 0, error: `Formato prezzo non valido: "${fascia}". Valori consentiti: ${FASCIA_ENUM.join(", ")}` });
        continue;
      }

      const lat = locale.lat !== undefined ? parseFloat(String(locale.lat)) : undefined;
      const lng = locale.lng !== undefined ? parseFloat(String(locale.lng)) : undefined;

      try {
        const mdPath = `content/locali/${slug}.md`;

        // STEP A2 — Verifica file MD esistente (offset foto + merge root)
        let existingSha: string | null = null;
        let existingContent: string | null = null;
        try {
          const existingFile = await gh(token, `/repos/${owner}/${repo}/contents/${mdPath}?ref=main`);
          existingSha = existingFile.sha as string;
          existingContent = b64Decode(existingFile.content as string).replace(/^﻿/, "");
        } catch (e) {
          if (!String((e as Error).message).includes("404")) throw e;
        }
        let existingFotoOffset = existingContent ? nextFotoOffset(getRootFoto(existingContent), slug) : 0;

        // STEP A3 — Orphan cleanup (solo per locale nuovo senza MD esistente).
        // Scansiona la cartella immagini: se ci sono file orfani da un locale
        // precedente con lo stesso slug, li eliminiamo atomicamente nel commit.
        // L'offset viene aggiornato al massimo trovato su disco per garantire
        // nomi sempre nuovi (evita collisioni di cache browser sulle stesse URL).
        // Usiamo il SHA esatto del commit corrente (non il label "main") per evitare
        // che dati stale dalla Contents API includano sha:null per path inesistenti
        // nel base_tree — ciò causerebbe GitRPC::BadObjectState sulle operazioni
        // successive che usano quel tree come base.
        const orphanPaths: string[] = [];
        if (existingContent === null) {
          const earlyRefData = await gh(token, `/repos/${owner}/${repo}/git/ref/heads/main`);
          const earlyCommitSha = (earlyRefData.object as Record<string, string>).sha;
          const imgDir = `public/images/locali/${slug}`;
          try {
            const dirContents = await gh(token, `/repos/${owner}/${repo}/contents/${imgDir}?ref=${earlyCommitSha}`);
            if (Array.isArray(dirContents)) {
              const dirNames = (dirContents as Record<string, unknown>[])
                .filter((f) => f.type === "file")
                .map((f) => (f.path as string).split("/").pop() as string);
              existingFotoOffset = nextFotoOffset(dirNames, slug);
              for (const f of dirContents as Record<string, unknown>[]) {
                if (f.type === "file") orphanPaths.push(f.path as string);
              }
            }
          } catch (e) {
            if (!String((e as Error).message).includes("404")) throw e;
          }
        }

        // STEP B — Blob foto su GitHub
        const fotoBlobShas: { path: string; sha: string }[] = [];
        const fotoNames: string[] = [];
        if (Array.isArray(locale.foto) && locale.foto.length > 0) {
          for (let i = 0; i < locale.foto.length; i++) {
            const base64string = locale.foto[i];
            const blobRes = await gh(token, `/repos/${owner}/${repo}/git/blobs`, {
              method: "POST",
              body: JSON.stringify({ content: base64string, encoding: "base64" }),
            });
            const blobSha = blobRes.sha as string;
            const fotoName = `${slug}-${existingFotoOffset + i + 1}.jpg`;
            fotoBlobShas.push({
              path: `public/images/locali/${slug}/${fotoName}`,
              sha: blobSha,
            });
            fotoNames.push(fotoName);
          }
        }

        // STEP D — Contenuto MD
        let contenutoMD: string;
        if (existingContent !== null) {
          contenutoMD = appendVisita(existingContent, {
            data_visita,
            sentiment: locale.sentiment,
            voto: locale.voto_dedotto,
            sponsorizzato: Boolean(locale.sponsorizzato),
            note_reel: note_reel ?? null,
            caption,
            url_post,
            foto_names: fotoNames,
          });
        } else {
          contenutoMD = buildFrontmatter({
            nome,
            slug,
            indirizzo: String(locale.indirizzo ?? ""),
            zona: String(locale.zona ?? ""),
            tipo: Array.isArray(locale.tipo) ? locale.tipo : [],
            fascia_prezzo: fascia,
            url_post,
            foto_names: fotoNames,
            data_visita,
            sentiment: locale.sentiment,
            voto: locale.voto_dedotto,
            sponsorizzato: Boolean(locale.sponsorizzato),
            note_reel: note_reel ?? null,
            caption,
            lat: Number.isFinite(lat) ? lat : undefined,
            lng: Number.isFinite(lng) ? lng : undefined,
          });
        }

        // STEP E — Commit Trees API con retry per 422/BadObjectState.
        // Gli items del tree sono invarianti tra i retry (blob già creati, orphan
        // verificati); solo il base_tree SHA viene riletto a ogni tentativo.
        const treeItems: Record<string, unknown>[] = [
          { path: mdPath, mode: "100644", type: "blob", content: contenutoMD },
        ];
        for (const blob of fotoBlobShas) {
          treeItems.push({ path: blob.path, mode: "100644", type: "blob", sha: blob.sha });
        }
        for (const path of orphanPaths) {
          treeItems.push({ path, mode: "100644", type: "blob", sha: null });
        }

        let lastGitError: Error | null = null;
        let commitUrl = "";
        for (let attempt = 0; attempt <= 2; attempt++) {
          try {
            // STEP C — SHA HEAD e tree root (riletto a ogni tentativo)
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
                message: `admin: add ${slug}`,
                tree: newTreeSha,
                parents: [commitSha],
              }),
            });
            const newCommitSha = newCommitData.sha as string;

            await gh(token, `/repos/${owner}/${repo}/git/refs/heads/main`, {
              method: "PATCH",
              body: JSON.stringify({ sha: newCommitSha, force: false }),
            });

            commitUrl = `https://github.com/${owner}/${repo}/commit/${newCommitSha}`;
            lastGitError = null;
            break;
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
        if (lastGitError) throw lastGitError;

        results.push({
          slug,
          success: true,
          commit_url: commitUrl,
          foto_salvate: fotoBlobShas.length,
        });
      } catch (e) {
        results.push({
          slug,
          success: false,
          commit_url: null,
          foto_salvate: 0,
          error: (e as Error).message,
        });
      }
    }

    return jsonResponse(200, results);
  } catch (e) {
    return jsonResponse(500, { error: (e as Error).message });
  }
};
