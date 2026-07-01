# Backend Implementation Spec

As-built architecture reference for `recon-backend`. Describes what is actually implemented today. For a completion-tracking view against the original engineering spec and later product asks, see `doc/backend-implementation-checklist.md`.

## 1. Scope

The backend handles auth, multi-tenancy, RBAC, file relay, report persistence, audit logging, and transactional email. It does **not** process transaction data — all reconciliation matching runs client-side in the frontend so raw financial records never transit the network. Concretely, the backend is responsible for:

- Better Auth: email/password and Google/Apple social sessions, cookie-based
- Multi-tenant organizations — every user belongs to exactly one org; reports and audit entries are shared within it
- Role-based access control (`admin`/`analyst`/`viewer`) enforced on every report/file/audit-log route and on Better Auth's own org-management endpoints
- Issuing presigned PUT URLs for direct browser → Cloudflare R2 uploads
- Saving/retrieving/deleting reconciliation reports and their row-level results in PostgreSQL
- An audit trail of report actions and org-management actions
- Resend email delivery (report emails, org invitation emails) via HTML templates

Out of scope for the backend (handled in `recon-frontend`): file parsing, the matching engine, CSV/XLSX export generation for the client-side flow.

## 2. Repo Structure

```
recon-backend/
├── controllers/         # files.controller.js, reports.controller.js, auditLog.controller.js
├── routes/               # auth.js, files.js, reports.js, auditLogs.js
├── middleware/           # authenticate.js, authorize.js, validate.js, rateLimit.js, errorHandler.js
├── db/                   # index.js — Prisma client
├── services/             # reportService.js, organizationService.js, permissions.js,
│                         # signupHookService.js, sessionHookService.js, orgAuditHookService.js,
│                         # auditLogService.js, emailService.js
├── types/                # file.js, recon.js — shared shapes, mirrored manually in frontend
├── utils/                # catchAsync.js, emailTemplate.js
├── templates/            # email-invitation.html, email-report.html
├── generated/prisma/     # generated Prisma client (models/, internal/, client.ts, enums.ts, ...)
├── prisma/               # schema.prisma, migrations/
├── auth.js               # Better Auth config — org plugin, custom RBAC roles, social providers, hooks
├── app.js                # entrypoint: loads dotenv, then dynamically imports server.js
├── server.js             # Express app assembly (middleware stack, route mounting)
├── errors.js             # error classes (RFC 7807 shape)
├── prisma.config.js      # Prisma 7 config (driver adapters)
├── tests/                # Jest, 16 suites
└── package.json
```

