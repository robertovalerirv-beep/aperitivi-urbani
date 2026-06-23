// Proxy server-side per creare una GitHub Issue da intake.
// - Verifica INTAKE_PASSWORD
// - Carica le immagini sul branch `intake-staging` via Contents API
// - Crea l'issue (su main) con body in formato compatibile con il workflow ingest
// Env richieste:
//   INTAKE_PASSWORD
//   GITHUB_TOKEN_INTAKE  (PAT fine-grained: Issues RW, Contents RW)
//   INTAKE_REPO_OWNER    (es. robertovalerirv-beep)
//   INTAKE_REPO_NAME     (es. aperitivi-urbani)

const STAGING_BRANCH = "intake-staging";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function gh(token, path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "content-type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const msg = body?.message || text || `HTTP ${res.status}`;
    throw new Error(`GitHub API ${res.status} (${path}): ${msg}`);
  }
  return body;
}

async function ensureStagingBranch(token, owner, repo) {
  try {
    await gh(token, `/repos/${owner}/${repo}/branches/${STAGING_BRANCH}`);
    return;
  } catch (e) {
    if (!String(e.message).includes("404")) throw e;
  }
  const repoInfo = await gh(token, `/repos/${owner}/${repo}`);
  const baseRef = await gh(token, `/repos/${owner}/${repo}/git/ref/heads/${repoInfo.default_branch}`);
  await gh(token, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${STAGING_BRANCH}`, sha: baseRef.object.sha }),
  });
}

async function uploadImage(token, owner, repo, path, contentB64) {
  return gh(token, `/repos/${owner}/${repo}/contents/${encodeURI(path)}`, {
    method: "PUT",
    body: JSON.stringify({
      message: `intake: upload ${path}`,
      content: contentB64,
      branch: STAGING_BRANCH,
    }),
  });
}

function buildIssueBody({ post_url, data, caption, nome_locale_hint, indirizzo, note, note_audio, locali_lista, imageUrls }) {
  // Riproduce il formato del Form ISSUE_TEMPLATE in modo leggibile dal workflow:
  // headings ### <Label del campo> seguiti dal valore.
  const lines = [];
  lines.push("### URL del post Instagram", "", post_url, "");
  lines.push("### Data del post", "", data, "");
  lines.push("### Caption integrale", "", caption, "");
  lines.push(
    "### Nome del locale (opzionale)",
    "",
    nome_locale_hint || "_No response_",
    ""
  );
  lines.push("### Foto del locale (opzionale)", "");
  if (imageUrls.length === 0) {
    lines.push("_No response_", "");
  } else {
    for (const u of imageUrls) lines.push(`![](${u})`);
    lines.push("");
  }
  lines.push(
    "### Note per il revisore",
    "",
    note || "_No response_",
    ""
  );
  if (indirizzo && String(indirizzo).trim()) {
    lines.push("**Indirizzo:**", "", String(indirizzo).trim(), "");
  }
  if (note_audio && String(note_audio).trim()) {
    lines.push("**Note audio (trascrizione reel):**", "", String(note_audio).trim(), "");
  }
  if (Array.isArray(locali_lista) && locali_lista.length > 0) {
    const validi = locali_lista
      .map((l) => ({
        nome: String(l?.nome ?? "").trim(),
        indirizzo: String(l?.indirizzo ?? "").trim(),
      }))
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

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const password = process.env.INTAKE_PASSWORD;
  const token = process.env.GITHUB_TOKEN_INTAKE;
  const owner = process.env.INTAKE_REPO_OWNER;
  const repo = process.env.INTAKE_REPO_NAME;

  if (!password || !token || !owner || !repo) {
    return jsonResponse(500, {
      error:
        "Env mancanti su Netlify. Servono: INTAKE_PASSWORD, GITHUB_TOKEN_INTAKE, INTAKE_REPO_OWNER, INTAKE_REPO_NAME.",
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Body JSON invalido" });
  }

  if (body?.password !== password) {
    return jsonResponse(401, { error: "Password errata" });
  }

  const { post_url, data, caption, nome_locale_hint, indirizzo, note, note_audio, locali_lista, images } = body;
  if (!post_url || !data || !caption) {
    return jsonResponse(400, {
      error: "Campi obbligatori mancanti: post_url, data, caption.",
    });
  }

  const uuid =
    (globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  try {
    await ensureStagingBranch(token, owner, repo);

    const imageUrls = [];
    if (Array.isArray(images) && images.length > 0) {
      for (const img of images) {
        if (!img?.filename || !img?.content_b64) {
          throw new Error("Immagine malformata (manca filename o content_b64).");
        }
        const path = `intake-staging/${uuid}/${img.filename}`;
        await uploadImage(token, owner, repo, path, img.content_b64);
        imageUrls.push(
          `https://raw.githubusercontent.com/${owner}/${repo}/${STAGING_BRANCH}/${path}`
        );
      }
    }

    const issueBody = buildIssueBody({
      post_url,
      data,
      caption,
      nome_locale_hint,
      indirizzo,
      note,
      note_audio,
      locali_lista,
      imageUrls,
    });

    const issue = await gh(token, `/repos/${owner}/${repo}/issues`, {
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
    return jsonResponse(502, { error: e.message });
  }
};
