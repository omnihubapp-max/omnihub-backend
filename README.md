# OmniHub Backend — organized & fixed

This folder was reorganized from a flat pile of 20+ files into the structure
`render.yaml`, `package.json`, and `docs/DeployGuide.html` already assumed.

## What changed

**1. Files sorted into the folders the code already expected**
Every route/service file `require()`s its neighbors using paths like
`../security/security` or `../services/PaymentService`. Those paths only
work if the files sit in matching folders, so everything was moved into:

```
server.js            ← entry point (was server_final.js — see below)
rewards.js            ← CoinService / HolidayService (fixed, see below)
package.json  render.yaml  .env.example
ai/            AIAssistant.js, aiRoutes.js
security/      security.js
monitoring/    monitoring.js
notifications/ pushService.js, notifRoutes.js
engagement/    engagement.js
ussd/          ussd.js
routes/        paymentRoutes.js, kycRoutes.js, marketRoutes.js
services/      PaymentService.js
webhook/       webhookRoutes.js
db/            schema.sql, payment_schema.sql, schema_additions.sql
uploads/kyc/   (empty — KYC images land here)
legacy/        older/superseded files, kept for reference only
```

**2. Picked one server file, archived the rest**
You had two full server implementations: `server.js` (simple, Bingo-only)
and `server_final.js` (integrates security, monitoring, payments, KYC, AI,
USSD, notifications — everything). `server_final.js` is clearly the
intended production entry point, so it's now `server.js`. The old simple
one, plus `BingoServer.js`, `BingoEngine.js`, and `TMA_server.js` (earlier
drafts/alternates that nothing else requires), moved to `legacy/` — not
deleted, just out of the way.

**3. Fixed `rewards.js` — this would have crashed on boot**
The original `omnihub-rewards.js` was written in ESM (`import`/`export`)
while every other file uses CommonJS (`require`/`module.exports`), and it
called `await redis.connect()` at the top of the file. Since neither
`render.yaml` nor `package.json` provision Redis, requiring it would have
thrown immediately. I rewrote it as CommonJS with the exact same coin/holiday
logic, but backed by a small in-memory TTL cache instead of Redis. Everything
else — daily limits, streak bonuses, holiday multipliers, the midnight sweep
cron — is unchanged. If you later add a real Redis instance, swap the
`cache` object near the top of the file for a real client; every call site
already uses the same `get`/`set`/`setEx` shape.

I also wired `rewards.js`'s `startCronJobs()` into `server.js`'s startup
sequence — it was exported but never called anywhere.

**4. Created the missing `routes/marketRoutes.js`**
`server.js` does `require('./routes/marketRoutes')` and mounts it at
`/api/market`, and the deploy guide's file tree lists it — but the file
itself wasn't in your upload. Without it the server would crash on boot.
I added a basic working version (listing CRUD + coin-based purchase,
creates its own table on first use) so the app runs, but you should treat
it as a placeholder to design properly once you decide what the marketplace
actually sells.

**5. Added the missing `sharp` dependency**
`routes/kycRoutes.js` uses `sharp` (for image processing) but it wasn't in
`package.json`. Added it.

**6. Added `.env.example`**
Built from the env vars `render.yaml` already references, so local setup is
`cp .env.example .env` instead of guessing variable names.

## Verified

- Every file passes `node -c` (syntax check).
- I traced every `require()` path by hand against the new folder layout —
  they all resolve correctly (`server.js` → `ai/`, `security/`,
  `monitoring/`, `notifications/`, `engagement/`, `ussd/`, `routes/`,
  `webhook/`, `services/`, `rewards.js`).
- I boot-tested `server.js` (with stubbed npm packages, since this
  environment has no internet access to actually `npm install`) — it loads
  every module, registers all cron jobs, and starts listening without
  errors.

## Before you deploy

- Run `npm install` (needs internet access, which I don't have here).
- Set up `.env` (copy `.env.example`) or the equivalent Render env vars.
- Run `npm run db:schema`, then `npm run db:payments`, then
  `npm run db:additions` against your Postgres database.
- Decide what `routes/marketRoutes.js` should really do — the current
  version is functional but minimal.
- `render.yaml` doesn't provision Redis, and `rewards.js` no longer needs
  it — fine for a single server instance; if you scale to multiple
  instances later, the in-memory cache won't be shared across them and
  you'd want real Redis at that point.

Frontend (`omnihub-frontend/`) hasn't been touched yet — let me know when
you want that one organized too.
