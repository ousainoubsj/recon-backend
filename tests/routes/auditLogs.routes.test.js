import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const USER_ID = 'user-1';

jest.unstable_mockModule('../../middleware/authenticate.js', () => ({
  authenticate: (req, res, next) => {
    req.session = { user: { id: USER_ID } };
    next();
  },
}));

const mockGetUserMembership = jest.fn();
jest.unstable_mockModule('../../services/organizationService.js', () => ({
  getUserMembership: mockGetUserMembership,
}));

const mockAuditLogService = {
  listAuditLogs: jest.fn(),
  createAuditLog: jest.fn(),
  logAuditSafely: jest.fn().mockResolvedValue(undefined),
  logAuditOnce: jest.fn().mockResolvedValue(undefined),
  getAuditLogStats: jest.fn(),
  getTopActions: jest.fn(),
  getTopUsers: jest.fn(),
};
jest.unstable_mockModule('../../services/auditLogService.js', () => mockAuditLogService);

const { auditLogsRouter } = await import('../../routes/auditLogs.js');
const { errorHandler } = await import('../../middleware/errorHandler.js');

const app = express();
app.use(express.json());
app.use('/api/audit-logs', auditLogsRouter);
app.use(errorHandler);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });
});

describe('GET /api/audit-logs', () => {
  it('returns the org audit log for an admin', async () => {
    mockAuditLogService.listAuditLogs.mockResolvedValue([{ id: 'log-1' }]);

    const res = await request(app).get('/api/audit-logs');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'log-1' }]);
    expect(mockAuditLogService.listAuditLogs).toHaveBeenCalledWith(USER_ID, {
      limit: 50,
      offset: undefined,
      q: undefined,
      action: undefined,
      entityType: undefined,
      actorUserId: undefined,
      dateFrom: undefined,
      dateTo: undefined,
      status: undefined,
    });
  });

  it('caps ?limit= at 200', async () => {
    mockAuditLogService.listAuditLogs.mockResolvedValue([]);

    await request(app).get('/api/audit-logs?limit=5000');

    expect(mockAuditLogService.listAuditLogs).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ limit: 200 }));
  });

  it('passes a valid ?limit= through', async () => {
    mockAuditLogService.listAuditLogs.mockResolvedValue([]);

    await request(app).get('/api/audit-logs?limit=20');

    expect(mockAuditLogService.listAuditLogs).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ limit: 20 }));
  });

  it('passes ?offset=, ?q=, ?action=, ?entityType=, ?userId=, ?dateFrom=, ?dateTo=, ?status= through', async () => {
    mockAuditLogService.listAuditLogs.mockResolvedValue([]);

    await request(app).get(
      '/api/audit-logs?offset=10&q=delete&action=report.delete&entityType=report&userId=user-2&dateFrom=2026-06-01&dateTo=2026-06-30&status=failed',
    );

    expect(mockAuditLogService.listAuditLogs).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        offset: 10,
        q: 'delete',
        action: 'report.delete',
        entityType: 'report',
        actorUserId: 'user-2',
        dateFrom: '2026-06-01',
        dateTo: '2026-06-30',
        status: 'failed',
      }),
    );
  });

  it('rejects an analyst with a 403 (read is admin-only)', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'analyst' });

    const res = await request(app).get('/api/audit-logs');

    expect(res.status).toBe(403);
    expect(res.body.type).toBe('https://recon.app/errors/authorisation-error');
    expect(mockAuditLogService.listAuditLogs).not.toHaveBeenCalled();
    expect(mockAuditLogService.logAuditOnce).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ action: 'auditLog.read.denied', status: 'failed' }),
      expect.any(Number),
    );
  });

  it('rejects a viewer with a 403', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).get('/api/audit-logs');

    expect(res.status).toBe(403);
  });
});

describe('GET /api/audit-logs/stats', () => {
  it("returns the org's audit stats for an admin", async () => {
    const stats = { total: 100, uniqueUsers: 5, byStatus: { success: 80, info: 10, warning: 5, failed: 5 } };
    mockAuditLogService.getAuditLogStats.mockResolvedValue(stats);

    const res = await request(app).get('/api/audit-logs/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(stats);
    expect(mockAuditLogService.getAuditLogStats).toHaveBeenCalledWith(USER_ID);
  });

  it('rejects a viewer with a 403', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).get('/api/audit-logs/stats');

    expect(res.status).toBe(403);
  });
});

describe('GET /api/audit-logs/top-actions', () => {
  it('returns the top actions for an admin', async () => {
    const actions = [{ label: 'report.create', count: 10 }];
    mockAuditLogService.getTopActions.mockResolvedValue(actions);

    const res = await request(app).get('/api/audit-logs/top-actions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(actions);
    expect(mockAuditLogService.getTopActions).toHaveBeenCalledWith(USER_ID);
  });
});

describe('GET /api/audit-logs/top-users', () => {
  it('returns the top users for an admin', async () => {
    const users = [{ name: 'Ousainou J.', count: 10 }];
    mockAuditLogService.getTopUsers.mockResolvedValue(users);

    const res = await request(app).get('/api/audit-logs/top-users');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(users);
    expect(mockAuditLogService.getTopUsers).toHaveBeenCalledWith(USER_ID);
  });
});

describe('GET /api/audit-logs/mine', () => {
  it("returns a viewer's own activity, forcing the actor filter to the caller", async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer', status: 'active' });
    mockAuditLogService.listAuditLogs.mockResolvedValue([{ id: 'log-1' }]);

    const res = await request(app).get('/api/audit-logs/mine?limit=6&userId=someone-else');

    expect(res.status).toBe(200);
    expect(mockAuditLogService.listAuditLogs).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ actorUserId: USER_ID, limit: 6 }));
  });

  it('refuses an inactive member', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer', status: 'inactive' });

    const res = await request(app).get('/api/audit-logs/mine');

    expect(res.status).toBe(403);
    expect(mockAuditLogService.listAuditLogs).not.toHaveBeenCalled();
  });

  it("still refuses a viewer the org-wide feed", async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer', status: 'active' });

    const res = await request(app).get('/api/audit-logs');

    expect(res.status).toBe(403);
  });
});

describe('POST /api/audit-logs', () => {
  it('no longer exists — audit entries are only written server-side', async () => {
    const res = await request(app).post('/api/audit-logs').send({ action: 'report.delete' });

    expect(res.status).toBe(404);
    expect(mockAuditLogService.createAuditLog).not.toHaveBeenCalled();
  });
});
