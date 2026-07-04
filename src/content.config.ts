import { defineCollection, z } from "astro:content";
import { glob } from "astro/loaders";

const tipoEnum = z.enum([
  "aperitivo",
  "ristorante",
  "cocktail-bar",
  "wine-bar",
  "bistrot",
  "trattoria",
  "pizzeria",
  "caffetteria",
  "altro",
]);

const sentimentEnum = z.enum([
  "entusiasta",
  "positivo",
  "neutro",
  "tiepido",
  "critico",
]);

const visita = z.object({
  data: z.string(),
  post_url: z.string().url(),
  caption: z.string(),
  foto: z.array(z.string()).default([]),
  issue: z.number().int().optional(),
  fonte_tipo: z.enum(["singola", "lista"]).default("singola"),
});

const locali = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./content/locali" }),
  schema: z.object({
    slug: z.string(),
    nome: z.string(),
    zona: z.string().nullable(),
    indirizzo: z.string().nullable().optional(),
    citta: z.string().default("Milano"),
    tipo: z.array(tipoEnum).min(1),
    fascia_prezzo: z.enum(["€", "€€", "€€€", "€€€€", "€€€€€"]).nullable().optional(),
    piatti_drink_citati: z.array(z.string()).default([]),
    sentiment: sentimentEnum.nullable().optional(),
    voto_dedotto: z.number().min(1).max(5).nullable().optional(),
    sponsorizzato: z.boolean().default(false),
    visite: z.array(visita).min(1),
    ultima_estrazione: z.string().optional(),
  }),
});

export const collections = { locali };
