import { jest } from '@jest/globals';

const mockPrisma = {
  member: { findMany: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn(), count: jest.fn() },
  invitation: { count: jest.fn() },
  organization: { findFirst: jest.fn(), update: jest.fn() },
  auditLog: { count: jest.fn() },
};

jest.unstable_mockModule('../../config/prisma.config.js', () => ({ prisma: mockPrisma }));

const mockLogAuditSafely = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/auditLogService.js', () => ({
  logAuditSafely: mockLogAuditSafely,
}));

const mockCreateNotification = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/notificationService.js', () => ({
  createNotification: mockCreateNotification,
}));

const mockMemberFindFirst = jest.fn();
jest.unstable_mockModule('../../services/organizationService.js', () => ({
  getUserMembership: mockMemberFindFirst,
}));

const { listMembers, getTeamStats, updateMember, getDepartments, addDepartment } = await import(
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
    expect(mockPrisma.invitation.count).toHaveBeenCalledWith({ where: { organizationId: ORG_ID, status: 'pending' } });
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
    mockPrisma.member.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.member.findFirst.mockResolvedValue({ id: 'm1', userId: USER_ID, department: 'Finance' });

    const result = await updateMember(USER_ID, 'm1', { department: 'Finance' });

    expect(result).toEqual({ id: 'm1', userId: USER_ID, department: 'Finance' });
    expect(mockPrisma.member.updateMany).toHaveBeenCalledWith({
      where: { id: 'm1', organizationId: ORG_ID },
      data: { department: 'Finance' },
    });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'member.update',
      entityType: 'member',
      entityId: 'm1',
      status: 'success',
      metadata: { department: 'Finance', status: undefined },
    });
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('logs a warning and notifies the affected member when deactivating someone else', async () => {
    mockPrisma.member.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.member.findFirst.mockResolvedValue({ id: 'm2', userId: 'user-2' });

    await updateMember(USER_ID, 'm2', { status: 'inactive' });

    expect(mockLogAuditSafely).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ action: 'member.update', status: 'warning' }),
    );
    expect(mockCreateNotification).toHaveBeenCalledWith('user-2', {
      type: 'member.deactivated',
      message: 'Your account was deactivated by an organization admin.',
      entityType: 'member',
      entityId: 'm2',
    });
  });

  it('does not notify when deactivating your own membership', async () => {
    mockPrisma.member.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.member.findFirst.mockResolvedValue({ id: 'm1', userId: USER_ID });

    await updateMember(USER_ID, 'm1', { status: 'inactive' });

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when the member does not exist in the org', async () => {
    mockPrisma.member.updateMany.mockResolvedValue({ count: 0 });

    await expect(updateMember(USER_ID, 'missing', { department: 'IT' })).rejects.toBeInstanceOf(NotFoundError);
    expect(mockLogAuditSafely).not.toHaveBeenCalled();
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
