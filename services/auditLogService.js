import { prisma } from '../db/index.js';
import { getUserMembership } from './organizationService.js';

/**
 * @param {string} userId
 * @param {{action: string, entityType?: string|null, entityId?: string|null, status?: 'success'|'info'|'warning'|'failed', ip?: string|null, metadata?: object|null}} entry
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
      status: entry.status ?? 'success',
      ip: entry.ip ?? null,
      metadata: entry.metadata ?? undefined,
    },
  });
}

export async function listAuditLogs(
  userId,
  { limit, offset, q, action, entityType, actorUserId, dateFrom, dateTo, status } = {},
) {
  const { organizationId } = await getUserMembership(userId);
  const query = q?.trim();
  const from = dateFrom ? new Date(dateFrom) : null;
  const to = dateTo ? new Date(dateTo) : null;
  const tsFilter = {
    ...(from && !Number.isNaN(from.getTime()) ? { gte: from } : {}),
    ...(to && !Number.isNaN(to.getTime()) ? { lte: to } : {}),
  };

  return prisma.auditLog.findMany({
    where: {
      organizationId,
      ...(query
        ? {
            OR: [
              { action: { contains: query, mode: 'insensitive' } },
              { user: { name: { contains: query, mode: 'insensitive' } } },
              { user: { email: { contains: query, mode: 'insensitive' } } },
            ],
          }
        : {}),
      ...(action ? (Array.isArray(action) ? { action: { in: action } } : { action }) : {}),
      ...(entityType ? { entityType } : {}),
      ...(actorUserId ? { userId: actorUserId } : {}),
      ...(AUDIT_LOG_STATUSES.includes(status) ? { status } : {}),
      ...(Object.keys(tsFilter).length > 0 ? { ts: tsFilter } : {}),
    },
    include: { user: { select: { name: true, email: true, image: true } } },
    orderBy: { ts: 'desc' },
    ...(offset ? { skip: offset } : {}),
    ...(limit ? { take: limit } : {}),
  });
}

const AUDIT_LOG_STATUSES = ['success', 'info', 'warning', 'failed'];

// SQL-side aggregation (groupBy/count), unlike Report's JS-side aggregatePeriod
// — audit logs accumulate at a much higher write rate than reconciliation
// runs, so pulling every row into JS to count them doesn't scale the same way.
// Feeds both AuditStats' 4 cards and AuditSidebar's Activity Summary donut —
// same numbers, different presentation — so there's only one query to make.
export async function getAuditLogStats(userId) {
  const { organizationId } = await getUserMembership(userId);
  const now = new Date();
  const last30Start = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const prev30Start = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

  const [total, uniqueUsers, byStatusRows, last30Count, prev30Count, last30UniqueRows, prev30UniqueRows] = await Promise.all([
    prisma.auditLog.count({ where: { organizationId } }),
    prisma.auditLog.findMany({ where: { organizationId }, distinct: ['userId'], select: { userId: true } }),
    prisma.auditLog.groupBy({ by: ['status'], where: { organizationId }, _count: true }),
    prisma.auditLog.count({ where: { organizationId, ts: { gte: last30Start } } }),
    prisma.auditLog.count({ where: { organizationId, ts: { gte: prev30Start, lt: last30Start } } }),
    prisma.auditLog.findMany({
      where: { organizationId, ts: { gte: last30Start } },
      distinct: ['userId'],
      select: { userId: true },
    }),
    prisma.auditLog.findMany({
      where: { organizationId, ts: { gte: prev30Start, lt: last30Start } },
      distinct: ['userId'],
      select: { userId: true },
    }),
  ]);

  const byStatus = { success: 0, info: 0, warning: 0, failed: 0 };
  for (const row of byStatusRows) {
    byStatus[row.status] = row._count;
  }

  // null (not 0) when there's nothing to compare against yet — a fresh org
  // with no prior-30-day activity has no meaningful "% vs last 30 days".
  const totalTrendPercent = prev30Count > 0 ? ((last30Count - prev30Count) / prev30Count) * 100 : null;
  const uniqueUsersTrend = last30UniqueRows.length - prev30UniqueRows.length;

  return { total, uniqueUsers: uniqueUsers.length, byStatus, totalTrendPercent, uniqueUsersTrend };
}

export async function getTopActions(userId, { limit = 5 } = {}) {
  const { organizationId } = await getUserMembership(userId);

  const rows = await prisma.auditLog.groupBy({
    by: ['action'],
    where: { organizationId },
    _count: true,
    orderBy: { _count: { action: 'desc' } },
    take: limit,
  });

  return rows.map((row) => ({ label: row.action, count: row._count }));
}

// Mirrors getTopFilePairs' shape (§4): top N, plus an "Other Users" bucket
// for the remainder — computed from the already-known total rather than a
// second query.
export async function getTopUsers(userId, { limit = 5 } = {}) {
  const { organizationId } = await getUserMembership(userId);

  const [total, grouped] = await Promise.all([
    prisma.auditLog.count({ where: { organizationId } }),
    prisma.auditLog.groupBy({
      by: ['userId'],
      where: { organizationId },
      _count: true,
      orderBy: { _count: { userId: 'desc' } },
      take: limit,
    }),
  ]);

  const users = await prisma.user.findMany({
    where: { id: { in: grouped.map((row) => row.userId) } },
    select: { id: true, name: true, image: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  const top = grouped.map((row) => {
    const user = userById.get(row.userId);
    return { name: user?.name ?? row.userId, image: user?.image ?? null, count: row._count };
  });
  const topCount = top.reduce((sum, row) => sum + row.count, 0);
  const remainder = total - topCount;

  if (remainder > 0) {
    top.push({ name: 'Other Users', image: null, count: remainder });
  }

  return top;
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
