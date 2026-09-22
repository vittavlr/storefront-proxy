/**
 * Storefront proxy — a small, separate server that logs into your
 * EXISTING billing API with a staff account and re-exposes two
 * read-only, phone-scoped endpoints for the public ordering site.
 *
 * This process is the only thing that ever holds your billing login
 * credentials or talks to your billing API directly. The public
 * storefront (index.html) only ever talks to THIS server.
 *
 * Nothing in your billing app's codebase needs to change.
 */
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const {
  BILLING_API_BASE,
  BILLING_CLIENT_URL,
  BUSINESS_ID,
  STAFF_EMAIL,
  STAFF_PASSWORD,
  ALLOWED_ORIGIN,
  PORT = 4100,
} = process.env;

for (const [k, v] of Object.entries({ BILLING_API_BASE, BILLING_CLIENT_URL, BUSINESS_ID, STAFF_EMAIL, STAFF_PASSWORD, ALLOWED_ORIGIN })) {
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
  // Access tokens are short-lived (15m by default); re-login well
  // before then instead of managing the httpOnly refresh cookie.
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
  if (res.status === 401) { t = await login(); res = await doFetch(t); } // token invalidated server-side — retry once
  if (!res.ok) throw new Error(`Billing API ${path} failed (${res.status})`);
  return res.json();

  function doFetch(tok) {
    return fetch(`${BILLING_API_BASE}${path}`, {
      ...opts,
      headers: {
        ...(opts.headers || {}),
        Authorization: `Bearer ${tok}`,
        "x-business-id": BUSINESS_ID,
      },
    });
  }
}

// ---------------------------------------------------------------------

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 200, standardHeaders: true, legacyHeaders: false });
app.use(limiter);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Live catalog with stock — read-only, no cost/margin fields forwarded.
app.get("/products", async (_req, res) => {
  try {
    const data = await billingFetch(`/api/products?pageSize=100`);
    const products = (data.products || data.items || data).map((p) => ({
      id: p.id,
      name: p.name,
      unit: p.customUnitLabel || p.unit,
      price: Number(p.sellingPrice),
      stock: Number(p.currentStock),
      category: p.category?.name || "Other",
    }));
    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Could not load products right now" });
  }
});

// A customer's own past orders, looked up by phone number.
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
        try {
          const share = await billingFetch(`/api/invoices/${inv.id}/share`, { method: "POST" });
          shareUrl = `${BILLING_CLIENT_URL}${share.path}`;
        } catch { /* share link is a nice-to-have, don't fail the whole request over it */ }
        results.push({
          invoiceNumber: inv.invoiceNumber,
          date: inv.invoiceDate,
          total: Number(inv.total),
          balanceDue: Number(inv.balanceDue),
          status: inv.status,
          shareUrl,
        });
      }
    }
    results.sort((a, b) => new Date(b.date) - new Date(a.date));
    res.json(results.slice(0, 50));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Could not look that up right now" });
  }
});

app.listen(PORT, () => console.log(`Storefront proxy listening on :${PORT}`));
