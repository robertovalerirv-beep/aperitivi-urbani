export const prerender = false;

import type { APIRoute } from "astro";

const STAGING_BRANCH = "intake-staging";

function jsonResponse(status: number, body: object) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function gh(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "content-type": "application/json",
      ...((init.headers as Record<string, string>) || {}),
    },
  });
  const text = await res.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = (body as Record<string, string>)?.message || text || `HTTP ${res.status}`;
    throw new Error(`GitHub API ${res.status} (${path}): ${msg}`);
  }
  return body as Record<string, unknown>;
}

async function ensureStagingBranch(token: string, owner: string, repo: string) {
  try {
    await gh(token, `/repos/${owner}/${repo}/branches/${STAGING_BRANCH}`);
    return;
  } catch (e) {
    if (!String((e as Error).message).includes("404")) throw e;
  }
  const repoInfo = await gh(token, `/repos/${owner}/${repo}`);
  const baseRef = await gh(token, `/repos/${owner}/${repo}/git/ref/heads/${repoInfo.default_branch}`);
  await gh(token, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${STAGING_BRANCH}`, sha: (baseRef.object as Record<string,string>).sha }),
  });
}

async function uploadImage(token: string, owner: string, repo: string, path: string, contentB64: string) {
  return gh(token, `/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `intake: upload ${path}`,
      content: contentB64,
      branch: STAGING_BRANCH,
    }),
  });
}

function buildIssueBody({ post_url, data, caption, nome_locale_hint, indirizzo, note, note_audio, locali_lista, imageUrls }: {
  post_url: string; data: string; caption: string; nome_locale_hint?: string;
  indirizzo?: string; note?: string; note_audio?: string;
  locali_lista?: { nome: string; indirizzo: string }[]; imageUrls: string[];
}) {
  const lines: string[] = [];
  lines.push("### URL del post Instagram", "", post_url, "");
  lines.push("### Data del post", "", data, "");
  lines.push("### Caption integrale", "", caption, "");
  lines.push("### Nome del locale (opzionale)", "", nome_locale_hint || "_No response_", "");
  lines.push("### Foto del locale (opzionale)", "");
  if (imageUrls.length === 0) {
    lines.push("_No response_", "");
  } else {
    for (const u of imageUrls) lines.push(`![](${u})`);
    lines.push("");
  }
  lines.push("### Note per il revisore", "", note || "_No response_", "");
  if (indirizzo && String(indirizzo).trim()) {
    lines.push("**Indirizzo:**", "", String(indirizzo).trim(), "");
  }
  if (note_audio && String(note_audio).trim()) {
    lines.push("**Note audio (trascrizione reel):**", "", String(note_audio).trim(), "");
  }
  if (Array.isArray(locali_lista) && locali_lista.length > 0) {
    const validi = locali_lista
      .map((l) => ({ nome: String(l?.nome ?? "").trim(), indirizzo: String(l?.indirizzo ?? "").trim() }))
      .filter((l) => l.nome.length > 0);
    if (validi.length > 0) {
      lines.push("**Locali citati:**", "");
      for (const l of validi) {
        const ind = l.indirizzo || "—";
        lines.push(`- Nome: ${l.nome} | Indirizzo: ${ind}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

export const POST: APIRoute = async ({ request }) => {
  const password = import.meta.env.INTAKE_PASSWORD;
  const token = import.meta.env.GITHUB_TOKEN_INTAKE;
  const owner = import.meta.env.INTAKE_REPO_OWNER;
  const repo = import.meta.env.INTAKE_REPO_NAME;

  if (!password || !token || !owner || !repo) {
    return jsonResponse(500, {
      error: "Env mancanti. Servono: INTAKE_PASSWORD, GITHUB_TOKEN_INTAKE, INTAKE_REPO_OWNER, INTAKE_REPO_NAME.",
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

  const { post_url, data, caption, nome_locale_hint, indirizzo, note, note_audio, locali_lista, images } = body as Record<string, unknown>;
  if (!post_url || !data || !caption) {
    return jsonResponse(400, { error: "Campi obbligatori mancanti: post_url, data, caption." });
  }

  const uuid = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  try {
    await ensureStagingBranch(token as string, owner as string, repo as string);

    const imageUrls: string[] = [];
    if (Array.isArray(images) && images.length > 0) {
      for (const img of images as { filename?: string; content_b64?: string }[]) {
        if (!img?.filename || !img?.content_b64) {
          throw new Error("Immagine malformata (manca filename o content_b64).");
        }
        const path = `intake-staging/${uuid}/${img.filename}`;
        await uploadImage(token as string, owner as string, repo as string, path, img.content_b64);
        imageUrls.push(`https://raw.githubusercontent.com/${owner}/${repo}/${STAGING_BRANCH}/${path}`);
      }
    }

    const issueBody = buildIssueBody({
      post_url: post_url as string,
      data: data as string,
      caption: caption as string,
      nome_locale_hint: nome_locale_hint as string | undefined,
      indirizzo: indirizzo as string | undefined,
      note: note as string | undefined,
      note_audio: note_audio as string | undefined,
      locali_lista: locali_lista as { nome: string; indirizzo: string }[] | undefined,
      imageUrls,
    });

    const issue = await gh(token as string, `/repos/${owner}/${repo}/issues`, {
      method: "POST",
      body: JSON.stringify({
        title: `[Recensione] ${nome_locale_hint || post_url}`,
        body: issueBody,
        labels: ["recensione"],
      }),
    });

    return jsonResponse(200, {
      ok: true,
      issue_url: issue.html_url,
      issue_number: issue.number,
    });
  } catch (e) {
    return jsonResponse(502, { error: (e as Error).message });
  }
};
