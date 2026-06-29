export const prerender = false;

import type { APIRoute } from "astro";

export const GET: APIRoute = async () => {
  const key = import.meta.env.GOOGLE_MAPS_API_KEY ?? "";
  return new Response(JSON.stringify({ key }), {
    headers: { "content-type": "application/json" },
  });
};
