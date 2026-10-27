import { withSubject } from '../utils/audit.js';

// Maps Better Auth request paths to audit action names.
// Confirmed empirically against the running plugin: '/organization/create'
// and '/organization/invite-member' both matched this kebab-case naming
// convention exactly; the rest follow the same convention as the plugin's
// own endpoint names (createInvitation -> /organization/invite-member,
// removeMember -> /organization/remove-member, etc. per organization.mjs).
// Login paths were added the same way once real Google credentials made
// social sign-in testable end-to-end.
const AUDIT_ACTIONS = {
  '/organization/invite-member': 'organization.member.invite',
  '/organization/accept-invitation': 'organization.invitation.accept',
  '/organization/cancel-invitation': 'organization.invitation.cancel',
  '/organization/update': 'organization.update',
  '/organization/delete': 'organization.delete',
  '/sign-in/email': 'auth.login',
  '/callback/google': 'auth.login',
  '/callback/apple': 'auth.login',
};

// Paths whose successful response body already contains the acting user
// (Better Auth's sign-in/callback responses include { user, session }) —
// unlike org-management paths, there's no pre-existing session cookie on
// the incoming request to re-fetch via getSession: the session is created
// *by* this very request.
const SELF_CONTAINED_USER_PATHS = new Set(['/sign-in/email', '/callback/google', '/callback/apple']);

const LOGIN_METHOD_BY_PATH = {
  '/sign-in/email': 'email',
  '/callback/google': 'google',
  '/callback/apple': 'apple',
};

function isFailedResponse(returned) {
  return !!returned && typeof returned === 'object' && returned.name === 'APIError';
}

// Read-only/non-mutating-to-org-state actions are 'info'; actions that
// already trigger a notification to an affected *other* user elsewhere in
// this codebase (role changed, member removed, org deleted) are 'warning' —
// everything else defaults to 'success'. See reportService.js's
// bulkDeleteReports for the equivalent report-side rule.
const STATUS_BY_ACTION = {
  'auth.login': 'info',
  'organization.delete': 'warning',
};

// Best-effort IP extraction for the Better-Auth-hook-driven entries — unlike
// Express controllers (which just read req.ip), ctx.headers here is a
// Fetch-standard Headers-like object with no guaranteed client-IP field.
function extractIp(headers) {
  return headers?.get?.('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
}

function extractUserAgent(headers) {
  return headers?.get?.('user-agent') ?? null;
}

// One explicit shape per path, never the raw request body: the body carries
// routing ids (organizationId, memberId) that mean nothing in the audit feed.
function describeOrgAction(ctx) {
  const returned = ctx.context?.returned;
  switch (ctx.path) {
    case '/organization/invite-member':
      return withSubject({ role: ctx.body.role }, { name: ctx.body.email });
    case '/organization/accept-invitation':
      return { role: returned.invitation.role };
    case '/organization/cancel-invitation':
      return withSubject({ role: returned.role }, { name: returned.email });
    case '/organization/update':
      return ctx.body?.data ?? null;
    case '/organization/delete':
      return withSubject({}, { name: returned?.name });
    default:
      return { method: LOGIN_METHOD_BY_PATH[ctx.path] };
  }
}

/**
 * Wired as a global Better Auth `hooks.after` middleware (see auth.js).
 * Records an audit log entry for org-management actions and logins that
 * succeeded, a failed email/password login attempt against a *known* user
 * (an unknown email or a failed OAuth callback has no resolvable actor to
 * attach it to, so those stay unlogged), and fires a couple of targeted
 * notifications (role changed, invitation accepted) off the same hook point
 * rather than instrumenting separate call sites.
 *
 * @param {{path: string, body: unknown, headers: unknown, context: {returned?: unknown}}} ctx
 * @param {{getSession: Function, logAuditSafely: Function, createNotification: Function, prisma: object}} deps
 */
export async function auditOrgAction(ctx, { getSession, logAuditSafely, createNotification, prisma }) {
  const action = AUDIT_ACTIONS[ctx.path];
  if (!action) return;

  if (isFailedResponse(ctx.context?.returned)) {
    if (ctx.path === '/sign-in/email' && ctx.body?.email) {
      const user = await prisma.user.findUnique({ where: { email: ctx.body.email }, select: { id: true } }).catch(() => null);
      if (user) {
        await logAuditSafely(user.id, {
          action: 'auth.login_failed',
          entityType: null,
          status: 'failed',
          ip: extractIp(ctx.headers),
          userAgent: extractUserAgent(ctx.headers),
          metadata: { method: 'email' },
        });
      }
    }
    return;
  }

  let actingUser;
  if (SELF_CONTAINED_USER_PATHS.has(ctx.path)) {
    actingUser = ctx.context?.returned?.user;
  } else {
    const session = await getSession({ headers: ctx.headers }).catch(() => null);
    actingUser = session?.user;
  }
  if (!actingUser) return;

  await logAuditSafely(actingUser.id, {
    action,
    entityType: SELF_CONTAINED_USER_PATHS.has(ctx.path) ? null : 'organization',
    status: STATUS_BY_ACTION[action] ?? 'success',
    ip: extractIp(ctx.headers),
    userAgent: extractUserAgent(ctx.headers),
    metadata: describeOrgAction(ctx),
  });

  if (ctx.path === '/organization/accept-invitation') {
    const inviterId = ctx.context?.returned?.invitation?.inviterId;
    if (inviterId) {
      await createNotification(inviterId, {
        type: 'invitation.accepted',
        message: `${actingUser.name} accepted your invitation and joined the organization.`,
        entityType: 'invitation',
        entityId: ctx.body.invitationId,
      });
    }
  }
}
