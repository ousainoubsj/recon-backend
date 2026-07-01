# Backend Implementation Spec

Extracted from `Reconciliation_App_Engineering_Spec.pdf` (rev 1.0, June 2026) — backend-relevant sections only. Source of truth is the PDF; this file is a working checklist for `recon-backend`.

## 1. Scope

The backend handles **auth, file relay, and report persistence only**. It does **not** process transaction data — all reconciliation matching runs client-side in the frontend so raw financial records never transit the network. Concretely, the backend is responsible for:

- Better Auth (email/password sessions, cookie-based)
- Issuing presigned PUT URLs for direct browser → Cloudflare R2 uploads
- Saving/retrieving/deleting reconciliation reports and their row-level results in PostgreSQL
- Resend email delivery (report export emails)

Out of scope for the backend (handled in `recon-frontend`): file parsing, the matching engine, CSV/XLSX export generation for the client-side flow.

## 2. Repo Structure (current, as implemented)

```
recon-backend/
├── controllers/         # files.controller.js, reports.controller.js
├── routes/               # auth.js, files.js, reports.js
├── middleware/           # authenticate.js, validate.js, rateLimit.js
├── db/                   # index.js — Prisma client
├── services/             # reportService.js
├── types/                # file.js, recon.js — shared shapes, mirrored manually in frontend
├── utils/                # catchAsync.js
├── generated/prisma/     # generated Prisma client (models/, internal/, client.ts, enums.ts, ...)
├── prisma/               # schema.prisma, migrations/
├── auth.js               # Better Auth config
├── app.js                # Express app assembly
├── server.js             # server entrypoint (listens, starts app)
├── errors.js             # error classes / RFC 7807 handler
├── prisma.config.js      # Prisma 7 config (driver adapters)
└── package.json
```

> Note: the spec's reference layout nests app code under `src/` (`src/routes/`, `src/middleware/`, etc.) and uses TypeScript. The current repo keeps these at the project root and uses plain JS instead of TS — functionally equivalent, just flattened. It also splits routing into thin `routes/` handlers plus `controllers/` for request logic, and adds `server.js` as a separate entrypoint from `app.js`, neither of which appear in the spec's reference layout.

## 3. Data Contracts the Backend Must Persist/Relay

These types are defined by the frontend but the backend's Prisma schema and DTOs must be shape-compatible:

```ts
type ReconStatus = 'matched' | 'mismatched' | 'unmatched_a' | 'unmatched_b' | 'duplicate';

interface ReconRow {
  ref: string;
  status: ReconStatus;
  amountA: number | null;
  amountB: number | null;
  amountDiff: number | null;
  dateA?: string | null;
  dateB?: string | null;
  rawA?: Record<string, unknown>;
  rawB?: Record<string, unknown>;
}

interface ReconSummary {
  total: number;
  matched: number;
  mismatched: number;
  unmatchedA: number;
  unmatchedB: number;
  duplicates: number;
  matchRate: number;
  totalBreakValue: number;
  durationMs: number;
}

// POST /api/reports request body
interface SaveReportDto {
  fileAName: string;
  fileBName: string;
  summary: ReconSummary;
  rows: ReconRow[];     // persisted to report_rows
  config: ReconConfig;  // tolerances used
}

// POST /api/auth/sign-in/email response (Better Auth)
interface AuthResponse {
  user: { id: string; email: string; name: string; role: Role };
  session: { id: string; expiresAt: string };
}
```

Session delivery: HttpOnly + Secure `Set-Cookie` (`better-auth.session_token`). **No bearer token in the response body.**

## 4. Backend Architecture

### 4.1 App structure
- Express app entry mounts route modules: `routes/auth.js` (Better Auth catch-all via `toNodeHandler`), `routes/reports.js` (list/save/get/delete), `routes/files.js` (presign).
- `authenticate` middleware applied to all protected routers; reads session via `auth.api.getSession()` and attaches `req.session`.

### 4.2 Middleware stack (apply globally in `app.js`)

| Middleware | Package | Notes |
|---|---|---|
| `helmet()` | helmet@7 | CSP, X-Frame-Options, HSTS, etc. |
| `cors()` | cors@2 | Restrict to `FRONTEND_URL`; `credentials: true` for cookie auth |
| `cookieParser()` | cookie-parser@1 | Reads Better Auth session cookie |
| rate limiter | express-rate-limit@7 | Auth routes: 10 req/min. API routes: 200 req/min per IP |
| `authenticate` | custom (Better Auth) | Validates session, attaches `req.session` |
| `validate(schema)` | zod@3 | Per-route schema; 422 with structured field errors on failure |
| request logger | pino-http@9 | Structured JSON in prod, pretty in dev |

### 4.3 Authentication — Better Auth

Configured once, mounted under `/api/auth`:

```js
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "./db";

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: { enabled: true },
  trustedOrigins: [process.env.FRONTEND_URL],
  session: {
    expiresIn: 60 * 60 * 24 * 7,   // 7 days
    updateAge: 60 * 60 * 24,        // refresh if older than 1 day
    cookieCache: { enabled: true, maxAge: 60 * 5 },
  },
});
```

