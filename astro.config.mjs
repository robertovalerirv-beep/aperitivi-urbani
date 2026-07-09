import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import rehypeSanitize from "rehype-sanitize";

export default defineConfig({
  site: "https://aperitivi-urbani.pages.dev",
  trailingSlash: "ignore",
  output: "static",
  adapter: cloudflare({
    platformProxy: { enabled: true },
  }),
  markdown: {
    rehypePlugins: [rehypeSanitize],
  },
});
