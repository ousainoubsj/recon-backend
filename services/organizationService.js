import { prisma } from '../db/index.js';
import { NotFoundError } from '../errors.js';

/**
 * @param {string} userId
 * @returns {Promise<{organizationId: string, role: string, status: 'active'|'inactive'}>}
 * @throws {NotFoundError} if the user has no organization membership
 */
export async function getUserMembership(userId) {
  const member = await prisma.member.findFirst({
    where: { userId },
    select: { organizationId: true, role: true, status: true },
  });
  if (!member) throw new NotFoundError('User does not belong to an organization');
  return member;
}

// Org-scoped, not user-scoped (no getUserMembership call) — needed by
// contexts with no "current session user" at all, like the scheduled-report
// cron runner, which only has organizationId off the schedule row.
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
