/**
 * Storefront proxy — talks to your EXISTING billing API (read-only) for
 * products and invoices, across TWO businesses in that same billing
 * account, and separately stores each business's own site content and
 * incoming product requests. Nothing in your billing app's codebase is
 * touched by any of this.
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
  BUSINESSES,       // "key:businessId:Display Name|key2:businessId2:Display Name 2"
  STAFF_EMAIL,
  STAFF_PASSWORD,
  ALLOWED_ORIGIN,
  ADMIN_PASSWORD,
  SUPABASE_URL,          // optional: when set with the key below, orders and site text live in Supabase
  NOTIFY_URL,            // optional: the Universe notify-events function address, for push notifications
  NOTIFY_SECRET,         // optional: the same WEBHOOK_SECRET that function uses. Server side only.
  SUPABASE_SERVICE_KEY,  // optional, server side only. Never put this in an app or in GitHub.
  PORT = 4100,
} = process.env;

for (const [k, v] of Object.entries({ BILLING_API_BASE, BILLING_CLIENT_URL, BUSINESSES, STAFF_EMAIL, STAFF_PASSWORD, ALLOWED_ORIGIN, ADMIN_PASSWORD })) {
  if (!v) { console.error(`Missing required env var: ${k}`); process.exit(1); }
}

// ---- parse the business list ----
// Each entry: key:businessId:Display Name — the FIRST one listed is the
// default/main business shown when nothing else is specified.
const BUSINESS_LIST = BUSINESSES.split("|").map((entry) => {
  const [key, businessId, ...nameParts] = entry.split(":");
  return { key: key.trim(), businessId: businessId.trim(), name: nameParts.join(":").trim() };
});
if (!BUSINESS_LIST.length) { console.error("BUSINESSES env var is empty"); process.exit(1); }
const DEFAULT_BUSINESS_KEY = BUSINESS_LIST[0].key;

function resolveBusiness(key) {
  return BUSINESS_LIST.find((b) => b.key === key) || BUSINESS_LIST.find((b) => b.key === DEFAULT_BUSINESS_KEY);
}

// ---- auth against the existing billing API (no changes to it needed) ----
// One staff login, shared across both businesses (the same staff account
// must have access to both inside your billing app).
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
async function billingFetch(businessId, path, opts = {}) {
  let t = await token();
  let res = await doFetch(t);
  if (res.status === 401) { t = await login(); res = await doFetch(t); }
  if (!res.ok) throw new Error(`Billing API ${path} failed (${res.status})`);
  return res.json();
  function doFetch(tok) {
    return fetch(`${BILLING_API_BASE}${path}`, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${tok}`, "x-business-id": businessId },
    });
  }
}

// ---- tiny on-disk JSON storage for content + requests, ONE SET PER BUSINESS ----
// NOTE: on most free hosts (Render included) this file resets whenever
// you redeploy the proxy (new build = fresh disk). It survives normal
// restarts/sleep-wake fine. If you need edits to survive redeploys too,
// say so and this can be swapped for a small real database later.
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
function contentFile(key) { return path.join(DATA_DIR, `content-${key}.json`); }
function requestsFile(key) { return path.join(DATA_DIR, `requests-${key}.json`); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, data) { fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ---- push notifications (optional) ----
// With NOTIFY_URL and NOTIFY_SECRET set, a new order alerts the staff phones and a status change alerts the customer's
// phone, through the Universe app's notify-events function. Without them nothing changes. A failure here never
// affects the order itself.
function notify(event) {
  if (!NOTIFY_URL || !NOTIFY_SECRET) return;
  fetch(NOTIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-webhook-secret": NOTIFY_SECRET },
    body: JSON.stringify(event),
    signal: AbortSignal.timeout(8000),
  }).catch((e) => console.error("Notify failed:", e.message));
}

// ---- storage layer -------------------------------------------------
// With SUPABASE_URL + SUPABASE_SERVICE_KEY set, requests and site text are
// kept in Supabase (they survive redeploys). Without them, everything
// works exactly as before using the JSON files above.
const USE_DB = Boolean(SUPABASE_URL && SUPABASE_SERVICE_KEY);
const DB = USE_DB ? SUPABASE_URL.replace(/\/+$/, "") + "/rest/v1" : "";
async function db(pathAndQuery, { method = "GET", body, prefer } = {}) {
  const res = await fetch(DB + pathAndQuery, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${pathAndQuery.split("?")[0]} failed (${res.status}) ${(await res.text()).slice(0, 200)}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
const fromRow = (r) => ({
  id: r.id, code: r.code, name: r.name, phone: r.phone, address: r.address, notes: r.notes,
  items: r.items, status: r.status, createdAt: r.created_at,
});
const toRow = (biz, e) => ({
  id: e.id, business: biz, code: e.code, name: e.name, phone: e.phone, address: e.address,
  notes: e.notes, items: e.items, status: e.status, created_at: e.createdAt,
});
const enc = encodeURIComponent;

async function listRequests(biz) {
  if (!USE_DB) return readJson(requestsFile(biz), []);
  const rows = await db(`/shop_requests?business=eq.${enc(biz)}&order=created_at.desc&limit=500`);
  return rows.map(fromRow);
}
async function listRequestsByPhone(biz, last10) {
  if (!USE_DB) {
    return readJson(requestsFile(biz), []).filter((r) => (r.phone || "").replace(/\D/g, "").endsWith(last10)).slice(0, 50);
  }
  return (await listRequests(biz)).filter((r) => (r.phone || "").replace(/\D/g, "").endsWith(last10)).slice(0, 50);
}
async function addRequest(biz, entry) {
  if (!USE_DB) {
    const all = readJson(requestsFile(biz), []);
    all.unshift(entry);
    writeJson(requestsFile(biz), all.slice(0, 500));
    return;
  }
  await db("/shop_requests", { method: "POST", body: toRow(biz, entry), prefer: "return=minimal" });
}
async function getRequest(biz, id) {
  if (!USE_DB) return readJson(requestsFile(biz), []).find((r) => r.id === id) || null;
  const rows = await db(`/shop_requests?business=eq.${enc(biz)}&id=eq.${enc(id)}&limit=1`);
  return rows[0] ? fromRow(rows[0]) : null;
}
async function saveRequest(biz, entry) {
  if (!USE_DB) {
    const all = readJson(requestsFile(biz), []);
    const i = all.findIndex((r) => r.id === entry.id);
    if (i !== -1) all[i] = entry;
    writeJson(requestsFile(biz), all);
    return;
  }
  await db(`/shop_requests?business=eq.${enc(biz)}&id=eq.${enc(entry.id)}`, { method: "PATCH", body: { status: entry.status, items: entry.items }, prefer: "return=minimal" });
}
async function removeRequest(biz, id) {
  if (!USE_DB) {
    const all = readJson(requestsFile(biz), []);
    const next = all.filter((r) => r.id !== id);
    if (next.length === all.length) return false;
    writeJson(requestsFile(biz), next);
    return true;
  }
  const rows = await db(`/shop_requests?business=eq.${enc(biz)}&id=eq.${enc(id)}`, { method: "DELETE", prefer: "return=representation" });
  return Array.isArray(rows) && rows.length > 0;
}
async function readContent(biz, fallback) {
  if (!USE_DB) return readJson(contentFile(biz), fallback);
  const rows = await db(`/shop_content?business=eq.${enc(biz)}&limit=1`);
  return rows[0] ? rows[0].data : fallback;
}
async function writeContent(biz, data) {
  if (!USE_DB) return writeJson(contentFile(biz), data);
  await db("/shop_content?on_conflict=business", { method: "POST", body: { business: biz, data, updated_at: new Date().toISOString() }, prefer: "resolution=merge-duplicates,return=minimal" });
}

// One-time copy of anything already on the disk into an empty Supabase table,
// so nothing that exists today is lost when you switch over.
async function importOldFiles() {
  if (!USE_DB) return;
  for (const b of BUSINESS_LIST) {
    try {
      const have = await db(`/shop_requests?business=eq.${enc(b.key)}&select=id&limit=1`);
      const old = readJson(requestsFile(b.key), []);
      if (!have.length && old.length) {
        await db("/shop_requests?on_conflict=id", { method: "POST", body: old.map((e) => toRow(b.key, e)), prefer: "resolution=ignore-duplicates,return=minimal" });
        console.log(`Imported ${old.length} old requests for ${b.key}`);
      }
      const hasContent = await db(`/shop_content?business=eq.${enc(b.key)}&select=business&limit=1`);
      const oldContent = readJson(contentFile(b.key), null);
      if (!hasContent.length && oldContent) await writeContent(b.key, oldContent);
    } catch (e) { console.error("Import skipped for", b.key, e.message); }
  }
}

// Sensible starting content per business, shown until the owner edits it
// from Admin. Known businesses get real contact details; anything else
// (a business added later) gets a plain, honest placeholder instead of
// a blank footer.
const KNOWN_CONTENT = {
  rice: {
    tagline: "Sugar and Rice at Best Price!",
    phone: "+91 97516 55590",
    email: "srivenkateshwara20030@gmail.com",
    address: "15, Arni Road, Thuthipet, Vellore, Tamilnadu - 632011.",
  },
  gas: {
    tagline: "Reliable gas cylinder delivery",
    phone: "+91 97516 55590",
    email: "srivenkateshwara20030@gmail.com",
    address: "15, Arni Road, Thuthipet, Vellore, Tamilnadu - 632011.",
  },
};
function defaultContentFor(biz) {
  const known = KNOWN_CONTENT[biz.key] || {};
  return {
    name: biz.name,
    tagline: known.tagline || "",
    phone: known.phone || "",
    email: known.email || "",
    hours: "Mon–Sat 8am–8pm · Sun 8am–1pm",
    address: known.address || "",
  };
}

function requireAdmin(req, res, next) {
  if (req.get("x-admin-password") !== ADMIN_PASSWORD) return res.status(401).json({ error: "Wrong admin password" });
  next();
}

// Resolves ?business=<key> on every route into req.biz, defaulting to
// the main business when the query param is missing or unrecognized.
function withBusiness(req, res, next) {
  req.biz = resolveBusiness(req.query.business);
  next();
}

// ---------------------------------------------------------------------

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());
app.use(withBusiness);

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 200, standardHeaders: true, legacyHeaders: false });
app.use(limiter);
// Requests can be submitted more freely but still capped against abuse.
const requestLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

app.get("/health", (_req, res) => res.json({ ok: true }));

// Public list of businesses the storefront can switch between — only
// the key and display name are exposed, never the real billing ID.
app.get("/businesses", (_req, res) => {
  res.json(BUSINESS_LIST.map((b) => ({ key: b.key, name: b.name, default: b.key === DEFAULT_BUSINESS_KEY })));
});

// ---- live catalog ----
app.get("/products", async (req, res) => {
  try {
    const data = await billingFetch(req.biz.businessId, `/api/products?pageSize=100`);
    const products = (data.products || data.items || data).map((p) => ({
      id: p.id, name: p.name, unit: p.customUnitLabel || p.unit,
      price: Number(p.sellingPrice), stock: Number(p.currentStock),
      category: p.category?.name || "Other",
    }));
    res.json(products);
  } catch (err) { console.error(err); res.status(502).json({ error: "Could not load products right now" }); }
});

// ---- purchase history by phone ----
app.get("/invoices", async (req, res) => {
  try {
    const digits = String(req.query.phone || "").replace(/\D/g, "");
    const last10 = digits.slice(-10);
    if (last10.length < 6) return res.json([]);
    const customerData = await billingFetch(req.biz.businessId, `/api/customers?search=${encodeURIComponent(last10)}&pageSize=50`);
    const customers = (customerData.customers || customerData.items || customerData)
      .filter((c) => (c.phone || "").replace(/\D/g, "").endsWith(last10));
    const results = [];
    for (const c of customers) {
      const invData = await billingFetch(req.biz.businessId, `/api/invoices?customerId=${c.id}&pageSize=50`);
      for (const inv of invData.invoices || []) {
        if (inv.status === "DRAFT") continue;
        let shareUrl = null;
        try { const share = await billingFetch(req.biz.businessId, `/api/invoices/${inv.id}/share`, { method: "POST" }); shareUrl = `${BILLING_CLIENT_URL}${share.path}`; } catch {}
        results.push({ invoiceNumber: inv.invoiceNumber, date: inv.invoiceDate, total: Number(inv.total), balanceDue: Number(inv.balanceDue), status: inv.status, shareUrl });
      }
    }
    results.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(results.slice(0, 50));
  } catch (err) { console.error(err); res.status(502).json({ error: "Could not look that up right now" }); }
});

// ---- editable site content (per business) ----
app.get("/content", async (req, res) => {
  try { res.json(await readContent(req.biz.key, defaultContentFor(req.biz))); }
  catch (err) { console.error(err); res.status(502).json({ error: "Could not load content right now" }); }
});
app.post("/content", requireAdmin, async (req, res) => {
  try {
    const merged = { ...defaultContentFor(req.biz), ...(await readContent(req.biz.key, {})), ...req.body };
    await writeContent(req.biz.key, merged);
    res.json(merged);
  } catch (err) { console.error(err); res.status(502).json({ error: "Could not save content right now" }); }
});

// ---- product requests (customer submits, admin reviews) — per business ----
app.post("/requests", requestLimiter, async (req, res) => {
  const { name, phone, address, notes, items } = req.body || {};
  if (!name || !phone || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "name, phone and at least one item are required" });
  }
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
  try {
    await addRequest(req.biz.key, entry);
    notify({ type: "SHOP_ORDER", business: req.biz.key, code: entry.code });
    res.status(201).json({ code: entry.code });
  } catch (err) { console.error(err); res.status(502).json({ error: "Could not save your request right now" }); }
});

app.get("/requests", requireAdmin, async (req, res) => {
  try { res.json(await listRequests(req.biz.key)); }
  catch (err) { console.error(err); res.status(502).json({ error: "Could not load requests right now" }); }
});

// Public: a customer looking up their own requests by phone number —
// same trust model as the /invoices lookup (matches last 10 digits).
// Only returns what the customer themselves submitted, never admin-only fields.
app.get("/my-requests", async (req, res) => {
  const digits = String(req.query.phone || "").replace(/\D/g, "");
  const last10 = digits.slice(-10);
  if (last10.length < 6) return res.json([]);
  try {
    const mine = (await listRequestsByPhone(req.biz.key, last10))
      .map((r) => ({ id: r.id, code: r.code, items: r.items, status: r.status, createdAt: r.createdAt }));
    res.json(mine);
  } catch (err) { console.error(err); res.status(502).json({ error: "Could not look that up right now" }); }
});

const ALLOWED_STATUS = ["new", "seen", "confirmed", "done", "cancelled"];

// Two ways to call this:
//  - { status }                          → sets the whole request's status
//  - { status, itemIndex, part }         → sets ONE part of ONE item:
//        part "stock" = the quantity taken from stock
//        part "extra" = the extra quantity beyond stock
app.patch("/requests/:id", requireAdmin, async (req, res) => {
  try {
    const entry = await getRequest(req.biz.key, req.params.id);
    if (!entry) return res.status(404).json({ error: "Not found" });

    const { status, itemIndex, part } = req.body || {};
    let changed = false;
    if (!ALLOWED_STATUS.includes(status)) return res.status(400).json({ error: "Invalid status" });

    if (itemIndex !== undefined) {
      const item = entry.items[Number(itemIndex)];
      if (!item) return res.status(400).json({ error: "No such item" });
      if (part === "stock") item.stockStatus = status;
      else if (part === "extra" && item.extra > 0) item.extraStatus = status;
      else return res.status(400).json({ error: "Invalid part" });
    } else {
      changed = entry.status !== status;
      entry.status = status;
    }
    await saveRequest(req.biz.key, entry);
    if (changed && status !== "new") notify({ type: "SHOP_STATUS", business: req.biz.key, phone: entry.phone, status, code: entry.code });
    res.json(entry);
  } catch (err) { console.error(err); res.status(502).json({ error: "Could not save that change right now" }); }
});

app.delete("/requests/:id", requireAdmin, async (req, res) => {
  try {
    if (!(await removeRequest(req.biz.key, req.params.id))) return res.status(404).json({ error: "Not found" });
    res.json({ deleted: true });
  } catch (err) { console.error(err); res.status(502).json({ error: "Could not delete right now" }); }
});

app.listen(PORT, () => {
  console.log(`Storefront proxy listening on :${PORT} — businesses: ${BUSINESS_LIST.map(b=>b.key).join(", ")} — storage: ${USE_DB ? "Supabase" : "disk"}`);
  importOldFiles();
});