Routing is split into thin `routes/` handlers plus `controllers/` for request logic. `app.js` and `server.js` are reversed from what the names suggest: `app.js` is the thin entrypoint (loads `dotenv`, dynamically imports `server.js` so env vars are guaranteed to load first, then calls `.listen()`), while `server.js` builds the actual Express `app` (middleware stack, route mounting, error handler).

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
  user: { id: string; email: string; name: string };
  session: { id: string; expiresAt: string };
}
```

`role` is not part of this response — it's not a global user attribute. Role lives per-organization on the `Member` row (§5), resolved via `services/organizationService.js`'s `getUserMembership(userId)` rather than read off the session's user object directly.

Session delivery: HttpOnly + Secure `Set-Cookie` (`better-auth.session_token`). **No bearer token in the response body.** Session cookie caching is deliberately disabled (§5.3) — every request re-reads the session from the DB.

## 4. API Reference

All routes prefixed `/api`. JSON throughout. Errors follow **RFC 7807** Problem Details.

| Method | Path | Description | Auth |
|---|---|---|---|
| POST | `/auth/sign-up/email` | Create account. Body: `{email, password, name}` | PUBLIC |
| POST | `/auth/sign-in/email` | Authenticate, sets session cookie | PUBLIC |
| GET | `/auth/sign-in/social?provider=google\|apple` | Start OAuth flow | PUBLIC |
| GET | `/auth/callback/{google,apple}` | OAuth callback | PUBLIC |
| POST | `/auth/sign-out` | Invalidate session cookie | AUTH |
| GET | `/auth/get-session` | Return current session | AUTH |
| POST | `/auth/organization/create` | Create an org (used internally by the signup hook, §5.3) | AUTH |
| POST | `/auth/organization/invite-member` | Invite a teammate by email + role | AUTH, `member:create` |
| POST | `/auth/organization/accept-invitation` | Join the inviting org | AUTH |
| POST | `/auth/organization/remove-member` | Remove a member | AUTH, `member:delete` |
| POST | `/auth/organization/update-member-role` | Change a member's role | AUTH, `member:update` |
| POST | `/auth/organization/cancel-invitation` | Cancel a pending invite | AUTH, `invitation:cancel` |
| POST | `/auth/organization/update` | Rename/update the org | AUTH, `organization:update` |
| POST | `/auth/organization/delete` | Delete the org | AUTH, `organization:delete` |
| POST | `/files/presign` | Issue R2 presigned PUT URL | AUTH, `file:upload` |
| GET | `/reports` | List all reports in the caller's org | AUTH, `report:read` |
| GET | `/reports/:id` | Full report with all rows | AUTH, `report:read` |
| POST | `/reports` | Save reconciliation result | AUTH, `report:create` |
| DELETE | `/reports/:id` | Delete; own report always, any org report if `admin` | AUTH, `report:delete` |
| POST | `/reports/:id/export` | Generate XLSX server-side, return as download | AUTH, `report:export` |
| POST | `/reports/:id/email` | Email report (HTML template). Body: `{to: string}` | AUTH, `report:email` |
| GET | `/audit-logs` | List the org's audit trail | AUTH, `auditLog:read` (admin only) |
| POST | `/audit-logs` | Record a manual audit entry | AUTH, `auditLog:create` |

The `/auth/organization/*` and `/auth/sign-in/social`, `/auth/callback/*` routes are Better Auth's own endpoints — auto-mounted the moment the `organization` plugin and `socialProviders` are configured in `auth.js`; no custom Express routes or controllers exist for them. Everything else under `/reports`, `/files`, `/audit-logs` is hand-written (`routes/`, `controllers/`).

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

## 5. Backend Architecture

### 5.1 App structure

`server.js` assembles the Express app and mounts route modules: `routes/auth.js` (Better Auth catch-all via `toNodeHandler`), `routes/reports.js`, `routes/files.js`, `routes/auditLogs.js`. Two middleware layers apply to protected routes, in order:

1. `authenticate` (`middleware/authenticate.js`) — calls `auth.api.getSession()`, throws `AuthenticationError` (401) if missing, else attaches `req.session`.
2. `requirePermission(resource, action)` (`middleware/authorize.js`) — resolves the caller's org role via `getUserMembership(req.session.user.id)` and checks it against the matrix in §5.4, throwing `AuthorisationError` (403) on a miss.

### 5.2 Middleware stack (`server.js`)

| Middleware | Package | Notes |
|---|---|---|
| `helmet()` | helmet@7 | CSP, X-Frame-Options, HSTS, etc. |
| `cors()` | cors@2 | Restrict to `FRONTEND_URL`; `credentials: true` for cookie auth |
| `cookieParser()` | cookie-parser@1 | Reads Better Auth session cookie |
| rate limiter | express-rate-limit@7 | Auth routes: 10 req/min. API routes: 200 req/min per IP |
| `authenticate` | custom (Better Auth) | Validates session, attaches `req.session` |
| `requirePermission(resource, action)` | custom | Per-route RBAC check (§5.4) |
| `validate(schema)` | zod@3 | Per-route schema; 422 with structured field errors on failure |
| request logger | pino-http@9 | Structured JSON in prod, pretty in dev |
| `errorHandler` | custom | RFC 7807 serialization, mounted last (§7) |

Better Auth's own handler is mounted before `express.json()` (it parses its own body) and gets the tighter auth rate limit; everything else sits behind `express.json()` and the looser API rate limit.

### 5.3 Authentication & Multi-tenancy — Better Auth

`auth.js` in full:

```js
import { betterAuth } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { organization } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { prisma } from './db/index.js';
import { ROLE_PERMISSIONS } from './services/permissions.js';
import { handleUserCreated } from './services/signupHookService.js';
import { repairActiveOrganization } from './services/sessionHookService.js';
import { auditOrgAction } from './services/orgAuditHookService.js';
import { logAuditSafely } from './services/auditLogService.js';
import { sendOrgInvitationEmail } from './services/emailService.js';

const statement = {
  organization: ['update', 'delete'],
  member: ['create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  report: ['create', 'read', 'delete', 'export', 'email'],
  file: ['upload'],
  auditLog: ['create', 'read'],
};
const ac = createAccessControl(statement);
const roles = Object.fromEntries(
  Object.entries(ROLE_PERMISSIONS).map(([name, perms]) => [name, ac.newRole(perms)]),
);

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET },
    apple: { clientId: process.env.APPLE_CLIENT_ID, clientSecret: process.env.APPLE_CLIENT_SECRET },
  },
  trustedOrigins: [process.env.FRONTEND_URL],
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: false }, // see the note below
  },
  databaseHooks: {
    user: {
      create: {
        after: (user) =>
          handleUserCreated(user, { prisma, createOrganization: auth.api.createOrganization }),
      },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (!ctx.path.startsWith('/organization')) return;
      const session = await auth.api.getSession({ headers: ctx.headers }).catch(() => null);
      await repairActiveOrganization(session?.session ?? null, { prisma });
    }),
    after: createAuthMiddleware((ctx) =>
      auditOrgAction(ctx, { getSession: auth.api.getSession, logAuditSafely }),
    ),
  },
  plugins: [
    organization({ ac, roles, creatorRole: 'admin', organizationLimit: 1, sendInvitationEmail: sendOrgInvitationEmail }),
  ],
});
```

**Signup → org provisioning** (`services/signupHookService.js`'s `handleUserCreated`, run from `databaseHooks.user.create.after`): checks for a pending `Invitation` matching the new user's email; if found, skips org creation (they'll join via `accept-invitation` instead). Otherwise auto-creates an org named `${email}'s organization` and makes the signer-upper its `admin` (`creatorRole: 'admin'`, not Better Auth's built-in `owner`/`admin` — see §5.4 for why).

**`activeOrganizationId` self-heal** (`services/sessionHookService.js`'s `repairActiveOrganization`, wired as the global `hooks.before` above): the org-creation call in `handleUserCreated` is not awaited by the sign-up flow before it creates the session, so a user's first session can be persisted with `activeOrganizationId: null` — which several Better Auth org endpoints (e.g. `invite-member` called without an explicit `organizationId`) rely on. This hook resolves the caller's org via `Member.findFirst` and patches the session row on every `/organization/*` request, so it self-heals regardless of the race. `session.cookieCache` must stay disabled for this to work: a cached cookie would otherwise keep serving the stale pre-repair snapshot for its whole TTL, independent of what the DB says.

**Audit hook**: see §5.6.

> ⚠️ `BETTER_AUTH_URL` must match the exact origin (including `https://`) in production. Better Auth validates origin on every request — a mismatch fails auth calls **silently**.

### 5.4 RBAC

Three custom roles — `admin`, `analyst`, `viewer` — replacing Better Auth's default `owner`/`admin`/`member`. Defined once, as plain data, in `services/permissions.js`:

```js
export const ROLE_PERMISSIONS = {
  admin: {
    organization: ['update', 'delete'],
    member: ['create', 'update', 'delete'],
    invitation: ['create', 'cancel'],
    report: ['create', 'read', 'delete', 'export', 'email'],
    file: ['upload'],
    auditLog: ['create', 'read'],
  },
  analyst: {
    organization: [], member: [], invitation: [],
    report: ['create', 'read', 'export', 'email'],
    file: ['upload'],
    auditLog: ['create'],
  },
  viewer: {
    organization: [], member: [], invitation: [],
    report: ['read', 'export', 'email'],
    file: [],
    auditLog: [],
  },
};
```

This single object feeds two independent enforcement points, so they can't drift apart:

- **Our own routes** (`report`/`file`/`auditLog`): `middleware/authorize.js`'s `requirePermission(resource, action)`.
- **Better Auth's org-management endpoints** (`organization`/`member`/`invitation`): `auth.js` builds custom `ac`/`roles` from the same object via `better-auth/plugins/access`'s `createAccessControl`, so e.g. `invite-member` is natively rejected for non-`admin` callers.

`creatorRole: 'admin'` gives the org founder real delete rights over their org. This only works because these are custom-defined roles — Better Auth's *built-in* `admin` role is deliberately weaker than its `owner` role and lacks `organization: ['delete']`; using the built-in roles here would have silently left founders unable to delete their own org.

### 5.5 File Upload Handler — Cloudflare R2

Backend issues a presigned PUT URL; browser uploads **directly** to R2. Server never buffers file bytes (`controllers/files.controller.js`):

```js
export const createPresignedUpload = async (req, res) => {
  const { filename, contentType, size } = req.body;
  if (typeof size !== 'number' || size > 50 * 1024 * 1024) throw new FileTooLargeError();
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) throw new ValidationError('Only CSV and XLSX files are accepted');

  const key = `uploads/${req.session.user.id}/${Date.now()}-${filename}`;
  const presignedUrl = await getSignedUrl(r2, new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME, Key: key, ContentType: contentType,
  }), { expiresIn: 300 });

  res.json({ url: presignedUrl, key });
};
```

- Presigned URLs expire in **5 minutes**.
- Allowed types: `text/csv`, `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`.
- Max file size: **50 MB**. Note: a missing/non-numeric `size` currently also throws `FileTooLargeError` (413) rather than a `ValidationError` (422) — a minor semantic mismatch, not yet fixed.
- The R2 storage key is scoped by `userId`, not `organizationId` — acceptable today since nothing reads uploads back through the app (presign only issues a write URL); would need revisiting if a "list my org's uploads" feature is ever added.

### 5.6 Report Persistence & Audit Logging — Prisma

`services/reportService.js`. Every function resolves the caller's org membership first via `services/organizationService.js`'s `getUserMembership(userId)` (a `Member.findFirst` keyed by `userId`) — the org boundary is always derived server-side from the session, never taken from client input, which is what makes this IDOR-safe.

```js
export async function saveReport(userId, dto) {
  const { organizationId } = await getUserMembership(userId);
  const report = await prisma.$transaction(async (tx) => {
    const report = await tx.report.create({ data: { userId, organizationId, /* ...fields */ } });
    await tx.reportRow.createMany({ data: dto.rows.map(/* ... */) });
    return report;
  });
  await logAuditSafely(userId, { action: 'report.create', entityType: 'report', entityId: report.id });
  return report.id;
}

