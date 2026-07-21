import { prisma } from '../db/index.js';
import { getUserMembership } from './organizationService.js';

/**
 * @param {string} userId
 * @param {{action: string, entityType?: string|null, entityId?: string|null, metadata?: object|null}} entry
 */
export async function createAuditLog(userId, entry) {
  const { organizationId } = await getUserMembership(userId);
  return prisma.auditLog.create({
    data: {
      userId,
      organizationId,
      action: entry.action,
      entityType: entry.entityType ?? null,
      entityId: entry.entityId ?? null,
      metadata: entry.metadata ?? undefined,
    },
  });
}

export async function listAuditLogs(userId, { limit } = {}) {
  const { organizationId } = await getUserMembership(userId);
  return prisma.auditLog.findMany({
    where: { organizationId },
    orderBy: { ts: 'desc' },
    ...(limit ? { take: limit } : {}),
  });
}

// Fire-and-log: callers recording their own side effects (report created,
// deleted, exported...) must never fail because logging failed.
export async function logAuditSafely(userId, entry) {
  try {
    await createAuditLog(userId, entry);
  } catch (err) {
    console.error('Failed to write audit log', entry.action, entry.entityId, err);
  }
}
