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

const mockLogAuditSafely = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/auditLogService.js', () => ({
  logAuditSafely: mockLogAuditSafely,
}));

const mockTeamService = {
  listMembers: jest.fn(),
  getTeamStats: jest.fn(),
  updateMember: jest.fn(),
};
jest.unstable_mockModule('../../services/teamService.js', () => mockTeamService);

const { teamRouter } = await import('../../routes/team.js');
const { errorHandler } = await import('../../middleware/errorHandler.js');
const { NotFoundError } = await import('../../errors.js');

const app = express();
app.use(express.json());
app.use('/api/team', teamRouter);
app.use(errorHandler);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });
});

describe('GET /api/team/members', () => {
  it("returns the org's members, unbounded by default", async () => {
    mockTeamService.listMembers.mockResolvedValue([{ id: 'm1' }]);

    const res = await request(app).get('/api/team/members');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'm1' }]);
    expect(mockTeamService.listMembers).toHaveBeenCalledWith(USER_ID, {
      limit: undefined,
      offset: undefined,
      q: undefined,
      role: undefined,
      status: undefined,
      department: undefined,
    });
  });

  it('passes ?q=, ?role=, ?status=, ?department=, ?limit=, ?offset= through', async () => {
    mockTeamService.listMembers.mockResolvedValue([]);

    await request(app).get('/api/team/members?q=ousainou&role=admin&status=active&department=IT&limit=5&offset=1');

    expect(mockTeamService.listMembers).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        q: 'ousainou',
        role: 'admin',
        status: 'active',
        department: 'IT',
        limit: 5,
        offset: 1,
      }),
    );
  });

  it('is allowed for a viewer (member:read is granted to all three roles)', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });
    mockTeamService.listMembers.mockResolvedValue([]);

    const res = await request(app).get('/api/team/members');

    expect(res.status).toBe(200);
  });
});

describe('GET /api/team/stats', () => {
  it("returns the org's team stats", async () => {
    const stats = { totalUsers: 10, activeUsers: 8, inactiveUsers: 2, administrators: 2, pendingInvites: 1 };
    mockTeamService.getTeamStats.mockResolvedValue(stats);

    const res = await request(app).get('/api/team/stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(stats);
    expect(mockTeamService.getTeamStats).toHaveBeenCalledWith(USER_ID);
  });

  it('is allowed for an analyst', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'analyst' });
    mockTeamService.getTeamStats.mockResolvedValue({});

    const res = await request(app).get('/api/team/stats');

    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/team/members/:id', () => {
  it('updates a member and returns it', async () => {
    mockTeamService.updateMember.mockResolvedValue({ id: 'm1', status: 'inactive' });

    const res = await request(app).patch('/api/team/members/m1').send({ status: 'inactive' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'm1', status: 'inactive' });
    expect(mockTeamService.updateMember).toHaveBeenCalledWith(USER_ID, 'm1', { status: 'inactive' });
  });

  it('accepts department alone', async () => {
    mockTeamService.updateMember.mockResolvedValue({ id: 'm1', department: 'Finance' });

    const res = await request(app).patch('/api/team/members/m1').send({ department: 'Finance' });

    expect(res.status).toBe(200);
    expect(mockTeamService.updateMember).toHaveBeenCalledWith(USER_ID, 'm1', { department: 'Finance' });
  });

  it('rejects an invalid status value with a 422', async () => {
    const res = await request(app).patch('/api/team/members/m1').send({ status: 'banned' });

    expect(res.status).toBe(422);
    expect(mockTeamService.updateMember).not.toHaveBeenCalled();
  });

  it('returns an RFC 7807 404 when the member does not exist in the org', async () => {
    mockTeamService.updateMember.mockRejectedValue(new NotFoundError());

    const res = await request(app).patch('/api/team/members/missing').send({ status: 'active' });

    expect(res.status).toBe(404);
  });

  it('rejects a non-admin with a 403 RFC 7807 error and logs the denial', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'analyst' });

    const res = await request(app).patch('/api/team/members/m1').send({ status: 'inactive' });

    expect(res.status).toBe(403);
    expect(res.body.type).toBe('https://recon.app/errors/authorisation-error');
    expect(mockTeamService.updateMember).not.toHaveBeenCalled();
    expect(mockLogAuditSafely).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ action: 'member.update.denied', status: 'failed' }),
    );
  });

  it('rejects an inactive admin (deactivated members lose all access, regardless of role)', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin', status: 'inactive' });

    const res = await request(app).patch('/api/team/members/m1').send({ status: 'active' });

    expect(res.status).toBe(403);
    expect(mockLogAuditSafely).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ metadata: { role: 'admin', reason: 'inactive' } }),
    );
  });
});
