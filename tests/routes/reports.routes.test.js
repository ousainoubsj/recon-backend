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

const mockReportService = {
  listReports: jest.fn(),
  saveReport: jest.fn(),
  getReport: jest.fn(),
  deleteReport: jest.fn(),
  getReportsSummary: jest.fn(),
  getReportsTrend: jest.fn(),
  saveDraft: jest.fn(),
  updateDraft: jest.fn(),
  listDrafts: jest.fn(),
  completeDraft: jest.fn(),
};

jest.unstable_mockModule('../../services/reportService.js', () => mockReportService);

jest.unstable_mockModule('../../services/auditLogService.js', () => ({
  logAuditSafely: jest.fn().mockResolvedValue(undefined),
}));

const { reportsRouter } = await import('../../routes/reports.js');
const { errorHandler } = await import('../../middleware/errorHandler.js');
const { NotFoundError } = await import('../../errors.js');

const app = express();
app.use(express.json());
app.use('/api/reports', reportsRouter);
app.use(errorHandler);

const validDto = {
  fileAName: 'a.csv',
  fileBName: 'b.csv',
  summary: {
    total: 1,
    matched: 1,
    mismatched: 0,
    unmatchedA: 0,
    unmatchedB: 0,
    duplicates: 0,
    matchRate: 1,
    totalBreakValue: 0,
    durationMs: 10,
  },
  rows: [{ ref: 'REF1', status: 'matched', amountA: 100, amountB: 100, amountDiff: 0 }],
  config: { amountTolerance: 0.01 },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });
});

describe('GET /api/reports', () => {
  it("returns the caller's reports, unbounded by default", async () => {
    mockReportService.listReports.mockResolvedValue([{ id: 'r1' }]);

    const res = await request(app).get('/api/reports');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'r1' }]);
    expect(mockReportService.listReports).toHaveBeenCalledWith(USER_ID, { limit: undefined });
  });

  it('passes a valid ?limit= through', async () => {
    mockReportService.listReports.mockResolvedValue([]);

    await request(app).get('/api/reports?limit=5');

    expect(mockReportService.listReports).toHaveBeenCalledWith(USER_ID, { limit: 5 });
  });

  it('ignores an invalid ?limit=', async () => {
    mockReportService.listReports.mockResolvedValue([]);

    await request(app).get('/api/reports?limit=not-a-number');

    expect(mockReportService.listReports).toHaveBeenCalledWith(USER_ID, { limit: undefined });
  });
});

describe('GET /api/reports/summary', () => {
  it("returns the caller's aggregated summary", async () => {
    const summary = { totalReconciliations: { current: 2, previous: 1, deltaPercent: 100 } };
    mockReportService.getReportsSummary.mockResolvedValue(summary);

    const res = await request(app).get('/api/reports/summary');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(summary);
    expect(mockReportService.getReportsSummary).toHaveBeenCalledWith(USER_ID);
  });

  it('allows a viewer (report:read is granted to all three roles)', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });
    mockReportService.getReportsSummary.mockResolvedValue({});

    const res = await request(app).get('/api/reports/summary');

    expect(res.status).toBe(200);
  });
});

describe('GET /api/reports/trend', () => {
  it('defaults months when not given', async () => {
    mockReportService.getReportsTrend.mockResolvedValue({ matchRateSeries: [] });

    const res = await request(app).get('/api/reports/trend');

    expect(res.status).toBe(200);
    expect(mockReportService.getReportsTrend).toHaveBeenCalledWith(USER_ID, undefined);
  });

  it('passes a valid ?months= through', async () => {
    mockReportService.getReportsTrend.mockResolvedValue({ matchRateSeries: [] });

    await request(app).get('/api/reports/trend?months=3');

    expect(mockReportService.getReportsTrend).toHaveBeenCalledWith(USER_ID, { months: 3 });
  });
});

describe('POST /api/reports', () => {
  it('saves a valid report and returns 201 with the new id', async () => {
    mockReportService.saveReport.mockResolvedValue('new-report-id');

    const res = await request(app).post('/api/reports').send(validDto);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'new-report-id' });
    expect(mockReportService.saveReport).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ fileAName: 'a.csv', fileBName: 'b.csv' }),
    );
  });

  it('rejects a body missing required fields with an RFC 7807 422', async () => {
    const res = await request(app).post('/api/reports').send({ fileAName: 'a.csv' });

    expect(res.status).toBe(422);
    expect(res.body.type).toBe('https://recon.app/errors/validation-error');
    expect(res.body.errors.length).toBeGreaterThan(0);
    expect(mockReportService.saveReport).not.toHaveBeenCalled();
  });

  it('rejects a negative amountTolerance', async () => {
    const res = await request(app)
      .post('/api/reports')
      .send({ ...validDto, config: { amountTolerance: -1 } });

    expect(res.status).toBe(422);
    expect(res.body.errors.some((e) => /non-negative/.test(e.message))).toBe(true);
  });

  it('rejects a viewer with a 403 RFC 7807 error', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).post('/api/reports').send(validDto);

    expect(res.status).toBe(403);
    expect(res.body.type).toBe('https://recon.app/errors/authorisation-error');
    expect(mockReportService.saveReport).not.toHaveBeenCalled();
  });
});

