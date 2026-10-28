/**
 * @param {{id: string, email: string}} user
 * @param {{prisma: import('@prisma/client').PrismaClient, createOrganization: Function}} deps
 */
export async function handleUserCreated(user, { prisma, createOrganization }) {
  // Better Auth never flips an expired invitation's status, so expiry is checked here.
  const pendingInvite = await prisma.invitation.findFirst({
    where: { email: user.email, status: 'pending', expiresAt: { gt: new Date() } },
  });
  if (pendingInvite) return; // they'll join the inviter's org via acceptInvitation instead

  try {
    await createOrganization({
      body: {
        name: `${user.email}'s organization`,
        slug: `org-${user.id}`,
        userId: user.id,
      },
    });
  } catch (err) {
    console.error('Failed to auto-create organization for new user', user.id, err);
    // Fail-open: the account still exists, just org-less until fixed manually.
    // There's no transaction spanning this hook and the user insert.
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
 * @param {string} userId
 * @param {{prisma: import('@prisma/client').PrismaClient}} deps
 */
export async function hasOrganization(userId, { prisma }) {
  const memberships = await prisma.member.count({ where: { userId } });
  return memberships > 0;
}
