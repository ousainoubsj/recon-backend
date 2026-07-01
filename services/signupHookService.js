/**
 * @param {{id: string, email: string}} user
 * @param {{prisma: import('../generated/prisma/client.ts').PrismaClient, createOrganization: Function}} deps
 */
export async function handleUserCreated(user, { prisma, createOrganization }) {
  const pendingInvite = await prisma.invitation.findFirst({
    where: { email: user.email, status: 'pending' },
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
