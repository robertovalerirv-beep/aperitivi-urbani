// Freno al brute force sulla password admin.
//
// Gli endpoint sotto /api/ accettano la password nel body: senza un freno,
// chi conosce il contratto (il repo di AU e' pubblico) puo' provare password
// a raffica. Cloudflare Pages non mette rate limit da solo.
//
// LIMITE NOTO: lo stato vive nella memoria dell'isolate che serve la
// richiesta. Cloudflare ne tiene diversi, per colo, e li ricicla: un
// attaccante distribuito o molto paziente non viene fermato del tutto. Questo
// alza il costo, non lo azzera. Il freno definitivo e' Cloudflare Access (o
// una regola WAF di rate limiting) davanti a /admin e /api/*, che si
// configura dalla dashboard, non da qui.
//
// Tarato per NON dare fastidio a chi lavora: 10 tentativi sbagliati prima di
// bloccare, e il blocco dura 5 minuti. Un typo o tre non chiudono fuori
// nessuno, e ogni accesso riuscito azzera il contatore.

const FINESTRA_MS = 10 * 60 * 1000; // entro cui si contano i tentativi
const MAX_TENTATIVI = 10; // tentativi sbagliati tollerati nella finestra
const BLOCCO_MS = 5 * 60 * 1000; // durata del blocco al superamento
const BLOCCO_LUNGO_MS = 30 * 60 * 1000; // se insiste dopo il primo blocco
const SOGLIA_BLOCCO_LUNGO = 20;
const RITARDO_ERRORE_MS = 300; // costo per tentativo sbagliato
const MAX_VOCI = 1000; // tetto alla mappa, per non crescere all'infinito

type Voce = { tentativi: number; primoTentativo: number; bloccatoFino: number };

const tentativi = new Map<string, Voce>();

function ora(): number {
  return Date.now();
}

/** L'IP vero lo mette Cloudflare; le altre intestazioni sono un ripiego. */
export function ipChiamante(request: Request): string {
  const cf = request.headers.get("cf-connecting-ip");
  if (cf) return cf;
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return "sconosciuto";
}

/** Toglie le voci scadute; se restano troppe, butta le piu' vecchie. */
function pulisci(adesso: number): void {
  for (const [chiave, voce] of tentativi) {
    const scaduta =
      voce.bloccatoFino < adesso && adesso - voce.primoTentativo > FINESTRA_MS;
    if (scaduta) tentativi.delete(chiave);
  }
  if (tentativi.size <= MAX_VOCI) return;
  const ordinate = [...tentativi.entries()].sort(
    (a, b) => a[1].primoTentativo - b[1].primoTentativo
  );
  for (const [chiave] of ordinate.slice(0, tentativi.size - MAX_VOCI)) {
    tentativi.delete(chiave);
  }
}

/**
 * Confronto a tempo costante: `!==` esce al primo carattere diverso e in
 * teoria misura quanto ci si e' avvicinati. In pratica dietro Cloudflare il
 * rumore di rete lo copre, ma costa due righe farlo bene.
 */
function stessaPassword(fornita: unknown, attesa: string): boolean {
  if (typeof fornita !== "string") return false;
  const a = new TextEncoder().encode(fornita);
  const b = new TextEncoder().encode(attesa);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

function risposta(status: number, body: object, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * Unico punto di verifica della password per gli endpoint admin.
 * Torna una Response da restituire subito (401 o 429) oppure null se la
 * password e' giusta e la richiesta puo' proseguire.
 */
export async function verificaPasswordAdmin(
  request: Request,
  passwordFornita: unknown,
  passwordAttesa: string
): Promise<Response | null> {
  const adesso = ora();
  const ip = ipChiamante(request);
  pulisci(adesso);

  const voce = tentativi.get(ip);

  if (voce && voce.bloccatoFino > adesso) {
    const attesa = Math.ceil((voce.bloccatoFino - adesso) / 1000);
    return risposta(
      429,
      { error: `Troppi tentativi. Riprova fra ${Math.ceil(attesa / 60)} minuti.` },
      { "retry-after": String(attesa) }
    );
  }

  if (stessaPassword(passwordFornita, passwordAttesa)) {
    // Accesso riuscito: il contatore riparte da zero.
    tentativi.delete(ip);
    return null;
  }

  const base: Voce =
    voce && adesso - voce.primoTentativo <= FINESTRA_MS
      ? voce
      : { tentativi: 0, primoTentativo: adesso, bloccatoFino: 0 };

  base.tentativi += 1;
  if (base.tentativi >= SOGLIA_BLOCCO_LUNGO) {
    base.bloccatoFino = adesso + BLOCCO_LUNGO_MS;
  } else if (base.tentativi >= MAX_TENTATIVI) {
    base.bloccatoFino = adesso + BLOCCO_MS;
  }
  tentativi.set(ip, base);

  // Ogni tentativo sbagliato costa un attimo: ininfluente per una persona,
  // fastidioso per uno script.
  await new Promise((r) => setTimeout(r, RITARDO_ERRORE_MS));

  if (base.bloccatoFino > adesso) {
    const attesa = Math.ceil((base.bloccatoFino - adesso) / 1000);
    return risposta(
      429,
      { error: `Troppi tentativi. Riprova fra ${Math.ceil(attesa / 60)} minuti.` },
      { "retry-after": String(attesa) }
    );
  }

  return risposta(401, { error: "Password errata" });
}
