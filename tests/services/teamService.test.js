import { jest } from '@jest/globals';

const mockPrisma = {
  member: { findMany: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn(), count: jest.fn() },
  session: { updateMany: jest.fn() },
  $queryRaw: jest.fn().mockResolvedValue([]),
  invitation: { count: jest.fn(), findFirst: jest.fn() },
  organization: { findFirst: jest.fn(), update: jest.fn() },
  auditLog: { count: jest.fn() },
  $transaction: jest.fn((fn) => fn(mockPrisma)),
};

jest.unstable_mockModule('../../config/prisma.config.js', () => ({ prisma: mockPrisma }));

const mockLogAuditSafely = jest.fn().mockResolvedValue(undefined);
const mockCreateAuditLog = jest.fn().mockResolvedValue({ id: 'log-1' });
jest.unstable_mockModule('../../services/auditLogService.js', () => ({
  logAuditSafely: mockLogAuditSafely,
  createAuditLog: mockCreateAuditLog,
}));

const mockCreateNotification = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/notificationService.js', () => ({
  createNotification: mockCreateNotification,
}));

const mockMemberFindFirst = jest.fn();
jest.unstable_mockModule('../../services/organizationService.js', () => ({
  getUserMembership: mockMemberFindFirst,
}));

const { listMembers, getTeamStats, updateMember, updateMemberRole, removeMember, getDepartments, addDepartment, getInvitationPreview } = await import(
  '../../services/teamService.js'
);
const { NotFoundError, ConflictError } = await import('../../errors.js');

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

beforeEach(() => {
  jest.clearAllMocks();
  mockMemberFindFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'admin' });
});

describe('listMembers', () => {
  const USER_INCLUDE = { user: { select: { id: true, name: true, email: true, image: true } } };

  it('lists all org members, newest first, unbounded by default', async () => {
    const members = [{ id: 'm1' }, { id: 'm2' }];
    mockPrisma.member.findMany.mockResolvedValue(members);

    const result = await listMembers(USER_ID);

    expect(result).toBe(members);
    expect(mockPrisma.member.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID },
      include: USER_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  });

  it('passes take/skip through when limit/offset are given', async () => {
    mockPrisma.member.findMany.mockResolvedValue([]);

    await listMembers(USER_ID, { limit: 10, offset: 5 });

    expect(mockPrisma.member.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10, skip: 5 }),
    );
  });

  it('filters by q against the user name/email', async () => {
    mockPrisma.member.findMany.mockResolvedValue([]);

    await listMembers(USER_ID, { q: 'ousainou' });

    expect(mockPrisma.member.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG_ID,
          user: {
            OR: [
              { name: { contains: 'ousainou', mode: 'insensitive' } },
              { email: { contains: 'ousainou', mode: 'insensitive' } },
            ],
          },
        },
      }),
    );
  });

  it('filters by role, status, and department', async () => {
    mockPrisma.member.findMany.mockResolvedValue([]);

    await listMembers(USER_ID, { role: 'admin', status: 'active', department: 'IT' });

    expect(mockPrisma.member.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG_ID, role: 'admin', status: 'active', department: 'IT' },
      }),
    );
  });

  it('ignores an unrecognized status value', async () => {
    mockPrisma.member.findMany.mockResolvedValue([]);

    await listMembers(USER_ID, { status: 'not-a-real-status' });

    expect(mockPrisma.member.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG_ID } }),
    );
  });
});

describe('getTeamStats', () => {
  it('returns total/active/inactive/administrator/pending-invite/new/deactivated counts', async () => {
    mockPrisma.member.count
      .mockResolvedValueOnce(10) // total
      .mockResolvedValueOnce(8) // active
      .mockResolvedValueOnce(2) // administrators
      .mockResolvedValueOnce(4); // newThisMonth
    mockPrisma.invitation.count.mockResolvedValue(3);
    mockPrisma.auditLog.count.mockResolvedValue(1);

    const stats = await getTeamStats(USER_ID);

    expect(stats).toEqual({
      totalUsers: 10,
      activeUsers: 8,
      inactiveUsers: 2,
      administrators: 2,
      pendingInvites: 3,
      newThisMonth: 4,
      deactivatedThisMonth: 1,
    });
    expect(mockPrisma.member.count).toHaveBeenNthCalledWith(1, { where: { organizationId: ORG_ID } });
    expect(mockPrisma.member.count).toHaveBeenNthCalledWith(2, { where: { organizationId: ORG_ID, status: 'active' } });
    expect(mockPrisma.member.count).toHaveBeenNthCalledWith(3, { where: { organizationId: ORG_ID, role: 'admin' } });
    expect(mockPrisma.member.count).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG_ID, createdAt: expect.any(Object) }) }),
    );
    expect(mockPrisma.invitation.count).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, status: 'pending', expiresAt: { gt: expect.any(Date) } },
    });
    expect(mockPrisma.auditLog.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG_ID,
          action: 'member.update',
          metadata: { path: ['status'], equals: 'inactive' },
        }),
      }),
    );
  });
});

