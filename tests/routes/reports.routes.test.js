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
  getHistoryStats: jest.fn(),
  getMatchRateDistribution: jest.fn(),
  getTopFilePairs: jest.fn(),
  updateReportTag: jest.fn(),
  updateReportName: jest.fn(),
  addFavorite: jest.fn(),
  removeFavorite: jest.fn(),
  bulkDeleteReports: jest.fn(),
  getMappingPreview: jest.fn(),
  getRulePreview: jest.fn(),
  runReconciliation: jest.fn(),
  getTransactions: jest.fn(),
  getTransaction: jest.fn(),
  markRowReviewed: jest.fn(),
  getBreakBreakdown: jest.fn(),
  getFilePairTrend: jest.fn(),
};

jest.unstable_mockModule('../../services/reportService.js', () => mockReportService);

const mockReportExportService = {
  recordExport: jest.fn().mockResolvedValue(undefined),
  listExports: jest.fn(),
};
jest.unstable_mockModule('../../services/reportExportService.js', () => mockReportExportService);

jest.unstable_mockModule('../../services/reportTemplateService.js', () => ({
  resolveSections: jest.fn(),
}));

jest.unstable_mockModule('../../services/scheduledReportService.js', () => ({
  createSchedule: jest.fn(),
  listSchedules: jest.fn(),
  updateSchedule: jest.fn(),
  deleteSchedule: jest.fn(),
}));

const mockLogAuditSafely = jest.fn().mockResolvedValue(undefined);
const mockLogResultsViewedOnce = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/auditLogService.js', () => ({
  logAuditSafely: mockLogAuditSafely,
  logResultsViewedOnce: mockLogResultsViewedOnce,
}));

const { reportsRouter } = await import('../../routes/reports.js');
const { errorHandler } = await import('../../middleware/errorHandler.js');
const { NotFoundError, ValidationError, ConflictError } = await import('../../errors.js');

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
    expect(mockReportService.listReports).toHaveBeenCalledWith(USER_ID, {
      limit: undefined,
      offset: undefined,
      q: undefined,
      dateFrom: undefined,
      dateTo: undefined,
      tag: undefined,
      favoritesOnly: false,
      status: undefined,
    });
  });

  it('passes ?status= through', async () => {
    mockReportService.listReports.mockResolvedValue([]);

    await request(app).get('/api/reports?status=failed');

    expect(mockReportService.listReports).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('passes a valid ?limit= through', async () => {
    mockReportService.listReports.mockResolvedValue([]);

    await request(app).get('/api/reports?limit=5');

    expect(mockReportService.listReports).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ limit: 5 }));
  });

  it('ignores an invalid ?limit=', async () => {
    mockReportService.listReports.mockResolvedValue([]);

    await request(app).get('/api/reports?limit=not-a-number');

    expect(mockReportService.listReports).toHaveBeenCalledWith(USER_ID, expect.objectContaining({ limit: undefined }));
  });

  it('passes ?offset=, ?q=, ?dateFrom=, ?dateTo=, ?tag= through', async () => {
    mockReportService.listReports.mockResolvedValue([]);

    await request(app).get('/api/reports?offset=10&q=june&dateFrom=2026-06-01&dateTo=2026-06-30&tag=bank');

    expect(mockReportService.listReports).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        offset: 10,
        q: 'june',
        dateFrom: '2026-06-01',
        dateTo: '2026-06-30',
        tag: 'bank',
      }),
    );
  });

  it('sets favoritesOnly to true only when ?favoritesOnly=true', async () => {
    mockReportService.listReports.mockResolvedValue([]);

    await request(app).get('/api/reports?favoritesOnly=true');
    expect(mockReportService.listReports).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ favoritesOnly: true }),
    );

    mockReportService.listReports.mockClear();
    await request(app).get('/api/reports?favoritesOnly=nope');
    expect(mockReportService.listReports).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ favoritesOnly: false }),
    );
  });
});

describe('GET /api/reports/history-stats', () => {
  it("returns the caller's org history stats", async () => {
    const stats = { totalReconciliations: { value: 3, deltaPercent: 0 } };
    mockReportService.getHistoryStats.mockResolvedValue(stats);

    const res = await request(app).get('/api/reports/history-stats');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(stats);
    expect(mockReportService.getHistoryStats).toHaveBeenCalledWith(USER_ID);
  });
});

