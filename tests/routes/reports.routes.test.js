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
  getOrganizationBrand: jest.fn().mockResolvedValue({ name: 'Test Org', logo: null }),
}));

const mockReportService = {
  listReports: jest.fn(),
  getReport: jest.fn(),
  deleteReport: jest.fn(),
  getReportsSummary: jest.fn(),
  getReportsTrend: jest.fn(),
  saveDraft: jest.fn(),
  updateDraft: jest.fn(),
  listDrafts: jest.fn(),
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
  enqueueReconciliationRun: jest.fn(),
  getTransactions: jest.fn(),
  getTransaction: jest.fn(),
  markRowReviewed: jest.fn(),
  resolveRows: jest.fn(),
  rerunReport: jest.fn(),
  unresolve: jest.fn(),
  listCorrections: jest.fn(),
  createCorrection: jest.fn(),
  deleteCorrection: jest.fn(),
  getBreakBreakdown: jest.fn(),
  getFilePairTrend: jest.fn(),
};

jest.unstable_mockModule('../../services/reportService.js', () => mockReportService);

const mockReportExportService = {
  recordExport: jest.fn().mockResolvedValue(undefined),
  listExports: jest.fn(),
  uploadExportFile: jest.fn().mockResolvedValue(undefined),
  getExportForDownload: jest.fn(),
  deleteExport: jest.fn().mockResolvedValue(undefined),
};
jest.unstable_mockModule('../../services/reportExportService.js', () => mockReportExportService);
jest.unstable_mockModule('../../utils/fileParser.js', () => ({ downloadFromR2: jest.fn() }));

jest.unstable_mockModule('../../services/reportTemplateService.js', () => ({
  resolveSections: jest.fn(),
  getTemplateName: jest.fn().mockResolvedValue(null),
}));

const mockLogAuditSafely = jest.fn().mockResolvedValue(undefined);
const mockLogResultsViewedOnce = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/auditLogService.js', () => ({
  logAuditSafely: mockLogAuditSafely,
  logAuditOnce: jest.fn().mockResolvedValue(undefined),
  logResultsViewedOnce: mockLogResultsViewedOnce,
}));

const { reportsRouter } = await import('../../routes/reports.js');
const { errorHandler } = await import('../../middleware/errorHandler.js');
const { NotFoundError, ValidationError, ConflictError } = await import('../../errors.js');

const app = express();
app.use(express.json());
app.use('/api/reports', reportsRouter);
app.use(errorHandler);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });
});

