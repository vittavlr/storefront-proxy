# Storefront — products, requests, purchase history, admin panel

Same architecture as before, nothing in your billing app touched:

    [storefront website]  →  [proxy server]  →  [your billing app]

## What's new in this version
- **Product requests**: customers pick quantities on the Products page
  and submit a request (name, phone, address, notes). Stored by the
  proxy, not sent anywhere near your billing app.
- **Admin panel**: a password-protected "Admin" tab where you can edit
  the homepage's shop details (name, tagline, phone, hours, address)
  and see/manage incoming requests (mark seen/confirmed/done/cancelled).
- Products (live stock) and My Purchases (phone lookup → real invoices)
  work exactly as before.

## Setup (same as before, plus one new value)

### 1. Proxy (`proxy/`)
cd proxy
cp .env.example .env   # fill in all SEVEN values now (added ADMIN_PASSWORD)
npm install
npm start

Deploy to Render (or wherever you already have it running) — just add
the new `ADMIN_PASSWORD` environment variable there too.

### 2. Storefront (`ordering-site/index.html`)
Set `PROXY_BASE` near the top of the script, same as before. Shop
details are no longer hardcoded here — set them once from the Admin
tab after deploying, and they'll load for every visitor.

### Using the admin panel
Open the site → scroll to the bottom of the Home page → "Admin login"
→ enter the `ADMIN_PASSWORD` you set. From there you can edit shop
details and review/update incoming requests.

## Important: where data lives
Requests and site content are stored in a JSON file on the proxy's
own disk (`proxy/data/`) — separate from your billing database
entirely. On most free hosts (Render included), this survives normal
restarts and sleep/wake cycles, but **resets when you redeploy the
proxy** (a fresh build starts with a fresh disk). For a small shop
checking in occasionally this is usually fine; if you outgrow it or
need it to survive redeploys, say so and this can be swapped for a
tiny real database instead.