describe('GET /api/reports/match-rate-distribution', () => {
  it('returns the match rate distribution buckets', async () => {
    const distribution = [{ label: '≥ 99%', value: 2, percent: '40.0%' }];
    mockReportService.getMatchRateDistribution.mockResolvedValue(distribution);

    const res = await request(app).get('/api/reports/match-rate-distribution');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(distribution);
  });
});

describe('GET /api/reports/top-file-pairs', () => {
  it('returns the top file pairs', async () => {
    const pairs = [{ label: 'a.csv vs b.csv', count: 3 }];
    mockReportService.getTopFilePairs.mockResolvedValue(pairs);

    const res = await request(app).get('/api/reports/top-file-pairs');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(pairs);
    expect(mockReportService.getTopFilePairs).toHaveBeenCalledWith(USER_ID);
  });
});

describe('POST /api/reports/bulk-delete', () => {
  it('deletes the given ids and returns the result', async () => {
    mockReportService.bulkDeleteReports.mockResolvedValue({ deletedCount: 2 });

    const res = await request(app)
      .post('/api/reports/bulk-delete')
      .send({ ids: ['123e4567-e89b-12d3-a456-426614174000', '223e4567-e89b-12d3-a456-426614174001'] });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deletedCount: 2 });
    expect(mockReportService.bulkDeleteReports).toHaveBeenCalledWith(
      USER_ID,
      ['123e4567-e89b-12d3-a456-426614174000', '223e4567-e89b-12d3-a456-426614174001'],
      { ip: expect.any(String) },
    );
  });

  it('rejects an empty ids array with a 422', async () => {
    const res = await request(app).post('/api/reports/bulk-delete').send({ ids: [] });

    expect(res.status).toBe(422);
    expect(mockReportService.bulkDeleteReports).not.toHaveBeenCalled();
  });

  it('rejects a non-uuid id with a 422', async () => {
    const res = await request(app).post('/api/reports/bulk-delete').send({ ids: ['not-a-uuid'] });

    expect(res.status).toBe(422);
  });

  it('rejects a viewer with a 403 RFC 7807 error', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app)
      .post('/api/reports/bulk-delete')
      .send({ ids: ['123e4567-e89b-12d3-a456-426614174000'] });

    expect(res.status).toBe(403);
    expect(mockReportService.bulkDeleteReports).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/reports/:id/tag', () => {
  it('updates the tag and returns the report', async () => {
    mockReportService.updateReportTag.mockResolvedValue({ id: 'r1', tag: 'bank' });

    const res = await request(app).patch('/api/reports/r1/tag').send({ tag: 'bank' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'r1', tag: 'bank' });
    expect(mockReportService.updateReportTag).toHaveBeenCalledWith(USER_ID, 'r1', 'bank');
  });

  it('accepts null to clear a tag', async () => {
    mockReportService.updateReportTag.mockResolvedValue({ id: 'r1', tag: null });

    const res = await request(app).patch('/api/reports/r1/tag').send({ tag: null });

    expect(res.status).toBe(200);
    expect(mockReportService.updateReportTag).toHaveBeenCalledWith(USER_ID, 'r1', null);
  });

  it('rejects an invalid tag value with a 422', async () => {
    const res = await request(app).patch('/api/reports/r1/tag').send({ tag: 'not-a-real-tag' });

    expect(res.status).toBe(422);
    expect(mockReportService.updateReportTag).not.toHaveBeenCalled();
  });

  it('returns an RFC 7807 404 when the report does not exist or is not completed', async () => {
    mockReportService.updateReportTag.mockRejectedValue(new NotFoundError());

    const res = await request(app).patch('/api/reports/missing/tag').send({ tag: 'bank' });

    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/reports/:id/name', () => {
  it('renames the report and returns it', async () => {
    mockReportService.updateReportName.mockResolvedValue({ id: 'r1', name: 'July Bank Reconciliation' });

    const res = await request(app).patch('/api/reports/r1/name').send({ name: 'July Bank Reconciliation' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'r1', name: 'July Bank Reconciliation' });
    expect(mockReportService.updateReportName).toHaveBeenCalledWith(USER_ID, 'r1', 'July Bank Reconciliation');
  });

  it('rejects an empty name with a 422', async () => {
    const res = await request(app).patch('/api/reports/r1/name').send({ name: '' });

    expect(res.status).toBe(422);
    expect(mockReportService.updateReportName).not.toHaveBeenCalled();
  });

  it('rejects a missing name with a 422', async () => {
    const res = await request(app).patch('/api/reports/r1/name').send({});

    expect(res.status).toBe(422);
    expect(mockReportService.updateReportName).not.toHaveBeenCalled();
  });

  it('returns an RFC 7807 404 when the report does not exist or is not completed', async () => {
    mockReportService.updateReportName.mockRejectedValue(new NotFoundError());

    const res = await request(app).patch('/api/reports/missing/name').send({ name: 'New Name' });

    expect(res.status).toBe(404);
  });
});