describe('GET /api/reports', () => {
  it("returns the caller's reports, unbounded by default", async () => {
    mockReportService.listReports.mockResolvedValue([{ id: '11111111-1111-4111-8111-111111111111' }]);

    const res = await request(app).get('/api/reports');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: '11111111-1111-4111-8111-111111111111' }]);
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
      { ip: expect.any(String), userAgent: null },
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
    mockReportService.updateReportTag.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', tag: 'bank' });

    const res = await request(app).patch('/api/reports/11111111-1111-4111-8111-111111111111/tag').send({ tag: 'bank' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: '11111111-1111-4111-8111-111111111111', tag: 'bank' });
    expect(mockReportService.updateReportTag).toHaveBeenCalledWith(USER_ID, '11111111-1111-4111-8111-111111111111', 'bank', { ip: expect.any(String), userAgent: null });
  });

  it('accepts null to clear a tag', async () => {
    mockReportService.updateReportTag.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', tag: null });

    const res = await request(app).patch('/api/reports/11111111-1111-4111-8111-111111111111/tag').send({ tag: null });

    expect(res.status).toBe(200);
    expect(mockReportService.updateReportTag).toHaveBeenCalledWith(USER_ID, '11111111-1111-4111-8111-111111111111', null, { ip: expect.any(String), userAgent: null });
  });

  it('rejects an invalid tag value with a 422', async () => {
    const res = await request(app).patch('/api/reports/11111111-1111-4111-8111-111111111111/tag').send({ tag: 'not-a-real-tag' });

    expect(res.status).toBe(422);
    expect(mockReportService.updateReportTag).not.toHaveBeenCalled();
  });

  it('returns an RFC 7807 404 when the report does not exist or is not completed', async () => {
    mockReportService.updateReportTag.mockRejectedValue(new NotFoundError());

    const res = await request(app).patch('/api/reports/33333333-3333-4333-8333-333333333333/tag').send({ tag: 'bank' });

    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/reports/:id/name', () => {
  it('renames the report and returns it', async () => {
    mockReportService.updateReportName.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', name: 'July Bank Reconciliation' });

    const res = await request(app).patch('/api/reports/11111111-1111-4111-8111-111111111111/name').send({ name: 'July Bank Reconciliation' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: '11111111-1111-4111-8111-111111111111', name: 'July Bank Reconciliation' });
    expect(mockReportService.updateReportName).toHaveBeenCalledWith(USER_ID, '11111111-1111-4111-8111-111111111111', 'July Bank Reconciliation', { ip: expect.any(String), userAgent: null });
  });

  it('rejects an empty name with a 422', async () => {
    const res = await request(app).patch('/api/reports/11111111-1111-4111-8111-111111111111/name').send({ name: '' });

    expect(res.status).toBe(422);
    expect(mockReportService.updateReportName).not.toHaveBeenCalled();
  });

  it('rejects a missing name with a 422', async () => {
    const res = await request(app).patch('/api/reports/11111111-1111-4111-8111-111111111111/name').send({});

    expect(res.status).toBe(422);
    expect(mockReportService.updateReportName).not.toHaveBeenCalled();
  });

  it('returns an RFC 7807 404 when the report does not exist or is not completed', async () => {
    mockReportService.updateReportName.mockRejectedValue(new NotFoundError());

    const res = await request(app).patch('/api/reports/33333333-3333-4333-8333-333333333333/name').send({ name: 'New Name' });

    expect(res.status).toBe(404);
  });
});

describe('PUT/DELETE /api/reports/:id/favorite', () => {
  it('PUT adds a favorite and returns 204', async () => {
    mockReportService.addFavorite.mockResolvedValue(undefined);

    const res = await request(app).put('/api/reports/11111111-1111-4111-8111-111111111111/favorite');

    expect(res.status).toBe(204);
    expect(mockReportService.addFavorite).toHaveBeenCalledWith(USER_ID, '11111111-1111-4111-8111-111111111111');
  });

  it('PUT returns an RFC 7807 404 when the report is inaccessible', async () => {
    mockReportService.addFavorite.mockRejectedValue(new NotFoundError());

    const res = await request(app).put('/api/reports/33333333-3333-4333-8333-333333333333/favorite');

    expect(res.status).toBe(404);
  });

  it('DELETE removes a favorite and returns 204', async () => {
    mockReportService.removeFavorite.mockResolvedValue(undefined);

    const res = await request(app).delete('/api/reports/11111111-1111-4111-8111-111111111111/favorite');

    expect(res.status).toBe(204);
    expect(mockReportService.removeFavorite).toHaveBeenCalledWith(USER_ID, '11111111-1111-4111-8111-111111111111');
  });

  it('is allowed for a viewer (report:read is granted to all three roles)', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });
    mockReportService.addFavorite.mockResolvedValue(undefined);

    const res = await request(app).put('/api/reports/11111111-1111-4111-8111-111111111111/favorite');

    expect(res.status).toBe(204);
  });
});

describe('GET /api/reports/:id/transactions', () => {
  it('returns the transaction list for a viewer (report:read)', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });
    mockReportService.getTransactions.mockResolvedValue({ rows: [{ id: '44444444-4444-4444-8444-444444444444' }], total: 1 });

    const res = await request(app).get('/api/reports/11111111-1111-4111-8111-111111111111/transactions?status=matched&limit=10');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ rows: [{ id: '44444444-4444-4444-8444-444444444444' }], total: 1 });
    expect(mockReportService.getTransactions).toHaveBeenCalledWith(
      USER_ID,
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({ status: 'matched', limit: 10 }),
    );
  });
});

