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

const mockSearchService = { search: jest.fn() };
jest.unstable_mockModule('../../services/searchService.js', () => mockSearchService);

jest.unstable_mockModule('../../services/auditLogService.js', () => ({
  logAuditSafely: jest.fn().mockResolvedValue(undefined),
}));

const { searchRouter } = await import('../../routes/search.js');
const { errorHandler } = await import('../../middleware/errorHandler.js');

const app = express();
app.use(express.json());
app.use('/api/search', searchRouter);
app.use(errorHandler);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });
});

describe('GET /api/search', () => {
  it('returns results for the given query (viewer has report:read)', async () => {
    mockSearchService.search.mockResolvedValue({ reports: [], members: [] });

    const res = await request(app).get('/api/search?q=bank');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reports: [], members: [] });
    expect(mockSearchService.search).toHaveBeenCalledWith(USER_ID, 'bank');
  });
});
