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

    const mdPath = `content/locali/${slug}.md`;
    const imgDir = `public/images/locali/${slug}`;

    // Verifica che il locale esista davvero prima di toccare l'albero Git
    try {
      await gh(token, `/repos/${owner}/${repo}/contents/${mdPath}?ref=main`);
    } catch (e) {
      if (String((e as Error).message).includes("404")) {
        return jsonResponse(404, { error: "Locale non trovato" });
      }
      throw e;
    }

    // Elenca le foto del locale (se la cartella non esiste, nessuna foto da eliminare)
    let imagePaths: string[] = [];
    try {
      const dirContents = await gh(token, `/repos/${owner}/${repo}/contents/${imgDir}?ref=main`);
      if (Array.isArray(dirContents)) {
        imagePaths = dirContents
          .filter((f: Record<string, unknown>) => f.type === "file")
          .map((f: Record<string, unknown>) => f.path as string);
      }
    } catch (e) {
      if (!String((e as Error).message).includes("404")) throw e;
    }

    // Tree con eliminazione atomica: MD + tutte le foto in un solo commit.
    // Items invarianti tra retry — solo base_tree SHA viene riletto.
    const treeItems: Record<string, unknown>[] = [
      { path: mdPath, mode: "100644", type: "blob", sha: null },
      ...imagePaths.map((path) => ({ path, mode: "100644", type: "blob", sha: null })),
    ];

    // Retry per 422/BadObjectState: riletto il ref a ogni tentativo.
    let lastGitError: Error | null = null;
    let commitUrl = "";
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
            message: `admin: elimina ${slug}`,
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

    return jsonResponse(200, {
      ok: true,
      commit_url: commitUrl,
      foto_eliminate: imagePaths.length,
    });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("[delete-locale] error:", msg);
    return jsonResponse(500, { error: "Errore durante l'eliminazione del locale." });
  }
};
