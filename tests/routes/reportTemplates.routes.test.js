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

const mockReportTemplateService = {
  listTemplates: jest.fn(),
  createTemplate: jest.fn(),
  deleteTemplate: jest.fn(),
};
jest.unstable_mockModule('../../services/reportTemplateService.js', () => mockReportTemplateService);

jest.unstable_mockModule('../../services/auditLogService.js', () => ({
  logAuditSafely: jest.fn().mockResolvedValue(undefined),
}));

const { reportTemplatesRouter } = await import('../../routes/reportTemplates.js');
const { errorHandler } = await import('../../middleware/errorHandler.js');
const { NotFoundError } = await import('../../errors.js');

const app = express();
app.use(express.json());
app.use('/api/report-templates', reportTemplatesRouter);
app.use(errorHandler);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });
});

describe('GET /api/report-templates', () => {
  it('lists visible templates', async () => {
    mockReportTemplateService.listTemplates.mockResolvedValue([{ id: 't1' }]);

    const res = await request(app).get('/api/report-templates');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 't1' }]);
    expect(mockReportTemplateService.listTemplates).toHaveBeenCalledWith(USER_ID);
  });
});

describe('POST /api/report-templates', () => {
  it('creates a custom template and returns 201', async () => {
    mockReportTemplateService.createTemplate.mockResolvedValue({ id: 't1', name: 'Custom' });

    const res = await request(app).post('/api/report-templates').send({ name: 'Custom' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 't1', name: 'Custom' });
    expect(mockReportTemplateService.createTemplate).toHaveBeenCalledWith(USER_ID, { name: 'Custom' });
  });

  it('rejects a missing name with a 422', async () => {
    const res = await request(app).post('/api/report-templates').send({});

    expect(res.status).toBe(422);
    expect(mockReportTemplateService.createTemplate).not.toHaveBeenCalled();
  });

  it('rejects a viewer with a 403', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).post('/api/report-templates').send({ name: 'Custom' });

    expect(res.status).toBe(403);
    expect(mockReportTemplateService.createTemplate).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/report-templates/:id', () => {
  it('deletes the template and returns 204', async () => {
    mockReportTemplateService.deleteTemplate.mockResolvedValue(undefined);

    const res = await request(app).delete('/api/report-templates/t1');

    expect(res.status).toBe(204);
    expect(mockReportTemplateService.deleteTemplate).toHaveBeenCalledWith(USER_ID, 't1');
  });

  it('returns a 404 RFC 7807 error for a system template or anything not owned', async () => {
    mockReportTemplateService.deleteTemplate.mockRejectedValue(new NotFoundError());

    const res = await request(app).delete('/api/report-templates/system-template');

    expect(res.status).toBe(404);
    expect(res.body.type).toBe('https://recon.app/errors/not-found');
  });
});