describe('GET /api/reports/drafts', () => {
  it("returns the caller's drafts", async () => {
    mockReportService.listDrafts.mockResolvedValue([{ id: 'draft-1' }]);

    const res = await request(app).get('/api/reports/drafts');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'draft-1' }]);
    expect(mockReportService.listDrafts).toHaveBeenCalledWith(USER_ID);
  });
});

describe('POST /api/reports/draft', () => {
  it('saves a draft with all-optional fields and returns 201', async () => {
    mockReportService.saveDraft.mockResolvedValue({ id: 'draft-1', status: 'draft' });

    const res = await request(app).post('/api/reports/draft').send({ name: 'Q3 Vendor Reconciliation' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'draft-1', status: 'draft' });
    expect(mockReportService.saveDraft).toHaveBeenCalledWith(USER_ID, { name: 'Q3 Vendor Reconciliation' });
  });

  it('accepts an entirely empty body', async () => {
    mockReportService.saveDraft.mockResolvedValue({ id: 'draft-1' });

    const res = await request(app).post('/api/reports/draft').send({});

    expect(res.status).toBe(201);
  });

  it('rejects a viewer with a 403 RFC 7807 error', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).post('/api/reports/draft').send({ name: 'x' });

    expect(res.status).toBe(403);
    expect(mockReportService.saveDraft).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/reports/draft/:id', () => {
  it('updates a draft and returns it', async () => {
    mockReportService.updateDraft.mockResolvedValue({ id: 'draft-1', name: 'Updated' });

    const res = await request(app).patch('/api/reports/draft/draft-1').send({ name: 'Updated' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'draft-1', name: 'Updated' });
    expect(mockReportService.updateDraft).toHaveBeenCalledWith(USER_ID, 'draft-1', { name: 'Updated' });
  });

  it('returns an RFC 7807 404 when not found or not owned', async () => {
    mockReportService.updateDraft.mockRejectedValue(new NotFoundError());

    const res = await request(app).patch('/api/reports/draft/missing').send({ name: 'x' });

    expect(res.status).toBe(404);
  });
});

describe('POST /api/reports/draft/:id/complete', () => {
  it('completes a draft with the full report DTO and returns the id', async () => {
    mockReportService.completeDraft.mockResolvedValue('draft-1');

    const res = await request(app).post('/api/reports/draft/draft-1/complete').send(validDto);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'draft-1' });
    expect(mockReportService.completeDraft).toHaveBeenCalledWith(
      USER_ID,
      'draft-1',
      expect.objectContaining({ fileAName: 'a.csv' }),
    );
  });

  it('rejects a body missing required fields with a 422, same validation as a fresh save', async () => {
    const res = await request(app).post('/api/reports/draft/draft-1/complete').send({ fileAName: 'a.csv' });

    expect(res.status).toBe(422);
    expect(mockReportService.completeDraft).not.toHaveBeenCalled();
  });

  it('returns an RFC 7807 404 when the draft does not exist or is not owned', async () => {
    mockReportService.completeDraft.mockRejectedValue(new NotFoundError());

    const res = await request(app).post('/api/reports/draft/missing/complete').send(validDto);

    expect(res.status).toBe(404);
  });
});

describe('GET /api/reports/:id', () => {
  it('returns the report when found', async () => {
    mockReportService.getReport.mockResolvedValue({ id: 'r1', rows: [] });

    const res = await request(app).get('/api/reports/r1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'r1', rows: [] });
  });

  it('returns an RFC 7807 404 when not found or not owned', async () => {
    mockReportService.getReport.mockRejectedValue(new NotFoundError());

    const res = await request(app).get('/api/reports/missing');

    expect(res.status).toBe(404);
    expect(res.body.type).toBe('https://recon.app/errors/not-found');
  });
});

describe('DELETE /api/reports/:id', () => {
  it('returns 204 on success', async () => {
    mockReportService.deleteReport.mockResolvedValue(undefined);

    const res = await request(app).delete('/api/reports/r1');

    expect(res.status).toBe(204);
  });

  it('returns an RFC 7807 404 when not found or not owned', async () => {
    mockReportService.deleteReport.mockRejectedValue(new NotFoundError());

    const res = await request(app).delete('/api/reports/missing');

    expect(res.status).toBe(404);
    expect(res.body.type).toBe('https://recon.app/errors/not-found');
  });

  it('rejects a viewer with a 403 RFC 7807 error', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).delete('/api/reports/r1');

    expect(res.status).toBe(403);
    expect(res.body.type).toBe('https://recon.app/errors/authorisation-error');
    expect(mockReportService.deleteReport).not.toHaveBeenCalled();
  });
});