export async function deleteReport(userId, reportId) {
  const { organizationId, role } = await getUserMembership(userId);
  const { count } = await prisma.report.deleteMany({
    where: { id: reportId, organizationId, ...(role === 'admin' ? {} : { userId }) },
  });
  if (count === 0) throw new NotFoundError();
  await logAuditSafely(userId, { action: 'report.delete', entityType: 'report', entityId: reportId });
}
```

`listReports`/`getReport` filter by `organizationId` alone (reports are shared org-wide); `deleteReport` additionally restricts to the caller's own `userId` unless their role is `admin`. `controllers/reports.controller.js`'s `exportReport`/`emailReport` fire `report.export`/`report.email` audit entries the same way, after the response is sent.

**Audit logging is best-effort** (`services/auditLogService.js`'s `logAuditSafely` — catches and `console.error`s failures rather than letting a logging error break the underlying action):

- Report actions above: `report.create`, `.delete`, `.export`, `.email`.
- Org-management actions, via `services/orgAuditHookService.js` wired as `auth.js`'s global `hooks.after`: `organization.member.invite`, `.remove`, `.role_update`, `organization.invitation.accept`, `.cancel`, `organization.update`, `.delete`. The hook maps Better Auth's request path to an action name, skips failed requests (`ctx.context.returned.name === 'APIError'`), and resolves the acting user via `auth.api.getSession({headers: ctx.headers})` — the global hook's own `ctx.context.session` is not populated (that belongs to the endpoint's internal middleware chain), so this manual resolution is required.
- `GET`/`POST /api/audit-logs` (`controllers/auditLog.controller.js`) for manually recorded entries — `read` is `admin`-only (audit trails are treated as sensitive/compliance-facing), `create` is open to `admin`/`analyst`.
- Nothing else is auto-logged (sign-in/out, file uploads) and there's no retention/archival policy.

### 5.7 Email — HTML templates

`services/emailService.js` renders HTML via `utils/emailTemplate.js`, following the pattern used in the sibling `Datafin HRMS` backend, scaled down to this repo's 2 email types (HRMS has 25+, so it also has a `views/send*.js` file per email — not warranted here):

- `templates/email-invitation.html`, `templates/email-report.html` — plain HTML, `{{placeholder}}` tokens, "Reconcil Transaction Reconciliation" branding.
- `renderEmailTemplate(name, data)` — reads the template file and substitutes placeholders.
- `escapeHtmlForEmail` — used only for user/DB-sourced strings (org name, inviter email, role, filenames); system-generated URLs like the accept-invite link are deliberately left unescaped.
- `htmlToText` — naive tag-stripping fallback for the email's plain-text part.
- A shared internal `sendEmail({to, subject, html, text})` wraps `resend.emails.send()`. It explicitly checks `result.error` and throws if present — the Resend SDK reports failures that way rather than by throwing, so an unchecked call would silently report success on a failed send.

## 6. Database Design

### 6.1 Models (`prisma/schema.prisma`)

- **User** — `id`, `email (unique)`, `name`, `emailVerified`, `image`, `createdAt`, `updatedAt`. No `password_hash` or `role` column — Better Auth stores credential hashes on `Account.password`, and role is per-organization on `Member.role`.
- **Report** — `id (uuid)`, `userId` (creator, FK → users, cascade), `organizationId` (tenant, FK → organization, cascade), `fileAName`, `fileBName`, `runDate`, row-count columns, `amountTolerance numeric(10,4)`, `dateToleranceDays`, `config jsonb`.
- **ReportRow** — `id (uuid)`, `reportId` (FK → reports, cascade), `ref varchar(500)`, `status` (enum), `amountA`/`amountB`/`amountDiff numeric(18,4)` (`amountDiff` computed in application code, **not** a DB generated column), `dateA`/`dateB`, `rawA`/`rawB jsonb`.
- **AuditLog** — `id (uuid)`, `userId` (FK → users, **no cascade** — a user can't be deleted while they have audit history, by design), `organizationId` **nullable** (FK → organization, `onDelete: SetNull` — an org's audit trail must survive its own deletion, including the `organization.delete` entry itself; this was originally `onDelete: Cascade` and silently destroyed the whole trail on org delete before being fixed), `action varchar(100)`, `entityType`/`entityId`, `ts`, `metadata jsonb`.
- **Organization** — `id`, `name`, `slug (unique)`, `logo`, `metadata`, `createdAt`.
- **Member** — `id`, `organizationId` (FK, cascade), `userId` (FK, cascade), `role: String` (`admin`/`analyst`/`viewer`), `createdAt`.
- **Invitation** — `id`, `organizationId` (FK, cascade), `email`, `role`, `status` (`pending`/`accepted`/`rejected`/`canceled`), `expiresAt`, `inviterId` (FK → users, cascade).
- **Session** / **Account** / **Verification** — Better Auth's own schema, generated via `npx @better-auth/cli generate`, not hand-written. `Session.activeOrganizationId` is the field §5.3's self-heal hook repairs.

### 6.2 Indexes

```sql
CREATE INDEX idx_reports_user_id ON reports(user_id);
CREATE INDEX idx_reports_organization_id ON reports(organization_id);
CREATE INDEX idx_reports_run_date ON reports(run_date DESC);
CREATE INDEX idx_rows_report_status ON report_rows(report_id, status);
CREATE INDEX idx_rows_ref ON report_rows(report_id, ref);
CREATE INDEX idx_audit_user_ts ON audit_logs(user_id, ts DESC);
CREATE INDEX idx_audit_organization_id ON audit_logs(organization_id);
```

**Open item**: `users.updated_at` is currently only a Prisma-level `@updatedAt` directive (ORM-side), not a DB `BEFORE UPDATE` trigger — unconfirmed whether that distinction matters for this project; flagged in the checklist doc.

### 6.3 Migration strategy

- `prisma/schema.prisma` is the single source of truth; migrations live in `prisma/migrations/` and are committed.
- **Dev**: `prisma migrate dev --name <name>` (interactive).
- **Production**: `prisma migrate deploy` only — runs as a pre-deploy/run command before the server starts. **Never run `migrate dev` against production** (it can reset data).
- This repo is on **Prisma 7** (driver adapters + `prisma.config.js`, `PrismaPg` adapter) — no schema-embedded `datasource.url`.
- Better-Auth-owned models (`Organization`/`Member`/`Invitation`/`Session`/`Account`/`Verification`) were added via `npx @better-auth/cli generate`, then hand-reconciled: the CLI's default ID type (plain string) had to be matched by removing `@db.Uuid` from `User.id` and every column that FKs to it, since Postgres rejects a foreign key between a `uuid` column and a `text` column.

## 7. Error Handling Strategy

All errors bubble to a global error-handler middleware (`middleware/errorHandler.js`, mounted last in `server.js`). Operational errors are caught and serialized as RFC 7807; programmer errors (uncaught exceptions/rejections) are logged and return a generic 500 — **never leak internal detail to the client**.

| Error class | HTTP status | When |
|---|---|---|
| `ValidationError` | 422 | Zod schema fails on body/query |
| `AuthenticationError` | 401 | Missing/expired/invalid session cookie |
| `AuthorisationError` | 403 | Valid session, role lacks the required permission (§5.4) |
| `NotFoundError` | 404 | Row not found, not in the caller's org, or (for delete) not owned and caller isn't `admin` |
| `FileTooLargeError` | 413 | Content-Length exceeds 50 MB, checked before presigning |
| `ConflictError` | 409 | Unique constraint violation (e.g. duplicate email) |
| 500 (unhandled) | 500 | Logged, generic body returned — not currently its own exported error class |

## 8. Environment & Configuration

`.env` (real values live in a gitignored `.env`; **no `.env.example` exists yet** — open item):

```
# Server
PORT=3001
NODE_ENV=development