describe('GET /api/reports/:id/transactions/:rowId', () => {
  it('returns a single transaction detail', async () => {
    const transaction = { id: '44444444-4444-4444-8444-444444444444', matchAnalysis: [], recommendedAction: 'x' };
    mockReportService.getTransaction.mockResolvedValue(transaction);

    const res = await request(app).get('/api/reports/11111111-1111-4111-8111-111111111111/transactions/44444444-4444-4444-8444-444444444444');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(transaction);
    expect(mockReportService.getTransaction).toHaveBeenCalledWith(USER_ID, '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444');
  });

  it('returns an RFC 7807 404 when the row is not found', async () => {
    mockReportService.getTransaction.mockRejectedValue(new NotFoundError());

    const res = await request(app).get('/api/reports/11111111-1111-4111-8111-111111111111/transactions/33333333-3333-4333-8333-333333333333');

    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/reports/:id/transactions/:rowId/review', () => {
  it('marks a row reviewed for an admin', async () => {
    mockReportService.markRowReviewed.mockResolvedValue({ id: '44444444-4444-4444-8444-444444444444', reviewed: true });

    const res = await request(app).patch('/api/reports/11111111-1111-4111-8111-111111111111/transactions/44444444-4444-4444-8444-444444444444/review').send({ reviewed: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: '44444444-4444-4444-8444-444444444444', reviewed: true });
    expect(mockReportService.markRowReviewed).toHaveBeenCalledWith(USER_ID, '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444', true, {
      ip: expect.any(String),
      userAgent: null,
    });
  });

  it('defaults reviewed to true when the body is empty', async () => {
    mockReportService.markRowReviewed.mockResolvedValue({ id: '44444444-4444-4444-8444-444444444444', reviewed: true });

    const res = await request(app).patch('/api/reports/11111111-1111-4111-8111-111111111111/transactions/44444444-4444-4444-8444-444444444444/review').send({});

    expect(res.status).toBe(200);
    expect(mockReportService.markRowReviewed).toHaveBeenCalledWith(USER_ID, '11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444', true, expect.anything());
  });

  it('rejects a viewer with a 403 RFC 7807 error', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).patch('/api/reports/11111111-1111-4111-8111-111111111111/transactions/44444444-4444-4444-8444-444444444444/review').send({ reviewed: false });

    expect(res.status).toBe(403);
    expect(mockReportService.markRowReviewed).not.toHaveBeenCalled();
  });
});

describe('POST /api/reports/:id/resolutions', () => {
  const REPORT_ID = '123e4567-e89b-12d3-a456-426614174000';
  const ROW_A = '223e4567-e89b-12d3-a456-426614174001';
  const ROW_B = '323e4567-e89b-12d3-a456-426614174002';
  const url = `/api/reports/${REPORT_ID}/resolutions`;

  it('creates a match for an analyst and returns 201 with the resolution', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'analyst' });
    mockReportService.resolveRows.mockResolvedValue({ id: 'res-1', kind: 'matched' });

    const res = await request(app).post(url).send({ kind: 'matched', rowIds: [ROW_A, ROW_B], note: '  Same payment  ' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'res-1', kind: 'matched' });
    // The note arrives trimmed: the zod-parsed body replaces req.body.
    expect(mockReportService.resolveRows).toHaveBeenCalledWith(
      USER_ID,
      REPORT_ID,
      { kind: 'matched', rowIds: [ROW_A, ROW_B], note: 'Same payment' },
      { ip: expect.any(String), userAgent: null },
    );
  });

  it('rejects a viewer with a 403', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).post(url).send({ kind: 'explained', rowIds: [ROW_A], note: 'n' });

    expect(res.status).toBe(403);
    expect(mockReportService.resolveRows).not.toHaveBeenCalled();
  });

  it.each([
    ['a match without exactly two rows', { kind: 'matched', rowIds: [ROW_A], note: 'n' }],
    ['a blank note', { kind: 'explained', rowIds: [ROW_A], note: '   ' }],
    ['the same row twice', { kind: 'explained', rowIds: [ROW_A, ROW_A], note: 'n' }],
    ['a non-uuid row id', { kind: 'explained', rowIds: ['row-1'], note: 'n' }],
    ['an unknown kind', { kind: 'ignored', rowIds: [ROW_A], note: 'n' }],
    ['more than 100 rows', { kind: 'explained', rowIds: Array.from({ length: 101 }, () => ROW_A), note: 'n' }],
  ])('rejects %s with a 422', async (_label, body) => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });

    const res = await request(app).post(url).send(body);

    expect(res.status).toBe(422);
    expect(mockReportService.resolveRows).not.toHaveBeenCalled();
  });

  it('404s on a malformed report id before reaching the service', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });

    const res = await request(app).post('/api/reports/not-a-uuid/resolutions').send({ kind: 'explained', rowIds: [ROW_A], note: 'n' });

    expect(res.status).toBe(404);
    expect(mockReportService.resolveRows).not.toHaveBeenCalled();
  });

  it('passes a service ConflictError through as a 409', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });
    mockReportService.resolveRows.mockRejectedValue(new ConflictError('One of these transactions is already resolved'));

    const res = await request(app).post(url).send({ kind: 'explained', rowIds: [ROW_A], note: 'n' });

    expect(res.status).toBe(409);
  });
});

