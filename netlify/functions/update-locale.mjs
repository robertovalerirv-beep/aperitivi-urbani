// Proxy server-side per modifiche admin a un singolo file MD locale.
// - Verifica ADMIN_PASSWORD
// - Legge content/locali/<slug>.md via GitHub Contents API (main)
// - Aggiorna SOLO i campi top-level editabili nel frontmatter (regex mirate,
//   resto del file invariato byte-per-byte — visite[], ultima_estrazione,
//   slug, body markdown preservati)
// - Riscrive il file via PUT Contents API (commit su main)
//
// Env richieste:
//   ADMIN_PASSWORD
//   GITHUB_TOKEN_INTAKE   (PAT fine-grained: Contents RW)
//   INTAKE_REPO_OWNER     (es. robertovalerirv-beep)
//   INTAKE_REPO_NAME      (es. aperitivi-urbani)

const EDITABLE_SCALARS = [
  "nome",
  "zona",
  "indirizzo",
  "citta",
  "fascia_prezzo",
  "sentiment",
  "voto_dedotto",
  "sponsorizzato",
];
const EDITABLE_ARRAYS = ["tipo"];

const TIPO_ENUM = [
  "aperitivo", "ristorante", "cocktail-bar", "wine-bar",
  "bistrot", "trattoria", "pizzeria", "caffetteria", "altro",
];
const FASCIA_ENUM = ["€", "€€", "€€€", "€€€€", "€€€€€"];
const SENTIMENT_ENUM = ["entusiasta", "positivo", "neutro", "tiepido", "critico"];

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function gh(token, urlPath, init = {}) {
  const res = await fetch(`https://api.github.com${urlPath}`, {
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
    throw new Error(`GitHub API ${res.status} (${urlPath}): ${msg}`);
  }
  return body;
}

function yamlValue(v) {
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") return String(v);
  const s = String(v);
  // Bare scalar safe se solo ASCII + accenti italiani + simboli comuni
  if (/^[A-Za-z0-9 .,àèéìòùÀÈÉÌÒÙ'\-€]+$/.test(s) && !/^(null|true|false|yes|no|~)$/i.test(s)) {
    return s;
  }
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function setScalar(fm, key, value) {
  const re = new RegExp(`^(${key}:)[ \\t]*.*$`, "m");
  if (re.test(fm)) return fm.replace(re, `$1 ${yamlValue(value)}`);
  // Chiave non presente: appendi dopo slug (o in coda al frontmatter se slug non esiste)
  if (/^slug:.*$/m.test(fm)) {
    return fm.replace(/^(slug:.*)$/m, `$1\n${key}: ${yamlValue(value)}`);
  }
  return fm + `\n${key}: ${yamlValue(value)}`;
}

function setArrayBlock(fm, key, arr) {
  let block;
  if (!arr || arr.length === 0) {
    block = `${key}: []`;
  } else {
    block = `${key}:\n  - ${arr.map((v) => yamlValue(v)).join("\n  - ")}`;
  }
  // Flow form: tipo: [a, b]  oppure  tipo: []
  const flowRe = new RegExp(`^${key}:[ \\t]*\\[[^\\]]*\\][ \\t]*$`, "m");
  if (flowRe.test(fm)) return fm.replace(flowRe, block);
  // Block form: tipo:\n  - a\n  - b
  const blockRe = new RegExp(`^${key}:[ \\t]*\\r?\\n((?:[ \\t]+-[ \\t]+.*\\r?\\n?)+)`, "m");
  if (blockRe.test(fm)) return fm.replace(blockRe, block + "\n");
  // Block vuoto: "tipo:" senza contenuto
  const emptyRe = new RegExp(`^${key}:[ \\t]*$`, "m");
  if (emptyRe.test(fm)) return fm.replace(emptyRe, block);
  // Chiave assente: inserisci dopo slug
  if (/^slug:.*$/m.test(fm)) {
    return fm.replace(/^(slug:.*)$/m, `$1\n${block}`);
  }
  return fm + `\n${block}`;
}

function normalizeFields(input) {
  const out = {};
  // Scalari nullable: stringa vuota → null
  for (const k of ["zona", "indirizzo", "fascia_prezzo", "sentiment"]) {
    if (k in input) {
      const v = input[k];
      out[k] = v === "" || v === undefined ? null : v;
    }
  }
  if ("nome" in input) out.nome = String(input.nome ?? "").trim();
  if ("citta" in input) out.citta = String(input.citta ?? "").trim() || "Milano";
  if ("voto_dedotto" in input) {
    const v = input.voto_dedotto;
    if (v === null || v === "" || v === undefined) out.voto_dedotto = null;
    else {
      const n = Number(v);
      out.voto_dedotto = Number.isFinite(n) ? n : null;
    }
  }
  if ("sponsorizzato" in input) out.sponsorizzato = Boolean(input.sponsorizzato);
  if (Array.isArray(input.tipo)) {
    out.tipo = input.tipo.filter((t) => TIPO_ENUM.includes(t));
  }
  if ("description" in input) {
    out.description = typeof input.description === "string" ? input.description : "";
  }
  return out;
}

function validateFields(f) {
  const errs = [];
  if (f.nome !== undefined && !f.nome) errs.push("nome non può essere vuoto");
  if (Array.isArray(f.tipo) && f.tipo.length === 0) errs.push("tipo deve contenere almeno un valore");
  if (f.fascia_prezzo !== undefined && f.fascia_prezzo !== null && !FASCIA_ENUM.includes(f.fascia_prezzo)) {
    errs.push(`fascia_prezzo invalida: ${f.fascia_prezzo}`);
  }
  if (f.sentiment !== undefined && f.sentiment !== null && !SENTIMENT_ENUM.includes(f.sentiment)) {
    errs.push(`sentiment invalido: ${f.sentiment}`);
  }
  if (f.voto_dedotto !== undefined && f.voto_dedotto !== null) {
    const v = f.voto_dedotto;
    if (!(Number.isFinite(v) && v >= 1 && v <= 5)) errs.push("voto_dedotto fuori range 1-5");
  }
  return errs;
}

export default async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const password = process.env.ADMIN_PASSWORD;
  const token = process.env.GITHUB_TOKEN_INTAKE;
  const owner = process.env.INTAKE_REPO_OWNER;
  const repo = process.env.INTAKE_REPO_NAME;

  if (!password || !token || !owner || !repo) {
    return jsonResponse(500, {
      error:
        "Env mancanti su Netlify. Servono: ADMIN_PASSWORD, GITHUB_TOKEN_INTAKE, INTAKE_REPO_OWNER, INTAKE_REPO_NAME.",
    });
  }

  let body;
  try { body = await req.json(); } catch { return jsonResponse(400, { error: "Body JSON invalido" }); }

  if (body?.password !== password) {
    return jsonResponse(401, { error: "Password errata" });
  }

  // Verifica password ping (senza altri campi → solo check)
  if (body?.ping === true) {
    return jsonResponse(200, { ok: true });
  }

  const slug = body?.slug;
  if (typeof slug !== "string" || !/^[a-z0-9-]+$/.test(slug)) {
    return jsonResponse(400, { error: "Slug invalido o mancante" });
  }
  if (!body?.fields || typeof body.fields !== "object") {
    return jsonResponse(400, { error: "fields mancanti" });
  }

  const fields = normalizeFields(body.fields);
  const errs = validateFields(fields);
  if (errs.length > 0) return jsonResponse(400, { error: errs.join("; ") });

  const filePath = `content/locali/${slug}.md`;

  try {
    // Read current file
    const current = await gh(token, `/repos/${owner}/${repo}/contents/${filePath}?ref=main`);
    const sha = current.sha;
    const decoded = Buffer.from(current.content, "base64").toString("utf8");
    const m = decoded.replace(/^﻿/, "").match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) throw new Error("Frontmatter non trovato nel file remoto.");
    let fm = m[1];
    const oldTail = m[2];

    // Apply scalar edits
    for (const k of EDITABLE_SCALARS) {
      if (k in fields) fm = setScalar(fm, k, fields[k]);
    }
    // Apply array edits
    for (const k of EDITABLE_ARRAYS) {
      if (k in fields) fm = setArrayBlock(fm, k, fields[k]);
    }

    const newTail = typeof fields.description === "string"
      ? (fields.description.trim() ? fields.description.trimEnd() + "\n" : "")
      : oldTail;
    const newContent = `---\n${fm}\n---\n${newTail}`;
    const newB64 = Buffer.from(newContent, "utf8").toString("base64");

    const commit = await gh(token, `/repos/${owner}/${repo}/contents/${filePath}`, {
      method: "PUT",
      body: JSON.stringify({
        message: `admin: edit ${slug}`,
        content: newB64,
        sha,
        branch: "main",
      }),
    });

    return jsonResponse(200, {
      ok: true,
      commit_url: commit.commit?.html_url ?? null,
    });
  } catch (e) {
    return jsonResponse(502, { error: e.message });
  }
};