# Database
DATABASE_URL=postgres://recon:password@localhost:5432/recon_db

# Better Auth
BETTER_AUTH_SECRET=<32-byte random secret>
BETTER_AUTH_URL=http://localhost:3001

# Better Auth - social sign-in (blank disables the provider)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
APPLE_CLIENT_ID=
APPLE_CLIENT_SECRET=

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

Current status: `GOOGLE_CLIENT_ID`/`SECRET`, `APPLE_CLIENT_ID`/`SECRET`, `RESEND_API_KEY`, and the R2 credentials are all still placeholder values in the working `.env` — social sign-in, real email delivery, and real file uploads are code-complete but functionally unverified against live third-party services. Apple additionally needs a self-generated JWT client secret (from a Team ID, Key ID, and a `.p8` private key) that expires every ≤6 months, rather than a static dashboard value like Google's — an operational task, not code.

## 9. Testing Strategy

16 Jest suites (native ESM, `NODE_OPTIONS=--experimental-vm-modules`, no Babel), ~100 tests, all against a mocked Prisma client / mocked `auth.js` boundaries / mocked AWS SDK / mocked `resend` package — no real network or DB calls in any test:

| Suite group | Files |
|---|---|
| Services | `reportService`, `organizationService`, `permissions`, `signupHookService`, `sessionHookService`, `orgAuditHookService`, `auditLogService`, `emailService` |
| Routes | `auth` (wiring only — Better Auth's own behavior isn't re-tested), `reports` (CRUD + export/email), `files` (presign), `auditLogs` |
| Middleware | `authenticate`, `authorize` |
| Utils | `emailTemplate` |