describe('POST /api/reports/:id/rerun', () => {
  const REPORT_ID = '123e4567-e89b-12d3-a456-426614174000';

  it('creates a rerun draft for an analyst and returns 201 with its id', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'analyst' });
    mockReportService.rerunReport.mockResolvedValue({ id: 'draft-9' });

    const res = await request(app).post(`/api/reports/${REPORT_ID}/rerun`);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 'draft-9' });
    expect(mockReportService.rerunReport).toHaveBeenCalledWith(USER_ID, REPORT_ID, { ip: expect.any(String), userAgent: null });
  });

  it('rejects a viewer with a 403', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).post(`/api/reports/${REPORT_ID}/rerun`);

    expect(res.status).toBe(403);
    expect(mockReportService.rerunReport).not.toHaveBeenCalled();
  });

  it('404s on a malformed report id before reaching the service', async () => {
    const res = await request(app).post('/api/reports/not-a-uuid/rerun');

    expect(res.status).toBe(404);
    expect(mockReportService.rerunReport).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/reports/:id/resolutions/:resolutionId', () => {
  const REPORT_ID = '123e4567-e89b-12d3-a456-426614174000';
  const RESOLUTION_ID = '423e4567-e89b-12d3-a456-426614174003';

  it('undoes a resolution for an admin and returns 204', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });
    mockReportService.unresolve.mockResolvedValue(undefined);

    const res = await request(app).delete(`/api/reports/${REPORT_ID}/resolutions/${RESOLUTION_ID}`);

    expect(res.status).toBe(204);
    expect(mockReportService.unresolve).toHaveBeenCalledWith(USER_ID, REPORT_ID, RESOLUTION_ID, expect.anything());
  });

  it('rejects a viewer with a 403', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).delete(`/api/reports/${REPORT_ID}/resolutions/${RESOLUTION_ID}`);

    expect(res.status).toBe(403);
    expect(mockReportService.unresolve).not.toHaveBeenCalled();
  });

  it('404s on a malformed resolution id before reaching the service', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });

    const res = await request(app).delete(`/api/reports/${REPORT_ID}/resolutions/not-a-uuid`);

    expect(res.status).toBe(404);
    expect(mockReportService.unresolve).not.toHaveBeenCalled();
  });
});

