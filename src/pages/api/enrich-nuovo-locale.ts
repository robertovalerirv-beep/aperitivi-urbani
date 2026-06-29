export const prerender = false;

import type { APIRoute } from "astro";

function jsonResponse(status: number, body: object) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const runtime = (locals as Record<string, unknown>).runtime as { env?: Record<string, string> } | undefined;
    const env = runtime?.env ?? import.meta.env;
    const password = env.ADMIN_PASSWORD;
    if (!password) {
      return jsonResponse(500, { error: "ADMIN_PASSWORD non configurata." });
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

    const { caption, note_reel, locali, url_post, data_visita, modalita } = body as {
      caption?: string;
      note_reel?: string;
      locali?: { indirizzo: string; zona: string; foto: string[] }[];
      url_post?: string;
      data_visita?: string;
      modalita?: string;
    };

    const testoPerAI = [caption, note_reel].filter(Boolean).join("\n\n---\n\n");

    const anthropicKey = env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      return jsonResponse(500, { error: "ANTHROPIC_API_KEY non configurata." });
    }

    let arricchimento: Record<string, unknown> = {
      tipo: [],
      fascia_prezzo: null,
      sentiment: null,
      voto_dedotto: null,
      sponsorizzato: false,
      piatti_drink_citati: [],
    };

    try {
      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          system:
            "Rispondi SOLO con JSON valido. Nessun testo prima o dopo. Nessun markdown. Nessun backtick. Solo l'oggetto JSON.",
          messages: [
            {
              role: "user",
              content: `Analizza questo testo di una recensione di locale milanese ed estrai le informazioni richieste.\n\nTesto:\n${testoPerAI}\n\nRestituisci un oggetto JSON con questi campi:\n- tipo: array di stringhe tra ["aperitivo","ristorante","cocktail-bar","wine-bar","bistrot","trattoria","pizzeria","caffetteria","altro"]\n- fascia_prezzo: stringa tra "€","€€","€€€","€€€€" oppure null\n- sentiment: stringa tra "entusiasta","positivo","neutro","tiepido","critico" oppure null\n- voto_dedotto: numero da 1 a 5 (passo 0.5) oppure null\n- sponsorizzato: boolean (true solo se ci sono segnali espliciti come #adv #ad #sponsored "in collaborazione con" gifting dichiarato)\n- piatti_drink_citati: array di stringhe con i piatti/drink menzionati`,
            },
          ],
        }),
      });

      if (aiRes.ok) {
        const data = await aiRes.json();
        const text = (data.content?.[0]?.text as string) ?? "{}";
        const raw = text.match(/\{[\s\S]*\}/)?.[0] ?? "{}";
        try {
          const parsed = JSON.parse(raw);
          arricchimento = {
            tipo: Array.isArray(parsed.tipo) ? parsed.tipo : [],
            fascia_prezzo: parsed.fascia_prezzo ?? null,
            sentiment: parsed.sentiment ?? null,
            voto_dedotto: parsed.voto_dedotto ?? null,
            sponsorizzato: Boolean(parsed.sponsorizzato),
            piatti_drink_citati: Array.isArray(parsed.piatti_drink_citati) ? parsed.piatti_drink_citati : [],
          };
        } catch {
          // lascia i valori default null
        }
      }
    } catch {
      // errore AI: restituiamo i campi null invece di 500
    }

    return jsonResponse(200, {
      arricchimento,
      locali: locali ?? [],
      url_post,
      data_visita,
      modalita,
      caption,
      note_reel,
    });
  } catch (e) {
    return jsonResponse(500, { error: (e as Error).message });
  }
};