**Not done**: true integration tests against a real/disposable Postgres (index performance at scale, real transaction behavior). Every behavior in §5.3/§5.6 that depends on real Better Auth/Postgres interaction (the `activeOrganizationId` race, the audit-log path→action mappings, the `AuditLog` cascade bug) was instead confirmed by manually exercising the real dev database directly, then cleaning up — not covered by an automated integration suite.

E2E (Playwright) and engine/component tests live in `recon-frontend` but exercise this backend's API as part of the full happy-path flow.

## 10. Deployment — DigitalOcean (planned, not yet built)

- Deployed to **DigitalOcean App Platform** as its own service (`recon-backend`), independent from `recon-frontend`.
- Managed **PostgreSQL 16** database cluster, same region/VPC, private networking only (no public DB exposure).
- `run_command: prisma migrate deploy && node app.js` — migrations always applied before the server starts.
- `DATABASE_URL` injected via DB binding in `app.yaml`; secrets (`BETTER_AUTH_SECRET`, R2/Resend/OAuth keys) marked `type: SECRET`.
- Zero-downtime deploys: old instance stays live until the new one passes health checks. Last 10 deploys retained for one-click rollback.
- `NODE_ENV=production` and `BETTER_AUTH_URL` must exactly match the deployed origin (scheme + host).