describe('corrections routes', () => {
  const REPORT_ID = '123e4567-e89b-12d3-a456-426614174000';
  const ROW_ID = '223e4567-e89b-12d3-a456-426614174001';
  const CORRECTION_ID = '523e4567-e89b-12d3-a456-426614174004';
  const url = `/api/reports/${REPORT_ID}/corrections`;
  const body = { rowId: ROW_ID, side: 'B', field: 'amount', correctedValue: ' 1250.00 ', reason: ' Bank export dropped the cents ' };

  it('creates a correction for an analyst and returns 201, with the value and reason trimmed', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'analyst' });
    mockReportService.createCorrection.mockResolvedValue({ id: CORRECTION_ID });

    const res = await request(app).post(url).send(body);

    expect(res.status).toBe(201);
    expect(mockReportService.createCorrection).toHaveBeenCalledWith(
      USER_ID,
      REPORT_ID,
      { rowId: ROW_ID, side: 'B', field: 'amount', correctedValue: '1250.00', reason: 'Bank export dropped the cents' },
      { ip: expect.any(String), userAgent: null },
    );
  });

  it('rejects a viewer creating or removing a correction with a 403', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    expect((await request(app).post(url).send(body)).status).toBe(403);
    expect((await request(app).delete(`${url}/${CORRECTION_ID}`)).status).toBe(403);
    expect(mockReportService.createCorrection).not.toHaveBeenCalled();
    expect(mockReportService.deleteCorrection).not.toHaveBeenCalled();
  });

  it('lets a viewer list corrections', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });
    mockReportService.listCorrections.mockResolvedValue([]);

    const res = await request(app).get(`${url}?limit=500`);

    expect(res.status).toBe(200);
    expect(mockReportService.listCorrections).toHaveBeenCalledWith(USER_ID, REPORT_ID, { limit: 100, offset: undefined });
  });

  it.each([
    ['an unknown field', { ...body, field: 'description' }],
    ['an unknown side', { ...body, side: 'C' }],
    ['a blank value', { ...body, correctedValue: '   ' }],
    ['a blank reason', { ...body, reason: '' }],
    ['a value over 500 characters', { ...body, correctedValue: 'x'.repeat(501) }],
    ['a non-uuid row id', { ...body, rowId: 'row-1' }],
  ])('rejects %s with a 422', async (_label, invalid) => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });

    const res = await request(app).post(url).send(invalid);

    expect(res.status).toBe(422);
    expect(mockReportService.createCorrection).not.toHaveBeenCalled();
  });

  it('404s on a malformed id before reaching the service', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });

    expect((await request(app).post('/api/reports/not-a-uuid/corrections').send(body)).status).toBe(404);
    expect((await request(app).delete(`${url}/not-a-uuid`)).status).toBe(404);
  });

  it('removes a pending correction with a 204, and passes a 409 for an applied one through', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });
    mockReportService.deleteCorrection.mockResolvedValueOnce(undefined);
    mockReportService.deleteCorrection.mockRejectedValueOnce(new ConflictError('An applied correction is part of this run and cannot be removed'));

    expect((await request(app).delete(`${url}/${CORRECTION_ID}`)).status).toBe(204);
    expect((await request(app).delete(`${url}/${CORRECTION_ID}`)).status).toBe(409);
  });
});

describe('GET /api/reports/:id/break-breakdown', () => {
  it('returns the break-reason breakdown', async () => {
    const breakdown = [{ category: 'Amount Mismatch', amount: 100, percent: 50 }];
    mockReportService.getBreakBreakdown.mockResolvedValue(breakdown);

    const res = await request(app).get('/api/reports/11111111-1111-4111-8111-111111111111/break-breakdown');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(breakdown);
  });
});