describe('PUT/DELETE /api/reports/:id/favorite', () => {
  it('PUT adds a favorite and returns 204', async () => {
    mockReportService.addFavorite.mockResolvedValue(undefined);

    const res = await request(app).put('/api/reports/r1/favorite');

    expect(res.status).toBe(204);
    expect(mockReportService.addFavorite).toHaveBeenCalledWith(USER_ID, 'r1');
  });

  it('PUT returns an RFC 7807 404 when the report is inaccessible', async () => {
    mockReportService.addFavorite.mockRejectedValue(new NotFoundError());

    const res = await request(app).put('/api/reports/missing/favorite');

    expect(res.status).toBe(404);
  });

  it('DELETE removes a favorite and returns 204', async () => {
    mockReportService.removeFavorite.mockResolvedValue(undefined);

    const res = await request(app).delete('/api/reports/r1/favorite');

    expect(res.status).toBe(204);
    expect(mockReportService.removeFavorite).toHaveBeenCalledWith(USER_ID, 'r1');
  });

  it('is allowed for a viewer (report:read is granted to all three roles)', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });
    mockReportService.addFavorite.mockResolvedValue(undefined);

    const res = await request(app).put('/api/reports/r1/favorite');

    expect(res.status).toBe(204);
  });
});

describe('GET /api/reports/:id/transactions', () => {
  it('returns the transaction list for a viewer (report:read)', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });
    mockReportService.getTransactions.mockResolvedValue({ rows: [{ id: 'row-1' }], total: 1 });

    const res = await request(app).get('/api/reports/r1/transactions?status=matched&limit=10');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rows: [{ id: 'row-1' }], total: 1 });
    expect(mockReportService.getTransactions).toHaveBeenCalledWith(
      USER_ID,
      'r1',
      expect.objectContaining({ status: 'matched', limit: 10 }),
    );
  });
});

