/**
 * Creates the user's own org unless a usable invitation means they'll join the inviter's org instead.
 * Shared by signup and the lazy fallback in getUserMembership.
 * @param {{id: string, email: string}} user
 * @param {{prisma: import('@prisma/client').PrismaClient, createOrganization: Function}} deps
 */
export async function createPersonalOrganizationIfUninvited(user, { prisma, createOrganization }) {
  // Better Auth never flips an expired invitation's status, so expiry is checked here.
  const pendingInvite = await prisma.invitation.findFirst({
    where: { email: user.email, status: 'pending', expiresAt: { gt: new Date() } },
  });
  if (pendingInvite) return;

  await createOrganization({
    body: {
      name: `${user.email}'s organization`,
      slug: `org-${user.id}`,
      userId: user.id,
    },
  });
}

/**
 * @param {{id: string, email: string}} user
 * @param {{prisma: import('@prisma/client').PrismaClient, createOrganization: Function}} deps
 */
export async function handleUserCreated(user, deps) {
  try {
    await createPersonalOrganizationIfUninvited(user, deps);
  } catch (err) {
    // Fail-open: getUserMembership creates it on the user's next request.
    console.error('Failed to auto-create organization for new user', user.id, err);
  }
}

/**
 * The address a still-usable invitation was sent to, or null when the invitation is gone, used or expired.
 * @param {string} invitationId
 * @param {{prisma: import('@prisma/client').PrismaClient}} deps
 */
export async function usableInvitationEmail(invitationId, { prisma }) {
  const invitation = await prisma.invitation.findFirst({
    where: { id: invitationId, status: 'pending', expiresAt: { gt: new Date() } },
    select: { email: true },
  });
  return invitation?.email ?? null;
}

/**
 * Called before a user joins an org by invitation: one org per user. An existing org is given up only when it is
 * the personal one created for them (slug `org-<userId>`) and holds nothing: no other members, reports, templates,
 * exports or pending invitations. Those conditions sit in the delete itself, so work created meanwhile blocks it.
 * @param {{id: string}} user
 * @param {{organizationId: string}} invitation
 * @param {{prisma: import('@prisma/client').PrismaClient}} deps
 * @returns {Promise<boolean>} whether the user may join
 */
export async function releaseEmptyPersonalOrganization(user, invitation, { prisma }) {
  const memberships = await prisma.member.findMany({
    where: { userId: user.id },
    select: { organization: { select: { id: true, name: true, slug: true } } },
  });
  if (memberships.length === 0) return true;
  if (memberships.length > 1) return false;

  const { organization } = memberships[0];
  if (organization.slug !== `org-${user.id}`) return false;

  const { count } = await prisma.organization.deleteMany({
    where: {
      id: organization.id,
      members: { every: { userId: user.id } },
      reports: { none: {} },
      reportTemplates: { none: {} },
      matchRuleTemplates: { none: {} },
      reportExports: { none: {} },
      invitations: { none: { status: 'pending' } },
    },
  });
  if (count === 0) return false;

  // Written directly: with no membership right now, createAuditLog's getUserMembership has no org to resolve.
  await prisma.auditLog
    .create({
      data: {
        userId: user.id,
        organizationId: invitation.organizationId,
        action: 'organization.personal.replace',
        entityType: 'organization',
        entityId: organization.id,
        metadata: { replacedOrganizationName: organization.name },
      },
    })
    .catch((err) => console.error('Failed to write audit log', 'organization.personal.replace', organization.id, err));
  return true;
}