describe('updateMember', () => {
  it('updates department/status and audit-logs success when not deactivating someone else', async () => {
    const updated = { id: 'm1', userId: USER_ID, department: 'Finance', user: { name: 'Awa Ceesay', email: 'awa@example.com' } };
    mockPrisma.member.findFirst
      .mockResolvedValueOnce({ department: 'Operations', status: 'active' })
      .mockResolvedValueOnce(updated);
    mockPrisma.member.updateMany.mockResolvedValue({ count: 1 });

    const result = await updateMember(USER_ID, 'm1', { department: 'Finance' }, { ip: '10.0.0.1', userAgent: 'UA' });

    expect(result).toEqual(updated);
    expect(mockPrisma.member.updateMany).toHaveBeenCalledWith({
      where: { id: 'm1', organizationId: ORG_ID },
      data: { department: 'Finance' },
    });
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      USER_ID,
      {
        action: 'member.update',
        entityType: 'member',
        entityId: 'm1',
        status: 'success',
        ip: '10.0.0.1',
        userAgent: 'UA',
        metadata: {
          changes: { department: { from: 'Operations', to: 'Finance' } },
          subject: { name: 'Awa Ceesay', code: 'awa@example.com' },
        },
      },
      mockPrisma,
    );
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('logs a warning and notifies the affected member when deactivating someone else', async () => {
    mockPrisma.member.findFirst
      .mockResolvedValueOnce({ department: null, status: 'active' })
      .mockResolvedValueOnce({ id: 'm2', userId: 'user-2', user: { name: 'Lamin Jallow', email: 'lamin@example.com' } });
    mockPrisma.member.updateMany.mockResolvedValue({ count: 1 });

    await updateMember(USER_ID, 'm2', { status: 'inactive' });

    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        action: 'member.update',
        status: 'warning',
        metadata: {
          changes: { status: { from: 'active', to: 'inactive' } },
          subject: { name: 'Lamin Jallow', code: 'lamin@example.com' },
        },
      }),
      mockPrisma,
    );
    expect(mockCreateNotification).toHaveBeenCalledWith('user-2', {
      type: 'member.deactivated',
      message: 'Your account was deactivated by an organization admin.',
      entityType: 'member',
      entityId: 'm2',
    });
  });

  it('does not notify when deactivating your own membership', async () => {
    mockPrisma.member.findFirst
      .mockResolvedValueOnce({ department: null, status: 'active' })
      .mockResolvedValueOnce({ id: 'm1', userId: USER_ID, user: { name: 'Awa Ceesay', email: 'awa@example.com' } });
    mockPrisma.member.updateMany.mockResolvedValue({ count: 1 });

    await updateMember(USER_ID, 'm1', { status: 'inactive' });

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when the member does not exist in the org', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce(null);

    await expect(updateMember(USER_ID, 'missing', { department: 'IT' })).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.member.updateMany).not.toHaveBeenCalled();
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it('fails the whole update, and notifies no one, when the audit row cannot be written', async () => {
    mockPrisma.member.findFirst
      .mockResolvedValueOnce({ department: null, status: 'active' })
      .mockResolvedValueOnce({ id: 'm2', userId: 'user-2', user: { name: 'Lamin Jallow', email: 'lamin@example.com' } });
    mockPrisma.member.updateMany.mockResolvedValue({ count: 1 });
    mockCreateAuditLog.mockRejectedValueOnce(new Error('audit insert failed'));

    await expect(updateMember(USER_ID, 'm2', { status: 'inactive' })).rejects.toThrow('audit insert failed');
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});

describe('getDepartments', () => {
  it("returns the org's department list", async () => {
    mockPrisma.organization.findFirst.mockResolvedValue({ departments: ['Finance', 'Engineering'] });

    const result = await getDepartments(USER_ID);

    expect(result).toEqual(['Finance', 'Engineering']);
    expect(mockPrisma.organization.findFirst).toHaveBeenCalledWith({
      where: { id: ORG_ID },
      select: { departments: true },
    });
  });
});

describe('addDepartment', () => {
  it('appends the new department and audit-logs it', async () => {
    mockPrisma.organization.findFirst.mockResolvedValue({ departments: ['Finance'] });
    mockPrisma.organization.update.mockResolvedValue({});

    const result = await addDepartment(USER_ID, ' Engineering ');

    expect(result).toEqual(['Finance', 'Engineering']);
    expect(mockPrisma.organization.update).toHaveBeenCalledWith({
      where: { id: ORG_ID },
      data: { departments: ['Finance', 'Engineering'] },
    });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'team.department.create',
      entityType: 'organization',
      entityId: ORG_ID,
      metadata: { department: 'Engineering' },
    });
  });

  it('throws ConflictError on a case-insensitive duplicate and does not write', async () => {
    mockPrisma.organization.findFirst.mockResolvedValue({ departments: ['Finance'] });

    await expect(addDepartment(USER_ID, 'finance')).rejects.toBeInstanceOf(ConflictError);
    expect(mockPrisma.organization.update).not.toHaveBeenCalled();
    expect(mockLogAuditSafely).not.toHaveBeenCalled();
  });
});

