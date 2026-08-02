/**
 * Better Auth only sets a session's activeOrganizationId when the client
 * explicitly calls setActiveOrganization. Our signup flow creates the
 * user's organization server-side (databaseHooks.user.create.after), and
 * that hook is not awaited by the sign-up flow before it proceeds to create
 * the session — so a session can easily be created before its owner's org
 * exists, leaving activeOrganizationId permanently null. That breaks any
 * org-management endpoint that relies on the session's active org (e.g.
 * invite-member without an explicit organizationId in the body).
 *
 * Rather than race to fix this once at session-creation time, this repairs
 * the session lazily on every request to an /organization/* endpoint
 * (wired as a global `hooks.before` in auth.js, scoped by path) — by the
 * time any such request arrives, the org has long since been created.
 * Session cookie caching must stay disabled (see auth.js) so each request
 * re-reads this repaired value from the database instead of an earlier,
 * stale cached snapshot.
 *
 * @param {{id: string, userId: string, activeOrganizationId?: string|null}|null} session
 * @param {{prisma: import('@prisma/client').PrismaClient}} deps
 */
export async function repairActiveOrganization(session, { prisma }) {
  if (!session || session.activeOrganizationId) return;

  const member = await prisma.member.findFirst({
    where: { userId: session.userId },
    select: { organizationId: true },
  });
  if (!member) return; // org-less user (e.g. signup hook failed) — nothing to set

  await prisma.session.update({
    where: { id: session.id },
    data: { activeOrganizationId: member.organizationId },
  });
}