describe('GET /api/reports/:id/transactions/:rowId', () => {
  it('returns a single transaction detail', async () => {
    const transaction = { id: 'row-1', matchAnalysis: [], recommendedAction: 'x' };
    mockReportService.getTransaction.mockResolvedValue(transaction);

    const res = await request(app).get('/api/reports/r1/transactions/row-1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(transaction);
    expect(mockReportService.getTransaction).toHaveBeenCalledWith(USER_ID, 'r1', 'row-1');
  });

  it('returns an RFC 7807 404 when the row is not found', async () => {
    mockReportService.getTransaction.mockRejectedValue(new NotFoundError());

    const res = await request(app).get('/api/reports/r1/transactions/missing');

    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/reports/:id/transactions/:rowId/review', () => {
  it('marks a row reviewed for an admin', async () => {
    mockReportService.markRowReviewed.mockResolvedValue({ id: 'row-1', reviewed: true });

    const res = await request(app).patch('/api/reports/r1/transactions/row-1/review').send({ reviewed: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'row-1', reviewed: true });
    expect(mockReportService.markRowReviewed).toHaveBeenCalledWith(USER_ID, 'r1', 'row-1', true, {
      ip: expect.any(String),
    });
  });

  it('defaults reviewed to true when the body is empty', async () => {
    mockReportService.markRowReviewed.mockResolvedValue({ id: 'row-1', reviewed: true });

    const res = await request(app).patch('/api/reports/r1/transactions/row-1/review').send({});

    expect(res.status).toBe(200);
    expect(mockReportService.markRowReviewed).toHaveBeenCalledWith(USER_ID, 'r1', 'row-1', true, expect.anything());
  });

  it('rejects a viewer with a 403 RFC 7807 error', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).patch('/api/reports/r1/transactions/row-1/review').send({ reviewed: false });

    expect(res.status).toBe(403);
    expect(mockReportService.markRowReviewed).not.toHaveBeenCalled();
  });
});

describe('GET /api/reports/:id/break-breakdown', () => {
  it('returns the break-reason breakdown', async () => {
    const breakdown = [{ category: 'Amount Mismatch', amount: 100, percent: 50 }];
    mockReportService.getBreakBreakdown.mockResolvedValue(breakdown);

    const res = await request(app).get('/api/reports/r1/break-breakdown');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(breakdown);
  });
});

describe('GET /api/reports/:id/trend', () => {
  it('returns the file-pair match-rate and break-value trend, defaulting scope to "filePair"', async () => {
    const trend = { matchRateTrend: { current: [], prior: [] }, breakValueTrend: { current: [], prior: [] } };
    mockReportService.getFilePairTrend.mockResolvedValue(trend);

    const res = await request(app).get('/api/reports/r1/trend');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(trend);
    expect(mockReportService.getFilePairTrend).toHaveBeenCalledWith(USER_ID, 'r1', { scope: 'filePair' });
  });

  it('passes scope=overall through when given', async () => {
    mockReportService.getFilePairTrend.mockResolvedValue({});

    await request(app).get('/api/reports/r1/trend?scope=overall');

    expect(mockReportService.getFilePairTrend).toHaveBeenCalledWith(USER_ID, 'r1', { scope: 'overall' });
  });

  it('ignores an unrecognized scope value, falling back to "filePair"', async () => {
    mockReportService.getFilePairTrend.mockResolvedValue({});

    await request(app).get('/api/reports/r1/trend?scope=bogus');

    expect(mockReportService.getFilePairTrend).toHaveBeenCalledWith(USER_ID, 'r1', { scope: 'filePair' });
  });

  it('passes a valid ?limit= through, capped at 7', async () => {
    mockReportService.getFilePairTrend.mockResolvedValue({});

    await request(app).get('/api/reports/r1/trend?limit=5');

    expect(mockReportService.getFilePairTrend).toHaveBeenCalledWith(USER_ID, 'r1', { scope: 'filePair', limit: 5 });
  });

  it('passes limit: undefined when not given, leaving the default (7) to the service layer', async () => {
    mockReportService.getFilePairTrend.mockResolvedValue({});

    await request(app).get('/api/reports/r1/trend');

    expect(mockReportService.getFilePairTrend).toHaveBeenCalledWith(USER_ID, 'r1', { scope: 'filePair', limit: undefined });
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

describe('GET /api/reports/exports', () => {
  it("returns the org's export history, unbounded by default", async () => {
    mockReportExportService.listExports.mockResolvedValue([{ id: 'exp-1' }]);

    const res = await request(app).get('/api/reports/exports');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'exp-1' }]);
    expect(mockReportExportService.listExports).toHaveBeenCalledWith(USER_ID, {
      limit: undefined,
      offset: undefined,
      q: undefined,
    });
  });

  it('passes a valid ?limit= through', async () => {
    mockReportExportService.listExports.mockResolvedValue([]);

    await request(app).get('/api/reports/exports?limit=10');

    expect(mockReportExportService.listExports).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ limit: 10 }),
    );
  });

  it('passes ?offset= and ?q= through', async () => {
    mockReportExportService.listExports.mockResolvedValue([]);

    await request(app).get('/api/reports/exports?offset=20&q=june');

    expect(mockReportExportService.listExports).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ offset: 20, q: 'june' }),
    );
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
      { ip: expect.any(String) },
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
    expect(mockReportService.updateDraft).toHaveBeenCalledWith(USER_ID, 'draft-1', { name: 'Updated' }, {
      ip: expect.any(String),
    });
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
      { ip: expect.any(String) },
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

describe('POST /api/reports/:id/mapping-preview', () => {
  it('returns the mapping preview for an admin', async () => {
    const preview = { fileA: { filename: 'a.csv' }, fileB: { filename: 'b.csv' } };
    mockReportService.getMappingPreview.mockResolvedValue(preview);

    const res = await request(app).post('/api/reports/draft-1/mapping-preview').send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual(preview);
    expect(mockReportService.getMappingPreview).toHaveBeenCalledWith(USER_ID, 'draft-1');
  });

  it('rejects a viewer with a 403 RFC 7807 error', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).post('/api/reports/draft-1/mapping-preview').send();

    expect(res.status).toBe(403);
    expect(mockReportService.getMappingPreview).not.toHaveBeenCalled();
  });
});

const columnMapping = {
  fileA: { referenceNumber: 'Transaction_ID', amount: 'Debit Amount', transactionDate: 'Posting Date' },
  fileB: { referenceNumber: 'Ref_No', amount: 'Amount', transactionDate: 'Value Date' },
};

