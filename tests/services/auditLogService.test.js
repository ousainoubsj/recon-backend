import { jest } from '@jest/globals';

const mockPrisma = {
  auditLog: { create: jest.fn(), findMany: jest.fn() },
  member: { findFirst: jest.fn() },
};

jest.unstable_mockModule('../../db/index.js', () => ({ prisma: mockPrisma }));

const { createAuditLog, listAuditLogs, logAuditSafely } = await import(
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
        metadata: { reason: 'duplicate' },
      },
    });
  });

  it('defaults optional fields to null when omitted', async () => {
    mockPrisma.auditLog.create.mockResolvedValue({ id: 'log-1' });

    await createAuditLog(USER_ID, { action: 'sign-in' });

    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        organizationId: ORG_ID,
        action: 'sign-in',
        entityType: null,
        entityId: null,
        metadata: undefined,
      },
    });
  });
});

describe('listAuditLogs', () => {
  it('lists entries scoped to the organization, newest first', async () => {
    const logs = [{ id: 'log-1' }, { id: 'log-2' }];
    mockPrisma.auditLog.findMany.mockResolvedValue(logs);

    const result = await listAuditLogs(USER_ID);

    expect(result).toBe(logs);
    expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID },
      orderBy: { ts: 'desc' },
    });
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
