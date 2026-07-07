export const prerender = false;

import type { APIRoute } from "astro";

const EDITABLE_SCALARS = ["nome", "zona", "indirizzo", "citta", "fascia_prezzo", "sentiment", "voto_dedotto", "sponsorizzato"] as const;
const EDITABLE_ARRAYS = ["tipo"] as const;

const TIPO_ENUM = ["aperitivo", "ristorante", "cocktail-bar", "wine-bar", "bistrot", "trattoria", "pizzeria", "caffetteria", "sushi", "etnico", "orientale", "vegetariano", "pesce", "carne", "pasticceria", "locale-easy", "locale-raffinato", "altro"];
const FASCIA_ENUM = ["€", "€€", "€€€", "€€€€", "€€€€€"];
const SENTIMENT_ENUM = ["entusiasta", "positivo", "neutro", "tiepido", "critico"];

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
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "aperitivi-urbani/1.0",
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

function yamlValue(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (v === true) return "true";
  if (v === false) return "false";
  if (typeof v === "number") return String(v);
  const s = String(v);
  if (/^[A-Za-z0-9 .,àèéìòùÀÈÉÌÒÙ'\-€]+$/.test(s) && !/^(null|true|false|yes|no|~)$/i.test(s)) {
    return s;
  }
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function setScalar(fm: string, key: string, value: unknown): string {
  const re = new RegExp(`^(${key}:)[ \\t]*.*$`, "m");
  if (re.test(fm)) return fm.replace(re, `$1 ${yamlValue(value)}`);
  if (/^slug:.*$/m.test(fm)) {
    return fm.replace(/^(slug:.*)$/m, `$1\n${key}: ${yamlValue(value)}`);
  }
  return fm + `\n${key}: ${yamlValue(value)}`;
}

function setArrayBlock(fm: string, key: string, arr: unknown[]): string {
  let block: string;
  if (!arr || arr.length === 0) {
    block = `${key}: []`;
  } else {
    block = `${key}:\n  - ${arr.map((v) => yamlValue(v)).join("\n  - ")}`;
  }
  const flowRe = new RegExp(`^${key}:[ \\t]*\\[[^\\]]*\\][ \\t]*$`, "m");
  if (flowRe.test(fm)) return fm.replace(flowRe, block);
  const blockRe = new RegExp(`^${key}:[ \\t]*\\r?\\n((?:[ \\t]+-[ \\t]+.*\\r?\\n?)+)`, "m");
  if (blockRe.test(fm)) return fm.replace(blockRe, block + "\n");
  const emptyRe = new RegExp(`^${key}:[ \\t]*$`, "m");
  if (emptyRe.test(fm)) return fm.replace(emptyRe, block);
  if (/^slug:.*$/m.test(fm)) {
    return fm.replace(/^(slug:.*)$/m, `$1\n${block}`);
  }
  return fm + `\n${block}`;
}

function normalizeFields(input: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const k of ["zona", "indirizzo", "fascia_prezzo", "sentiment"] as const) {
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
    out.tipo = (input.tipo as string[]).filter((t) => TIPO_ENUM.includes(t));
  }
  if ("description" in input) {
    out.description = typeof input.description === "string" ? input.description : "";
  }
  if ("caption" in input) {
    // Solo trim ai bordi: gli a-capo interni restano e vengono escapati in scrittura.
    out.caption = String(input.caption ?? "").trim();
  }
  return out;
}

function validateFields(f: Record<string, unknown>) {
  const errs: string[] = [];
  if (f.nome !== undefined && !f.nome) errs.push("nome non può essere vuoto");
  if (f.fascia_prezzo !== undefined && f.fascia_prezzo !== null && !FASCIA_ENUM.includes(f.fascia_prezzo as string)) {
    errs.push(`fascia_prezzo invalida: ${f.fascia_prezzo}`);
  }
  if (f.sentiment !== undefined && f.sentiment !== null && !SENTIMENT_ENUM.includes(f.sentiment as string)) {
    errs.push(`sentiment invalido: ${f.sentiment}`);
  }
  if (f.voto_dedotto !== undefined && f.voto_dedotto !== null) {
    const v = f.voto_dedotto as number;
    if (!(Number.isFinite(v) && v >= 1 && v <= 5)) errs.push("voto_dedotto fuori range 1-5");
  }
  if (f.caption !== undefined && !String(f.caption).trim()) {
    errs.push("la caption non può essere vuota");
  }
  return errs;
}

function b64Decode(b64: string): string {
  const clean = b64.replace(/\n/g, "");
  const bytes = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function b64Encode(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export const POST: APIRoute = async ({ request, locals }) => {
  const runtime = (locals as Record<string, unknown>).runtime as { env?: Record<string, string> } | undefined;
  const env = runtime?.env ?? import.meta.env;
  const password = env.ADMIN_PASSWORD;
  const token = env.GITHUB_TOKEN_INTAKE;
  const owner = env.INTAKE_REPO_OWNER;
  const repo = env.INTAKE_REPO_NAME;

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return jsonResponse(400, { error: "Body JSON invalido" }); }

  if (body?.password !== password) {
    return jsonResponse(401, { error: "Password errata" });
  }

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

  const fields = normalizeFields(body.fields as Record<string, unknown>);
  const errs = validateFields(fields);
  if (errs.length > 0) return jsonResponse(400, { error: errs.join("; ") });

  const filePath = `content/locali/${slug}.md`;

  try {
    const current = await gh(token as string, `/repos/${owner}/${repo}/contents/${filePath}?ref=main`);
    const sha = current.sha as string;
    const decoded = b64Decode(current.content as string).replace(/^﻿/, "");
    const m = decoded.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) throw new Error("Frontmatter non trovato nel file remoto.");
    let fm = m[1];
    const tail = m[2];

    for (const k of EDITABLE_SCALARS) {
      if (k in fields) fm = setScalar(fm, k, fields[k]);
    }
    for (const k of EDITABLE_ARRAYS) {
      if (k in fields) fm = setArrayBlock(fm, k, fields[k] as unknown[]);
    }

    if ("caption" in fields) {
      // Sostituisce SOLO la prima riga caption: (visite[0], la più recente —
      // appendVisita inserisce le nuove visite in testa). Stesso escaping di
      // salva-locale.ts: virgolette e a-capo escapati in stringa single-line.
      const captionRe = /^([ \t]*caption:)[ \t]*".*"[ \t]*$/m;
      if (!captionRe.test(fm)) {
        throw new Error("Riga caption non trovata nel frontmatter: impossibile aggiornare la caption.");
      }
      const escaped = String(fields.caption).replace(/"/g, '\\"').replace(/\n/g, "\\n");
      fm = fm.replace(captionRe, (_full, prefix) => `${prefix} "${escaped}"`);
    }

    const newTail = typeof fields.description === "string"
      ? (fields.description.trim() ? fields.description.trimEnd() + "\n" : "")
      : tail;
    const newContent = `---\n${fm}\n---\n${newTail}`;
    const newB64 = b64Encode(newContent);

    const commit = await gh(token as string, `/repos/${owner}/${repo}/contents/${filePath}`, {
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
      commit_url: (commit.commit as Record<string, unknown>)?.html_url ?? null,
    });
  } catch (e) {
    return jsonResponse(502, { error: (e as Error).message });
  }
};