describe('POST /api/reports/:id/rule-preview', () => {
  it('returns the estimated preview for an admin', async () => {
    const preview = { estimatedMatches: 10, possibleMismatches: 1, potentialDuplicates: 0, missingReferences: 2 };
    mockReportService.getRulePreview.mockResolvedValue(preview);

    const res = await request(app)
      .post('/api/reports/draft-1/rule-preview')
      .send({ columnMapping, config: { amountTolerance: 0.5 } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(preview);
    expect(mockReportService.getRulePreview).toHaveBeenCalledWith(
      USER_ID,
      'draft-1',
      expect.objectContaining({ columnMapping }),
    );
  });

  it('rejects a body missing config with a 422', async () => {
    const res = await request(app).post('/api/reports/draft-1/rule-preview').send({});

    expect(res.status).toBe(422);
    expect(mockReportService.getRulePreview).not.toHaveBeenCalled();
  });

  it('returns an RFC 7807 409 when no sample/mapping is cached yet', async () => {
    mockReportService.getRulePreview.mockRejectedValue(new ConflictError('Call mapping-preview first'));

    const res = await request(app)
      .post('/api/reports/draft-1/rule-preview')
      .send({ config: { amountTolerance: 0.5 } });

    expect(res.status).toBe(409);
    expect(res.body.type).toBe('https://recon.app/errors/conflict');
  });

  it('rejects a viewer with a 403 RFC 7807 error', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app)
      .post('/api/reports/draft-1/rule-preview')
      .send({ columnMapping, config: { amountTolerance: 0.5 } });

    expect(res.status).toBe(403);
    expect(mockReportService.getRulePreview).not.toHaveBeenCalled();
  });
});

describe('POST /api/reports/:id/run', () => {
  it('runs reconciliation for an admin and returns the new report id', async () => {
    mockReportService.runReconciliation.mockResolvedValue('report-1');

    const res = await request(app)
      .post('/api/reports/draft-1/run')
      .send({ columnMapping, config: { amountTolerance: 0.5, dateToleranceDays: 1 } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'report-1' });
    expect(mockReportService.runReconciliation).toHaveBeenCalledWith(
      USER_ID,
      'draft-1',
      expect.objectContaining({ columnMapping }),
      { ip: expect.any(String) },
    );
  });

  it('rejects a body missing columnMapping with a 422', async () => {
    const res = await request(app)
      .post('/api/reports/draft-1/run')
      .send({ config: { amountTolerance: 0.5 } });

    expect(res.status).toBe(422);
    expect(mockReportService.runReconciliation).not.toHaveBeenCalled();
  });

  it('returns an RFC 7807 422 when files have not been uploaded yet', async () => {
    mockReportService.runReconciliation.mockRejectedValue(new ValidationError('Both files must be uploaded'));

    const res = await request(app)
      .post('/api/reports/draft-1/run')
      .send({ columnMapping, config: { amountTolerance: 0.5 } });

    expect(res.status).toBe(422);
  });

  it('rejects an analyst just fine (report:create is not admin-only) but rejects a viewer with a 403', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app)
      .post('/api/reports/draft-1/run')
      .send({ columnMapping, config: { amountTolerance: 0.5 } });

    expect(res.status).toBe(403);
    expect(mockReportService.runReconciliation).not.toHaveBeenCalled();
  });
});

describe('GET /api/reports/:id', () => {
  it('returns the report when found', async () => {
    mockReportService.getReport.mockResolvedValue({ id: 'r1', rows: [] });

    const res = await request(app).get('/api/reports/r1');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'r1', rows: [] });
  });

  it('logs report.results.viewed (deduped) for a completed report, with the report name as metadata', async () => {
    mockReportService.getReport.mockResolvedValue({ id: 'r1', status: 'completed', name: 'Bank Reconciliation Q2', rows: [] });

    await request(app).get('/api/reports/r1');

    expect(mockLogResultsViewedOnce).toHaveBeenCalledWith(USER_ID, 'r1', {
      status: 'info',
      ip: expect.any(String),
      metadata: { reportName: 'Bank Reconciliation Q2' },
    });
  });

  it('falls back to a placeholder name when the report has none', async () => {
    mockReportService.getReport.mockResolvedValue({ id: 'r1', status: 'completed', name: null, rows: [] });

    await request(app).get('/api/reports/r1');

    expect(mockLogResultsViewedOnce).toHaveBeenCalledWith(
      USER_ID,
      'r1',
      expect.objectContaining({ metadata: { reportName: 'Untitled Reconciliation' } }),
    );
  });

  it('does not log report.results.viewed for a draft', async () => {
    mockReportService.getReport.mockResolvedValue({ id: 'r1', status: 'draft', rows: [] });

    await request(app).get('/api/reports/r1');

    expect(mockLogResultsViewedOnce).not.toHaveBeenCalled();
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
