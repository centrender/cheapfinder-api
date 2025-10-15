// src/server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import pino from "pino";
import { etsySearch } from "./sources/etsy.js";
import { mountEtsyOAuth } from "./oauth_etsy.js";

dotenv.config();

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8080;
const NODE_ENV = process.env.NODE_ENV || "production";
const MOCK_MODE = String(process.env.MOCK_MODE || "true").toLowerCase() === "true";

const logger =
  NODE_ENV === "development"
    ? pino({ transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } }, level: "info" })
    : pino({ level: "info" });

const app = express();
app.use(cors());
app.use(express.json());

// --- Simple IP rate limiter (no deps): 30 req/min/IP ---
const hits = new Map(); // ip -> { count, ts }
const WINDOW_MS = 60_000;
const MAX_REQ = 30;
app.use((req, res, next) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const rec = hits.get(ip);
    if (!rec || now - rec.ts > WINDOW_MS) {
      hits.set(ip, { count: 1, ts: now });
      return next();
    }
    if (rec.count >= MAX_REQ) return res.status(429).json({ error: "Rate limit exceeded. Try again in a minute." });
    rec.count += 1;
    next();
  } catch {
    next();
  }
});

// ---- OAuth helper routes
mountEtsyOAuth(app);

// ---- health
app.get("/health", (_req, res) => res.json({ ok: true, env: NODE_ENV, mock: MOCK_MODE }));

// ---- utils
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v, d = "") => (typeof v === "string" && v.trim() ? v.trim() : d);
const landed = (p, s, t) => Math.round((p + s + t) * 100) / 100;

// ---- mock
function mockItemsForQuery(q) {
  const base = [
    { source: "Etsy", title: `${q} Alpha`, seller: "Shop 111", rating: 4.7, reviews: 120, variant: "Default", price: 19.99, shipping: 4.99, estimated_tax: 0, eta_days: 3, listing_url: "https://etsy.com/listing/1" },
    { source: "Shopify (Aggregator)", title: `${q} Beta`, seller: "Brand X", rating: 4.6, reviews: 803, variant: "Default", price: 27, shipping: 9, estimated_tax: 0, eta_days: 5, listing_url: "https://brandx.com/products/beta" },
    { source: "Etsy", title: `${q} Gamma`, seller: "Shop 222", rating: 4.4, reviews: 52, variant: "Default", price: 16, shipping: 6.49, estimated_tax: 0, eta_days: 6, listing_url: "https://etsy.com/listing/2" },
    { source: "Shopify (Curated)", title: `${q} Delta`, seller: "Brand Y", rating: 4.8, reviews: 431, variant: "Default", price: 31, shipping: 0, estimated_tax: 0, eta_days: 4, listing_url: "https://brandy.com/products/delta" }
  ];
  return base.map(it => ({ ...it, landed_price: landed(it.price, it.shipping, it.estimated_tax) }));
}

// ---- orchestrator
async function searchAllSources({ q, zip, minRating, minReviews, maxPrice, sourcesCsv, limit }) {
  const allow = new Set((sourcesCsv || "etsy,shopify_agg,shopify_curated").split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
  let items = [];

  const canEtsy = !MOCK_MODE && process.env.ETSY_API_KEY && process.env.ETSY_ACCESS_TOKEN && allow.has("etsy");
  if (canEtsy) {
    try {
      items.push(...await etsySearch({ q, limit }));
    } catch (e) {
      logger.warn({ msg: "etsySearch failed; falling back to mock", err: String(e) });
    }
  }

  if (allow.has("shopify_agg") || allow.has("shopify_curated")) {
    items.push(...mockItemsForQuery(q).filter(it => it.source.toLowerCase().includes("shopify")));
  }

  if (items.length === 0) items = mockItemsForQuery(q);

  if (minRating > 0) items = items.filter(it => num(it.rating, 0) >= minRating);
  if (minReviews > 0) items = items.filter(it => num(it.reviews, 0) >= minReviews);
  if (maxPrice > 0) items = items.filter(it => num(it.price, 0) <= maxPrice);

  items = items.map(it => ({ ...it, landed_price: num(it.landed_price, landed(num(it.price,0), num(it.shipping,0), num(it.estimated_tax,0))) }));
  items.sort((a,b) =>
    (num(a.landed_price)-num(b.landed_price)) ||
    (num(b.rating)-num(a.rating)) ||
    (num(b.reviews)-num(a.reviews)) ||
    (num(a.eta_days,999)-num(b.eta_days,999))
  );

  return items.slice(0, limit);
}

// ---- /search
app.get("/search", async (req, res) => {
  try {
    const q = str(req.query.q); if (!q) return res.status(400).json({ error: "Missing q" });
    const zip = str(req.query.zip, "90001");
    const limit = Math.max(1, Math.min(100, num(req.query.limit, 10)));
    const minRating = num(req.query.minRating, 0);
    const minReviews = num(req.query.minReviews, 0);
    const maxPrice = num(req.query.maxPrice, 0);
    const sourcesCsv = str(req.query.sources, "etsy,shopify_agg,shopify_curated");

    const items = await searchAllSources({ q, zip, minRating, minReviews, maxPrice, sourcesCsv, limit });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: "Internal error" });
  }
});

app.listen(PORT, () => logger.info(`CheapFinder v3 on http://localhost:${PORT}`));
