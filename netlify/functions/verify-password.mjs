// Verifica la password di intake. Non rivela mai l'esito esatto.
// Env richieste: INTAKE_PASSWORD

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  const expected = process.env.INTAKE_PASSWORD;
  if (!expected) {
    return new Response(
      JSON.stringify({ error: "INTAKE_PASSWORD non configurata su Netlify" }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }
  let body;
  try {
    body = await req.json();
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
