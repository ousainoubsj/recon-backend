# recon-backend

Express/Node.js backend for the Transaction Reconciliation app. Handles auth (Better Auth), file relay to Cloudflare R2, and report persistence (Prisma/Postgres) — it never processes transaction data itself.

Plain JavaScript (ESM, `"type": "module"`) — matches `Fixed-Asset-Register-Backend` / `Datafin-HRMS-Docs-And-Backend`, not the spec's TypeScript code samples.

## Setup

```bash
npm install
cp .env.example .env   # then fill in DATABASE_URL, BETTER_AUTH_SECRET, R2_*, RESEND_API_KEY
npx prisma migrate dev --name init
npm run dev
```

Better Auth needs its own `Session` / `Account` / `Verification` models in `prisma/schema.prisma` in addition to the `User` model already there. After `npm install`, run:

```bash
npx @better-auth/cli generate
```

and re-run `npx prisma migrate dev` once those are merged in.

## Structure

- `app.js` — bootstrap only: loads `.env` via `dotenv.config()`, then dynamically imports `server.js` and starts listening (see the comment in that file for why dotenv needs the dynamic import)
- `server.js` — the actual Express app: middleware stack, route mounting, global error handler
- `auth.js` — Better Auth config (session cookies, not JWT)
- `routes/` — `auth.js` (Better Auth catch-all), `files.js` (R2 presign), `reports.js` (CRUD + export + email)
- `middleware/` — `authenticate.js`, `validate.js`, `rateLimit.js`
- `services/reportService.js` — Prisma transaction for saving a report + its rows
- `utils/catchAsync.js` — wraps async route handlers so a rejected promise reaches the error handler (same idiom as FAR/HRMS)
- `types/` — JSDoc `@typedef`s only (erased at runtime, editor-hint purposes), mirrored manually with `recon-frontend/lib/types/`
- `prisma/schema.prisma` — see the header comment for two deliberate deviations from the spec's raw SQL

## Known gaps (scaffold, not yet implemented)

- No local Postgres is wired up — point `DATABASE_URL` at whatever instance you're using (local, Docker, or a dev DB on DigitalOcean).
- `report_rows.amount_diff` is computed in `reportService.js` rather than as a true Postgres `GENERATED ALWAYS AS` column.
- No test files exist yet; `jest` is installed but ESM + Jest needs `NODE_OPTIONS=--experimental-vm-modules` (or swap to `node --test`, which has native ESM support) — worth deciding before writing the first test.
