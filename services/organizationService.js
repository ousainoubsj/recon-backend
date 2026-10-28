import { prisma } from '../config/prisma.config.js';
import { NotFoundError } from '../errors.js';
import { createPersonalOrganizationIfUninvited } from './signupHookService.js';

/**
 * A user with no org gets their own here, unless a usable invitation is waiting for them. That covers signing
 * up for an invitation that later expired or was cancelled, and a failed signup-time creation.
 * @param {string} userId
 * @returns {Promise<{organizationId: string, role: string, status: 'active'|'inactive'}>}
 * @throws {NotFoundError} if the user has no organization membership and none could be created
 */
export async function getUserMembership(userId) {
  const findMembership = () =>
    prisma.member.findFirst({
      where: { userId },
      select: { organizationId: true, role: true, status: true },
    });

  const member = await findMembership();
  if (member) return member;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true } });
  if (!user) throw new NotFoundError('User does not belong to an organization');

  // Imported here: auth.js imports services that import this module.
  const { auth } = await import('../auth.js');
  try {
    await createPersonalOrganizationIfUninvited(user, { prisma, createOrganization: auth.api.createOrganization });
  } catch (err) {
    // Also fails when a concurrent request created it first (the slug is unique per user); the re-read covers that.
    console.error('Failed to create a missing organization', userId, err);
  }

  const created = await findMembership();
  if (!created) throw new NotFoundError('User does not belong to an organization');
  return created;
}

// Org-scoped, not user-scoped (no getUserMembership call) — needed by
// contexts with no "current session user" at all.
export async function getOrganizationBrand(organizationId) {
  return prisma.organization.findFirst({ where: { id: organizationId }, select: { name: true, logo: true, orgType: true } });
}

const LAST_ACTIVE_THROTTLE_MS = 5 * 60 * 1000;

// Best-effort, like logAuditSafely — recording activity must never break a
// request. Throttled so an active user doesn't trigger a write on every
// single request: the update only touches rows where lastActiveAt is
// null or already stale, so most calls match zero rows and are cheap.
export async function touchLastActive(userId) {
  try {
    const now = new Date();
    const threshold = new Date(now.getTime() - LAST_ACTIVE_THROTTLE_MS);
    await prisma.member.updateMany({
      where: { userId, OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: threshold } }] },
      data: { lastActiveAt: now },
    });
  } catch (err) {
    console.error('Failed to update lastActiveAt', userId, err);
  }
}
