// Validazione delle foto in arrivo dagli endpoint admin.
//
// Il client ridimensiona e converte in JPEG con canvas.toDataURL("image/jpeg")
// e manda il solo base64. Il server, fino a qui, si fidava: qualunque stringa
// base64 finiva committata come <slug>-N.jpg. E' post-autenticazione, ma un
// file non-immagine o da centinaia di MB entrerebbe nella storia di git, da
// dove non si toglie piu'.
//
// I limiti sono larghi apposta: una foto ridimensionata a 1600px sta sotto il
// megabyte, quindi 10 MB non danno fastidio a nessuno che lavori normalmente.

const MAX_BYTE_FOTO = 10 * 1024 * 1024; // per singola foto
const MAX_FOTO_PER_RICHIESTA = 30;

/**
 * "/9j/" in base64 sono i byte FF D8 FF, cioe' l'intestazione JPEG: e' lo
 * stesso controllo dei magic bytes, fatto senza decodificare tutta la stringa.
 */
function sembraJpeg(b64: string): boolean {
  return b64.startsWith("/9j/");
}

/** Byte reali rappresentati da una stringa base64, senza decodificarla. */
function byteStimati(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/**
 * Torna il messaggio d'errore da restituire al client, oppure null se le foto
 * vanno bene. Il messaggio e' esplicito: chi carica deve capire cosa rifare.
 */
export function erroreFoto(foto: unknown): string | null {
  if (foto === undefined || foto === null) return null;
  if (!Array.isArray(foto)) return "Formato foto non valido";
  if (foto.length > MAX_FOTO_PER_RICHIESTA) {
    return `Troppe foto in una volta sola: massimo ${MAX_FOTO_PER_RICHIESTA} per salvataggio`;
  }
  for (let i = 0; i < foto.length; i++) {
    const f = foto[i];
    const n = i + 1;
    if (typeof f !== "string" || !f.trim()) {
      return `Foto ${n}: contenuto mancante o non valido`;
    }
    // Il client manda il solo base64, senza il prefisso "data:image/...".
    if (f.startsWith("data:")) {
      return `Foto ${n}: attesa la sola parte base64, non l'intera data URL`;
    }
    if (!sembraJpeg(f)) {
      return `Foto ${n}: sono accettati solo file JPEG`;
    }
    if (byteStimati(f) > MAX_BYTE_FOTO) {
      return `Foto ${n}: supera il limite di ${MAX_BYTE_FOTO / 1024 / 1024} MB`;
    }
  }
  return null;
}