describe('updateMember deactivation guard', () => {
  it('refuses to deactivate the last active admin, under the org lock', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce({ department: null, status: 'active', role: 'admin' });
    mockPrisma.member.count.mockResolvedValueOnce(1);

    await expect(updateMember(USER_ID, 'm1', { status: 'inactive' })).rejects.toBeInstanceOf(ConflictError);
    expect(mockPrisma.$queryRaw).toHaveBeenCalled();
    expect(mockPrisma.member.updateMany).not.toHaveBeenCalled();
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
  });

  it('allows deactivating an admin while another active admin remains', async () => {
    mockPrisma.member.findFirst
      .mockResolvedValueOnce({ department: null, status: 'active', role: 'admin' })
      .mockResolvedValueOnce({ id: 'm2', userId: 'user-2', user: { name: 'Awa', email: 'awa@example.com' } });
    mockPrisma.member.count.mockResolvedValueOnce(2);
    mockPrisma.member.updateMany.mockResolvedValue({ count: 1 });

    await updateMember(USER_ID, 'm2', { status: 'inactive' });

    expect(mockPrisma.member.updateMany).toHaveBeenCalled();
  });

  it('does not lock or check admins for a department-only edit', async () => {
    mockPrisma.member.findFirst
      .mockResolvedValueOnce({ department: null, status: 'active', role: 'admin' })
      .mockResolvedValueOnce({ id: 'm1', userId: USER_ID, user: { name: 'Awa', email: 'awa@example.com' } });
    mockPrisma.member.updateMany.mockResolvedValue({ count: 1 });

    await updateMember(USER_ID, 'm1', { department: 'Finance' });

    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
    expect(mockPrisma.member.count).not.toHaveBeenCalled();
  });
});

