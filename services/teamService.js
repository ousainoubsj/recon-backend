import { prisma } from '../config/prisma.config.js';
import { ConflictError, NotFoundError } from '../errors.js';
import { getUserMembership } from './organizationService.js';
import { createAuditLog, logAuditSafely } from './auditLogService.js';
import { withSubject } from '../utils/audit.js';
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
    // Better Auth never flips an expired invitation's status, so expiry is checked here.
    prisma.invitation.count({ where: { organizationId, status: 'pending', expiresAt: { gt: new Date() } } }),
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

// Serializes every role change, removal and deactivation in one org, so two admins demoting each other at once
// can't both pass the last-admin check and leave the org without one.
async function lockOrganization(tx, organizationId) {
  await tx.$queryRaw`SELECT id FROM "organization" WHERE id = ${organizationId} FOR UPDATE`;
}

async function assertNotLastActiveAdmin(tx, organizationId, member) {
  if (member.role !== 'admin' || member.status !== 'active') return;
  const activeAdmins = await tx.member.count({ where: { organizationId, role: 'admin', status: 'active' } });
  if (activeAdmins <= 1) throw new ConflictError('The organization needs at least one active administrator');
}

// Deactivating someone is a sensitive action (same reasoning as §5's
// role_update/remove) — audited as a warning, not a plain success, and the
// affected member is notified, mirroring the existing role_changed pattern.
export async function updateMember(userId, memberId, { department, status }, { ip, userAgent } = {}) {
  const { organizationId } = await getUserMembership(userId);

  // Deactivation revokes access, so its audit row commits or rolls back with the change itself.
  const member = await prisma.$transaction(async (tx) => {
    if (status === 'inactive') await lockOrganization(tx, organizationId);
    const before = await tx.member.findFirst({
      where: { id: memberId, organizationId },
      select: { department: true, status: true, role: true },
    });
    if (!before) throw new NotFoundError();
    if (status === 'inactive') await assertNotLastActiveAdmin(tx, organizationId, before);

    await tx.member.updateMany({
      where: { id: memberId, organizationId },
      data: {
        ...(department !== undefined ? { department } : {}),
        ...(status !== undefined ? { status } : {}),
      },
    });

    const updated = await tx.member.findFirst({
      where: { id: memberId, organizationId },
      include: { user: { select: { name: true, email: true, image: true } } },
    });

    const changes = {};
    if (department !== undefined && department !== before.department) changes.department = { from: before.department, to: department };
    if (status !== undefined && status !== before.status) changes.status = { from: before.status, to: status };

    await createAuditLog(
      userId,
      {
        action: 'member.update',
        entityType: 'member',
        entityId: memberId,
        status: status === 'inactive' ? 'warning' : 'success',
        ip,
        userAgent,
        metadata: withSubject({ changes }, { name: updated.user.name, code: updated.user.email }),
      },
      tx,
    );

    return updated;
  });

  const isDeactivating = status === 'inactive' && member.userId !== userId;
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

// Owned here rather than by Better Auth's /organization/update-member-role (blocked in auth.js) so the
// change, its previous value and its audit row commit in one transaction.
export async function updateMemberRole(userId, memberId, role, { ip, userAgent } = {}) {
  const { organizationId } = await getUserMembership(userId);

  const result = await prisma.$transaction(async (tx) => {
    await lockOrganization(tx, organizationId);
    const member = await tx.member.findFirst({
      where: { id: memberId, organizationId },
      include: { user: { select: { name: true, email: true, image: true } } },
    });
    if (!member) throw new NotFoundError();
    if (member.role === role) return { member, changed: false };

    if (role !== 'admin') await assertNotLastActiveAdmin(tx, organizationId, member);

    await tx.member.updateMany({ where: { id: memberId, organizationId }, data: { role } });
    await createAuditLog(
      userId,
      {
        action: 'organization.member.role_update',
        entityType: 'member',
        entityId: memberId,
        status: 'warning',
        ip,
        userAgent,
        metadata: withSubject({ changes: { role: { from: member.role, to: role } } }, { name: member.user.name, code: member.user.email }),
      },
      tx,
    );
    return { member: { ...member, role }, changed: true };
  });

  if (result.changed && result.member.userId !== userId) {
    await createNotification(result.member.userId, {
      type: 'member.role_changed',
      message: `Your role was changed to ${role}.`,
      entityType: 'member',
      entityId: memberId,
    });
  }

  return result.member;
}

// Same reasoning as updateMemberRole: replaces Better Auth's /organization/remove-member.
export async function removeMember(userId, memberId, { ip, userAgent } = {}) {
  const { organizationId } = await getUserMembership(userId);

  await prisma.$transaction(async (tx) => {
    await lockOrganization(tx, organizationId);
    const member = await tx.member.findFirst({
      where: { id: memberId, organizationId },
      include: { user: { select: { name: true, email: true } } },
    });
    if (!member) throw new NotFoundError();

    await assertNotLastActiveAdmin(tx, organizationId, member);

    await tx.member.deleteMany({ where: { id: memberId, organizationId } });
    // Better Auth only reset the remover's own session; any session of the removed user still pointing here is stale.
    await tx.session.updateMany({
      where: { userId: member.userId, activeOrganizationId: organizationId },
      data: { activeOrganizationId: null },
    });
    await createAuditLog(
      userId,
      {
        action: 'organization.member.remove',
        entityType: 'member',
        entityId: memberId,
        status: 'warning',
        ip,
        userAgent,
        metadata: withSubject({ role: member.role }, { name: member.user.name, code: member.user.email }),
      },
      tx,
    );
  });
}

export async function getDepartments(userId) {
  const { organizationId } = await getUserMembership(userId);
  const org = await prisma.organization.findFirst({ where: { id: organizationId }, select: { departments: true } });
  return org.departments;
}

export async function addDepartment(userId, name, { ip, userAgent } = {}) {
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
    ip,
    userAgent,
    metadata: { department: trimmed },
  });

  return departments;
}
