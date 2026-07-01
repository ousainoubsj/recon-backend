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
    expect(mockAuditLogService.listAuditLogs).toHaveBeenCalledWith(USER_ID);
  });

  it('rejects an analyst with a 403 (read is admin-only)', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'analyst' });

    const res = await request(app).get('/api/audit-logs');

    expect(res.status).toBe(403);
    expect(res.body.type).toBe('https://recon.app/errors/authorisation-error');
    expect(mockAuditLogService.listAuditLogs).not.toHaveBeenCalled();
  });

  it('rejects a viewer with a 403', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).get('/api/audit-logs');

    expect(res.status).toBe(403);
  });
});

describe('POST /api/audit-logs', () => {
  const body = { action: 'report.delete', entityType: 'report', entityId: '123e4567-e89b-12d3-a456-426614174000' };

  it('creates an entry for an admin', async () => {
    mockAuditLogService.createAuditLog.mockResolvedValue({ id: 'log-1' });

    const res = await request(app).post('/api/audit-logs').send(body);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'log-1' });
    expect(mockAuditLogService.createAuditLog).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ action: 'report.delete' }),
    );
  });

  it('creates an entry for an analyst (create is not admin-only)', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'analyst' });
    mockAuditLogService.createAuditLog.mockResolvedValue({ id: 'log-1' });

    const res = await request(app).post('/api/audit-logs').send(body);

    expect(res.status).toBe(201);
  });

  it('rejects a viewer with a 403', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).post('/api/audit-logs').send(body);

    expect(res.status).toBe(403);
    expect(mockAuditLogService.createAuditLog).not.toHaveBeenCalled();
  });

  it('rejects a body missing the required action field with a 422', async () => {
    const res = await request(app).post('/api/audit-logs').send({ entityType: 'report' });

    expect(res.status).toBe(422);
    expect(res.body.type).toBe('https://recon.app/errors/validation-error');
    expect(mockAuditLogService.createAuditLog).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid entityId with a 422', async () => {
    const res = await request(app)
      .post('/api/audit-logs')
      .send({ action: 'report.delete', entityId: 'not-a-uuid' });

    expect(res.status).toBe(422);
  });
});
