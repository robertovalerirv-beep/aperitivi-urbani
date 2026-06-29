export const prerender = false;

import type { APIRoute } from "astro";

export const GET: APIRoute = async ({ locals }) => {
  const runtime = (locals as any).runtime;
  const env = runtime?.env ?? import.meta.env;
  const key = env.GOOGLE_MAPS_API_KEY ?? "";
  return new Response(JSON.stringify({ key }), {
    headers: { "content-type": "application/json" },
  });
};
