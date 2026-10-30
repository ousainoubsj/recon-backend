import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

let mockSessionUser;
jest.unstable_mockModule('../../middleware/authenticate.js', () => ({
  authenticate: (req, res, next) => {
    req.session = { user: mockSessionUser };
    next();
  },
}));

const mockPlatform = {
  listCompanies: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  getCompany: jest.fn(),
  createCompany: jest.fn().mockResolvedValue({ id: 'org-a' }),
  updateCompany: jest.fn(),
  setCompanyStatus: jest.fn().mockResolvedValue({ id: 'org-a' }),
  inviteCompanyUser: jest.fn(),
  enterCompany: jest.fn().mockResolvedValue({ organizationId: 'org-a', name: 'Atlantic' }),
  exitCompany: jest.fn(),
  listPlatformAdmins: jest.fn().mockResolvedValue({ items: [], total: 0 }),
  invitePlatformAdmin: jest.fn(),
  setPlatformAdminStatus: jest.fn(),
  getAdminCompanies: jest.fn(),
  setAdminCompanies: jest.fn(),
};
jest.unstable_mockModule('../../services/platformService.js', () => mockPlatform);

const { superAdminRouter } = await import('../../routes/superAdmin.js');
const { errorHandler } = await import('../../middleware/errorHandler.js');

const app = express();
app.use(express.json());
app.use('/api/super-admin', superAdminRouter);
app.use(errorHandler);

const OWNER = { id: 'owner-1', platformRole: 'owner', platformStatus: 'active' };
const ADMIN = { id: 'admin-1', platformRole: 'admin', platformStatus: 'active' };
const CUSTOMER = { id: 'user-1', platformRole: null, platformStatus: null };
const ORG_ID = 'KO7JrBniBUSRZrPHV71dy7qRWBdK6cS3';

const COMPANY_ROUTES = [
  ['get', '/api/super-admin/companies'],
  ['get', `/api/super-admin/companies/${ORG_ID}`],
  ['post', '/api/super-admin/companies'],
  ['patch', `/api/super-admin/companies/${ORG_ID}`],
  ['post', `/api/super-admin/companies/${ORG_ID}/suspend`],
  ['post', `/api/super-admin/companies/${ORG_ID}/activate`],
  ['post', `/api/super-admin/companies/${ORG_ID}/invitations`],
  ['post', `/api/super-admin/companies/${ORG_ID}/enter`],
  ['post', '/api/super-admin/exit'],
];
const OWNER_ROUTES = [
  ['get', '/api/super-admin/admins'],
  ['post', '/api/super-admin/admins'],
  ['post', '/api/super-admin/admins/admin-2/suspend'],
  ['post', '/api/super-admin/admins/admin-2/activate'],
  ['delete', '/api/super-admin/admins/admin-2'],
  ['get', '/api/super-admin/admins/admin-2/companies'],
  ['put', '/api/super-admin/admins/admin-2/companies'],
];

beforeEach(() => {
  jest.clearAllMocks();
  mockSessionUser = OWNER;
});

describe('gates', () => {
  it.each([...COMPANY_ROUTES, ...OWNER_ROUTES])('a customer user gets 403 on %s %s', async (method, path) => {
    mockSessionUser = CUSTOMER;
    const res = await request(app)[method](path).send({});
    expect(res.status).toBe(403);
  });

  it.each(OWNER_ROUTES)('a platform admin gets 403 on owner-only %s %s', async (method, path) => {
    mockSessionUser = ADMIN;
    const res = await request(app)[method](path).send({});
    expect(res.status).toBe(403);
  });

  it('a suspended owner gets 403', async () => {
    mockSessionUser = { ...OWNER, platformStatus: 'suspended' };
    const res = await request(app).get('/api/super-admin/companies');
    expect(res.status).toBe(403);
    expect(mockPlatform.listCompanies).not.toHaveBeenCalled();
  });

  it('404s a malformed company id before the service', async () => {
    const res = await request(app).post('/api/super-admin/companies/bad%20id!/enter');
    expect(res.status).toBe(404);
    expect(mockPlatform.enterCompany).not.toHaveBeenCalled();
  });
});

describe('companies', () => {
  it('passes the session user, filters and capped paging to the service', async () => {
    mockSessionUser = ADMIN;
    await request(app).get('/api/super-admin/companies?q=%20atl%20&status=suspended&offset=16&limit=500');

    expect(mockPlatform.listCompanies).toHaveBeenCalledWith(ADMIN, { q: 'atl', status: 'suspended', offset: 16, limit: 100 });
  });

  it('422s an unknown status filter', async () => {
    const res = await request(app).get('/api/super-admin/companies?status=deleted');
    expect(res.status).toBe(422);
  });

  it('creates a company: 201, and 422 for a bad email', async () => {
    const ok = await request(app).post('/api/super-admin/companies').send({ name: 'Atlantic', firstAdminEmail: 'lead@atlantic.com' });
    const bad = await request(app).post('/api/super-admin/companies').send({ name: 'Atlantic', firstAdminEmail: 'nope' });

    expect(ok.status).toBe(201);
    expect(bad.status).toBe(422);
    expect(mockPlatform.createCompany).toHaveBeenCalledTimes(1);
  });

  it('suspend and activate map to the service status', async () => {
    await request(app).post(`/api/super-admin/companies/${ORG_ID}/suspend`);
    await request(app).post(`/api/super-admin/companies/${ORG_ID}/activate`);

    expect(mockPlatform.setCompanyStatus.mock.calls.map((c) => c[2])).toEqual(['suspended', 'active']);
  });

  it('invites with a member role only', async () => {
    const res = await request(app).post(`/api/super-admin/companies/${ORG_ID}/invitations`).send({ email: 'a@b.co', role: 'owner' });
    expect(res.status).toBe(422);
  });

  it('enter returns the company; exit is 204 for the caller', async () => {
    mockSessionUser = ADMIN;
    const entered = await request(app).post(`/api/super-admin/companies/${ORG_ID}/enter`);
    const exited = await request(app).post('/api/super-admin/exit');

    expect(entered.body).toEqual({ organizationId: 'org-a', name: 'Atlantic' });
    expect(exited.status).toBe(204);
    expect(mockPlatform.exitCompany).toHaveBeenCalledWith(ADMIN.id);
  });
});

describe('platform admins (owner)', () => {
  it('suspend, activate and remove map to the service status', async () => {
    await request(app).post('/api/super-admin/admins/admin-2/suspend');
    await request(app).post('/api/super-admin/admins/admin-2/activate');
    const removed = await request(app).delete('/api/super-admin/admins/admin-2');

    expect(removed.status).toBe(204);
    expect(mockPlatform.setPlatformAdminStatus.mock.calls.map((c) => c[2])).toEqual(['suspended', 'active', 'removed']);
  });

  it('accepts an empty assignment list and 422s a non-array', async () => {
    mockPlatform.setAdminCompanies.mockResolvedValue({ organizationIds: [] });
    const ok = await request(app).put('/api/super-admin/admins/admin-2/companies').send({ organizationIds: [] });
    const bad = await request(app).put('/api/super-admin/admins/admin-2/companies').send({ organizationIds: 'org-a' });

    expect(ok.status).toBe(200);
    expect(bad.status).toBe(422);
  });
});