> ⚠️ Better Auth's default user schema has **no `role` field**. Must register it via `additionalFields` on the user model, or `role` will not exist on `session.user`.

> ⚠️ `BETTER_AUTH_URL` must match the exact origin (including `https://`) in production. Better Auth validates origin on every request — a mismatch fails auth calls **silently**.

### 4.4 File Upload Handler — Cloudflare R2

Backend issues a presigned PUT URL; browser uploads **directly** to R2. Server never buffers file bytes.

```js
router.post('/presign', authenticate, async (req, res) => {
  const { filename, contentType, size } = req.body;
  if (size > 50 * 1024 * 1024)
    return res.status(413).json({ error: "File exceeds 50 MB limit" });

  const key = `uploads/${req.session.user.id}/${Date.now()}-${filename}`;
  const presignedUrl = await getSignedUrl(r2, new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    ContentType: contentType,
  }), { expiresIn: 300 });

  res.json({ url: presignedUrl, key });
});
```

- Presigned URLs expire in **5 minutes**.
- Validate file type (CSV/XLSX only) before issuing the URL.
- Max file size: **50 MB**.

### 4.5 Report Persistence — Prisma

`saveReport` must run as a single transaction: insert the `Report` row, then bulk-insert `ReportRow`s via `createMany`.

```js
export async function saveReport(userId, dto) {
  return prisma.$transaction(async (tx) => {
    const report = await tx.report.create({
      data: {
        userId,
        fileAName: dto.fileAName,
        fileBName: dto.fileBName,
        totalRows: dto.summary.total,
        matchedCount: dto.summary.matched,
        unmatchedCount: dto.summary.unmatchedA + dto.summary.unmatchedB,
        mismatchedCount: dto.summary.mismatched,
        duplicateCount: dto.summary.duplicates,
        amountTolerance: dto.config.amountTolerance,
        dateTolerance: dto.config.dateTolerance ?? null,
      },
    });
    await tx.reportRow.createMany({
      data: dto.rows.map(r => ({ reportId: report.id, ...r })),
    });
    return report;
  }).then(r => r.id);
}
```

## 5. Database Design

### 5.1 Tables

- **users** — `id (uuid pk)`, `email (unique)`, `password_hash`, `role` (`admin|analyst|viewer`, default `analyst`), `created_at`, `updated_at` (trigger-maintained).
- **reports** — `id`, `user_id (fk → users, cascade delete)`, `file_a_name`, `file_b_name`, `run_date`, `total_rows`, `matched_count`, `unmatched_count`, `mismatched_count`, `duplicate_count`, `amount_tolerance numeric(10,4)`, `date_tolerance_days`, `config jsonb` (full `ReconConfig` snapshot).
- **report_rows** — `id`, `report_id (fk → reports, cascade delete)`, `ref varchar(500)`, `status` (`matched|mismatched|unmatched_a|unmatched_b|duplicate`), `amount_a numeric(18,4)`, `amount_b numeric(18,4)`, `amount_diff` **generated column** (`amount_a - amount_b`, `STORED`), `date_a`, `date_b`, `raw_a jsonb`, `raw_b jsonb`.
- **audit_logs** — `id`, `user_id (fk → users)`, `action`, `entity_type`, `entity_id`, `ts`, `metadata jsonb`.

### 5.2 Indexes & constraints

```sql
CREATE INDEX idx_reports_user_id ON reports(user_id);
CREATE INDEX idx_reports_run_date ON reports(run_date DESC);
CREATE INDEX idx_rows_report_status ON report_rows(report_id, status);
CREATE INDEX idx_rows_ref ON report_rows(report_id, ref);
CREATE INDEX idx_audit_user_ts ON audit_logs(user_id, ts DESC);
```

`updated_at` on `users` is maintained via a `BEFORE UPDATE` trigger (`set_updated_at()`), not application code.

### 5.3 Migration strategy

- `prisma/schema.prisma` is the single source of truth; migrations live in `prisma/migrations/` and are committed.
- **Dev**: `prisma migrate dev --name <name>` (interactive).
- **Production**: `prisma migrate deploy` only — runs as a pre-deploy/run command before the server starts. **Never run `migrate dev` against production** (it can reset data).
- `prisma db push` is prototype/dev-only (no migration file generated).

> Project-specific note: this repo is now on **Prisma 7** (driver adapters + `prisma.config.js`), which postdates this spec revision (written against Prisma 5/6 conventions like schema-embedded `datasource.url`). The persistence model and migration commands above still apply; only the client wiring (`PrismaPg` adapter, `prisma.config.js`) differs from the spec's literal code samples.

## 6. API Reference

All routes prefixed `/api`. JSON throughout. Errors follow **RFC 7807** Problem Details.