**Status: not started.** No `app.yaml` or any DigitalOcean-specific config exists in the repo — nothing is actually deployable today.

## 11. Key Architectural Decisions

| Decision | Rationale |
|---|---|
| Better Auth over NextAuth/Auth.js/custom JWT | Framework-agnostic, works on Express via `toNodeHandler()`; built-in session mgmt, email/password, OAuth; no manual JWT rotation |
| Better Auth's `organization` plugin for multi-tenancy, rather than hand-rolled tenant tables | Free membership CRUD, invitation flow, and a request-level access-control system (`ac`/`roles`) that our own RBAC hooks into directly, instead of building all of that from scratch |
| Custom `admin`/`analyst`/`viewer` roles replacing Better Auth's built-in `owner`/`admin`/`member`, defined once in `services/permissions.js` and consumed by both the plugin's `ac` and our own `requirePermission` middleware | A single object as the source of truth means our own routes and Better Auth's org endpoints can never enforce contradictory permissions; also lets the org founder (`creatorRole: 'admin'`) keep real delete rights, which Better Auth's built-in `admin` role deliberately lacks |
| Audit logging as a best-effort side effect (`logAuditSafely`) rather than part of the primary transaction | A logging failure should never block a report save/delete or an org action from succeeding; trades strict audit completeness for availability |
| Cloudflare R2 over S3/Supabase/DO Spaces | S3-compatible API, zero egress to Cloudflare Workers, presigned PUT keeps files off the backend entirely |
| Resend over SendGrid/Postmark/SMTP | Developer-first API, first-class Next.js/React Email integration, no SMTP server to manage |
| HTML email via plain `{{placeholder}}` templates (matching the sibling `Datafin HRMS` backend's pattern) rather than a templating engine like Handlebars or React Email | Consistency with an existing, working sibling-project convention; proportionate to this repo's 2 email types versus HRMS's 25+ |
| Prisma ORM over Drizzle/Knex/TypeORM | Schema-first, fully typed client, auditable versioned SQL migrations |
| Two separate repos (`recon-backend`/`recon-frontend`) over a monorepo | Independent deploy pipelines, access control, and release cycles for a two-service project |

## 12. Hard Constraints

| Constraint | Value | Why it matters here |
|---|---|---|
| Max file size | 50 MB per file | Enforced in `/files/presign` before issuing the URL |
| TLS | Required in production | Financial data in transit |
| Node version | Repo runs Node 24 | Not pinned via `engines` in `package.json` — open item |
| Postgres version | 16 (Neon, serverless) | Managed DB cluster must be provisioned at v16; Neon's cold-start behavior means the first request after idle can take 5+ seconds or transiently fail — observed repeatedly during manual testing, not a code bug |
| Each user belongs to exactly one organization | `organizationLimit: 1` | Central invariant behind §5.3/§5.4 — changing this would require reworking the signup hook, the self-heal hook, and `getUserMembership`'s `findFirst` (currently safe only because it's unambiguous) |
