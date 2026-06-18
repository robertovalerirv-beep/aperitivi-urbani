# Aperitivi Urbani

Sito statico delle recensioni di locali milanesi di [@aperitivi_urbani](https://www.instagram.com/aperitivi_urbani/) (Valeria Carbone).

Vedi [CLAUDE.md](CLAUDE.md) per architettura e vincoli.

## Sviluppo locale

```bash
npm install
npm run dev          # Astro dev server su http://localhost:4321
npm run validate     # valida content/locali/ contro schemas/locale-schema.json
npm run build        # build statica in dist/
```

## Aggiungere una recensione

1. Apri una **GitHub Issue** usando il template "Nuova recensione".
2. Incolla URL del post, caption, data; eventualmente allega foto.
3. Il workflow `ingest-recensione.yml` apre una Pull Request con la scheda generata.
4. Review umana → merge → Netlify deploya da `main`.

Niente scraping Instagram, niente LLM a runtime lato pubblico.

## Deploy

Continuous deployment su Netlify da branch `main`. Config in [netlify.toml](netlify.toml).