| Method | Path | Description | Auth |
|---|---|---|---|
| POST | `/auth/sign-up/email` | Create account. Body: `{email, password, name}` | PUBLIC |
| POST | `/auth/sign-in/email` | Authenticate, sets session cookie | PUBLIC |
| POST | `/auth/sign-out` | Invalidate session cookie | AUTH |
| GET | `/auth/get-session` | Return current session | AUTH |
| POST | `/files/presign` | Issue R2 presigned PUT URL | AUTH |
| GET | `/reports` | List own reports. Supports `?page&limit&status` | AUTH |
| GET | `/reports/:id` | Full report with all rows | AUTH |
| POST | `/reports` | Save reconciliation result | AUTH |
| DELETE | `/reports/:id` | Hard delete; cascades to `report_rows` | AUTH |
| POST | `/reports/:id/export` | Generate XLSX server-side, return as download | AUTH |
| POST | `/reports/:id/email` | Email report. Body: `{to: string}` | AUTH |

Error shape:

```json
{
  "type": "https://recon.app/errors/validation-error",
  "title": "Validation Error",
  "status": 422,
  "detail": "amount_tolerance must be a non-negative number",
  "instance": "/api/reports",
  "errors": [{ "field": "amount_tolerance", "message": "..." }]
}
```

## 7. Error Handling Strategy

All errors bubble to a global error-handler middleware. Operational errors are caught and serialized as RFC 7807; programmer errors (uncaught exceptions/rejections) are logged via pino and return a generic 500 — **never leak internal detail to the client**.

| Error class | HTTP status | When |
|---|---|---|
| `ValidationError` | 422 | Zod schema fails on body/query |
| `AuthenticationError` | 401 | Missing/expired/invalid session cookie |
| `AuthorisationError` | 403 | Valid session, insufficient role |
| `NotFoundError` | 404 | Row not found or not owned by user |
| `FileTooLargeError` | 413 | Content-Length exceeds 50 MB, checked before presigning |
| `ConflictError` | 409 | Unique constraint violation (e.g. duplicate email) |
| `InternalError` | 500 | Unhandled — logged with stack trace |

## 8. Environment & Configuration

`.env.example` (canonical template, never commit real secrets):

```
# Server
PORT=3001
NODE_ENV=development

# Database
DATABASE_URL=postgres://recon:password@localhost:5432/recon_db

# Better Auth
BETTER_AUTH_SECRET=<32-byte random secret>
BETTER_AUTH_URL=http://localhost:3001

# CORS
FRONTEND_URL=http://localhost:3000

# Cloudflare R2
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET_NAME=recon-uploads

# Resend
RESEND_API_KEY=re_xxx
EMAIL_FROM=noreply@yourdomain.com

# File limits
MAX_FILE_SIZE_MB=50
```

## 9. Testing Strategy (backend-relevant layers)

| Layer | Framework | What to test | Coverage target |
|---|---|---|---|
| Express routes | Jest + Supertest | Auth flow, file upload validation, report CRUD, role enforcement | 85% |
| DB queries | Jest + test DB | `saveReport` transaction, index performance on 100k rows | 70% |

E2E (Playwright) and engine/component tests live in `recon-frontend` but exercise this backend's API as part of the full happy-path flow.

## 10. Deployment — DigitalOcean

- Deployed to **DigitalOcean App Platform** as its own service (`recon-backend`), independent from `recon-frontend`.
- Managed **PostgreSQL 16** database cluster, same region/VPC, private networking only (no public DB exposure).
- `run_command: pnpm prisma migrate deploy && node dist/app.js` (or `node app.js` for this plain-JS repo) — migrations always applied before the server starts.
- `DATABASE_URL` injected via DB binding in `app.yaml`; secrets (`BETTER_AUTH_SECRET`, R2/Resend keys) marked `type: SECRET`.
- Zero-downtime deploys: old instance stays live until the new one passes health checks. Last 10 deploys retained for one-click rollback.
- `NODE_ENV=production` and `BETTER_AUTH_URL` must exactly match the deployed origin (scheme + host).

## 11. Key Architectural Decisions (backend-relevant, from ADR log)

| ADR | Decision | Rationale |
|---|---|---|
| ADR-09 | Better Auth over NextAuth/Auth.js/custom JWT | Framework-agnostic, works on Express via `toNodeHandler()`; built-in session mgmt, email/password, OAuth; no manual JWT rotation |
| ADR-10 | Cloudflare R2 over S3/Supabase/DO Spaces | S3-compatible API, zero egress to Cloudflare Workers, presigned PUT keeps files off the backend entirely |
| ADR-11 | Resend over SendGrid/Postmark/SMTP | Developer-first API, first-class Next.js/React Email integration, no SMTP server to manage |
| ADR-05 | Prisma ORM over Drizzle/Knex/TypeORM | Schema-first, fully typed client, auditable versioned SQL migrations |
| ADR-06 | Two separate repos over monorepo | Independent deploy pipelines, access control, and release cycles for a two-service project |

## 12. Hard Constraints Relevant to Backend

| Constraint | Value | Why it matters here |
|---|---|---|
| Max file size | 50 MB per file | Enforced in `/files/presign` before issuing the URL |
| TLS | Required in production | Financial data in transit |
| Node version | 20 LTS per spec | This repo currently runs Node 24 — newer than spec baseline; revisit if DigitalOcean's `node-js` buildpack pins an older runtime |
| Postgres version | 16 | Managed DB cluster must be provisioned at v16 |