describe('updateMemberRole', () => {
  const analyst = { id: 'm2', userId: 'user-2', role: 'analyst', status: 'active', user: { name: 'Awa Ceesay', email: 'awa@example.com' } };

  it('locks the org, changes the role and writes the from/to audit row in the same transaction', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce(analyst);

    const result = await updateMemberRole(USER_ID, 'm2', 'admin', { ip: '10.0.0.1', userAgent: 'UA' });

    expect(result.role).toBe('admin');
    expect(mockPrisma.$queryRaw).toHaveBeenCalled();
    expect(mockPrisma.member.updateMany).toHaveBeenCalledWith({ where: { id: 'm2', organizationId: ORG_ID }, data: { role: 'admin' } });
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      USER_ID,
      {
        action: 'organization.member.role_update',
        entityType: 'member',
        entityId: 'm2',
        status: 'warning',
        ip: '10.0.0.1',
        userAgent: 'UA',
        metadata: { changes: { role: { from: 'analyst', to: 'admin' } }, subject: { name: 'Awa Ceesay', code: 'awa@example.com' } },
      },
      mockPrisma,
    );
    expect(mockCreateNotification).toHaveBeenCalledWith('user-2', expect.objectContaining({ type: 'member.role_changed' }));
  });

  it('writes nothing when the role is unchanged', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce(analyst);

    await updateMemberRole(USER_ID, 'm2', 'analyst');

    expect(mockPrisma.member.updateMany).not.toHaveBeenCalled();
    expect(mockCreateAuditLog).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('refuses to demote the last active admin', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce({ ...analyst, userId: USER_ID, role: 'admin' });
    mockPrisma.member.count.mockResolvedValueOnce(1);

    await expect(updateMemberRole(USER_ID, 'm2', 'viewer')).rejects.toBeInstanceOf(ConflictError);
    expect(mockPrisma.member.count).toHaveBeenCalledWith({ where: { organizationId: ORG_ID, role: 'admin', status: 'active' } });
    expect(mockPrisma.member.updateMany).not.toHaveBeenCalled();
  });

  it("404s for a member outside the caller's org", async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce(null);

    await expect(updateMemberRole(USER_ID, 'other-org', 'admin')).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.member.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'other-org', organizationId: ORG_ID } }));
  });

  it('notifies no one when the audit row fails, because the change rolls back with it', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce(analyst);
    mockCreateAuditLog.mockRejectedValueOnce(new Error('audit insert failed'));

    await expect(updateMemberRole(USER_ID, 'm2', 'admin')).rejects.toThrow('audit insert failed');
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });
});

describe('removeMember', () => {
  const viewer = { id: 'm3', userId: 'user-3', role: 'viewer', status: 'active', user: { name: 'Lamin Jallow', email: 'lamin@example.com' } };

  it('deletes the membership, clears their sessions pointing at the org, and audits in one transaction', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce(viewer);

    await removeMember(USER_ID, 'm3', { ip: '10.0.0.1', userAgent: 'UA' });

    expect(mockPrisma.member.deleteMany).toHaveBeenCalledWith({ where: { id: 'm3', organizationId: ORG_ID } });
    expect(mockPrisma.session.updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-3', activeOrganizationId: ORG_ID },
      data: { activeOrganizationId: null },
    });
    expect(mockCreateAuditLog).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        action: 'organization.member.remove',
        metadata: { role: 'viewer', subject: { name: 'Lamin Jallow', code: 'lamin@example.com' } },
      }),
      mockPrisma,
    );
  });

  it('refuses to remove the last active admin', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce({ ...viewer, role: 'admin' });
    mockPrisma.member.count.mockResolvedValueOnce(1);

    await expect(removeMember(USER_ID, 'm3')).rejects.toBeInstanceOf(ConflictError);
    expect(mockPrisma.member.deleteMany).not.toHaveBeenCalled();
  });

  it('allows removing an admin while another active admin remains', async () => {
    mockPrisma.member.findFirst.mockResolvedValueOnce({ ...viewer, role: 'admin' });
    mockPrisma.member.count.mockResolvedValueOnce(2);

    await removeMember(USER_ID, 'm3');

    expect(mockPrisma.member.deleteMany).toHaveBeenCalled();
  });
});

describe('getInvitationPreview', () => {
  it('looks up only a pending, unexpired invitation and returns the public fields', async () => {
    const expiresAt = new Date('2026-11-04T00:00:00Z');
    mockPrisma.invitation.findFirst.mockResolvedValue({
      email: 'invitee@example.com',
      role: 'viewer',
      expiresAt,
      organization: { name: 'Acme' },
      user: { name: '', email: 'admin@acme.com' },
    });

    const preview = await getInvitationPreview('inv-1');

    expect(mockPrisma.invitation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'inv-1', status: 'pending', expiresAt: { gt: expect.any(Date) } } }),
    );
    expect(preview).toEqual({
      email: 'invitee@example.com',
      role: 'viewer',
      expiresAt,
      organizationName: 'Acme',
      inviterName: 'admin@acme.com',
    });
  });

  it('throws NotFoundError when the invitation is unusable', async () => {
    mockPrisma.invitation.findFirst.mockResolvedValue(null);

    await expect(getInvitationPreview('inv-1')).rejects.toBeInstanceOf(NotFoundError);
  });
});
