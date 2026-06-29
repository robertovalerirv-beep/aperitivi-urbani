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

function b64Encode(str: string): string {
  return btoa(unescape(encodeURIComponent(str)));
}

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

function buildFrontmatter(params: {
  nome: string; slug: string; indirizzo: string; zona: string;
  tipo: string[]; fascia_prezzo: string | null; url_post: string;
  foto_names: string[]; data_visita: string; sentiment: string | null;
  voto: number | null; sponsorizzato: boolean; note_reel: string | null;
  caption: string; piatti_drink: string[];
}): string {
  const { nome, slug, indirizzo, zona, tipo, fascia_prezzo, url_post, foto_names,
    data_visita, sentiment, voto, sponsorizzato, note_reel, caption, piatti_drink } = params;

  const tipoBlock = tipo.length > 0
    ? `tipo:\n  - ${tipo.join("\n  - ")}`
    : `tipo:\n  - altro`;
  const fotoBlock = foto_names.length > 0
    ? `foto:\n  - ${foto_names.join("\n  - ")}`
    : `foto: []`;
  const piattiBlock = piatti_drink.length > 0
    ? `piatti_drink_citati:\n  - ${piatti_drink.join("\n  - ")}`
    : `piatti_drink_citati: []`;

  return `---
nome: "${nome.replace(/"/g, '\\"')}"
slug: "${slug}"
indirizzo: "${indirizzo.replace(/"/g, '\\"')}"
zona: "${zona.replace(/"/g, '\\"')}"
${tipoBlock}
fascia_prezzo: ${fascia_prezzo ? `"${fascia_prezzo}"` : "null"}
instagram_url: "${url_post.replace(/"/g, '\\"')}"
${fotoBlock}
visite:
  - data: "${data_visita}"
    sentiment: ${sentiment ? `"${sentiment}"` : "null"}
    voto: ${voto !== null ? voto : "null"}
    sponsorizzato: ${sponsorizzato}
    note_reel: ${note_reel ? `"${note_reel.replace(/"/g, '\\"')}"` : "null"}
    caption: "${caption.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"
    ${piattiBlock}
    post_url: "${url_post.replace(/"/g, '\\"')}"
    foto: []
