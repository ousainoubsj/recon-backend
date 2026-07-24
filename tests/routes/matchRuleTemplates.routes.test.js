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

const mockMatchRuleTemplateService = {
  listTemplates: jest.fn(),
  createTemplate: jest.fn(),
  deleteTemplate: jest.fn(),
};
jest.unstable_mockModule('../../services/matchRuleTemplateService.js', () => mockMatchRuleTemplateService);

jest.unstable_mockModule('../../services/auditLogService.js', () => ({
  logAuditSafely: jest.fn().mockResolvedValue(undefined),
}));

const { matchRuleTemplatesRouter } = await import('../../routes/matchRuleTemplates.js');
const { errorHandler } = await import('../../middleware/errorHandler.js');
const { NotFoundError } = await import('../../errors.js');

const app = express();
app.use(express.json());
app.use('/api/match-rule-templates', matchRuleTemplatesRouter);
app.use(errorHandler);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });
});

describe('GET /api/match-rule-templates', () => {
  it("lists the caller's templates", async () => {
    mockMatchRuleTemplateService.listTemplates.mockResolvedValue([{ id: 't1' }]);

    const res = await request(app).get('/api/match-rule-templates');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 't1' }]);
    expect(mockMatchRuleTemplateService.listTemplates).toHaveBeenCalledWith(USER_ID);
  });
});

describe('POST /api/match-rule-templates', () => {
  const validBody = { name: 'Bank Recon Rules', config: { amountTolerance: 0.5, dateToleranceDays: 1 } };

  it('creates a template and returns 201', async () => {
    mockMatchRuleTemplateService.createTemplate.mockResolvedValue({ id: 't1', name: 'Bank Recon Rules' });

    const res = await request(app).post('/api/match-rule-templates').send(validBody);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 't1', name: 'Bank Recon Rules' });
    expect(mockMatchRuleTemplateService.createTemplate).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ name: 'Bank Recon Rules', config: expect.objectContaining(validBody.config) }),
    );
  });

  it('rejects a missing name with a 422', async () => {
    const res = await request(app).post('/api/match-rule-templates').send({ config: validBody.config });

    expect(res.status).toBe(422);
    expect(mockMatchRuleTemplateService.createTemplate).not.toHaveBeenCalled();
  });

  it('rejects a missing config with a 422', async () => {
    const res = await request(app).post('/api/match-rule-templates').send({ name: 'x' });

    expect(res.status).toBe(422);
    expect(mockMatchRuleTemplateService.createTemplate).not.toHaveBeenCalled();
  });

  it('rejects a viewer with a 403', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).post('/api/match-rule-templates').send(validBody);

    expect(res.status).toBe(403);
    expect(mockMatchRuleTemplateService.createTemplate).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/match-rule-templates/:id', () => {
  it('deletes the template and returns 204', async () => {
    mockMatchRuleTemplateService.deleteTemplate.mockResolvedValue(undefined);

    const res = await request(app).delete('/api/match-rule-templates/t1');

    expect(res.status).toBe(204);
    expect(mockMatchRuleTemplateService.deleteTemplate).toHaveBeenCalledWith(USER_ID, 't1');
  });

  it("returns a 404 RFC 7807 error for another user's template", async () => {
    mockMatchRuleTemplateService.deleteTemplate.mockRejectedValue(new NotFoundError());

    const res = await request(app).delete('/api/match-rule-templates/not-mine');

    expect(res.status).toBe(404);
    expect(res.body.type).toBe('https://recon.app/errors/not-found');
  });
});
