import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import sitemap from "@astrojs/sitemap";
import rehypeSanitize from "rehype-sanitize";

// Dominio canonico del sito. Serve a canonical, Open Graph e sitemap:
// se e' sbagliato Google indicizza (o de-indicizza) le pagine sbagliate.
// Override in build con SITE_URL per un dominio custom.
const SITE = process.env.SITE_URL || "https://aperitivi-urbani.pages.dev";

export default defineConfig({
  site: SITE,
  trailingSlash: "ignore",
  output: "static",
  // "file" genera dist/locali/<slug>.html invece di dist/locali/<slug>/index.html.
  // Con l'output a cartelle Cloudflare Pages risponde 308 su /locali/<slug>
  // (redirect verso la versione con slash finale): canonical, sitemap e link
  // interni punterebbero tutti a URL che redirigono.
  build: { format: "file" },
  adapter: cloudflare({
    platformProxy: { enabled: true },
  }),
  integrations: [
    sitemap({
      // Fuori dalla sitemap tutto cio' che non deve finire su Google:
      // pannello admin, form intake, endpoint API.
      filter: (page) => {
        const path = new URL(page).pathname.replace(/\/+$/, "") || "/";
        return (
          !path.startsWith("/admin") &&
          !path.startsWith("/api") &&
          path !== "/aperitivi-intake-2026"
        );
      },
      // Le URL in sitemap devono coincidere ESATTAMENTE con il <link rel=
      // "canonical"> della pagina, altrimenti Google vede due varianti dello
      // stesso indirizzo. Il canonical non ha slash finale: qui lo togliamo.
      serialize: (item) => {
        const u = new URL(item.url);
        u.pathname = u.pathname.replace(/\/+$/, "") || "/";
        return { ...item, url: u.href };
      },
    }),
  ],
  markdown: {
    rehypePlugins: [rehypeSanitize],
  },
});
