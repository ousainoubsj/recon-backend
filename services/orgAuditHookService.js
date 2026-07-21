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
  '/organization/remove-member': 'organization.member.remove',
  '/organization/update-member-role': 'organization.member.role_update',
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

/**
 * Wired as a global Better Auth `hooks.after` middleware (see auth.js).
 * Records an audit log entry for org-management actions and logins that
 * succeeded, and fires a couple of targeted notifications (role changed,
 * invitation accepted) off the same hook point rather than instrumenting
 * separate call sites.
 *
 * @param {{path: string, body: unknown, headers: unknown, context: {returned?: unknown}}} ctx
 * @param {{getSession: Function, logAuditSafely: Function, createNotification: Function, prisma: object}} deps
 */
export async function auditOrgAction(ctx, { getSession, logAuditSafely, createNotification, prisma }) {
  const action = AUDIT_ACTIONS[ctx.path];
  if (!action) return;
  if (isFailedResponse(ctx.context?.returned)) return;

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
    metadata: SELF_CONTAINED_USER_PATHS.has(ctx.path) ? { method: LOGIN_METHOD_BY_PATH[ctx.path] } : (ctx.body ?? null),
  });

  if (ctx.path === '/organization/update-member-role') {
    const member = await prisma.member.findUnique({ where: { id: ctx.body.memberId }, select: { userId: true } });
    if (member && member.userId !== actingUser.id) {
      await createNotification(member.userId, {
        type: 'member.role_changed',
        message: `Your role was changed to ${ctx.body.role}.`,
        entityType: 'member',
        entityId: ctx.body.memberId,
      });
    }
  }

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
