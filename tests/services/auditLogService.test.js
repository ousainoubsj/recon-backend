import { jest } from '@jest/globals';

const mockPrisma = {
  auditLog: { create: jest.fn(), findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
  user: { findMany: jest.fn() },
  member: { findFirst: jest.fn() },
};

jest.unstable_mockModule('../../db/index.js', () => ({ prisma: mockPrisma }));

const { createAuditLog, listAuditLogs, logAuditSafely, getAuditLogStats, getTopActions, getTopUsers } = await import(
  '../../services/auditLogService.js'
);

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'admin' });
});

describe('createAuditLog', () => {
  it("creates an entry scoped to the user's organization", async () => {
    mockPrisma.auditLog.create.mockResolvedValue({ id: 'log-1' });

    const result = await createAuditLog(USER_ID, {
      action: 'report.delete',
      entityType: 'report',
      entityId: 'r1',
      status: 'warning',
      ip: '10.0.0.1',
      metadata: { reason: 'duplicate' },
    });

    expect(result).toEqual({ id: 'log-1' });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        organizationId: ORG_ID,
        action: 'report.delete',
        entityType: 'report',
        entityId: 'r1',
        status: 'warning',
        ip: '10.0.0.1',
        metadata: { reason: 'duplicate' },
      },
    });
  });

  it('defaults optional fields to null/success when omitted', async () => {
    mockPrisma.auditLog.create.mockResolvedValue({ id: 'log-1' });

    await createAuditLog(USER_ID, { action: 'sign-in' });

    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        organizationId: ORG_ID,
        action: 'sign-in',
        entityType: null,
        entityId: null,
        status: 'success',
        ip: null,
        metadata: undefined,
      },
    });
  });
});

describe('listAuditLogs', () => {
  const USER_INCLUDE = { user: { select: { name: true, email: true, image: true } } };

  it('lists entries scoped to the organization, newest first, unbounded by default', async () => {
    const logs = [{ id: 'log-1' }, { id: 'log-2' }];
    mockPrisma.auditLog.findMany.mockResolvedValue(logs);

    const result = await listAuditLogs(USER_ID);

    expect(result).toBe(logs);
    expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID },
      include: USER_INCLUDE,
      orderBy: { ts: 'desc' },
    });
  });

  it('passes take through when a limit is given', async () => {
    mockPrisma.auditLog.findMany.mockResolvedValue([]);

    await listAuditLogs(USER_ID, { limit: 50 });

    expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID },
      include: USER_INCLUDE,
      orderBy: { ts: 'desc' },
      take: 50,
    });
  });

  it('passes skip through when an offset is given', async () => {
    mockPrisma.auditLog.findMany.mockResolvedValue([]);

    await listAuditLogs(USER_ID, { offset: 20 });

    expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20 }));
  });

  it('filters by action, entityType, actorUserId, and status when given', async () => {
    mockPrisma.auditLog.findMany.mockResolvedValue([]);

    await listAuditLogs(USER_ID, {
      action: 'report.delete',
      entityType: 'report',
      actorUserId: 'user-2',
      status: 'failed',
    });

    expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG_ID,
          action: 'report.delete',
          entityType: 'report',
          userId: 'user-2',
          status: 'failed',
        },
      }),
    );
  });

  it('filters by a list of actions using an IN clause when action is an array', async () => {
    mockPrisma.auditLog.findMany.mockResolvedValue([]);

    await listAuditLogs(USER_ID, {
      action: ['settings.organization_info.update', 'organization.update'],
    });

    expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG_ID,
          action: { in: ['settings.organization_info.update', 'organization.update'] },
        },
      }),
    );
  });

  it('ignores an unrecognized status value', async () => {
    mockPrisma.auditLog.findMany.mockResolvedValue([]);

    await listAuditLogs(USER_ID, { status: 'not-a-real-status' });

    expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG_ID } }),
    );
  });

  it('filters by q against action or the acting user name/email', async () => {
    mockPrisma.auditLog.findMany.mockResolvedValue([]);

    await listAuditLogs(USER_ID, { q: 'delete' });

    expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG_ID,
          OR: [
            { action: { contains: 'delete', mode: 'insensitive' } },
            { user: { name: { contains: 'delete', mode: 'insensitive' } } },
            { user: { email: { contains: 'delete', mode: 'insensitive' } } },
          ],
        },
      }),
    );
  });

  it('filters by date range, ignoring an invalid date', async () => {
    mockPrisma.auditLog.findMany.mockResolvedValue([]);

    await listAuditLogs(USER_ID, { dateFrom: '2026-06-01', dateTo: '2026-06-30' });
    expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ts: { gte: new Date('2026-06-01'), lte: new Date('2026-06-30') } }),
      }),
    );

    mockPrisma.auditLog.findMany.mockClear();
    await listAuditLogs(USER_ID, { dateFrom: 'not-a-date' });
    expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG_ID } }),
    );
  });
});

