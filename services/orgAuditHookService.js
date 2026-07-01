// Maps Better Auth organization-plugin request paths to audit action names.
// Confirmed empirically against the running plugin: '/organization/create'
// and '/organization/invite-member' both matched this kebab-case naming
// convention exactly; the rest follow the same convention as the plugin's
// own endpoint names (createInvitation -> /organization/invite-member,
// removeMember -> /organization/remove-member, etc. per organization.mjs).
const ORG_AUDIT_ACTIONS = {
  '/organization/invite-member': 'organization.member.invite',
  '/organization/remove-member': 'organization.member.remove',
  '/organization/update-member-role': 'organization.member.role_update',
  '/organization/accept-invitation': 'organization.invitation.accept',
  '/organization/cancel-invitation': 'organization.invitation.cancel',
  '/organization/update': 'organization.update',
  '/organization/delete': 'organization.delete',
};

function isFailedResponse(returned) {
  return !!returned && typeof returned === 'object' && returned.name === 'APIError';
}

/**
 * Wired as a global Better Auth `hooks.after` middleware (see auth.js).
 * Records an audit log entry for org-management actions that succeeded,
 * attributed to the session resolved from the request's own headers (the
 * global hook's own `ctx.context.session` is not populated — it belongs to
 * the endpoint's internal middleware chain, not this outer hook).
 *
 * @param {{path: string, body: unknown, headers: unknown, context: {returned?: unknown}}} ctx
 * @param {{getSession: Function, logAuditSafely: Function}} deps
 */
export async function auditOrgAction(ctx, { getSession, logAuditSafely }) {
  const action = ORG_AUDIT_ACTIONS[ctx.path];
  if (!action) return;
  if (isFailedResponse(ctx.context?.returned)) return;

  const session = await getSession({ headers: ctx.headers }).catch(() => null);
  if (!session) return;

  await logAuditSafely(session.user.id, {
    action,
    entityType: 'organization',
    metadata: ctx.body ?? null,
  });
}
