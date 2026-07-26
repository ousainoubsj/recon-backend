import { prisma } from '../db/index.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { getUserMembership } from './organizationService.js';
import { logAuditSafely } from './auditLogService.js';
import { createNotification } from './notificationService.js';

const MEMBER_STATUSES = ['active', 'inactive'];

export async function listMembers(userId, { q, role, status, department, offset, limit } = {}) {
  const { organizationId } = await getUserMembership(userId);
  const query = q?.trim();

  return prisma.member.findMany({
    where: {
      organizationId,
      ...(query
        ? {
            user: {
              OR: [
                { name: { contains: query, mode: 'insensitive' } },
                { email: { contains: query, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
      ...(role ? { role } : {}),
      ...(MEMBER_STATUSES.includes(status) ? { status } : {}),
      ...(department ? { department } : {}),
    },
    include: { user: { select: { id: true, name: true, email: true, image: true } } },
    orderBy: { createdAt: 'desc' },
    ...(offset ? { skip: offset } : {}),
    ...(limit ? { take: limit } : {}),
  });
}

export async function getTeamStats(userId) {
  const { organizationId } = await getUserMembership(userId);
  const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  const [totalUsers, activeUsers, administrators, pendingInvites, newThisMonth, deactivatedThisMonth] = await Promise.all([
    prisma.member.count({ where: { organizationId } }),
    prisma.member.count({ where: { organizationId, status: 'active' } }),
    prisma.member.count({ where: { organizationId, role: 'admin' } }),
    prisma.invitation.count({ where: { organizationId, status: 'pending' } }),
    prisma.member.count({ where: { organizationId, createdAt: { gte: startOfMonth } } }),
    // Member has no deactivatedAt timestamp — the only record of *when* a
    // deactivation happened is updateMember's own 'member.update' audit log
    // entry, whose metadata carries the new status.
    prisma.auditLog.count({
      where: {
        organizationId,
        action: 'member.update',
        ts: { gte: startOfMonth },
        metadata: { path: ['status'], equals: 'inactive' },
      },
    }),
  ]);

  return {
    totalUsers,
    activeUsers,
    inactiveUsers: totalUsers - activeUsers,
    administrators,
    pendingInvites,
    newThisMonth,
    deactivatedThisMonth,
  };
}

// Deactivating someone is a sensitive action (same reasoning as §5's
// role_update/remove) — audited as a warning, not a plain success, and the
// affected member is notified, mirroring the existing role_changed pattern.
export async function updateMember(userId, memberId, { department, status }) {
  const { organizationId } = await getUserMembership(userId);

  const { count } = await prisma.member.updateMany({
    where: { id: memberId, organizationId },
    data: {
      ...(department !== undefined ? { department } : {}),
      ...(status !== undefined ? { status } : {}),
    },
  });
  if (count === 0) throw new NotFoundError();

  const member = await prisma.member.findFirst({
    where: { id: memberId, organizationId },
    include: { user: { select: { name: true, email: true, image: true } } },
  });

  const isDeactivating = status === 'inactive' && member.userId !== userId;
  await logAuditSafely(userId, {
    action: 'member.update',
    entityType: 'member',
    entityId: memberId,
    status: status === 'inactive' ? 'warning' : 'success',
    metadata: { department, status },
  });

  if (isDeactivating) {
    await createNotification(member.userId, {
      type: 'member.deactivated',
      message: 'Your account was deactivated by an organization admin.',
      entityType: 'member',
      entityId: memberId,
    });
  }

  return member;
}

export async function getDepartments(userId) {
  const { organizationId } = await getUserMembership(userId);
  const org = await prisma.organization.findFirst({ where: { id: organizationId }, select: { departments: true } });
  return org.departments;
}

export async function addDepartment(userId, name) {
  const { organizationId } = await getUserMembership(userId);
  const trimmed = name.trim();

  const org = await prisma.organization.findFirst({ where: { id: organizationId }, select: { departments: true } });
  if (org.departments.some((d) => d.toLowerCase() === trimmed.toLowerCase())) {
    throw new ConflictError('That department already exists');
  }

  const departments = [...org.departments, trimmed];
  await prisma.organization.update({ where: { id: organizationId }, data: { departments } });

  await logAuditSafely(userId, {
    action: 'team.department.create',
    entityType: 'organization',
    entityId: organizationId,
    metadata: { department: trimmed },
  });

  return departments;
}
