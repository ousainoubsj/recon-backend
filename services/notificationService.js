import { prisma } from '../config/prisma.config.js';
import { NotFoundError } from '../errors.js';
import { getUserMembership } from './organizationService.js';

/**
 * Best-effort, like logAuditSafely — a notification failing to write must
 * never break the real action (role change, invitation accept, report
 * delete) that triggered it.
 * @param {string} userId - the recipient
 * @param {{type: string, message: string, entityType?: string|null, entityId?: string|null}} entry
 */
export async function createNotification(userId, entry) {
  try {
    const { organizationId } = await getUserMembership(userId);
    await prisma.notification.create({
      data: {
        userId,
        organizationId,
        type: entry.type,
        message: entry.message,
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
      },
    });
  } catch (err) {
    console.error('Failed to write notification', entry.type, userId, err);
  }
}

/**
 * One page of the user's notifications, newest first. `types` keeps only those types and `excludeTypes` drops
 * them (the frontend's catch-all tab is "everything not in the other tabs"). Paged by cursor rather than offset,
 * so a notification arriving between pages doesn't repeat a row. countsByType covers all of the user's
 * notifications, for the tab badges.
 */
export async function listNotifications(userId, { types, excludeTypes, limit = 20, cursor } = {}) {
  const typeFilter = types?.length ? { type: { in: types } } : excludeTypes?.length ? { type: { notIn: excludeTypes } } : {};
  const where = { userId, ...typeFilter };
  const [page, total, byType] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // One extra row says whether another page exists without a second count.
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
    prisma.notification.count({ where }),
    prisma.notification.groupBy({ by: ['type'], where: { userId }, _count: { _all: true } }),
  ]);

  const items = page.slice(0, limit);
  return {
    items,
    total,
    nextCursor: page.length > limit ? items[items.length - 1].id : null,
    countsByType: Object.fromEntries(byType.map((group) => [group.type, group._count._all])),
  };
}

export async function countUnread(userId) {
  return prisma.notification.count({ where: { userId, read: false } });
}

export async function markAsRead(userId, notificationId) {
  const { count } = await prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { read: true },
  });
  if (count === 0) throw new NotFoundError();
}

export async function markAllAsRead(userId) {
  await prisma.notification.updateMany({
    where: { userId, read: false },
    data: { read: true },
  });
}