---
`;
}

function appendVisita(existingMd: string, params: {
  data_visita: string; sentiment: string | null; voto: number | null;
  sponsorizzato: boolean; note_reel: string | null; caption: string;
  piatti_drink: string[]; url_post: string; foto_names: string[];
}): string {
  const { data_visita, sentiment, voto, sponsorizzato, note_reel, caption, piatti_drink, url_post } = params;
  const piattiBlock = piatti_drink.length > 0
    ? `\n    piatti_drink_citati:\n      - ${piatti_drink.join("\n      - ")}`
    : `\n    piatti_drink_citati: []`;

  const nuovaVisita = `  - data: "${data_visita}"
    sentiment: ${sentiment ? `"${sentiment}"` : "null"}
    voto: ${voto !== null ? voto : "null"}
    sponsorizzato: ${sponsorizzato}
    note_reel: ${note_reel ? `"${note_reel.replace(/"/g, '\\"')}"` : "null"}
    caption: "${caption.replace(/"/g, '\\"').replace(/\n/g, "\\n")}"${piattiBlock}
    post_url: "${url_post.replace(/"/g, '\\"')}"
    foto: []`;

  const visisteRe = /^visite:\s*$/m;
  if (visisteRe.test(existingMd)) {
    return existingMd.replace(visisteRe, `visite:\n${nuovaVisita}`);
  }
  const lastVisitaRe = /^(visite:[\s\S]*?)(\n---\n|$)/m;
  const m = existingMd.match(lastVisitaRe);
  if (m) {
    const insert = m[0].replace(m[2], `\n${nuovaVisita}${m[2]}`);
    return existingMd.replace(lastVisitaRe, insert);
  }
  return existingMd;
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
  piatti_drink_citati: string[];
  foto: string[];
}

interface InputBody {
  password: string;
  url_post: string;
  data_visita: string;
  caption: string;
  note_reel?: string;
  locali: LocaleInput[];
}

export const POST: APIRoute = async ({ request }) => {
  try {
    const password = import.meta.env.ADMIN_PASSWORD;
    const token = import.meta.env.GITHUB_TOKEN_INTAKE;
    const owner = import.meta.env.INTAKE_REPO_OWNER;
    const repo = import.meta.env.INTAKE_REPO_NAME;

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

      try {
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
            const fotoName = `${slug}-${i + 1}.jpg`;
            fotoBlobShas.push({
              path: `public/images/locali/${slug}/${fotoName}`,
              sha: blobSha,
            });
            fotoNames.push(fotoName);
          }
        }

        // STEP C — SHA HEAD e tree root
        const refData = await gh(token, `/repos/${owner}/${repo}/git/ref/heads/main`);
        const commitSha = (refData.object as Record<string, string>).sha;
        const commitData = await gh(token, `/repos/${owner}/${repo}/git/commits/${commitSha}`);
        const treeSha = (commitData.tree as Record<string, string>).sha;

        // STEP D — Contenuto MD
        let contenutoMD: string;
        const mdPath = `content/locali/${slug}.md`;

        let existingSha: string | null = null;
        try {
          const existingFile = await gh(token, `/repos/${owner}/${repo}/contents/${mdPath}?ref=main`);
          existingSha = existingFile.sha as string;
          const existingContent = b64Decode(existingFile.content as string).replace(/^﻿/, "");
          contenutoMD = appendVisita(existingContent, {
            data_visita,
            sentiment: locale.sentiment,
            voto: locale.voto_dedotto,
            sponsorizzato: Boolean(locale.sponsorizzato),
            note_reel: note_reel ?? null,
            caption,
            piatti_drink: locale.piatti_drink_citati ?? [],
            url_post,
            foto_names: fotoNames,
          });
        } catch (e) {
          if (!String((e as Error).message).includes("404")) throw e;
          contenutoMD = buildFrontmatter({
            nome,
            slug,
            indirizzo: String(locale.indirizzo ?? ""),
            zona: String(locale.zona ?? ""),
            tipo: Array.isArray(locale.tipo) ? locale.tipo : [],
            fascia_prezzo: locale.fascia_prezzo ?? null,
            url_post,
            foto_names: fotoNames,
            data_visita,
            sentiment: locale.sentiment,
            voto: locale.voto_dedotto,
            sponsorizzato: Boolean(locale.sponsorizzato),
            note_reel: note_reel ?? null,
            caption,
            piatti_drink: locale.piatti_drink_citati ?? [],
          });
        }

        // STEP E — Commit Trees API
        const treeItems: Record<string, unknown>[] = [
          {
            path: mdPath,
            mode: "100644",
            type: "blob",
            content: contenutoMD,
          },
        ];
        for (const blob of fotoBlobShas) {
          treeItems.push({
            path: blob.path,
            mode: "100644",
            type: "blob",
            sha: blob.sha,
          });
        }

        const newTreeData = await gh(token, `/repos/${owner}/${repo}/git/trees`, {
          method: "POST",
          body: JSON.stringify({ base_tree: treeSha, tree: treeItems }),
        });
        const newTreeSha = newTreeData.sha as string;

        const newCommitData = await gh(token, `/repos/${owner}/${repo}/git/commits`, {
          method: "POST",
          body: JSON.stringify({
            message: `admin: add ${slug} [skip ci]`,
            tree: newTreeSha,
            parents: [commitSha],
          }),
        });
        const newCommitSha = newCommitData.sha as string;

        await gh(token, `/repos/${owner}/${repo}/git/refs/heads/main`, {
          method: "PATCH",
          body: JSON.stringify({ sha: newCommitSha, force: false }),
        });

        results.push({
          slug,
          success: true,
          commit_url: `https://github.com/${owner}/${repo}/commit/${newCommitSha}`,
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
