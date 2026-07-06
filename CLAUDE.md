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
- Continuous deployment su **Cloudflare Pages** da branch `main`
  (progetto: `aperitivi-urbani`, URL: `https://aperitivi-urbani.pages.dev`).
- Il file `netlify.toml` è conservato come fallback consultabile ma
  **il deploy automatico su Netlify è disattivato** — unico target: CF Pages.
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
├── src/                      # Astro (frontend)
├── astro.config.mjs
├── package.json
└── netlify.toml              # conservato come fallback, non deploy attivo
```

## Variabili d'ambiente su Cloudflare Pages (produzione)
Configurate come **Secret** (Encrypted):
- `ADMIN_PASSWORD` — accesso pannello admin
- `ANTHROPIC_API_KEY` — enrichment AI in /admin/nuovo
- `GITHUB_TOKEN_INTAKE` — creazione issue da form intake
- `INTAKE_REPO_OWNER` — owner del repo GitHub
- `INTAKE_REPO_NAME` — nome del repo GitHub
- `INTAKE_PASSWORD` — password del form intake pubblico (**da aggiungere se mancante**)

Configurate come **Plain text**:
- `GOOGLE_MAPS_API_KEY` — embed mappa Google su schede locali e homepage

Nota: il beacon Cloudflare Web Analytics è hardcoded in `src/layouts/Layout.astro`
(token `483a9a30282c4fdb95a8bfde2de693cb`), non usa variabile d'ambiente.

## Nota per nuovi siti creator
Ogni nuovo sito creator si crea **direttamente su Cloudflare Pages** (skill
`creator-site-clone`), mai su Netlify. Il sito aperitivi-urbani è il template
di riferimento: stesso adapter `@astrojs/cloudflare`, stesso `output: "static"`,
stessa struttura secrets su CF Pages.
