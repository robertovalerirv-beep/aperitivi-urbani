export const prerender = false;

import type { APIRoute } from "astro";

export const POST: APIRoute = async ({ request }) => {
  const expected = import.meta.env.INTAKE_PASSWORD;
  if (!expected) {
    return new Response(JSON.stringify({ error: "INTAKE_PASSWORD non configurata" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Body JSON invalido" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  if (body?.password !== expected) {
    return new Response(JSON.stringify({ error: "Password errata" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
