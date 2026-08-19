/**
 * Segnala a IndexNow gli indirizzi del sito.
 *
 * Perche' esiste. Un sito nuovo non viene trovato perche' e' online: viene
 * trovato perche' qualcuno lo nomina. Finche' nessuna pagina al mondo rimanda
 * qui, i robot non hanno da dove arrivare.
 *
 * IndexNow e' l'unico modo di dire "esisto, vieni a vedere" senza possedere un
 * account da nessuna parte: si pubblica una chiave in chiaro sul sito, e chi
 * la trova al suo posto sa che la segnalazione viene da chi il sito lo governa.
 * La raccolgono Bing (e con lui Copilot e DuckDuckGo), Yandex, Seznam, Naver.
 *
 * Google NON partecipa e non accetta segnalazioni anonime: la' si passa da
 * Search Console, che richiede l'account del proprietario. Non c'e' scorciatoia.
 *
 * Uso:
 *   npm run segnala
 *
 * Va rilanciato quando cambiano gli indirizzi (locale nuovo, slug rinominato).
 * Rilanciarlo a vuoto non fa danno.
 */

const SITO = process.env.SITE_URL || 'https://aperitivi-urbani.pages.dev';

/**
 * La chiave sta in chiaro dentro al sito, in `public/<chiave>.txt`.
 * Non e' un segreto: e' il contrario, e' la prova pubblica che chi segnala ha
 * accesso al sito. Se cambia qui va rinominato anche quel file.
 */
const CHIAVE = '6fe7475dcc9a4f85b48b8e4227528a14';

const MOTORI = ['https://api.indexnow.org/indexnow', 'https://www.bing.com/indexnow'];

/** Gli indirizzi si leggono dalla sitemap: una fonte sola, sempre aggiornata. */
async function indirizzi() {
  const indice = await (await fetch(`${SITO}/sitemap-index.xml`)).text();
  const mappe = [...indice.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

  const trovati = [];
  for (const mappa of mappe) {
    const xml = await (await fetch(mappa)).text();
    trovati.push(...[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
  }
  return [...new Set(trovati)];
}

const urlList = await indirizzi();
if (urlList.length === 0) {
  console.error('Nessun indirizzo nella sitemap: niente da segnalare.');
  process.exit(1);
}

// Prima si controlla che la chiave sia davvero raggiungibile: senza, la
// segnalazione viene rifiutata e non si capisce perche'.
const prova = await fetch(`${SITO}/${CHIAVE}.txt`);
const contenuto = (await prova.text()).trim();
if (!prova.ok || contenuto !== CHIAVE) {
  console.error(
    `La chiave non e' pubblicata: ${SITO}/${CHIAVE}.txt risponde ` +
      `${prova.status} con "${contenuto.slice(0, 40)}".\n` +
      'Serve che il file esista e contenga esattamente la chiave.'
  );
  process.exit(1);
}

console.log(`Segnalo ${urlList.length} indirizzi di ${new URL(SITO).host}`);

const corpo = JSON.stringify({ host: new URL(SITO).host, key: CHIAVE, urlList });

for (const motore of MOTORI) {
  const risposta = await fetch(motore, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: corpo,
  });
  // 200 accettato, 202 preso in carico: entrambi vanno bene.
  console.log(`  ${motore} -> ${risposta.status} ${risposta.statusText}`);
  if (!risposta.ok) console.log('    ' + (await risposta.text()).slice(0, 300));
}
