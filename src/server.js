// src/server.js
// CheapFinder v3 — minimal, Render-ready API (ESM)

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pino from "pino";
// keep this import; we stubbed it earlier to a no-op class
import { Analytics } from "./analytics.js";

// --- env / logger -----------------------------------------------------------
dotenv.config();

// Render (and most PaaS) set PORT in env; default to 8080 locally.
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const NODE_ENV = process.env.NODE_ENV || "production";
const MOCK_MODE = String(process.env.MOCK_MODE || "true").toLowerCase() === "true";
const ANALYTICS_ENABLED = String(process.env.ANALYTICS_ENABLED || "false").toLowerCase() === "true";

const logger =
  NODE_ENV === "development"
    ? pino({
        transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } },
        level: "info",
      })
    : pino({ level: "info" });

const analytics = new Analytics();

// --- app --------------------------------------------------------------------
const app = express();
app.use(cors());
app.use(express.json());

// --- health -----------------------------------------------------------------
app.get("/health", (_req, res) => {
  res.json({ ok: true, env: NODE_ENV, mock: MOCK_MODE });
});

// --- utils ------------------------------------------------------------------
function num(val, def = 0) {
  if (val === undefined || val === null || val === "") return def;
  const n = Number(val);
  return Number.isFinite(n) ? n : def;
}
function str(val, def = "") {
  return typeof val === "string" && val.trim() ? val.trim() : def;
}
function landed(price, shipping, estTax) {
  return Math.round((price + shipping + estTax) * 100) / 100;
}

// --- MOCK data (safe defaults) ----------------------------------------------
function mockItemsForQuery(q) {
  // Tiny deterministic mock set (works offline & for GPT “Test”)
  // You can extend this list or swap in real adapters when MOCK_MODE=false.
  const base = [
    {
      source: "Etsy",
      title: `${q} Alpha`,
      seller: "Shop 111",
      rating: 4.7,
      reviews: 120,
      variant: "Default",
      price: 19.99,
      shipping: 4.99,
      estimated_tax: 0,
      eta_days: 3,
      listing_url: "https://etsy.com/listing/1",
    },
    {
      source: "Shopify (Aggregator)",
      title: `${q} Beta`,
      seller: "Brand X",
      rating: 4.6,
      reviews: 803,
      variant: "Default",
      price: 27.0,
      shipping: 9.0,
      estimated_tax: 0,
      eta_days: 5,
      listing_url: "https://brandx.com/products/beta",
    },
    {
      source: "Etsy",
      title: `${q} Gamma`,
      seller: "Shop 222",
      rating: 4.4,
      reviews: 52,
      variant: "Default",
      price: 16.0,
      shipping: 6.49,
      estimated_tax: 0,
      eta_days: 6,
      listing_url: "https://etsy.com/listing/2",
    },
    {
      source: "Shopify (Curated)",
      title: `${q} Delta`,
      seller: "Brand Y",
      rating: 4.8,
      reviews: 431,
      variant: "Default",
      price: 31.0,
      shipping: 0.0,
      estimated_tax: 0,
      eta_days: 4,
      listing_url: "https://brandy.com/products/delta",
    },
  ];

  // add landed_price
  return base.map((it) => ({
    ...it,
    landed_price: landed(it.price, it.shipping, it.estimated_tax),
  }));
}

// --- real adapters (placeholder) --------------------------------------------
// When you’re ready, flip MOCK_MODE=false and implement real fetchers here.
// Keep signatures consistent: (q, zip, filters) => Promise<Item[]>
// For now, we only serve mock data.

async function searchAllSources({ q, zip, minRating, minReviews, maxPrice, sourcesCsv }) {
  let items = mockItemsForQuery(q);

  // Filter by sources if provided
  if (sourcesCsv) {
    const allow = new Set(
      sourcesCsv
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    );
    items = items.filter((it) => {
      const label = it.source.toLowerCase();
      return (
        (allow.has("etsy") && label.includes("etsy")) ||
        (allow.has("shopify_agg") && label.includes("aggregator")) ||
        (allow.has("shopify_curated") && label.includes("curated"))
      );
    });
  }

  // Apply filters
  if (minRating > 0) items = items.filter((it) => num(it.rating, 0) >= minRating);
  if (minReviews > 0) items = items.filter((it) => num(it.reviews, 0) >= minReviews);
  if (maxPrice > 0) items = items.filter((it) => num(it.price, 0) <= maxPrice);

  // Sort & tie-breaks: landed asc → rating desc → reviews desc → eta asc
  items.sort((a, b) => {
    const lp = num(a.landed_price) - num(b.landed_price);
    if (lp !== 0) return lp;
    const r = num(b.rating) - num(a.rating);
    if (r !== 0) return r;
    const rv = num(b.reviews) - num(a.reviews);
    if (rv !== 0) return rv;
    return num(a.eta_days) - num(b.eta_days);
  });

  // lightweight analytics (no-op by default)
  if (ANALYTICS_ENABLED) {
    try {
      await analytics.record({
        event: "search",
        q,
        zip,
        minRating,
        minReviews,
        maxPrice,
        sourcesCsv,
        count: items.length,
        ts: Date.now(),
      });
    } catch (e) {
      logger.warn({ msg: "analytics.record failed", err: String(e) });
    }
  }

  return items;
}

// --- /search ----------------------------------------------------------------
app.get("/search", async (req, res) => {
  try {
    const q = str(req.query.q);
    if (!q) return res.status(400).json({ error: "Missing required query param: q" });

    const zip = str(req.query.zip, "90001");
    const limit = Math.max(1, Math.min(100, num(req.query.limit, 10)));
    const minRating = num(req.query.minRating, 0);
    const minReviews = num(req.query.minReviews, 0);
    const maxPrice = num(req.query.maxPrice, 0);
    const sourcesCsv = str(req.query.sources, "etsy,shopify_agg,shopify_curated");

    const items = await searchAllSources({ q, zip, minRating, minReviews, maxPrice, sourcesCsv });

    res.json({ items: items.slice(0, limit) });
  } catch (err) {
    logger.error({ msg: "search failed", err: String(err) });
    res.status(500).json({ error: "Internal error" });
  }
});

// --- start ------------------------------------------------------------------
app.listen(PORT, () => {
  logger.info(`CheapFinder v3 on http://localhost:${PORT}`);
});

// --- safety -----------------------------------------------------------------
process.on("unhandledRejection", (reason) => {
  logger.error({ msg: "unhandledRejection", reason: String(reason) });
});
process.on("uncaughtException", (err) => {
  logger.error({ msg: "uncaughtException", err: String(err) });
});
