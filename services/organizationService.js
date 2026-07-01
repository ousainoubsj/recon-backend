import { prisma } from '../db/index.js';
import { NotFoundError } from '../errors.js';

/**
 * @param {string} userId
 * @returns {Promise<{organizationId: string, role: string}>}
 * @throws {NotFoundError} if the user has no organization membership
 */
export async function getUserMembership(userId) {
  const member = await prisma.member.findFirst({
    where: { userId },
    select: { organizationId: true, role: true },
  });
  if (!member) throw new NotFoundError('User does not belong to an organization');
  return member;
}