describe('GET /api/reports/:id/trend', () => {
  it('returns the file-pair match-rate and break-value trend, defaulting scope to "filePair"', async () => {
    const trend = { matchRateTrend: { current: [], prior: [] }, breakValueTrend: { current: [], prior: [] } };
    mockReportService.getFilePairTrend.mockResolvedValue(trend);

    const res = await request(app).get('/api/reports/11111111-1111-4111-8111-111111111111/trend');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(trend);
    expect(mockReportService.getFilePairTrend).toHaveBeenCalledWith(USER_ID, '11111111-1111-4111-8111-111111111111', { scope: 'filePair' });
  });

  it('passes scope=overall through when given', async () => {
    mockReportService.getFilePairTrend.mockResolvedValue({});

    await request(app).get('/api/reports/11111111-1111-4111-8111-111111111111/trend?scope=overall');

    expect(mockReportService.getFilePairTrend).toHaveBeenCalledWith(USER_ID, '11111111-1111-4111-8111-111111111111', { scope: 'overall' });
  });

  it('ignores an unrecognized scope value, falling back to "filePair"', async () => {
    mockReportService.getFilePairTrend.mockResolvedValue({});

    await request(app).get('/api/reports/11111111-1111-4111-8111-111111111111/trend?scope=bogus');

    expect(mockReportService.getFilePairTrend).toHaveBeenCalledWith(USER_ID, '11111111-1111-4111-8111-111111111111', { scope: 'filePair' });
  });

  it('passes a valid ?limit= through, capped at 7', async () => {
    mockReportService.getFilePairTrend.mockResolvedValue({});

    await request(app).get('/api/reports/11111111-1111-4111-8111-111111111111/trend?limit=5');

    expect(mockReportService.getFilePairTrend).toHaveBeenCalledWith(USER_ID, '11111111-1111-4111-8111-111111111111', { scope: 'filePair', limit: 5 });
  });

  it('passes limit: undefined when not given, leaving the default (7) to the service layer', async () => {
    mockReportService.getFilePairTrend.mockResolvedValue({});

    await request(app).get('/api/reports/11111111-1111-4111-8111-111111111111/trend');

    expect(mockReportService.getFilePairTrend).toHaveBeenCalledWith(USER_ID, '11111111-1111-4111-8111-111111111111', { scope: 'filePair', limit: undefined });
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
    mockReportExportService.listExports.mockResolvedValue([{ id: '55555555-5555-4555-8555-555555555555' }]);

    const res = await request(app).get('/api/reports/exports');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: '55555555-5555-4555-8555-555555555555' }]);
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

describe('GET /api/reports/drafts', () => {
  it("returns the caller's drafts", async () => {
    const page = { items: [{ id: '22222222-2222-4222-8222-222222222222' }], total: 1 };
    mockReportService.listDrafts.mockResolvedValue(page);

    const res = await request(app).get('/api/reports/drafts?limit=500&offset=20');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(page);
    expect(mockReportService.listDrafts).toHaveBeenCalledWith(USER_ID, { limit: 100, offset: 20 });
  });
});

describe('POST /api/reports/draft', () => {
  it('saves a draft with all-optional fields and returns 201', async () => {
    mockReportService.saveDraft.mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222', status: 'draft' });

    const res = await request(app).post('/api/reports/draft').send({ name: 'Q3 Vendor Reconciliation' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: '22222222-2222-4222-8222-222222222222', status: 'draft' });
    expect(mockReportService.saveDraft).toHaveBeenCalledWith(USER_ID, { name: 'Q3 Vendor Reconciliation' });
  });

  it('accepts an entirely empty body', async () => {
    mockReportService.saveDraft.mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222' });

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
    mockReportService.updateDraft.mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222', name: 'Updated' });

    const res = await request(app).patch('/api/reports/draft/22222222-2222-4222-8222-222222222222').send({ name: 'Updated' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: '22222222-2222-4222-8222-222222222222', name: 'Updated' });
    expect(mockReportService.updateDraft).toHaveBeenCalledWith(USER_ID, '22222222-2222-4222-8222-222222222222', { name: 'Updated' }, {
      ip: expect.any(String),
      userAgent: null,
    });
  });

  it('returns an RFC 7807 404 when not found or not owned', async () => {
    mockReportService.updateDraft.mockRejectedValue(new NotFoundError());

    const res = await request(app).patch('/api/reports/draft/33333333-3333-4333-8333-333333333333').send({ name: 'x' });

    expect(res.status).toBe(404);
  });
});

describe('POST /api/reports/:id/mapping-preview', () => {
  it('returns the mapping preview for an admin', async () => {
    const preview = { fileA: { filename: 'a.csv' }, fileB: { filename: 'b.csv' } };
    mockReportService.getMappingPreview.mockResolvedValue(preview);

    const res = await request(app).post('/api/reports/22222222-2222-4222-8222-222222222222/mapping-preview').send();

    expect(res.status).toBe(200);
    expect(res.body).toEqual(preview);
    expect(mockReportService.getMappingPreview).toHaveBeenCalledWith(USER_ID, '22222222-2222-4222-8222-222222222222');
  });

  it('rejects a viewer with a 403 RFC 7807 error', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).post('/api/reports/22222222-2222-4222-8222-222222222222/mapping-preview').send();

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
      .post('/api/reports/22222222-2222-4222-8222-222222222222/rule-preview')
      .send({ columnMapping, config: { amountTolerance: 0.5 } });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(preview);
    expect(mockReportService.getRulePreview).toHaveBeenCalledWith(
      USER_ID,
      '22222222-2222-4222-8222-222222222222',
      expect.objectContaining({ columnMapping }),
    );
  });

  it('rejects a body missing config with a 422', async () => {
    const res = await request(app).post('/api/reports/22222222-2222-4222-8222-222222222222/rule-preview').send({});

    expect(res.status).toBe(422);
    expect(mockReportService.getRulePreview).not.toHaveBeenCalled();
  });

  it('returns an RFC 7807 409 when no sample/mapping is cached yet', async () => {
    mockReportService.getRulePreview.mockRejectedValue(new ConflictError('Call mapping-preview first'));

    const res = await request(app)
      .post('/api/reports/22222222-2222-4222-8222-222222222222/rule-preview')
      .send({ config: { amountTolerance: 0.5 } });

    expect(res.status).toBe(409);
    expect(res.body.type).toBe('https://recon.app/errors/conflict');
  });

  it('rejects a viewer with a 403 RFC 7807 error', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app)
      .post('/api/reports/22222222-2222-4222-8222-222222222222/rule-preview')
      .send({ columnMapping, config: { amountTolerance: 0.5 } });

    expect(res.status).toBe(403);
    expect(mockReportService.getRulePreview).not.toHaveBeenCalled();
  });
});

