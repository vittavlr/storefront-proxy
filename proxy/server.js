/**
 * Storefront proxy — talks to your EXISTING billing API (read-only) for
 * products and invoices, and separately stores two small things of its
 * own on disk: editable site content, and incoming product requests.
 * Nothing in your billing app's codebase is touched by any of this.
 */
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  BILLING_API_BASE,
  BILLING_CLIENT_URL,
  BUSINESS_ID,
  STAFF_EMAIL,
  STAFF_PASSWORD,
  ALLOWED_ORIGIN,
  ADMIN_PASSWORD,
  PORT = 4100,
} = process.env;

for (const [k, v] of Object.entries({ BILLING_API_BASE, BILLING_CLIENT_URL, BUSINESS_ID, STAFF_EMAIL, STAFF_PASSWORD, ALLOWED_ORIGIN, ADMIN_PASSWORD })) {
  if (!v) { console.error(`Missing required env var: ${k}`); process.exit(1); }
}

// ---- auth against the existing billing API (no changes to it needed) ----
let session = { accessToken: null, expiresAt: 0 };

async function login() {
  const res = await fetch(`${BILLING_API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: STAFF_EMAIL, password: STAFF_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Billing login failed (${res.status})`);
  const data = await res.json();
  session = { accessToken: data.accessToken, expiresAt: Date.now() + 12 * 60 * 1000 };
  return session.accessToken;
}
async function token() {
  if (session.accessToken && Date.now() < session.expiresAt) return session.accessToken;
  return login();
}
async function billingFetch(path, opts = {}) {
  let t = await token();
  let res = await doFetch(t);
  if (res.status === 401) { t = await login(); res = await doFetch(t); }
  if (!res.ok) throw new Error(`Billing API ${path} failed (${res.status})`);
  return res.json();
  function doFetch(tok) {
    return fetch(`${BILLING_API_BASE}${path}`, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${tok}`, "x-business-id": BUSINESS_ID },
    });
  }
}

// ---- tiny on-disk JSON storage for content + requests ----
// NOTE: on most free hosts (Render included) this file resets whenever
// you redeploy the proxy (new build = fresh disk). It survives normal
// restarts/sleep-wake fine. If you need edits to survive redeploys too,
// say so and this can be swapped for a small real database later.
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const CONTENT_FILE = path.join(DATA_DIR, "content.json");
const REQUESTS_FILE = path.join(DATA_DIR, "requests.json");

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

const DEFAULT_CONTENT = {
  name: "Sri Amman Sugar and Rice Mandi",
  tagline: "Sugar and Rice at Best Price!",
  phone: "+91 97516 55590",
  email: "srivenkateshwara20030@gmail.com",
  hours: "Mon–Sat 8am–8pm · Sun 8am–1pm",
  address: "15, Arni Road, Thuthipet, Vellore, Tamilnadu - 632011.",
};

function requireAdmin(req, res, next) {
  if (req.get("x-admin-password") !== ADMIN_PASSWORD) return res.status(401).json({ error: "Wrong admin password" });
  next();
}

// ---------------------------------------------------------------------

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 200, standardHeaders: true, legacyHeaders: false });
app.use(limiter);
// Requests can be submitted more freely but still capped against abuse.
const requestLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- live catalog (unchanged) ----
app.get("/products", async (_req, res) => {
  try {
    const data = await billingFetch(`/api/products?pageSize=100`);
    const products = (data.products || data.items || data).map((p) => ({
      id: p.id, name: p.name, unit: p.customUnitLabel || p.unit,
      price: Number(p.sellingPrice), stock: Number(p.currentStock),
      category: p.category?.name || "Other",
    }));
    res.json(products);
  } catch (err) { console.error(err); res.status(502).json({ error: "Could not load products right now" }); }
});

// ---- purchase history by phone (unchanged) ----
app.get("/invoices", async (req, res) => {
  try {
    const digits = String(req.query.phone || "").replace(/\D/g, "");
    const last10 = digits.slice(-10);
    if (last10.length < 6) return res.json([]);
    const customerData = await billingFetch(`/api/customers?search=${encodeURIComponent(last10)}&pageSize=50`);
    const customers = (customerData.customers || customerData.items || customerData)
      .filter((c) => (c.phone || "").replace(/\D/g, "").endsWith(last10));
    const results = [];
    for (const c of customers) {
      const invData = await billingFetch(`/api/invoices?customerId=${c.id}&pageSize=50`);
      for (const inv of invData.invoices || []) {
        if (inv.status === "DRAFT") continue;
        let shareUrl = null;
        try { const share = await billingFetch(`/api/invoices/${inv.id}/share`, { method: "POST" }); shareUrl = `${BILLING_CLIENT_URL}${share.path}`; } catch {}
        results.push({ invoiceNumber: inv.invoiceNumber, date: inv.invoiceDate, total: Number(inv.total), balanceDue: Number(inv.balanceDue), status: inv.status, shareUrl });
      }
    }
    results.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(results.slice(0, 50));
  } catch (err) { console.error(err); res.status(502).json({ error: "Could not look that up right now" }); }
});

// ---- editable site content ----
app.get("/content", (_req, res) => res.json(readJson(CONTENT_FILE, DEFAULT_CONTENT)));
app.post("/content", requireAdmin, (req, res) => {
  const merged = { ...DEFAULT_CONTENT, ...readJson(CONTENT_FILE, {}), ...req.body };
  writeJson(CONTENT_FILE, merged);
  res.json(merged);
});

// ---- product requests (customer submits, admin reviews) ----
app.post("/requests", requestLimiter, (req, res) => {
  const { name, phone, address, notes, items } = req.body || {};
  if (!name || !phone || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "name, phone and at least one item are required" });
  }
  const all = readJson(REQUESTS_FILE, []);
  const entry = {
    id: crypto.randomUUID(),
    code: Math.random().toString(36).slice(2, 6).toUpperCase() + String(Date.now()).slice(-2),
    name: String(name).slice(0, 120),
    phone: String(phone).slice(0, 30),
    address: String(address || "").slice(0, 300),
    notes: String(notes || "").slice(0, 300),
    items: items
      .slice(0, 30)
      .map((it) => ({
        name: String(it.name || "").slice(0, 120),
        unit: String(it.unit || "").slice(0, 20),
        qty: Math.min(1e6, Math.max(0, Number(it.qty) || 0)),   // quantity taken from stock
        extra: Math.min(1e6, Math.max(0, Number(it.extra) || 0)), // extra beyond current stock (0 = none)
        // stockStatus / extraStatus stay unset until the admin marks them
        // individually; until then each follows the request's overall status.
      }))
      .filter((it) => it.qty > 0 || it.extra > 0),
    status: "new",
    createdAt: new Date().toISOString(),
  };
  if (!entry.items.length) {
    return res.status(400).json({ error: "at least one item with a quantity is required" });
  }
  all.unshift(entry);
  writeJson(REQUESTS_FILE, all.slice(0, 500));
  res.status(201).json({ code: entry.code });
});

app.get("/requests", requireAdmin, (_req, res) => res.json(readJson(REQUESTS_FILE, [])));

// Public: a customer looking up their own requests by phone number —
// same trust model as the /invoices lookup (matches last 10 digits).
// Only returns what the customer themselves submitted, never admin-only fields.
app.get("/my-requests", (req, res) => {
  const digits = String(req.query.phone || "").replace(/\D/g, "");
  const last10 = digits.slice(-10);
  if (last10.length < 6) return res.json([]);
  const all = readJson(REQUESTS_FILE, []);
  const mine = all
    .filter((r) => (r.phone || "").replace(/\D/g, "").endsWith(last10))
    .map((r) => ({ id: r.id, code: r.code, items: r.items, status: r.status, createdAt: r.createdAt }))
    .slice(0, 50);
  res.json(mine);
});

const ALLOWED_STATUS = ["new", "seen", "confirmed", "done", "cancelled"];

// Two ways to call this:
//  - { status }                          → sets the whole request's status
//  - { status, itemIndex, part }         → sets ONE part of ONE item:
//        part "stock" = the quantity taken from stock
//        part "extra" = the extra quantity beyond stock
app.patch("/requests/:id", requireAdmin, (req, res) => {
  const all = readJson(REQUESTS_FILE, []);
  const idx = all.findIndex((r) => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });

  const { status, itemIndex, part } = req.body || {};
  if (!ALLOWED_STATUS.includes(status)) return res.status(400).json({ error: "Invalid status" });

  if (itemIndex !== undefined) {
    const item = all[idx].items[Number(itemIndex)];
    if (!item) return res.status(400).json({ error: "No such item" });
    if (part === "stock") item.stockStatus = status;
    else if (part === "extra" && item.extra > 0) item.extraStatus = status;
    else return res.status(400).json({ error: "Invalid part" });
  } else {
    all[idx].status = status;
  }
  writeJson(REQUESTS_FILE, all);
  res.json(all[idx]);
});

app.delete("/requests/:id", requireAdmin, (req, res) => {
  const all = readJson(REQUESTS_FILE, []);
  const next = all.filter((r) => r.id !== req.params.id);
  if (next.length === all.length) return res.status(404).json({ error: "Not found" });
  writeJson(REQUESTS_FILE, next);
  res.json({ deleted: true });
});

app.listen(PORT, () => console.log(`Storefront proxy listening on :${PORT}`));