describe('getAuditLogStats', () => {
  it('returns total, unique users, counts grouped by status, and 30-day trends', async () => {
    mockPrisma.auditLog.count
      .mockResolvedValueOnce(100) // total
      .mockResolvedValueOnce(60) // last30Count
      .mockResolvedValueOnce(40); // prev30Count
    mockPrisma.auditLog.findMany
      .mockResolvedValueOnce([{ userId: 'u1' }, { userId: 'u2' }]) // uniqueUsers (all-time)
      .mockResolvedValueOnce([{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }]) // last30Unique
      .mockResolvedValueOnce([{ userId: 'u1' }]); // prev30Unique
    mockPrisma.auditLog.groupBy.mockResolvedValue([
      { status: 'success', _count: 80 },
      { status: 'failed', _count: 5 },
      { status: 'warning', _count: 10 },
      { status: 'info', _count: 5 },
    ]);

    const stats = await getAuditLogStats(USER_ID);

    expect(stats).toEqual({
      total: 100,
      uniqueUsers: 2,
      byStatus: { success: 80, info: 5, warning: 10, failed: 5 },
      totalTrendPercent: 50,
      uniqueUsersTrend: 2,
    });
    expect(mockPrisma.auditLog.count).toHaveBeenNthCalledWith(1, { where: { organizationId: ORG_ID } });
    expect(mockPrisma.auditLog.count).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: expect.objectContaining({ organizationId: ORG_ID, ts: expect.any(Object) }) }),
    );
    expect(mockPrisma.auditLog.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { organizationId: ORG_ID },
      _count: true,
    });
  });

  it('defaults missing statuses to 0', async () => {
    mockPrisma.auditLog.count.mockResolvedValue(1);
    mockPrisma.auditLog.findMany.mockResolvedValue([{ userId: 'u1' }]);
    mockPrisma.auditLog.groupBy.mockResolvedValue([{ status: 'success', _count: 1 }]);

    const stats = await getAuditLogStats(USER_ID);

    expect(stats.byStatus).toEqual({ success: 1, info: 0, warning: 0, failed: 0 });
  });

  it('returns null totalTrendPercent when there is no prior-30-day activity to compare against', async () => {
    mockPrisma.auditLog.count
      .mockResolvedValueOnce(10) // total
      .mockResolvedValueOnce(10) // last30Count
      .mockResolvedValueOnce(0); // prev30Count
    mockPrisma.auditLog.findMany.mockResolvedValue([]);
    mockPrisma.auditLog.groupBy.mockResolvedValue([]);

    const stats = await getAuditLogStats(USER_ID);

    expect(stats.totalTrendPercent).toBeNull();
  });
});

describe('getTopActions', () => {
  it('returns the top actions by count, no remainder bucket', async () => {
    mockPrisma.auditLog.groupBy.mockResolvedValue([
      { action: 'report.create', _count: 10 },
      { action: 'report.export', _count: 5 },
    ]);

    const actions = await getTopActions(USER_ID, { limit: 5 });

    expect(actions).toEqual([
      { label: 'report.create', count: 10 },
      { label: 'report.export', count: 5 },
    ]);
    expect(mockPrisma.auditLog.groupBy).toHaveBeenCalledWith({
      by: ['action'],
      where: { organizationId: ORG_ID },
      _count: true,
      orderBy: { _count: { action: 'desc' } },
      take: 5,
    });
  });
});

describe('getTopUsers', () => {
  it('joins user names and appends an "Other Users" remainder bucket', async () => {
    mockPrisma.auditLog.count.mockResolvedValue(30);
    mockPrisma.auditLog.groupBy.mockResolvedValue([
      { userId: 'u1', _count: 15 },
      { userId: 'u2', _count: 5 },
    ]);
    mockPrisma.user.findMany.mockResolvedValue([
      { id: 'u1', name: 'Ousainou J.' },
      { id: 'u2', name: 'Amie J.' },
    ]);

    const users = await getTopUsers(USER_ID, { limit: 2 });

    expect(users).toEqual([
      { name: 'Ousainou J.', count: 15 },
      { name: 'Amie J.', count: 5 },
      { name: 'Other Users', count: 10 },
    ]);
  });

  it('omits the remainder bucket when the top group already covers the total', async () => {
    mockPrisma.auditLog.count.mockResolvedValue(15);
    mockPrisma.auditLog.groupBy.mockResolvedValue([{ userId: 'u1', _count: 15 }]);
    mockPrisma.user.findMany.mockResolvedValue([{ id: 'u1', name: 'Ousainou J.' }]);

    const users = await getTopUsers(USER_ID, { limit: 5 });

    expect(users).toEqual([{ name: 'Ousainou J.', count: 15 }]);
  });
});

describe('logAuditSafely', () => {
  it('resolves normally when the write succeeds', async () => {
    mockPrisma.auditLog.create.mockResolvedValue({ id: 'log-1' });

    await expect(logAuditSafely(USER_ID, { action: 'report.create', entityId: 'r1' })).resolves.toBeUndefined();
  });

  it('swallows and logs the error instead of throwing when the write fails', async () => {
    mockPrisma.auditLog.create.mockRejectedValue(new Error('db unavailable'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      logAuditSafely(USER_ID, { action: 'report.create', entityId: 'r1' }),
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });
});