describe('POST /api/reports/:id/run', () => {
  it('enqueues reconciliation for an admin and returns 202 with the processing report id', async () => {
    mockReportService.enqueueReconciliationRun.mockResolvedValue('report-1');

    const res = await request(app)
      .post('/api/reports/22222222-2222-4222-8222-222222222222/run')
      .send({ columnMapping, config: { amountTolerance: 0.5, dateToleranceDays: 1 } });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ id: 'report-1', status: 'processing' });
    expect(mockReportService.enqueueReconciliationRun).toHaveBeenCalledWith(
      USER_ID,
      '22222222-2222-4222-8222-222222222222',
      expect.objectContaining({ columnMapping }),
      { ip: expect.any(String), userAgent: null },
    );
  });

  it('rejects a body missing columnMapping with a 422', async () => {
    const res = await request(app)
      .post('/api/reports/22222222-2222-4222-8222-222222222222/run')
      .send({ config: { amountTolerance: 0.5 } });

    expect(res.status).toBe(422);
    expect(mockReportService.enqueueReconciliationRun).not.toHaveBeenCalled();
  });

  it('returns an RFC 7807 422 when files have not been uploaded yet', async () => {
    mockReportService.enqueueReconciliationRun.mockRejectedValue(new ValidationError('Both files must be uploaded'));

    const res = await request(app)
      .post('/api/reports/22222222-2222-4222-8222-222222222222/run')
      .send({ columnMapping, config: { amountTolerance: 0.5 } });

    expect(res.status).toBe(422);
  });

  it('rejects an analyst just fine (report:create is not admin-only) but rejects a viewer with a 403', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app)
      .post('/api/reports/22222222-2222-4222-8222-222222222222/run')
      .send({ columnMapping, config: { amountTolerance: 0.5 } });

    expect(res.status).toBe(403);
    expect(mockReportService.enqueueReconciliationRun).not.toHaveBeenCalled();
  });
});

