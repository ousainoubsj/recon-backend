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

export async function listNotifications(userId) {
  return prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
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
