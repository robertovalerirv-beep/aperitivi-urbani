import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  site: "https://aperitiviurbani.pages.dev",
  trailingSlash: "ignore",
  output: "static",
  adapter: cloudflare(),
});
