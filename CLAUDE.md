# Aperitivi Urbani — Sito recensioni locali

## Obiettivo
Sito statico che raccoglie e indicizza le recensioni di locali milanesi
pubblicate su Instagram da @aperitivi_urbani (Valeria Carbone, food &
beverage blogger, ~105K follower, autrice di un libro Mondadori Electa
sui locali milanesi). Il sito è un'estensione ufficiale del suo brand,
con consenso scritto dell'autrice a riutilizzare i contenuti dei post.

## Fonte dati
- **NON c'è scraping di Instagram** (vietato da ToS + robots.txt, verificato).
- Ogni recensione entra nel sito via **GitHub Issue manuale**, usando il
  template `.github/ISSUE_TEMPLATE/nuova-recensione.yml` (form strutturato:
  URL del post, caption integrale, data, eventuali foto allegate).
- Un workflow GitHub Actions (`ingest-recensione.yml`) si attiva su
  `issues: opened` e usa `anthropics/claude-code-action` in headless mode
  per estrarre i campi secondo `schemas/locale-schema.json`, generare o
  aggiornare il file Markdown del locale, e aprire una **Pull Request**
  verso `main`.
- **Niente commit diretti su main**: ogni recensione passa da review umana
  finché non ci si fida dell'estrazione automatica.

## Modello dati
- **1 locale = 1 file Markdown** in `content/locali/<slug>.md`.
- Frontmatter YAML conforme a `schemas/locale-schema.json`.
- Visite multiple allo stesso locale si accumulano nell'array `visite[]`
  (l'automazione aggiorna il file esistente invece di crearne uno nuovo).

## Deploy
- Frontend: **Astro** (statico), buildato in CI.
- Continuous deployment su **Netlify** da branch `main`.
- Nessun backend, nessuna chiamata LLM a runtime lato pubblico.
- Claude gira **solo** in GitHub Actions, in fase di ingestion.

## Cosa NON fare
- Non scrivere scraper Instagram in nessuna forma.
- Non chiamare API LLM dalle pagine pubbliche del sito.
- Non commitare contenuti direttamente su main: sempre via PR.
- Non inventare campi non presenti in caption/foto: se un campo non è
  desumibile, va lasciato `null`.
- Non marcare `sponsorizzato: true` senza segnali espliciti nella caption
  (#adv, #ad, #sponsored, "in collaborazione con", gifting dichiarato).
  In dubbio: `false`.
- L'automazione di ingest non deve modificare nulla fuori da
  `content/locali/` e `public/img/locali/`.

## Struttura repo
```
.
├── CLAUDE.md
├── .github/
│   ├── ISSUE_TEMPLATE/nuova-recensione.yml
│   └── workflows/ingest-recensione.yml
├── schemas/locale-schema.json
├── content/locali/<slug>.md
├── public/img/locali/<slug>/*.jpg
├── scripts/validate-locali.mjs
├── src/                      # Astro (frontend, da implementare)
├── astro.config.mjs
├── package.json
└── netlify.toml
```