describe('GET /api/reports/:id', () => {
  // Prisma rejects a non-UUID with P2007, which surfaced as a 500 before validateParams covered these routes.
  it.each([
    ['get', '/api/reports/not-a-uuid'],
    ['delete', '/api/reports/not-a-uuid'],
    ['get', '/api/reports/not-a-uuid/transactions'],
    ['get', '/api/reports/11111111-1111-4111-8111-111111111111/transactions/not-a-uuid'],
    ['delete', '/api/reports/exports/not-a-uuid'],
  ])('404s on a malformed id (%s %s) before reaching the service', async (method, url) => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });

    const res = await request(app)[method](url);

    expect(res.status).toBe(404);
    expect(mockReportService.getReport).not.toHaveBeenCalled();
    expect(mockReportService.deleteReport).not.toHaveBeenCalled();
    expect(mockReportService.getTransactions).not.toHaveBeenCalled();
    expect(mockReportService.getTransaction).not.toHaveBeenCalled();
  });

  it('returns the report when found', async () => {
    mockReportService.getReport.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', rows: [] });

    const res = await request(app).get('/api/reports/11111111-1111-4111-8111-111111111111');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: '11111111-1111-4111-8111-111111111111', rows: [] });
  });

  it('logs report.results.viewed (deduped) for a completed report, with the report name as metadata', async () => {
    mockReportService.getReport.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', status: 'completed', name: 'Bank Reconciliation Q2', rows: [] });

    await request(app).get('/api/reports/11111111-1111-4111-8111-111111111111');

    expect(mockLogResultsViewedOnce).toHaveBeenCalledWith(USER_ID, '11111111-1111-4111-8111-111111111111', {
      status: 'info',
      ip: expect.any(String),
      userAgent: null,
      metadata: { subject: { name: 'Bank Reconciliation Q2' } },
    });
  });

  it('falls back to a placeholder name when the report has none', async () => {
    mockReportService.getReport.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', status: 'completed', name: null, rows: [] });

    await request(app).get('/api/reports/11111111-1111-4111-8111-111111111111');

    expect(mockLogResultsViewedOnce).toHaveBeenCalledWith(
      USER_ID,
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({ metadata: { subject: { name: 'Untitled Reconciliation' } } }),
    );
  });

  it('does not log report.results.viewed for a draft', async () => {
    mockReportService.getReport.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111', status: 'draft', rows: [] });

    await request(app).get('/api/reports/11111111-1111-4111-8111-111111111111');

    expect(mockLogResultsViewedOnce).not.toHaveBeenCalled();
  });

  it('returns an RFC 7807 404 when not found or not owned', async () => {
    mockReportService.getReport.mockRejectedValue(new NotFoundError());

    const res = await request(app).get('/api/reports/33333333-3333-4333-8333-333333333333');

    expect(res.status).toBe(404);
    expect(res.body.type).toBe('https://recon.app/errors/not-found');
  });
});

describe('DELETE /api/reports/:id', () => {
  it('returns 204 on success', async () => {
    mockReportService.deleteReport.mockResolvedValue(undefined);

    const res = await request(app).delete('/api/reports/11111111-1111-4111-8111-111111111111');

    expect(res.status).toBe(204);
  });

  it('returns an RFC 7807 404 when not found or not owned', async () => {
    mockReportService.deleteReport.mockRejectedValue(new NotFoundError());

    const res = await request(app).delete('/api/reports/33333333-3333-4333-8333-333333333333');

    expect(res.status).toBe(404);
    expect(res.body.type).toBe('https://recon.app/errors/not-found');
  });

  it('rejects a viewer with a 403 RFC 7807 error', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).delete('/api/reports/11111111-1111-4111-8111-111111111111');

    expect(res.status).toBe(403);
    expect(res.body.type).toBe('https://recon.app/errors/authorisation-error');
    expect(mockReportService.deleteReport).not.toHaveBeenCalled();
  });
});
