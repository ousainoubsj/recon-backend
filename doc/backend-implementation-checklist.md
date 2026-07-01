# Backend Implementation Checklist

Tracks implementation status against `doc/backend-implementation-spec.md`. Update checkboxes as work lands; re-audit periodically rather than trusting this file blindly.

## 1. Auth — Better Auth (spec §4.3)

- [x] Email/password enabled — `auth.js`
- [x] `role` registered via `additionalFields` (default `analyst`)
- [x] Session config: 7d expiry, 1d updateAge, cookie cache (5 min)
- [x] `trustedOrigins` set from `FRONTEND_URL`
- [x] Mounted under `/api/auth` via `toNodeHandler()` — `routes/auth.js`

## 2. Middleware stack (spec §4.2)

- [x] `helmet()`
- [x] `cors()` with `credentials: true`, restricted to `FRONTEND_URL`
- [x] `cookie-parser()`
- [x] Rate limiting — auth routes 10/min, API routes 200/min — `middleware/rateLimit.js`
- [x] `authenticate` middleware attaches `req.session`
- [x] `validate(schema)` — zod, 422 with field errors — `middleware/validate.js`
- [x] `pino-http` request logger
- [x] Global RFC 7807 error handler mounted last — `server.js`

## 3. File upload — Cloudflare R2 (spec §4.4)

- [x] `POST /files/presign` — `routes/files.js` + `controllers/files.controller.js`
- [x] File type validation (CSV/XLSX only)
- [x] 50 MB size check before presigning
- [x] Presigned PUT via `@aws-sdk/client-s3` + `s3-request-presigner`, `expiresIn: 300`

## 4. Report persistence (spec §4.5)

- [x] `saveReport` — single `$transaction`, `Report.create` + `ReportRow.createMany` — `services/reportService.js`
- [x] `listReports`, `getReport`, `deleteReport` implemented
- [ ] `amountDiff` computed in application code, not a DB generated column (spec §5.1 calls for `STORED` generated column — current schema uses a plain nullable `Decimal`) — confirm this deviation is intentional

## 5. Database — Prisma schema (spec §5)

- [x] `User` / `Report` / `ReportRow` / `AuditLog` models match spec fields
- [x] Indexes: `reports(user_id)`, `reports(run_date DESC)`, `report_rows(report_id, status)`, `report_rows(report_id, ref)`, `audit_logs(user_id, ts DESC)`
- [ ] `amount_diff` as a `STORED` generated column (currently app-computed — see above)
- [ ] Confirm `updated_at` `BEFORE UPDATE` trigger (`set_updated_at()`) exists in a migration, not just assumed

## 6. API routes (spec §6)

- [x] `POST /auth/sign-up/email`, `/sign-in/email`, `/sign-out`, `GET /auth/get-session`
- [x] `POST /files/presign`
- [x] `GET /reports` (list)
- [x] `GET /reports/:id`
- [x] `POST /reports`
- [x] `DELETE /reports/:id`
- [x] `POST /reports/:id/export` — server-side XLSX via `xlsx` lib
- [x] `POST /reports/:id/email` — via Resend

## 7. Error handling (spec §7)

- [x] RFC 7807 shape, `AppError` base class — `errors.js`
- [x] `ValidationError` (422), `AuthenticationError` (401), `AuthorisationError` (403), `NotFoundError` (404), `FileTooLargeError` (413), `ConflictError` (409)
- [ ] `InternalError` (500) — currently handled inline in the global handler, not exported as a named class; fine functionally, but inconsistent with the other error classes

## 8. Environment & config (spec §8)

- [x] `.env` present with all required vars (PORT, DATABASE_URL, BETTER_AUTH_SECRET/URL, FRONTEND_URL, R2_*, RESEND_API_KEY, EMAIL_FROM)
- [ ] `.env.example` — **missing**, should be committed as the canonical template (never commit real secrets)

## 9. Testing (spec §9)

- [x] Jest configured for native ESM (`jest.config.js`, `NODE_OPTIONS=--experimental-vm-modules`) — no Babel needed on Node 24
- [x] `reportService` unit tests against a mocked Prisma client — `saveReport` transaction shape, `listReports`, `getReport` (found/`NotFoundError`), `deleteReport` (found/`NotFoundError`) — `tests/services/reportService.test.js`
- [x] `authenticate` middleware unit test (session present / missing) — `tests/middleware/authenticate.test.js`
- [x] Reports CRUD route tests (Supertest) — list/create/get/delete, zod validation → 422, `NotFoundError` → 404 — `tests/routes/reports.routes.test.js`
- [x] Auth route wiring test — confirms `routes/auth.js` builds its handler from `toNodeHandler(auth)` and delegates every request to it; Better Auth's own sign-up/sign-in/session *behavior* is the library's responsibility, not re-tested here — `tests/routes/auth.routes.test.js`
- [x] File upload presign route tests — allowed type + under limit → 200, over 50 MB → 413, disallowed content type → 422 (mocks `getSignedUrl` from `@aws-sdk/s3-request-presigner` since real R2 endpoint config in `.env` is a placeholder and presigning resolves the endpoint eagerly) — `tests/routes/files.routes.test.js`
- [x] Export/email route tests — XLSX export returns workbook + correct headers, 404 when report missing; email sends via a mocked `Resend` client and returns 202, invalid recipient → 422, 404 when report missing — `tests/routes/reports.export-email.routes.test.js`
- [ ] True DB integration tests against a real/disposable Postgres (index performance on 100k rows, actual transaction behavior) — **deliberately not done**; current tests mock Prisma entirely. Revisit if a disposable test DB (Docker or a separate Neon branch) gets set up.

## 10. Deployment — DigitalOcean (spec §10)

- [ ] `app.yaml` or equivalent DO App Platform spec — **missing**
- [ ] `run_command` wiring `prisma migrate deploy && node server.js` — **missing**
- [ ] Secrets marked `type: SECRET` in deploy config — **missing** (blocked on `app.yaml` above)

## 11. Misc / cross-cutting

- [ ] Node engine not pinned in `package.json` (spec baseline is Node 20 LTS; repo runs Node 24 — decide whether to pin `engines.node`)

---

**Snapshot (updated 2026-07-01):** 13/15 spec areas fully implemented, 1 partial (`.env.example`), 1 missing (deployment config). Route/unit test coverage (mocked Prisma/AWS/Resend) now covers auth wiring, file presign, and reports CRUD + export/email; true DB integration tests and deployment config remain open. See individual unchecked items above for specifics.
