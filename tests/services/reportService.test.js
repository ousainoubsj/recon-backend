import { jest } from '@jest/globals';
import { Prisma } from '@prisma/client';

const mockTx = {
  report: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
  reportRow: { createMany: jest.fn(), updateMany: jest.fn() },
  reportSequence: { upsert: jest.fn() },
  reportRowResolution: { create: jest.fn(), findUnique: jest.fn() },
  reportCorrection: { updateMany: jest.fn() },
  $queryRaw: jest.fn(),
};

const mockPrisma = {
  $transaction: jest.fn(async (fn) => fn(mockTx)),
  $queryRaw: jest.fn(),
  report: {
    create: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    deleteMany: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn(),
  },
  reportExport: {
    findMany: jest.fn().mockResolvedValue([]),
  },
  reportFavorite: {
    upsert: jest.fn(),
    deleteMany: jest.fn(),
  },
  reportRow: {
    findMany: jest.fn(),
    count: jest.fn(),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    groupBy: jest.fn(),
  },
  reportRowResolution: {
    findFirst: jest.fn(),
    deleteMany: jest.fn(),
  },
  reportCorrection: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    upsert: jest.fn(),
    deleteMany: jest.fn(),
  },
  member: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  organization: {
    findFirst: jest.fn().mockResolvedValue({ defaultAmountTolerance: null, defaultDateToleranceDays: null }),
  },
  matchRuleTemplate: {
    findFirst: jest.fn(),
  },
  auditLog: {
    findMany: jest.fn().mockResolvedValue([]),
  },
};

jest.unstable_mockModule('../../config/prisma.config.js', () => ({ prisma: mockPrisma }));

const mockDeleteR2Objects = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../utils/r2Client.js', () => ({ r2: { send: jest.fn() }, deleteR2Objects: mockDeleteR2Objects }));

const mockLogAuditSafely = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/auditLogService.js', () => ({
  logAuditSafely: mockLogAuditSafely,
}));

const mockCreateNotification = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/notificationService.js', () => ({
  createNotification: mockCreateNotification,
}));

const mockDownloadFromR2 = jest.fn();
const mockParseTabularFile = jest.fn();
jest.unstable_mockModule('../../utils/fileParser.js', () => ({
  downloadFromR2: mockDownloadFromR2,
  parseTabularFile: mockParseTabularFile,
}));

const mockRunMatch = jest.fn();
const mockExtrapolatePreview = jest.fn();
const mockBuildMatchAnalysis = jest.fn();
const mockBuildRecommendedAction = jest.fn();
const mockBuildShortReason = jest.fn().mockReturnValue({ type: 'Other', reason: '' });
const mockDeriveDescription = jest.fn().mockReturnValue('');
jest.unstable_mockModule('../../services/matchingEngine.js', () => ({
  runMatch: mockRunMatch,
  extrapolatePreview: mockExtrapolatePreview,
  buildMatchAnalysis: mockBuildMatchAnalysis,
  buildRecommendedAction: mockBuildRecommendedAction,
  buildShortReason: mockBuildShortReason,
  deriveDescription: mockDeriveDescription,
  // Stand-ins with the real parsers' accept/reject behaviour; matchingEngine.test.js covers the parsers themselves.
  parseAmount: (value) => (/^-?\d+(\.\d+)?$/.test(String(value).replace(/,/g, '')) ? Number(String(value).replace(/,/g, '')) : null),
  parseDate: (value) => (Number.isNaN(new Date(value).getTime()) ? null : new Date(value)),
}));

const mockSuggestMapping = jest.fn();
const mockMappingFromSuggestions = jest.fn();
const mockComputeValidationSummary = jest.fn();
jest.unstable_mockModule('../../services/columnMappingService.js', () => ({
  suggestMapping: mockSuggestMapping,
  mappingFromSuggestions: mockMappingFromSuggestions,
  computeValidationSummary: mockComputeValidationSummary,
}));

// persistCompletedRun's bulk row write (COPY, not createMany) and the
// reconciliation job queue both live outside Prisma — mocked at the module
// boundary same as everything else here, so these tests assert on *what*
// gets bulk-inserted/enqueued without needing real pg-copy-streams/BullMQ
// mechanics. See tests/services/reportRowBulkInsert.test.js for real
// CSV-encoding coverage.
const mockCopyReportRowsIn = jest.fn().mockResolvedValue(undefined);
const mockDeleteReportRows = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/reportRowBulkInsert.js', () => ({
  copyReportRowsIn: mockCopyReportRowsIn,
  deleteReportRows: mockDeleteReportRows,
}));

const mockEnqueueReconciliationJob = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../queues/reconciliationQueue.js', () => ({
  enqueueReconciliationJob: mockEnqueueReconciliationJob,
  RECONCILIATION_QUEUE_NAME: 'reconciliation-runs',
}));

// The mapping-preview sample cache lives in Redis, not Postgres (see
// mappingSampleCache.js) — mocked at the module boundary same as the other
// out-of-Prisma dependencies above, so these tests never open a real Redis
// connection.
const mockSetSampleRows = jest.fn().mockResolvedValue(undefined);
const mockGetSampleRows = jest.fn();
const mockClearSampleRows = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/mappingSampleCache.js', () => ({
  setSampleRows: mockSetSampleRows,
  getSampleRows: mockGetSampleRows,
  clearSampleRows: mockClearSampleRows,
}));

const {
  listReports,
  getReport,
  rerunReport,
  deleteReport,
  getReportsSummary,
  getReportsTrend,
  saveDraft,
  updateDraft,
  listDrafts,
  enqueueReconciliationRun,
  executeReconciliationRun,
  getMappingPreview,
  getRulePreview,
  getTransactions,
  getTransaction,
  markRowReviewed,
  resolveRows,
  unresolve,
  createCorrection,
  listCorrections,
  deleteCorrection,
  getBreakBreakdown,
  getFilePairTrend,
  getHistoryStats,
  getWeeklyDigestStats,
  getMatchRateDistribution,
  getTopFilePairs,
  updateReportTag,
  updateReportName,
  addFavorite,
  removeFavorite,
  bulkDeleteReports,
  getReportsByIds,
  getComparisonReports,
} = await import('../../services/reportService.js');
const { NotFoundError, ValidationError, ConflictError } = await import('../../errors.js');

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const ORG_ID = 'org-1';

const CURRENT_YEAR = new Date().getUTCFullYear();

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockTx));
  mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
  mockTx.reportSequence.upsert.mockResolvedValue({ year: CURRENT_YEAR, lastValue: 1 });
  // Default: already has a sequence number, so persistCompletedRun's
  // (executeReconciliationRun) needsSequence check is false and the
  // existing literal-match assertions on tx.report.update's payload below
  // don't need to account for sequenceYear/sequenceNumber being added.
  mockTx.report.findUnique.mockResolvedValue({ sequenceNumber: 42 });
  // getReport's resolution summary; tests that need other raw-query results override it.
  // getReport's two summaries share $queryRaw; answer each by the table it reads.
  mockPrisma.$queryRaw.mockImplementation(async (strings) =>
    strings.join('').includes('report_corrections') ? [{ pending: 0, applied: 0 }] : [{ resolvedCount: 0, unresolvedExceptionCount: 0 }],
  );
  mockPrisma.reportCorrection.findMany.mockResolvedValue([]);
  // Postgres returns NUMERIC sums as Decimals.
  mockTx.$queryRaw.mockResolvedValue([
    { matchedValue: new Prisma.Decimal('100.0000'), unmatchedValue: new Prisma.Decimal('50.0000'), duplicateValue: new Prisma.Decimal(0) },
  ]);
});

describe('listReports', () => {
  // Mirrors listReports' explicit select in reportService.js -- trimmed to
  // what the frontend's Report type actually needs, deliberately excluding
  // rulesConfig/fileASampleRows/fileBSampleRows/sourceReportId (unused by
  // any listReports consumer, and the sample-row fields can be several MB
  // each on an untouched pre-migration draft-turned-failed report).
  const REPORT_LIST_SELECT = {
    id: true,
    userId: true,
    organizationId: true,
    status: true,
    errorMessage: true,
    fileAName: true,
    fileBName: true,
    name: true,
    tag: true,
    progress: true,
    runDate: true,
    updatedAt: true,
    totalRows: true,
    matchedCount: true,
    unmatchedCount: true,
    mismatchedCount: true,
    duplicateCount: true,
    totalBreakValue: true,
    amountTolerance: true,
    dateToleranceDays: true,
    sequenceYear: true,
    sequenceNumber: true,
    fileAKey: true,
    fileBKey: true,
    columnMapping: true,
    config: true,
    fileASummary: true,
    fileBSummary: true,
    valueBreakdown: true,
    favorites: { where: { userId: USER_ID }, select: { id: true } },
    supersededBy: { select: { id: true, sequenceYear: true, sequenceNumber: true } },
  };
  const DEFAULT_STATUS = { in: ['completed', 'failed'] };

  it("maps a superseded report's successor to its formatted reference", async () => {
    mockPrisma.report.findMany.mockResolvedValue([
      { id: 'r1', favorites: [], supersededBy: { id: 'r2', sequenceYear: 2026, sequenceNumber: 12 } },
    ]);

    const [row] = await listReports(USER_ID);

    expect(row.supersededBy).toEqual({ id: 'r2', reference: 'REC-2026-000012' });
  });

  it("queries all completed+failed reports in the user's organization, newest first, unbounded by default, mapping isFavorited", async () => {
    mockPrisma.report.findMany.mockResolvedValue([
      { id: 'r1', favorites: [] },
      { id: 'r2', favorites: [{ id: 'fav-1' }] },
    ]);

    const result = await listReports(USER_ID);

    expect(result).toEqual([
      { id: 'r1', isFavorited: false, supersededBy: null },
      { id: 'r2', isFavorited: true, supersededBy: null },
    ]);
    expect(mockPrisma.report.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, status: DEFAULT_STATUS },
      select: REPORT_LIST_SELECT,
      orderBy: { runDate: 'desc' },
    });
  });

  it('narrows to a single status when given', async () => {
    mockPrisma.report.findMany.mockResolvedValue([]);

    await listReports(USER_ID, { status: 'failed' });
    expect(mockPrisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'failed' }) }),
    );

    mockPrisma.report.findMany.mockClear();
    await listReports(USER_ID, { status: 'completed' });
    expect(mockPrisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'completed' }) }),
    );
  });

  it('ignores an unrecognized status value and falls back to the default (completed+failed)', async () => {
    mockPrisma.report.findMany.mockResolvedValue([]);

    await listReports(USER_ID, { status: 'draft' });

    expect(mockPrisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: DEFAULT_STATUS }) }),
    );
  });

  it('passes take through when a limit is given', async () => {
    mockPrisma.report.findMany.mockResolvedValue([]);

    await listReports(USER_ID, { limit: 5 });

    expect(mockPrisma.report.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, status: DEFAULT_STATUS },
      select: REPORT_LIST_SELECT,
      orderBy: { runDate: 'desc' },
      take: 5,
    });
  });

  it('passes skip through when an offset is given', async () => {
    mockPrisma.report.findMany.mockResolvedValue([]);

    await listReports(USER_ID, { offset: 20 });

    expect(mockPrisma.report.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20 }));
  });

  it('filters by name/file names when q is given', async () => {
    mockPrisma.report.findMany.mockResolvedValue([]);

    await listReports(USER_ID, { q: 'june' });

    expect(mockPrisma.report.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG_ID,
        status: DEFAULT_STATUS,
        OR: [
          { name: { contains: 'june', mode: 'insensitive' } },
          { fileAName: { contains: 'june', mode: 'insensitive' } },
          { fileBName: { contains: 'june', mode: 'insensitive' } },
        ],
      },
      select: REPORT_LIST_SELECT,
      orderBy: { runDate: 'desc' },
    });
  });

  it('filters by date range when dateFrom/dateTo are given', async () => {
    mockPrisma.report.findMany.mockResolvedValue([]);

    await listReports(USER_ID, { dateFrom: '2026-06-01', dateTo: '2026-06-30' });

    expect(mockPrisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          runDate: { gte: new Date('2026-06-01'), lte: new Date('2026-06-30') },
        }),
      }),
    );
  });

  it('ignores an invalid date rather than throwing or filtering', async () => {
    mockPrisma.report.findMany.mockResolvedValue([]);

    await listReports(USER_ID, { dateFrom: 'not-a-date' });

    expect(mockPrisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG_ID, status: DEFAULT_STATUS } }),
    );
  });

  it('filters by tag when valid, ignores an unrecognized tag value', async () => {
    mockPrisma.report.findMany.mockResolvedValue([]);

    await listReports(USER_ID, { tag: 'bank' });
    expect(mockPrisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tag: 'bank' }) }),
    );

    mockPrisma.report.findMany.mockClear();
    await listReports(USER_ID, { tag: 'not-a-real-tag' });
    expect(mockPrisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG_ID, status: DEFAULT_STATUS } }),
    );
  });

  it('filters to favorited reports only when favoritesOnly is true', async () => {
    mockPrisma.report.findMany.mockResolvedValue([]);

    await listReports(USER_ID, { favoritesOnly: true });

    expect(mockPrisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ favorites: { some: { userId: USER_ID } } }),
      }),
    );
  });
});

describe('getReport', () => {
  it('returns the report without fetching rows by default', async () => {
    const report = { id: 'r1' };
    mockPrisma.report.findFirst.mockResolvedValue(report);

    const result = await getReport(USER_ID, 'r1');

    expect(result).toEqual({
      ...report,
      priorRun: null,
      runDurationMs: null,
      resolutionSummary: { resolvedCount: 0, unresolvedExceptionCount: 0 },
      correctionSummary: { pending: 0, applied: 0 },
      rerunOf: null,
      supersededBy: null,
    });
    expect(mockPrisma.report.findFirst).toHaveBeenCalledWith({
      where: { id: 'r1', organizationId: ORG_ID },
      include: { supersededBy: { select: { id: true, sequenceYear: true, sequenceNumber: true } } },
    });
    expect(mockPrisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  // The bug this covers: include: { rows: true } used to be unconditional,
  // so every poll during/after a run — even ones that only ever render
  // status/progress — paid the cost of fetching and serializing every row.
  // For a large report (AFTAB-scale, 9k+ rows each carrying full rawA/rawB
  // source JSON), that made the progress screen appear to hang right around
  // completion, since the moment status flips to completed the payload
  // jumps from empty to several MB on the very next poll. Only
  // export/email call sites need row-level data now, via includeRows:true.
  it('fetches rows only when includeRows is explicitly requested', async () => {
    const report = { id: 'r1', rows: [] };
    mockPrisma.report.findFirst.mockResolvedValue(report);

    await getReport(USER_ID, 'r1', { includeRows: true });

    expect(mockPrisma.report.findFirst).toHaveBeenCalledWith({
      where: { id: 'r1', organizationId: ORG_ID },
      include: {
        rows: { include: { resolution: { select: { kind: true, note: true } } } },
        corrections: expect.objectContaining({ where: { applied: true } }),
        supersededBy: { select: { id: true, sequenceYear: true, sequenceNumber: true } },
      },
    });
  });

  it('resolves priorRun from the most recent other completed report in the org, regardless of file pair', async () => {
    const report = { id: 'r1', status: 'completed', rows: [], runDate: new Date('2026-07-15T00:00:00.000Z') };
    mockPrisma.report.findFirst
      .mockResolvedValueOnce(report)
      .mockResolvedValueOnce({ matchedCount: 45, totalRows: 50, totalBreakValue: 12.5 });

    const result = await getReport(USER_ID, 'r1');

    expect(result.priorRun).toEqual({ matchRate: 90, totalBreakValue: 12.5 });
    expect(mockPrisma.report.findFirst).toHaveBeenNthCalledWith(2, {
      where: { organizationId: ORG_ID, status: 'completed', supersededById: null, id: { not: 'r1' }, runDate: { lt: report.runDate } },
      orderBy: { runDate: 'desc' },
      select: { matchedCount: true, totalRows: true, totalBreakValue: true },
    });
  });

  it('compares a rerun against the report it was rerun from, and names that report', async () => {
    const report = {
      id: 'rerun-1',
      organizationId: ORG_ID,
      status: 'completed',
      sourceReportId: 'source-1',
      runDate: new Date('2026-07-15T00:00:00.000Z'),
    };
    mockPrisma.report.findFirst
      .mockResolvedValueOnce(report)
      .mockResolvedValueOnce({ matchedCount: 40, totalRows: 50, totalBreakValue: 30 })
      .mockResolvedValueOnce({ id: 'source-1', name: 'June Bank', sequenceYear: 2026, sequenceNumber: 11 });

    const result = await getReport(USER_ID, 'rerun-1');

    expect(mockPrisma.report.findFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: 'source-1', organizationId: ORG_ID, status: 'completed' },
    }));
    expect(result.priorRun).toEqual({ matchRate: 80, totalBreakValue: 30 });
    expect(result.rerunOf).toEqual({ id: 'source-1', name: 'June Bank', reference: 'REC-2026-000011' });
  });

  it('returns rerunOf: null once the source report is gone', async () => {
    const report = { id: 'rerun-1', organizationId: ORG_ID, status: 'completed', sourceReportId: 'source-1', runDate: new Date() };
    mockPrisma.report.findFirst.mockResolvedValueOnce(report).mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    const result = await getReport(USER_ID, 'rerun-1');

    expect(result.priorRun).toBeNull();
    expect(result.rerunOf).toBeNull();
  });

  it('returns a null priorRun when no other completed report exists in the org', async () => {
    const report = { id: 'r1', status: 'completed', rows: [], runDate: new Date('2026-07-15T00:00:00.000Z') };
    mockPrisma.report.findFirst.mockResolvedValueOnce(report).mockResolvedValueOnce(null);

    const result = await getReport(USER_ID, 'r1');

    expect(result.priorRun).toBeNull();
  });

  it('throws NotFoundError when the report does not exist or is not in the org', async () => {
    mockPrisma.report.findFirst.mockResolvedValue(null);

    await expect(getReport(USER_ID, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it("hides another user's draft even within the same org", async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', status: 'draft', userId: OTHER_USER_ID, rows: [] });

    await expect(getReport(USER_ID, 'r1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it("returns the caller's own draft with a null priorRun, without even attempting the priorRun lookup since the report isn't completed", async () => {
    const report = { id: 'r1', status: 'draft', userId: USER_ID, rows: [] };
    mockPrisma.report.findFirst.mockResolvedValue(report);

    await expect(getReport(USER_ID, 'r1')).resolves.toEqual({
      ...report,
      progress: 0,
      priorRun: null,
      runDurationMs: null,
      resolutionSummary: { resolvedCount: 0, unresolvedExceptionCount: 0 },
      correctionSummary: { pending: 0, applied: 0 },
      rerunOf: null,
      supersededBy: null,
    });
    // A draft can't carry resolutions, so only the correction summary is queried: a rerun draft lists its corrections.
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockPrisma.report.findFirst).toHaveBeenCalledTimes(1);
  });

  it('computes runDurationMs from the started/completed audit-log pair for a completed report', async () => {
    const report = { id: 'r1', status: 'completed', rows: [], sourceReportId: null };
    mockPrisma.report.findFirst.mockResolvedValue(report);
    mockPrisma.auditLog.findMany.mockResolvedValue([
      { action: 'report.run.started', ts: new Date('2026-07-30T10:00:00.000Z') },
      { action: 'report.run.completed', ts: new Date('2026-07-30T10:00:04.500Z') },
    ]);

    const result = await getReport(USER_ID, 'r1');

    expect(result.runDurationMs).toBe(4500);
    expect(mockPrisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { entityType: 'report', entityId: 'r1', action: { in: ['report.run.started', 'report.run.completed'] } },
      }),
    );
  });

  it('pairs the latest completed event with the latest started event before it, so a retried run only measures the successful attempt', async () => {
    const report = { id: 'r1', status: 'completed', rows: [], sourceReportId: null };
    mockPrisma.report.findFirst.mockResolvedValue(report);
    mockPrisma.auditLog.findMany.mockResolvedValue([
      { action: 'report.run.started', ts: new Date('2026-07-30T10:00:00.000Z') },
      { action: 'report.run.started', ts: new Date('2026-07-30T10:05:00.000Z') },
      { action: 'report.run.completed', ts: new Date('2026-07-30T10:05:02.000Z') },
    ]);

    const result = await getReport(USER_ID, 'r1');

    expect(result.runDurationMs).toBe(2000);
  });

  it('returns runDurationMs: null when a completed report has no matching audit-log pair', async () => {
    const report = { id: 'r1', status: 'completed', rows: [], sourceReportId: null };
    mockPrisma.report.findFirst.mockResolvedValue(report);
    mockPrisma.auditLog.findMany.mockResolvedValue([]);

    const result = await getReport(USER_ID, 'r1');

    expect(result.runDurationMs).toBeNull();
  });
});

describe('deleteReport', () => {
  it('scopes deletion to the report creator when the role is not admin', async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
    mockPrisma.report.findFirst.mockResolvedValue({
      userId: USER_ID,
      name: 'June Bank Reconciliation',
      fileAName: 'a.csv',
      fileBName: 'b.csv',
      status: 'completed',
      sequenceYear: 2026,
      sequenceNumber: 4,
    });
    mockPrisma.report.deleteMany.mockResolvedValue({ count: 1 });

    await expect(deleteReport(USER_ID, 'r1', { ip: '10.0.0.1', userAgent: 'UA' })).resolves.toBeUndefined();
    expect(mockPrisma.report.deleteMany).toHaveBeenCalledWith({
      where: { id: 'r1', organizationId: ORG_ID, userId: USER_ID },
    });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'report.delete',
      entityType: 'report',
      entityId: 'r1',
      status: 'success',
      ip: '10.0.0.1',
      userAgent: 'UA',
      metadata: {
        filePair: 'a.csv vs b.csv',
        wasDraft: false,
        subject: { name: 'June Bank Reconciliation', code: 'REC-2026-000004' },
      },
    });
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("lets an admin delete any report in the org, notifying the original owner when it isn't their own", async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'admin' });
    mockPrisma.report.findFirst.mockResolvedValue({ userId: OTHER_USER_ID, name: null, fileAName: null, fileBName: null });
    mockPrisma.report.deleteMany.mockResolvedValue({ count: 1 });

    await expect(deleteReport(USER_ID, 'r1')).resolves.toBeUndefined();
    expect(mockPrisma.report.deleteMany).toHaveBeenCalledWith({
      where: { id: 'r1', organizationId: ORG_ID },
    });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ action: 'report.delete', status: 'warning' }),
    );
    expect(mockCreateNotification).toHaveBeenCalledWith(
      OTHER_USER_ID,
      expect.objectContaining({ type: 'report.deleted_by_admin', entityId: 'r1' }),
    );
  });

  it('does not notify when an admin deletes their own report', async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'admin' });
    mockPrisma.report.findFirst.mockResolvedValue({ userId: USER_ID });
    mockPrisma.report.deleteMany.mockResolvedValue({ count: 1 });

    await deleteReport(USER_ID, 'r1');

    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('throws NotFoundError without touching deleteMany when the report does not exist in the org', async () => {
    mockPrisma.report.findFirst.mockResolvedValue(null);

    await expect(deleteReport(USER_ID, 'missing')).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.report.deleteMany).not.toHaveBeenCalled();
    expect(mockLogAuditSafely).not.toHaveBeenCalled();
  });

  it('throws NotFoundError when the report exists but is not owned by a non-admin caller', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ userId: OTHER_USER_ID });
    mockPrisma.report.deleteMany.mockResolvedValue({ count: 0 });

    await expect(deleteReport(USER_ID, 'r1')).rejects.toBeInstanceOf(NotFoundError);
    expect(mockLogAuditSafely).not.toHaveBeenCalled();
  });
});

describe('saveDraft', () => {
  it('creates a minimal draft row with no rows and no audit log', async () => {
    mockPrisma.report.create.mockResolvedValue({ id: 'draft-1', status: 'draft' });

    const result = await saveDraft(USER_ID, { name: 'Q3 Vendor Reconciliation', fileAName: 'a.csv' });

    expect(result).toEqual({ id: 'draft-1', status: 'draft' });
    expect(mockPrisma.report.create).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        organizationId: ORG_ID,
        status: 'draft',
        name: 'Q3 Vendor Reconciliation',
        fileAName: 'a.csv',
        fileBName: null,
        progress: 0,
        config: { amountTolerance: undefined, dateToleranceDays: null },
      },
    });
    expect(mockLogAuditSafely).not.toHaveBeenCalled();
  });

  it("seeds config from the org's enforced default template when no config is given", async () => {
    mockPrisma.organization.findFirst.mockResolvedValueOnce({
      defaultAmountTolerance: null,
      defaultDateToleranceDays: null,
      enforcedMatchRuleTemplateId: 'tmpl-1',
    });
    mockPrisma.matchRuleTemplate.findFirst.mockResolvedValueOnce({
      config: { amountTolerance: 5, dateToleranceDays: 2, sameCurrencyOnly: false, duplicateHandling: 'skip' },
    });
    mockPrisma.report.create.mockResolvedValue({ id: 'draft-1' });

    await saveDraft(USER_ID, {});

    expect(mockPrisma.matchRuleTemplate.findFirst).toHaveBeenCalledWith({
      where: { id: 'tmpl-1', organizationId: ORG_ID },
      select: { config: true },
    });
    expect(mockPrisma.report.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        config: { amountTolerance: 5, dateToleranceDays: 2, sameCurrencyOnly: false, duplicateHandling: 'skip' },
      }),
    });
  });

  it('defaults progress to 0 and unset fields to null', async () => {
    mockPrisma.report.create.mockResolvedValue({ id: 'draft-1' });

    await saveDraft(USER_ID, {});

    expect(mockPrisma.report.create).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        organizationId: ORG_ID,
        status: 'draft',
        name: null,
        fileAName: null,
        fileBName: null,
        progress: 0,
        config: { amountTolerance: undefined, dateToleranceDays: null },
      },
    });
  });
});

describe('rerunReport', () => {
  const source = {
    id: 'source-1',
    name: 'June Bank',
    tag: 'bank',
    fileAKey: `uploads/${OTHER_USER_ID}/a.csv`,
    fileBKey: `uploads/${OTHER_USER_ID}/b.csv`,
    fileAName: 'ledger.csv',
    fileBName: 'statement.csv',
    fileASummary: { rows: 10, columns: 4, fileSizeBytes: 100 },
    fileBSummary: { rows: 9, columns: 5, fileSizeBytes: 90 },
    columnMapping: { fileA: { referenceNumber: 'Ref' }, fileB: { referenceNumber: 'Reference' } },
    rulesConfig: { amountTolerance: 0.5, duplicateHandling: 'flag-all' },
    config: { amountTolerance: 0 },
    sequenceYear: 2026,
    sequenceNumber: 11,
  };

  beforeEach(() => {
    mockPrisma.report.findFirst.mockResolvedValue(source);
    mockPrisma.report.create.mockResolvedValue({ id: 'draft-9' });
  });

  it("404s on another organization's report, and on one that isn't completed, without creating anything", async () => {
    mockPrisma.report.findFirst.mockResolvedValue(null);

    await expect(rerunReport(USER_ID, 'foreign-or-draft')).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.report.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'foreign-or-draft', organizationId: ORG_ID, status: 'completed' },
    }));
    expect(mockPrisma.report.create).not.toHaveBeenCalled();
  });

  it('rejects a report with no stored files (legacy client-computed saves)', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...source, fileAKey: null });

    await expect(rerunReport(USER_ID, 'source-1')).rejects.toBeInstanceOf(ValidationError);
    expect(mockPrisma.report.create).not.toHaveBeenCalled();
  });

  it('refuses to rerun a report a newer run already superseded, naming that run', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...source, supersededBy: { id: 'rerun-1', sequenceYear: 2026, sequenceNumber: 12 } });

    const error = await rerunReport(USER_ID, 'source-1').catch((e) => e);

    expect(error).toBeInstanceOf(ConflictError);
    expect(error.message).toContain('REC-2026-000012');
    expect(mockPrisma.report.create).not.toHaveBeenCalled();
  });

  it("creates the caller's own draft from the source's files, mapping and rules, linked back to it", async () => {
    const result = await rerunReport(USER_ID, 'source-1', { ip: '1.2.3.4', userAgent: 'jest' });

    expect(result).toEqual({ id: 'draft-9' });
    expect(mockPrisma.report.create).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        organizationId: ORG_ID,
        status: 'draft',
        progress: 0,
        name: 'June Bank',
        tag: 'bank',
        fileAKey: source.fileAKey,
        fileBKey: source.fileBKey,
        fileAName: 'ledger.csv',
        fileBName: 'statement.csv',
        fileASummary: source.fileASummary,
        fileBSummary: source.fileBSummary,
        columnMapping: source.columnMapping,
        // The full rules the source actually ran with, not its older tolerance-only config.
        config: source.rulesConfig,
        sourceReportId: 'source-1',
        corrections: { create: [] },
      },
      select: { id: true },
    });
    expect(mockPrisma.report.update).not.toHaveBeenCalled();
    expect(mockLogAuditSafely).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ action: 'report.rerun', entityId: 'draft-9', metadata: expect.objectContaining({ sourceReportId: 'source-1' }) }),
    );
  });
});

describe('rerunReport — legacy rules', () => {
  it("carries a source's retired 'skip' duplicate handling into the draft as flag-all", async () => {
    mockPrisma.report.findFirst.mockResolvedValue({
      id: 'source-1',
      fileAKey: 'uploads/u/a.csv',
      fileBKey: 'uploads/u/b.csv',
      rulesConfig: { amountTolerance: 1, duplicateHandling: 'skip' },
      supersededBy: null,
    });
    mockPrisma.report.create.mockResolvedValue({ id: 'draft-9' });

    await rerunReport(USER_ID, 'source-1');

    expect(mockPrisma.report.create.mock.calls[0][0].data.config).toEqual({ amountTolerance: 1, duplicateHandling: 'flag-all' });
  });
});

describe('rerunReport — corrections', () => {
  beforeEach(() => {
    mockPrisma.report.findFirst.mockResolvedValue({
      id: 'source-1',
      fileAKey: 'uploads/u/a.csv',
      fileBKey: 'uploads/u/b.csv',
      fileAName: 'a.csv',
      fileBName: 'b.csv',
      supersededBy: null,
    });
    mockPrisma.report.create.mockResolvedValue({ id: 'draft-9' });
  });

  it("copies the source's effective corrections as pending, a pending one overriding the applied one for the same field", async () => {
    const shared = { fileKey: 'uploads/u/b.csv', rowReference: 'INV-1', reason: 'r', createdBy: USER_ID, createdAt: new Date('2026-10-01') };
    // Ordered pending-first by the query, so the first one per row and field is the one that wins.
    mockPrisma.reportCorrection.findMany.mockResolvedValue([
      { ...shared, side: 'B', rowIndex: 2, field: 'amount', originalValue: '12', correctedValue: '11' },
      { ...shared, side: 'B', rowIndex: 2, field: 'amount', originalValue: '12', correctedValue: '10' },
      { ...shared, side: 'B', rowIndex: 2, field: 'date', originalValue: '2026-02-01', correctedValue: '2026-01-01' },
    ]);

    await rerunReport(USER_ID, 'source-1');

    expect(mockPrisma.reportCorrection.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { reportId: 'source-1' },
      orderBy: { applied: 'asc' },
    }));
    const { create } = mockPrisma.report.create.mock.calls[0][0].data.corrections;
    expect(create).toEqual([
      { ...shared, side: 'B', rowIndex: 2, field: 'amount', originalValue: '12', correctedValue: '11', applied: false },
      { ...shared, side: 'B', rowIndex: 2, field: 'date', originalValue: '2026-02-01', correctedValue: '2026-01-01', applied: false },
    ]);
  });
});

describe('updateDraft — replacing a file', () => {
  const OLD_B = `uploads/${USER_ID}/old-b.csv`;
  const NEW_B = `uploads/${USER_ID}/new-b.csv`;
  const before = {
    columnMapping: { fileA: { referenceNumber: 'Ref' }, fileB: { referenceNumber: 'Reference' } },
    config: null,
    name: 'June',
    sequenceYear: null,
    sequenceNumber: null,
    fileAKey: `uploads/${USER_ID}/a.csv`,
    fileBKey: OLD_B,
  };

  beforeEach(() => {
    mockPrisma.report.findFirst.mockResolvedValue(before);
    mockPrisma.report.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.member.findMany.mockResolvedValue([{ userId: USER_ID }]);
    mockPrisma.report.findMany.mockResolvedValue([]);
  });

  it("drops only the replaced side's mapping, summary and sample marker", async () => {
    await updateDraft(USER_ID, 'draft-1', { fileBKey: NEW_B, fileBName: 'new-b.csv' });

    const { data } = mockPrisma.report.updateMany.mock.calls[0][0];
    expect(data).toEqual({
      fileBName: 'new-b.csv',
      fileBKey: NEW_B,
      columnMapping: { fileA: { referenceNumber: 'Ref' }, fileB: undefined },
      fileBSummary: null,
      fileBSampleRows: null,
    });
  });

  it("deletes only the replaced side's corrections", async () => {
    await updateDraft(USER_ID, 'draft-1', { fileBKey: NEW_B });

    expect(mockPrisma.reportCorrection.deleteMany).toHaveBeenCalledWith({ where: { reportId: 'draft-1', side: { in: ['B'] } } });
  });

  it('deletes no corrections on a first upload or an unchanged key', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...before, fileBKey: null });
    await updateDraft(USER_ID, 'draft-1', { fileBKey: NEW_B });
    mockPrisma.report.findFirst.mockResolvedValue(before);
    await updateDraft(USER_ID, 'draft-1', { fileBKey: OLD_B });

    expect(mockPrisma.reportCorrection.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes the replaced upload when no other report uses it', async () => {
    await updateDraft(USER_ID, 'draft-1', { fileBKey: NEW_B });

    expect(mockDeleteR2Objects).toHaveBeenCalledWith([OLD_B]);
  });

  it("keeps the replaced upload when another report still uses it (a rerun's inherited file)", async () => {
    mockPrisma.report.findMany.mockResolvedValue([{ fileAKey: null, fileBKey: OLD_B }]);

    await updateDraft(USER_ID, 'draft-1', { fileBKey: NEW_B });

    expect(mockDeleteR2Objects).toHaveBeenCalledWith([]);
  });

  it('treats a first upload as nothing replaced: no mapping change, no deletion', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...before, fileBKey: null, columnMapping: null });

    await updateDraft(USER_ID, 'draft-1', { fileBKey: NEW_B });

    expect(mockPrisma.report.updateMany.mock.calls[0][0].data).toEqual({ fileBKey: NEW_B });
    expect(mockDeleteR2Objects).not.toHaveBeenCalled();
  });
});

describe('updateDraft', () => {
  it('updates only the fields provided, scoped to the caller and status draft-or-failed', async () => {
    mockPrisma.report.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'draft-1', name: 'Updated name' });

    const result = await updateDraft(USER_ID, 'draft-1', { name: 'Updated name' });

    expect(result).toEqual({ id: 'draft-1', name: 'Updated name' });
    expect(mockPrisma.report.updateMany).toHaveBeenCalledWith({
      where: { id: 'draft-1', userId: USER_ID, status: { in: ['draft', 'failed'] } },
      data: { name: 'Updated name' },
    });
  });

  it("throws NotFoundError when the draft doesn't exist or isn't the caller's", async () => {
    mockPrisma.report.updateMany.mockResolvedValue({ count: 0 });

    await expect(updateDraft(USER_ID, 'missing', { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
  });

  it('logs report.column_mapping.updated with a from/to diff when columnMapping actually changes', async () => {
    mockPrisma.report.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.report.findFirst.mockResolvedValue({
      id: 'draft-1',
      columnMapping: { fileA: { referenceNumber: 'Ref' }, fileB: {} },
      config: null,
    });

    await updateDraft(
      USER_ID,
      'draft-1',
      { columnMapping: { fileA: { referenceNumber: 'Reference No' }, fileB: { amount: 'Amount' } } },
      { ip: '10.0.0.1' },
    );

    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'report.column_mapping.updated',
      entityType: 'report',
      entityId: 'draft-1',
      ip: '10.0.0.1',
      userAgent: undefined,
      metadata: {
        changes: {
          fileAReferenceNumber: { from: 'Ref', to: 'Reference No' },
          fileBAmount: { from: null, to: 'Amount' },
        },
        subject: { name: 'Untitled Reconciliation' },
      },
    });
  });

  it('does not log report.column_mapping.updated when the patch resaves the same mapping', async () => {
    mockPrisma.report.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.report.findFirst.mockResolvedValue({
      id: 'draft-1',
      columnMapping: { fileA: { referenceNumber: 'Ref' }, fileB: {} },
      config: null,
    });

    await updateDraft(USER_ID, 'draft-1', { columnMapping: { fileA: { referenceNumber: 'Ref' }, fileB: {} } });

    expect(mockLogAuditSafely).not.toHaveBeenCalled();
  });

  it('logs report.matching_rules.updated with a from/to diff when config actually changes', async () => {
    mockPrisma.report.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.report.findFirst.mockResolvedValue({
      id: 'draft-1',
      columnMapping: null,
      config: { amountTolerance: 0.5 },
    });

    await updateDraft(USER_ID, 'draft-1', { config: { amountTolerance: 0.01 } });

    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'report.matching_rules.updated',
      entityType: 'report',
      entityId: 'draft-1',
      ip: undefined,
      userAgent: undefined,
      metadata: { changes: { amountTolerance: { from: 0.5, to: 0.01 } }, subject: { name: 'Untitled Reconciliation' } },
    });
  });

  it('does not log report.matching_rules.updated when the patch resaves the same config', async () => {
    mockPrisma.report.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.report.findFirst.mockResolvedValue({
      id: 'draft-1',
      columnMapping: null,
      config: { amountTolerance: 0.5 },
    });

    await updateDraft(USER_ID, 'draft-1', { config: { amountTolerance: 0.5 } });

    expect(mockLogAuditSafely).not.toHaveBeenCalled();
  });

  it('logs neither event for a patch that touches neither field (e.g. a progress-only autosave)', async () => {
    mockPrisma.report.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'draft-1' });

    await updateDraft(USER_ID, 'draft-1', { progress: 40 });

    expect(mockLogAuditSafely).not.toHaveBeenCalled();
  });
});

describe('listDrafts', () => {
  it("lists only the caller's own drafts, most recently updated first, with derived progress", async () => {
    const drafts = [
      { id: 'draft-1', status: 'draft', fileAKey: null, fileBKey: null, columnMapping: null, config: null },
      { id: 'draft-2', status: 'draft', fileAKey: 'a', fileBKey: 'b', columnMapping: null, config: null },
    ];
    mockPrisma.report.findMany.mockResolvedValue(drafts);

    const result = await listDrafts(USER_ID);

    expect(result).toEqual([
      { ...drafts[0], progress: 0 },
      { ...drafts[1], progress: 33 },
    ]);
    expect(mockPrisma.report.findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, organizationId: ORG_ID, status: 'draft' },
      orderBy: { updatedAt: 'desc' },
      omit: { fileASampleRows: true, fileBSampleRows: true },
    });
  });

  // The bug: without this omit, every draft in the list paid the cost of its
  // full cached mapping-preview sample (up to SAMPLE_ROW_CAP rows of every
  // column, several MB for a wide file) even though nothing in the response
  // ever reads it — making the drafts list take up to a minute for a user
  // with a few large-file-pair drafts.
  it('omits the cached sample-row blobs, which the draft list never reads', async () => {
    mockPrisma.report.findMany.mockResolvedValue([]);

    await listDrafts(USER_ID);

    expect(mockPrisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ omit: { fileASampleRows: true, fileBSampleRows: true } }),
    );
  });
});

describe('withDraftProgress (via getReport/listDrafts)', () => {
  const base = { id: 'r1', userId: USER_ID, status: 'draft', fileAKey: null, fileBKey: null, columnMapping: null, config: null, rows: [], sourceReportId: null };

  it('is 0% with no files uploaded yet', async () => {
    mockPrisma.report.findFirst.mockResolvedValue(base);
    const result = await getReport(USER_ID, 'r1');
    expect(result.progress).toBe(0);
  });

  it('is 33% once both files are uploaded but before mapping is saved', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...base, fileAKey: 'a', fileBKey: 'b' });
    const result = await getReport(USER_ID, 'r1');
    expect(result.progress).toBe(33);
  });

  it('is 66% once mapping is saved but before rules are saved', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...base, fileAKey: 'a', fileBKey: 'b', columnMapping: {} });
    const result = await getReport(USER_ID, 'r1');
    expect(result.progress).toBe(66);
  });

  it('is 90% once files, mapping, and rules are all saved', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...base, fileAKey: 'a', fileBKey: 'b', columnMapping: {}, config: {} });
    const result = await getReport(USER_ID, 'r1');
    expect(result.progress).toBe(90);
  });

  it('does not touch progress for a non-draft report', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...base, status: 'completed', progress: 100 });
    const result = await getReport(USER_ID, 'r1');
    expect(result.progress).toBe(100);
  });

  it('leaves progress at 0% for a template-created draft with config but no files yet', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...base, config: { amountTolerance: 0.5 } });
    const result = await getReport(USER_ID, 'r1');
    expect(result.progress).toBe(0);
  });
});

// Drives persistCompletedRun through the run pipeline, its only caller.
function completeRun(organizationId = ORG_ID) {
  mockPrisma.report.findFirst.mockResolvedValue({
    id: 'draft-1',
    name: 'June',
    userId: USER_ID,
    organizationId,
    fileAKey: 'uploads/u1/a.csv',
    fileBKey: 'uploads/u1/b.csv',
  });
  mockDownloadFromR2.mockResolvedValue(Buffer.from('x'));
  mockParseTabularFile.mockReturnValue({ headers: ['ref'], rows: [] });
  mockRunMatch.mockReturnValue({
    summary: { total: 2, matched: 1, mismatched: 1, unmatchedA: 0, unmatchedB: 0, duplicates: 0, totalBreakValue: 0 },
    rows: [],
  });
  return executeReconciliationRun({
    reportId: 'draft-1',
    userId: USER_ID,
    organizationId,
    dto: { columnMapping: runDto.columnMapping },
    config: runDto.config,
  });
}

describe('superseding on completion', () => {
  beforeEach(() => {
    mockTx.report.update.mockResolvedValue({ id: 'draft-1', fileAName: 'a.csv', fileBName: 'b.csv', totalRows: 2, matchedCount: 1 });
  });

  const supersedeCalls = () => mockTx.report.update.mock.calls.filter(([args]) => 'supersededById' in args.data);

  it('marks the source superseded by the rerun, inside the completion transaction, after locking the source', async () => {
    mockTx.report.findUnique
      .mockResolvedValueOnce({ sequenceNumber: 42, sourceReportId: 'source-1' })
      .mockResolvedValueOnce({ supersededById: null });

    await completeRun();

    expect(supersedeCalls()).toEqual([[{ where: { id: 'source-1' }, data: { supersededById: 'draft-1' } }]]);
    const lockCall = mockTx.$queryRaw.mock.calls.find(([sql]) => sql.join('').includes('FOR UPDATE'));
    expect(lockCall).toContain('source-1');
  });

  it('attaches to the end of the chain when the source was already superseded by an earlier rerun', async () => {
    mockTx.report.findUnique
      .mockResolvedValueOnce({ sequenceNumber: 42, sourceReportId: 'source-1' })
      .mockResolvedValueOnce({ supersededById: 'rerun-1' })
      .mockResolvedValueOnce({ supersededById: null });

    await completeRun();

    // The source keeps its link to rerun-1; rerun-1 is the one replaced now, so the chain stays linear.
    expect(supersedeCalls()).toEqual([[{ where: { id: 'rerun-1' }, data: { supersededById: 'draft-1' } }]]);
  });

  it('changes nothing on a retried completion that already superseded its source', async () => {
    mockTx.report.findUnique
      .mockResolvedValueOnce({ sequenceNumber: 42, sourceReportId: 'source-1' })
      .mockResolvedValueOnce({ supersededById: 'draft-1' });

    await completeRun();

    expect(supersedeCalls()).toEqual([]);
  });

  it('does nothing for an ordinary run, which has no source', async () => {
    mockTx.report.findUnique.mockResolvedValueOnce({ sequenceNumber: 42, sourceReportId: null });

    await completeRun();

    expect(supersedeCalls()).toEqual([]);
    expect(mockTx.$queryRaw.mock.calls.some(([sql]) => sql.join('').includes('FOR UPDATE'))).toBe(false);
  });

  it('does nothing when the source was deleted while the rerun ran', async () => {
    mockTx.report.findUnique.mockResolvedValueOnce({ sequenceNumber: 42, sourceReportId: 'source-1' }).mockResolvedValueOnce(null);

    await completeRun();

    expect(supersedeCalls()).toEqual([]);
  });
});

const runDto = {
  columnMapping: {
    fileA: { referenceNumber: 'Transaction_ID', amount: 'Debit Amount', transactionDate: 'Posting Date' },
    fileB: { referenceNumber: 'Ref_No', amount: 'Amount', transactionDate: 'Value Date' },
  },
  config: { amountTolerance: 0.5, dateToleranceDays: 1 },
};

describe('sequence numbers on completion', () => {
  it('assigns a sequence number on first completion (no prior sequence on the draft)', async () => {
    mockTx.report.findUnique.mockResolvedValue({ sequenceNumber: null });
    mockTx.reportSequence.upsert.mockResolvedValue({ year: CURRENT_YEAR, lastValue: 7 });
    mockTx.report.update.mockResolvedValue({ id: 'draft-1', totalRows: 2, matchedCount: 1 });

    await completeRun();

    expect(mockTx.report.findUnique).toHaveBeenCalledWith({ where: { id: 'draft-1' }, select: { sequenceNumber: true, sourceReportId: true } });
    expect(mockTx.report.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sequenceYear: CURRENT_YEAR, sequenceNumber: 7 }) }),
    );
  });

  // Regression test for the bug where ReportSequence was keyed only by year
  // — every organization shared one counter, so one org's completions
  // inflated the "Run #" every other org's next run started from. The
  // upsert must be scoped by (year, organizationId), not year alone.
  it("scopes the sequence-number upsert to the run's own organization, not a global year-only counter", async () => {
    mockTx.report.findUnique.mockResolvedValue({ sequenceNumber: null });
    mockTx.reportSequence.upsert.mockResolvedValue({ year: CURRENT_YEAR, lastValue: 1 });
    mockTx.report.update.mockResolvedValue({ id: 'draft-1', totalRows: 2, matchedCount: 1 });

    await completeRun('org-7');

    expect(mockTx.reportSequence.upsert).toHaveBeenCalledWith({
      where: { year_organizationId: { year: CURRENT_YEAR, organizationId: 'org-7' } },
      create: { year: CURRENT_YEAR, organizationId: 'org-7', lastValue: 1 },
      update: { lastValue: { increment: 1 } },
    });
  });

  it('does not reassign a sequence number on a retry that already has one', async () => {
    mockTx.report.findUnique.mockResolvedValue({ sequenceNumber: 42 });
    mockTx.report.update.mockResolvedValue({ id: 'draft-1', totalRows: 2, matchedCount: 1 });

    await completeRun();

    expect(mockTx.reportSequence.upsert).not.toHaveBeenCalled();
    const updateData = mockTx.report.update.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty('sequenceYear');
    expect(updateData).not.toHaveProperty('sequenceNumber');
  });
});

describe('enqueueReconciliationRun', () => {
  const draft = {
    id: 'draft-1',
    userId: USER_ID,
    name: 'Old name',
    fileAName: 'a.csv',
    fileBName: 'b.csv',
    fileAKey: 'uploads/u1/a.csv',
    fileBKey: 'uploads/u1/b.csv',
    status: 'draft',
  };

  beforeEach(() => {
    mockPrisma.report.findFirst.mockResolvedValue(draft);
    mockPrisma.report.update.mockResolvedValue({ id: 'draft-1', status: 'processing' });
  });

  it('validates, flips the report to processing, and enqueues a job — never running the pipeline itself', async () => {
    const id = await enqueueReconciliationRun(USER_ID, 'draft-1', runDto);

    expect(id).toBe('draft-1');
    expect(mockPrisma.report.update).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: { status: 'processing', progress: 10, errorMessage: null },
    });
    expect(mockEnqueueReconciliationJob).toHaveBeenCalledWith({
      reportId: 'draft-1',
      userId: USER_ID,
      organizationId: ORG_ID,
      ip: null,
      userAgent: null,
      dto: { name: runDto.name, columnMapping: runDto.columnMapping },
      config: runDto.config,
    });
    // The actual pipeline runs in the worker, not here.
    expect(mockDownloadFromR2).not.toHaveBeenCalled();
    expect(mockRunMatch).not.toHaveBeenCalled();
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'report.run.started',
      entityType: 'report',
      entityId: 'draft-1',
      status: 'info',
      ip: undefined,
      userAgent: undefined,
      metadata: { filePair: 'a.csv vs b.csv', subject: { name: 'Old name' } },
    });
  });

  it("throws NotFoundError when there's no such draft owned by the caller", async () => {
    mockPrisma.report.findFirst.mockResolvedValue(null);

    await expect(enqueueReconciliationRun(USER_ID, 'missing', runDto)).rejects.toBeInstanceOf(NotFoundError);
    expect(mockEnqueueReconciliationJob).not.toHaveBeenCalled();
  });

  it('throws ValidationError when either file has not been uploaded yet', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...draft, fileBKey: null });

    await expect(enqueueReconciliationRun(USER_ID, 'draft-1', runDto)).rejects.toBeInstanceOf(ValidationError);
    expect(mockEnqueueReconciliationJob).not.toHaveBeenCalled();
  });

  it('accepts a previously failed run for retry (status draft-or-failed)', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...draft, status: 'failed' });

    await enqueueReconciliationRun(USER_ID, 'draft-1', runDto);

    expect(mockPrisma.report.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'draft-1', userId: USER_ID, status: { in: ['draft', 'failed'] } } }),
    );
  });
});

describe('executeReconciliationRun', () => {
  const draft = {
    id: 'draft-1',
    name: 'Old name',
    fileAName: 'a.csv',
    fileBName: 'b.csv',
    fileAKey: 'uploads/u1/a.csv',
    fileBKey: 'uploads/u1/b.csv',
  };

  const jobPayload = {
    reportId: 'draft-1',
    userId: USER_ID,
    organizationId: ORG_ID,
    ip: undefined,
    dto: { name: undefined, columnMapping: runDto.columnMapping },
    config: runDto.config,
  };

  beforeEach(() => {
    mockPrisma.report.findFirst.mockResolvedValue(draft);
    mockDownloadFromR2.mockResolvedValue(Buffer.from('x'));
    mockParseTabularFile.mockReturnValue({ headers: ['ref'], rows: [] });
    mockRunMatch.mockReturnValue({
      summary: { total: 0, matched: 0, mismatched: 0, unmatchedA: 0, unmatchedB: 0, duplicates: 0, totalBreakValue: 0 },
      rows: [],
    });
    mockTx.report.update.mockResolvedValue({
      id: 'draft-1',
      fileAName: 'a.csv',
      fileBName: 'b.csv',
      totalRows: 2,
      matchedCount: 1,
      totalBreakValue: 50,
    });
  });

  it('downloads+parses both files fresh, runs the match, and persists a completed report', async () => {
    const id = await executeReconciliationRun(jobPayload);

    expect(id).toBe('draft-1');
    expect(mockDownloadFromR2).toHaveBeenCalledWith('uploads/u1/a.csv', expect.objectContaining({ onProgress: expect.any(Function) }));
    expect(mockDownloadFromR2).toHaveBeenCalledWith('uploads/u1/b.csv', expect.objectContaining({ onProgress: expect.any(Function) }));
    expect(mockRunMatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      runDto.columnMapping.fileA,
      runDto.columnMapping.fileB,
      runDto.config,
      { A: new Map(), B: new Map() },
    );
    expect(mockDeleteReportRows).toHaveBeenCalledWith('draft-1');
    expect(mockCopyReportRowsIn).toHaveBeenCalledWith('draft-1', [], expect.objectContaining({ onProgress: expect.any(Function) }));
    expect(mockTx.report.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'draft-1' },
        data: expect.objectContaining({ status: 'completed', columnMapping: runDto.columnMapping }),
      }),
    );
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'report.run.completed',
      entityType: 'report',
      entityId: 'draft-1',
      ip: undefined,
      userAgent: undefined,
      metadata: { matchRate: '50.00%', totalBreakValue: 50, correctionsApplied: 0, subject: { name: 'Untitled Reconciliation' } },
    });
  });

  it('bumps progress at the parse and match checkpoints', async () => {
    await executeReconciliationRun(jobPayload);

    expect(mockPrisma.report.update).toHaveBeenCalledWith({ where: { id: 'draft-1' }, data: { progress: 55 } });
    expect(mockPrisma.report.update).toHaveBeenCalledWith({ where: { id: 'draft-1' }, data: { progress: 60 } });
  });

  it("never writes sourceReportId, so a rerun's link from creation survives the run", async () => {
    mockPrisma.report.findFirst.mockResolvedValueOnce({ ...draft, sourceReportId: 'source-report' });

    await executeReconciliationRun(jobPayload);

    const completionData = mockTx.report.update.mock.calls[0][0].data;
    expect(completionData).not.toHaveProperty('sourceReportId');
    // No file-pair lookup any more: the draft lookup is the only report read.
    expect(mockPrisma.report.findFirst).toHaveBeenCalledTimes(1);
  });

  it('throws NotFoundError when the report no longer exists', async () => {
    mockPrisma.report.findFirst.mockResolvedValue(null);

    await expect(executeReconciliationRun(jobPayload)).rejects.toBeInstanceOf(NotFoundError);
    expect(mockDownloadFromR2).not.toHaveBeenCalled();
  });

  it('clears any prior errorMessage on a successful persisted run', async () => {
    await executeReconciliationRun(jobPayload);

    expect(mockTx.report.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ errorMessage: null }) }),
    );
  });

  it('persists a failed Report row and rethrows when the file download fails', async () => {
    const downloadError = new Error('R2 object not found');
    mockDownloadFromR2.mockRejectedValue(downloadError);
    mockPrisma.report.update.mockResolvedValue({ id: 'draft-1', status: 'failed' });

    await expect(executeReconciliationRun({ ...jobPayload, ip: '10.0.0.1' })).rejects.toBe(downloadError);

    expect(mockPrisma.report.update).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: { status: 'failed', errorMessage: 'R2 object not found' },
    });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'report.run.failed',
      entityType: 'report',
      entityId: 'draft-1',
      status: 'failed',
      ip: '10.0.0.1',
      userAgent: undefined,
      metadata: { reason: 'R2 object not found', subject: { name: 'Old name' } },
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('persists a failed Report row when parsing throws (e.g. an unrecognized file extension)', async () => {
    const parseError = new Error('Unsupported file extension: txt');
    mockParseTabularFile.mockImplementation(() => {
      throw parseError;
    });
    mockPrisma.report.update.mockResolvedValue({ id: 'draft-1', status: 'failed' });

    await expect(executeReconciliationRun(jobPayload)).rejects.toBe(parseError);
    expect(mockPrisma.report.update).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: { status: 'failed', errorMessage: 'Unsupported file extension: txt' },
    });
  });

  // The persistence-gap fix: a failure in the bulk row write (or the final
  // status-flip transaction) now correctly lands the report in `failed`
  // too, instead of leaving it silently stuck in whatever state it was in
  // (this exact scenario is what happened to the real AFTAB report before
  // this fix — stuck in `draft` with no errorMessage).
  it('persists a failed Report row when the bulk row write throws', async () => {
    const copyError = new Error('COPY failed: connection reset');
    mockCopyReportRowsIn.mockRejectedValueOnce(copyError);
    mockPrisma.report.update.mockResolvedValue({ id: 'draft-1', status: 'failed' });

    await expect(executeReconciliationRun(jobPayload)).rejects.toBe(copyError);
    expect(mockPrisma.report.update).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: { status: 'failed', errorMessage: 'COPY failed: connection reset' },
    });
  });

  it("runs with the corrections for the draft's current files and marks exactly those applied on completion", async () => {
    mockPrisma.reportCorrection.findMany.mockResolvedValue([
      { id: 'c1', side: 'A', rowIndex: 3, field: 'reference', correctedValue: 'INV-2231' },
      { id: 'c2', side: 'B', rowIndex: 3, field: 'amount', correctedValue: '10.00' },
      { id: 'c3', side: 'B', rowIndex: 3, field: 'date', correctedValue: '2026-01-01' },
    ]);

    await executeReconciliationRun(jobPayload);

    expect(mockPrisma.reportCorrection.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        reportId: 'draft-1',
        applied: false,
        OR: [{ side: 'A', fileKey: draft.fileAKey }, { side: 'B', fileKey: draft.fileBKey }],
      },
    }));
    const corrections = mockRunMatch.mock.calls[0][5];
    expect(corrections.A).toEqual(new Map([[3, { reference: 'INV-2231' }]]));
    expect(corrections.B).toEqual(new Map([[3, { amount: '10.00', date: '2026-01-01' }]]));
    expect(mockTx.reportCorrection.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['c1', 'c2', 'c3'] }, reportId: 'draft-1' },
      data: { applied: true },
    });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
      action: 'report.run.completed',
      metadata: expect.objectContaining({ correctionsApplied: 3 }),
    }));
  });

  it('leaves corrections pending when the run fails', async () => {
    mockPrisma.reportCorrection.findMany.mockResolvedValue([{ id: 'c1', side: 'A', rowIndex: 3, field: 'amount', correctedValue: '1' }]);
    mockCopyReportRowsIn.mockRejectedValueOnce(new Error('COPY failed'));
    mockPrisma.report.update.mockResolvedValue({ id: 'draft-1', status: 'failed' });

    await expect(executeReconciliationRun(jobPayload)).rejects.toThrow('COPY failed');
    expect(mockTx.reportCorrection.updateMany).not.toHaveBeenCalled();
  });

  it('marks nothing applied when the draft has no corrections', async () => {
    await executeReconciliationRun(jobPayload);

    expect(mockTx.reportCorrection.updateMany).not.toHaveBeenCalled();
  });
});

describe('getMappingPreview', () => {
  const draft = {
    id: 'draft-1',
    userId: USER_ID,
    fileAName: 'a.csv',
    fileBName: 'b.csv',
    fileAKey: 'uploads/u1/a.csv',
    fileBKey: 'uploads/u1/b.csv',
    columnMapping: null,
    status: 'draft',
  };

  beforeEach(() => {
    mockPrisma.report.findFirst.mockResolvedValue(draft);
    mockDownloadFromR2.mockResolvedValue(Buffer.from('xxxx'));
    mockParseTabularFile
      .mockReturnValueOnce({ headers: ['Ref'], rows: [{ Ref: 'R1' }] })
      .mockReturnValueOnce({ headers: ['Ref'], rows: [{ Ref: 'R1' }] });
    mockSuggestMapping.mockReturnValue([{ field: 'referenceNumber', label: 'Reference Number', value: 'Ref', confidence: 90 }]);
    mockMappingFromSuggestions.mockReturnValue({ referenceNumber: 'Ref' });
    mockComputeValidationSummary.mockReturnValue({
      missingValues: { count: 0, percent: 0 },
      duplicateReferences: { count: 0, percent: 0 },
    });
  });

  it('returns per-file preview data and caches a sample + suggested mapping on the draft', async () => {
    const preview = await getMappingPreview(USER_ID, 'draft-1');

    expect(preview.fileA.filename).toBe('a.csv');
    expect(preview.fileA.rows).toBe(1);
    expect(preview.fileA.mappings).toEqual([
      { field: 'referenceNumber', label: 'Reference Number', value: 'Ref', confidence: 90 },
    ]);
    // Postgres only gets a small marker (row data lives in Redis — see
    // mappingSampleCache.js) recording that a sample exists and its total
    // row count, for extrapolatePreview's scale factor.
    expect(mockPrisma.report.update).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: expect.objectContaining({
        fileASampleRows: { totalRows: 1 },
        fileBSampleRows: { totalRows: 1 },
        columnMapping: { fileA: { referenceNumber: 'Ref' }, fileB: { referenceNumber: 'Ref' } },
      }),
    });
    expect(mockSetSampleRows).toHaveBeenCalledWith('draft-1', 'A', [{ Ref: 'R1' }]);
    expect(mockSetSampleRows).toHaveBeenCalledWith('draft-1', 'B', [{ Ref: 'R1' }]);
  });

  it('persists per-file summaries (rows/columns/fileSizeBytes) that survive completion, unlike the sample-rows cache', async () => {
    const preview = await getMappingPreview(USER_ID, 'draft-1');

    expect(preview.fileA).toEqual(
      expect.objectContaining({ rows: 1, columns: 1, fileSizeBytes: 4 }),
    );
    expect(mockPrisma.report.update).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: expect.objectContaining({
        fileASummary: { rows: 1, columns: 1, fileSizeBytes: 4 },
        fileBSummary: { rows: 1, columns: 1, fileSizeBytes: 4 },
      }),
    });
  });

  it('does not overwrite an already-saved column mapping', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...draft, columnMapping: { fileA: {}, fileB: {} } });

    await getMappingPreview(USER_ID, 'draft-1');

    const call = mockPrisma.report.update.mock.calls[0][0];
    expect(call.data.columnMapping).toBeUndefined();
  });

  it('re-suggests only the side whose file was replaced, keeping the other saved side', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...draft, columnMapping: { fileA: { referenceNumber: 'Saved' } } });

    await getMappingPreview(USER_ID, 'draft-1');

    const call = mockPrisma.report.update.mock.calls[0][0];
    expect(call.data.columnMapping).toEqual({ fileA: { referenceNumber: 'Saved' }, fileB: { referenceNumber: 'Ref' } });
  });

  it('throws ValidationError when either file has not been uploaded yet', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...draft, fileAKey: null });

    await expect(getMappingPreview(USER_ID, 'draft-1')).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws NotFoundError when there's no such draft owned by the caller", async () => {
    mockPrisma.report.findFirst.mockResolvedValue(null);

    await expect(getMappingPreview(USER_ID, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('accepts a previously failed run for retry (status draft-or-failed)', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...draft, status: 'failed' });

    await getMappingPreview(USER_ID, 'draft-1');

    expect(mockPrisma.report.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'draft-1', userId: USER_ID, status: { in: ['draft', 'failed'] } } }),
    );
  });
});

describe('getRulePreview', () => {
  const sampleMarker = { totalRows: 2 };
  const sampleRows = [{ ref: 'R1' }];
  const draft = {
    id: 'draft-1',
    userId: USER_ID,
    fileASampleRows: sampleMarker,
    fileBSampleRows: sampleMarker,
    columnMapping: runDto.columnMapping,
    status: 'draft',
  };

  beforeEach(() => {
    mockPrisma.report.findFirst.mockResolvedValue(draft);
    mockGetSampleRows.mockResolvedValue(sampleRows);
    mockRunMatch.mockReturnValue({
      summary: { matched: 1, mismatched: 0, duplicates: 0, unmatchedA: 0, unmatchedB: 0 },
      rows: [],
    });
    mockExtrapolatePreview.mockReturnValue({
      estimatedMatches: 1,
      possibleMismatches: 0,
      potentialDuplicates: 0,
      missingReferences: 0,
    });
  });

  it('runs the match against the cached sample and extrapolates the result', async () => {
    const result = await getRulePreview(USER_ID, 'draft-1', { config: runDto.config });

    expect(result).toEqual({
      estimatedMatches: 1,
      possibleMismatches: 0,
      potentialDuplicates: 0,
      missingReferences: 0,
    });
    expect(mockGetSampleRows).toHaveBeenCalledWith('draft-1', 'A');
    expect(mockGetSampleRows).toHaveBeenCalledWith('draft-1', 'B');
    expect(mockRunMatch).toHaveBeenCalledWith(
      { rows: sampleRows },
      { rows: sampleRows },
      runDto.columnMapping.fileA,
      runDto.columnMapping.fileB,
      runDto.config,
      { A: new Map(), B: new Map() },
    );
    expect(mockExtrapolatePreview).toHaveBeenCalledWith(expect.anything(), 1, 2, 1, 2);
  });

  it('uses an explicit columnMapping override when provided instead of the cached one', async () => {
    const override = { fileA: { referenceNumber: 'X', amount: 'Y', transactionDate: 'Z' }, fileB: runDto.columnMapping.fileB };

    await getRulePreview(USER_ID, 'draft-1', { config: runDto.config, columnMapping: override });

    expect(mockRunMatch).toHaveBeenCalledWith(expect.anything(), expect.anything(), override.fileA, override.fileB, runDto.config, expect.any(Object));
  });

  it('throws ConflictError when no sample has been cached yet (Postgres marker absent)', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...draft, fileASampleRows: null });

    await expect(getRulePreview(USER_ID, 'draft-1', { config: runDto.config })).rejects.toBeInstanceOf(ConflictError);
  });

  // The Postgres marker only gets cleared on run completion, not on Redis
  // TTL expiry — so a marker-present-but-cache-gone state is a real,
  // separate case, not just defensive padding.
  it('throws ConflictError when the marker exists but the Redis cache has expired', async () => {
    mockGetSampleRows.mockResolvedValueOnce(null);

    await expect(getRulePreview(USER_ID, 'draft-1', { config: runDto.config })).rejects.toBeInstanceOf(ConflictError);
  });

  it('throws ConflictError when no column mapping is available anywhere', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...draft, columnMapping: null });

    await expect(getRulePreview(USER_ID, 'draft-1', { config: runDto.config })).rejects.toBeInstanceOf(ConflictError);
  });

  it("throws NotFoundError when there's no such draft owned by the caller", async () => {
    mockPrisma.report.findFirst.mockResolvedValue(null);

    await expect(getRulePreview(USER_ID, 'missing', { config: runDto.config })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('getTransactions', () => {
  beforeEach(() => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', organizationId: ORG_ID, status: 'completed' });
    mockPrisma.reportRow.findMany.mockResolvedValue([
      { id: 'row-1', ref: 'REF1', status: 'matched', amountA: 100, amountB: 100, amountDiff: 0, dateA: new Date('2026-01-01'), dateB: new Date('2026-01-01'), reviewed: false, rawA: {}, rawB: {} },
    ]);
    mockPrisma.reportRow.count.mockResolvedValue(1);
    mockBuildShortReason.mockReturnValue({ type: 'Other', reason: '' });
  });

  it('lists rows for a report the caller can access, mapped to the Explorer shape', async () => {
    const result = await getTransactions(USER_ID, 'r1', {});

    expect(result.total).toBe(1);
    expect(result.rows[0]).toEqual(
      expect.objectContaining({ id: 'row-1', status: 'Matched', reference: 'REF1', ledgerAmount: 100 }),
    );
    expect(mockPrisma.reportRow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { reportId: 'r1' }, take: 50, skip: 0 }),
    );
  });

  it("maps the 'unmatched' status filter to both unmatched_a and unmatched_b", async () => {
    await getTransactions(USER_ID, 'r1', { status: 'unmatched' });

    expect(mockPrisma.reportRow.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { reportId: 'r1', status: { in: ['unmatched_a', 'unmatched_b'] } } }),
    );
  });

  it('applies search/amount-range/date-range as AND conditions', async () => {
    await getTransactions(USER_ID, 'r1', { search: 'REF', amountMin: 10, amountMax: 100, dateFrom: '2026-01-01', dateTo: '2026-01-31' });

    const call = mockPrisma.reportRow.findMany.mock.calls[0][0];
    expect(call.where.AND).toHaveLength(3);
  });

  it('throws NotFoundError when the report is inaccessible', async () => {
    mockPrisma.report.findFirst.mockResolvedValue(null);

    await expect(getTransactions(USER_ID, 'missing', {})).rejects.toBeInstanceOf(NotFoundError);
  });

  it('ignores an unknown status instead of passing it to Prisma', async () => {
    await getTransactions(USER_ID, 'r1', { status: 'not-a-status' });

    expect(mockPrisma.reportRow.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { reportId: 'r1' } }));
  });

  it('accepts an explicit unmatched side for the match picker', async () => {
    await getTransactions(USER_ID, 'r1', { status: 'unmatched_b' });

    expect(mockPrisma.reportRow.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { reportId: 'r1', status: 'unmatched_b' } }));
  });

  it('filters by resolution and returns each row with its resolution in the same query', async () => {
    mockPrisma.reportRow.findMany.mockResolvedValue([
      { id: 'row-1', ref: 'REF1', status: 'unmatched_a', reviewed: false, resolution: { id: 'res-1', kind: 'explained' } },
    ]);

    const result = await getTransactions(USER_ID, 'r1', { resolution: 'resolved' });

    const call = mockPrisma.reportRow.findMany.mock.calls[0][0];
    expect(call.where.AND).toEqual([{ resolutionId: { not: null } }]);
    expect(call.include).toEqual({ resolution: { select: { id: true, kind: true } } });
    expect(result.rows[0].resolution).toEqual({ id: 'res-1', kind: 'explained' });
  });

  it("maps a row with no resolution to resolution: null and filters 'unresolved' by a null link", async () => {
    const result = await getTransactions(USER_ID, 'r1', { resolution: 'unresolved' });

    expect(mockPrisma.reportRow.findMany.mock.calls[0][0].where.AND).toEqual([{ resolutionId: null }]);
    expect(result.rows[0].resolution).toBeNull();
  });
});

describe('getTransaction', () => {
  it('returns a single row with raw fields, match analysis, and recommended action', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', organizationId: ORG_ID, status: 'completed', rulesConfig: { amountTolerance: 0.5 } });
    const row = { id: 'row-1', ref: 'REF1', status: 'mismatched', amountA: 100, amountB: 90, amountDiff: 10, rawA: { a: 1 }, rawB: { b: 2 } };
    mockPrisma.reportRow.findFirst.mockResolvedValue(row);
    mockBuildMatchAnalysis.mockReturnValue([{ text: 'x', passed: false }]);
    mockBuildRecommendedAction.mockReturnValue('Review it');

    const result = await getTransaction(USER_ID, 'r1', 'row-1');

    expect(result.rawA).toEqual({ a: 1 });
    expect(result.matchAnalysis).toEqual([{ text: 'x', passed: false }]);
    expect(result.recommendedAction).toBe('Review it');
    expect(mockBuildMatchAnalysis).toHaveBeenCalledWith(row, { amountTolerance: 0.5 });
  });

  it("returns the row's full resolution, with a null resolvedBy once that user is gone", async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', organizationId: ORG_ID, status: 'completed' });
    mockPrisma.reportRow.findFirst.mockResolvedValue({
      id: 'row-1',
      ref: 'REF1',
      status: 'unmatched_b',
      resolution: {
        id: 'res-1',
        kind: 'explained',
        note: 'Bank fee',
        resolvedAt: new Date('2026-10-27T10:00:00Z'),
        resolvedByUser: null,
        rows: [{ id: 'row-1', ref: 'REF1', status: 'unmatched_b' }],
      },
    });

    const result = await getTransaction(USER_ID, 'r1', 'row-1');

    expect(mockPrisma.reportRow.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'row-1', reportId: 'r1' } }));
    expect(result.resolution).toEqual({
      id: 'res-1',
      kind: 'explained',
      note: 'Bank fee',
      resolvedAt: new Date('2026-10-27T10:00:00Z'),
      resolvedBy: null,
      rows: [{ id: 'row-1', reference: 'REF1', side: 'B' }],
    });
  });

  it('throws NotFoundError when the row does not belong to the report', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', organizationId: ORG_ID, status: 'completed' });
    mockPrisma.reportRow.findFirst.mockResolvedValue(null);

    await expect(getTransaction(USER_ID, 'r1', 'missing-row')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('resolveRows', () => {
  const ROW_A = { id: 'row-a', ref: 'INV-1', status: 'unmatched_a', resolutionId: null };
  const ROW_B = { id: 'row-b', ref: 'BNK-1', status: 'unmatched_b', resolutionId: null };
  const STORED_RESOLUTION = {
    id: 'res-1',
    kind: 'matched',
    note: 'Same payment',
    resolvedAt: new Date('2026-10-27T10:00:00Z'),
    resolvedByUser: { id: USER_ID, name: 'Ada' },
    rows: [
      { id: 'row-a', ref: 'INV-1', status: 'unmatched_a' },
      { id: 'row-b', ref: 'BNK-1', status: 'unmatched_b' },
    ],
  };

  beforeEach(() => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', organizationId: ORG_ID, status: 'completed', userId: USER_ID });
    mockPrisma.reportRow.findMany.mockResolvedValue([ROW_A, ROW_B]);
    mockTx.reportRowResolution.create.mockResolvedValue({ id: 'res-1' });
    mockTx.reportRow.updateMany.mockResolvedValue({ count: 2 });
    mockTx.reportRowResolution.findUnique.mockResolvedValue(STORED_RESOLUTION);
  });

  const matchInput = { kind: 'matched', rowIds: ['row-a', 'row-b'], note: 'Same payment' };

  it("404s on another organization's report without reading or writing any row", async () => {
    // assertReportAccess scopes the lookup to the caller's org, so a foreign report id comes back empty.
    mockPrisma.report.findFirst.mockResolvedValue(null);

    await expect(resolveRows(USER_ID, 'foreign-report', matchInput)).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.report.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'foreign-report', organizationId: ORG_ID } }));
    expect(mockPrisma.reportRow.findMany).not.toHaveBeenCalled();
    expect(mockTx.reportRowResolution.create).not.toHaveBeenCalled();
  });

  it('404s when a row id belongs to a different report', async () => {
    mockPrisma.reportRow.findMany.mockResolvedValue([ROW_A]);

    await expect(resolveRows(USER_ID, 'r1', matchInput)).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.reportRow.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['row-a', 'row-b'] }, reportId: 'r1' } }));
    expect(mockTx.reportRowResolution.create).not.toHaveBeenCalled();
  });

  it('404s on a report that is not completed', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', organizationId: ORG_ID, status: 'processing', userId: USER_ID });

    await expect(resolveRows(USER_ID, 'r1', matchInput)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('pairs one unmatched row from each side in one transaction and audit-logs it after', async () => {
    const result = await resolveRows(USER_ID, 'r1', matchInput, { ip: '1.2.3.4', userAgent: 'jest' });

    expect(mockTx.reportRowResolution.create).toHaveBeenCalledWith({
      data: { reportId: 'r1', kind: 'matched', note: 'Same payment', resolvedBy: USER_ID },
      select: { id: true },
    });
    expect(mockTx.reportRow.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['row-a', 'row-b'] }, reportId: 'r1', resolutionId: null },
      data: { resolutionId: 'res-1' },
    });
    expect(result).toEqual({
      id: 'res-1',
      kind: 'matched',
      note: 'Same payment',
      resolvedAt: STORED_RESOLUTION.resolvedAt,
      resolvedBy: { id: USER_ID, name: 'Ada' },
      rows: [
        { id: 'row-a', reference: 'INV-1', side: 'A' },
        { id: 'row-b', reference: 'BNK-1', side: 'B' },
      ],
    });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        action: 'report.row.resolve',
        entityId: 'r1',
        metadata: expect.objectContaining({ resolutionId: 'res-1', kind: 'matched', transactionRefs: ['INV-1', 'BNK-1'] }),
      }),
    );
  });

  it('rejects a match of two rows from the same side', async () => {
    mockPrisma.reportRow.findMany.mockResolvedValue([ROW_A, { ...ROW_B, status: 'unmatched_a' }]);

    await expect(resolveRows(USER_ID, 'r1', matchInput)).rejects.toBeInstanceOf(ValidationError);
    expect(mockTx.reportRowResolution.create).not.toHaveBeenCalled();
  });

  it('rejects a match that includes a mismatched row', async () => {
    mockPrisma.reportRow.findMany.mockResolvedValue([ROW_A, { ...ROW_B, status: 'mismatched' }]);

    await expect(resolveRows(USER_ID, 'r1', matchInput)).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects resolving a matched row of either kind', async () => {
    mockPrisma.reportRow.findMany.mockResolvedValue([{ ...ROW_A, status: 'matched' }]);

    await expect(resolveRows(USER_ID, 'r1', { kind: 'explained', rowIds: ['row-a'], note: 'n' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('allows explaining mismatched and duplicate rows', async () => {
    mockPrisma.reportRow.findMany.mockResolvedValue([
      { ...ROW_A, status: 'mismatched' },
      { ...ROW_B, status: 'duplicate' },
    ]);

    await expect(resolveRows(USER_ID, 'r1', { kind: 'explained', rowIds: ['row-a', 'row-b'], note: 'Bank fee' })).resolves.toBeDefined();
  });

  it('409s when a row is already resolved, before writing anything', async () => {
    mockPrisma.reportRow.findMany.mockResolvedValue([ROW_A, { ...ROW_B, resolutionId: 'res-0' }]);

    await expect(resolveRows(USER_ID, 'r1', matchInput)).rejects.toBeInstanceOf(ConflictError);
    expect(mockTx.reportRowResolution.create).not.toHaveBeenCalled();
  });

  it('409s and audits nothing when a concurrent resolve claims a row between the read and the write', async () => {
    // The guarded updateMany skips the row another transaction already took; throwing inside the
    // transaction rolls back the resolution created just before it.
    mockTx.reportRow.updateMany.mockResolvedValue({ count: 1 });

    await expect(resolveRows(USER_ID, 'r1', matchInput)).rejects.toBeInstanceOf(ConflictError);
    expect(mockTx.reportRowResolution.findUnique).not.toHaveBeenCalled();
    expect(mockLogAuditSafely).not.toHaveBeenCalled();
  });
});

describe('unresolve', () => {
  beforeEach(() => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', organizationId: ORG_ID, status: 'completed', userId: USER_ID });
    mockPrisma.reportRowResolution.findFirst.mockResolvedValue({
      id: 'res-1',
      kind: 'explained',
      note: 'Timing difference',
      rows: [{ ref: 'INV-1' }],
    });
    mockPrisma.reportRowResolution.deleteMany.mockResolvedValue({ count: 1 });
  });

  it("404s on another organization's report without touching resolutions", async () => {
    mockPrisma.report.findFirst.mockResolvedValue(null);

    await expect(unresolve(USER_ID, 'foreign-report', 'res-1')).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.reportRowResolution.deleteMany).not.toHaveBeenCalled();
  });

  it('404s for a resolution id that belongs to a different report', async () => {
    mockPrisma.reportRowResolution.findFirst.mockResolvedValue(null);

    await expect(unresolve(USER_ID, 'r1', 'res-of-other-report')).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.reportRowResolution.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'res-of-other-report', reportId: 'r1' } }));
    expect(mockPrisma.reportRowResolution.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes the resolution scoped to the report and audit-logs what was undone', async () => {
    await unresolve(USER_ID, 'r1', 'res-1');

    expect(mockPrisma.reportRowResolution.deleteMany).toHaveBeenCalledWith({ where: { id: 'res-1', reportId: 'r1' } });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        action: 'report.row.unresolve',
        metadata: expect.objectContaining({ kind: 'explained', note: 'Timing difference', transactionRefs: ['INV-1'] }),
      }),
    );
  });

  it('404s when a concurrent undo deleted it first', async () => {
    mockPrisma.reportRowResolution.deleteMany.mockResolvedValue({ count: 0 });

    await expect(unresolve(USER_ID, 'r1', 'res-1')).rejects.toBeInstanceOf(NotFoundError);
    expect(mockLogAuditSafely).not.toHaveBeenCalled();
  });
});

describe('markRowReviewed', () => {
  beforeEach(() => {
    mockPrisma.report.findFirst.mockResolvedValue({
      id: 'r1',
      organizationId: ORG_ID,
      status: 'completed',
      sequenceYear: 2026,
      sequenceNumber: 8,
    });
  });

  it('marks a row reviewed and audit-logs it with the formatted report reference, not the raw id', async () => {
    mockPrisma.reportRow.updateMany.mockResolvedValue({ count: 1 });
    const row = { id: 'row-1', ref: 'TXN-00042', status: 'mismatched', reviewed: true };
    mockPrisma.reportRow.findFirst.mockResolvedValue(row);

    const result = await markRowReviewed(USER_ID, 'r1', 'row-1', true, { ip: '10.0.0.1' });

    expect(result).toEqual(row);
    expect(mockPrisma.reportRow.findFirst).toHaveBeenCalledWith({ where: { id: 'row-1', reportId: 'r1' } });
    expect(mockPrisma.reportRow.updateMany).toHaveBeenCalledWith({
      where: { id: 'row-1', reportId: 'r1' },
      data: expect.objectContaining({ reviewed: true, reviewedBy: USER_ID }),
    });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        action: 'report.row.review',
        metadata: {
          transactionRef: 'TXN-00042',
          rowStatus: 'mismatched',
          reviewed: true,
          subject: { name: 'Untitled Reconciliation', code: 'REC-2026-000008' },
        },
      }),
    );
  });

  it('names the report without a reference when it has no sequence number yet', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', name: 'Q2 Bank', organizationId: ORG_ID, status: 'completed', sequenceYear: null, sequenceNumber: null });
    mockPrisma.reportRow.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.reportRow.findFirst.mockResolvedValue({ id: 'row-1', ref: 'TXN-1', status: 'matched', reviewed: true });

    await markRowReviewed(USER_ID, 'r1', 'row-1', true);

    expect(mockLogAuditSafely).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        metadata: { transactionRef: 'TXN-1', rowStatus: 'matched', reviewed: true, subject: { name: 'Q2 Bank' } },
      }),
    );
  });

  it('clears reviewedBy/reviewedAt when un-reviewing', async () => {
    mockPrisma.reportRow.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.reportRow.findFirst.mockResolvedValue({ id: 'row-1', reviewed: false });

    await markRowReviewed(USER_ID, 'r1', 'row-1', false);

    expect(mockPrisma.reportRow.updateMany).toHaveBeenCalledWith({
      where: { id: 'row-1', reportId: 'r1' },
      data: { reviewed: false, reviewedBy: null, reviewedAt: null },
    });
  });

  it('throws NotFoundError when the row does not exist', async () => {
    mockPrisma.reportRow.updateMany.mockResolvedValue({ count: 0 });

    await expect(markRowReviewed(USER_ID, 'r1', 'missing-row')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('getBreakBreakdown', () => {
  beforeEach(() => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', organizationId: ORG_ID, status: 'completed' });
  });

  it('adds group sums as decimals, so a reason split across groups comes out exact', async () => {
    // Two duplicated-partner groups (one per side) both land in one bucket: 0.1 + 0.2 must be 0.3, not 0.30000000000000004.
    mockPrisma.reportRow.groupBy.mockResolvedValue([
      { breakReason: 'duplicate', status: 'unmatched_a', _sum: { amountDiff: null, amountA: new Prisma.Decimal('0.1'), amountB: null } },
      { breakReason: 'duplicate', status: 'unmatched_b', _sum: { amountDiff: null, amountA: null, amountB: new Prisma.Decimal('0.2') } },
    ]);

    const breakdown = await getBreakBreakdown(USER_ID, 'r1');

    expect(breakdown[0]).toEqual({ category: 'Duplicated in Other File', amount: 0.3, percent: 100 });
  });

  it('sums the correct amount column per break reason and sorts descending by amount, zero-filling untriggered categories', async () => {
    mockPrisma.reportRow.groupBy.mockResolvedValue([
      { breakReason: 'amount_mismatch', _sum: { amountDiff: 50, amountA: null, amountB: null } },
      { breakReason: 'missing_counterparty', _sum: { amountDiff: null, amountA: 200, amountB: null } },
      { breakReason: 'missing_internal', _sum: { amountDiff: null, amountA: null, amountB: 30 } },
    ]);

    const breakdown = await getBreakBreakdown(USER_ID, 'r1');

    expect(breakdown[0]).toEqual({ category: 'Missing in Counterparty File', amount: 200, percent: expect.any(Number) });
    expect(breakdown.map((b) => b.category)).toEqual([
      'Missing in Counterparty File',
      'Amount Mismatch',
      'Missing in Internal Ledger',
      'Date Mismatch',
      'Others',
    ]);
    expect(breakdown.find((b) => b.category === 'Others')).toEqual({ category: 'Others', amount: 0, percent: 0 });
    const totalPercent = breakdown.reduce((sum, b) => sum + b.percent, 0);
    expect(totalPercent).toBeCloseTo(100, 0);
  });

  it('uses the transaction face value (amountA), not the near-zero amountDiff, for date_mismatch and other', async () => {
    mockPrisma.reportRow.groupBy.mockResolvedValue([
      { breakReason: 'date_mismatch', _sum: { amountDiff: 0.5, amountA: 1000, amountB: 999.5 } },
      { breakReason: 'other', _sum: { amountDiff: 0, amountA: 500, amountB: 500 } },
    ]);

    const breakdown = await getBreakBreakdown(USER_ID, 'r1');

    expect(breakdown.find((b) => b.category === 'Date Mismatch')).toEqual(
      expect.objectContaining({ category: 'Date Mismatch', amount: 1000 }),
    );
    expect(breakdown.find((b) => b.category === 'Others')).toEqual(
      expect.objectContaining({ category: 'Others', amount: 500 }),
    );
  });

  it('returns an empty array (not 5 zero-filled buckets) when the report has no breaks at all', async () => {
    mockPrisma.reportRow.groupBy.mockResolvedValue([]);

    const breakdown = await getBreakBreakdown(USER_ID, 'r1');

    expect(breakdown).toEqual([]);
  });

  it('excludes duplicate rows by status, so unmatched rows with a duplicated partner still count', async () => {
    mockPrisma.reportRow.groupBy.mockResolvedValue([]);

    await getBreakBreakdown(USER_ID, 'r1');

    expect(mockPrisma.reportRow.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['breakReason', 'status'],
        where: { reportId: 'r1', breakReason: { not: null }, status: { not: 'duplicate' } },
      }),
    );
  });

  it('adds a Duplicated in Other File bucket from both sides, so the buckets sum to the break value', async () => {
    mockPrisma.reportRow.groupBy.mockResolvedValue([
      { breakReason: 'missing_internal', status: 'unmatched_b', _sum: { amountDiff: null, amountA: null, amountB: 30 } },
      { breakReason: 'duplicate', status: 'unmatched_a', _sum: { amountDiff: null, amountA: 100, amountB: null } },
      { breakReason: 'duplicate', status: 'unmatched_b', _sum: { amountDiff: null, amountA: null, amountB: 70 } },
    ]);

    const breakdown = await getBreakBreakdown(USER_ID, 'r1');

    expect(breakdown[0]).toEqual({ category: 'Duplicated in Other File', amount: 170, percent: 85 });
    expect(breakdown.reduce((sum, b) => sum + b.amount, 0)).toBe(200);
  });

  it('omits the Duplicated in Other File bucket when nothing falls in it', async () => {
    mockPrisma.reportRow.groupBy.mockResolvedValue([
      { breakReason: 'missing_internal', status: 'unmatched_b', _sum: { amountDiff: null, amountA: null, amountB: 30 } },
    ]);

    const breakdown = await getBreakBreakdown(USER_ID, 'r1');

    expect(breakdown.map((b) => b.category)).not.toContain('Duplicated in Other File');
  });
});

describe('getFilePairTrend', () => {
  beforeEach(() => {
    mockPrisma.report.findFirst.mockResolvedValue({
      id: 'r1',
      organizationId: ORG_ID,
      status: 'completed',
      fileAName: 'a.csv',
      fileBName: 'b.csv',
    });
  });

  it('returns the 7 most recent runs (oldest to newest) as current, and the 7 before those as prior', async () => {
    // Most-recent-first from the DB (orderBy runDate desc) — 10 runs total.
    const runs = Array.from({ length: 10 }, (_, i) => ({
      totalRows: 100,
      matchedCount: 90 + i,
      totalBreakValue: 10 * i,
    }));
    mockPrisma.report.findMany.mockResolvedValue(runs);

    const trend = await getFilePairTrend(USER_ID, 'r1');

    expect(trend.matchRateTrend.current).toHaveLength(7);
    expect(trend.matchRateTrend.prior).toHaveLength(3);
    // runs[0] (matchedCount 90) is the most recent — reversed, it lands last
    // in `current`.
    expect(trend.matchRateTrend.current[6]).toBe(90);
    expect(trend.matchRateTrend.current[0]).toBe(96);
    expect(trend.matchRateTrend.prior[2]).toBe(97);
  });

  it('returns shorter (or empty) arrays rather than padding when fewer than 7/14 runs exist', async () => {
    mockPrisma.report.findMany.mockResolvedValue([
      { totalRows: 100, matchedCount: 80, totalBreakValue: 5 },
      { totalRows: 100, matchedCount: 90, totalBreakValue: 2 },
    ]);

    const trend = await getFilePairTrend(USER_ID, 'r1');

    expect(trend.matchRateTrend.current).toHaveLength(2);
    expect(trend.matchRateTrend.prior).toHaveLength(0);
  });

  it('returns empty series when there are no completed runs for this file pair yet', async () => {
    mockPrisma.report.findMany.mockResolvedValue([]);

    const trend = await getFilePairTrend(USER_ID, 'r1');

    expect(trend.matchRateTrend.current).toEqual([]);
    expect(trend.matchRateTrend.prior).toEqual([]);
    expect(trend.breakValueTrend.current).toEqual([]);
  });

  it('queries completed reports with a case-insensitive file-pair match, most recent 14', async () => {
    mockPrisma.report.findMany.mockResolvedValue([]);

    await getFilePairTrend(USER_ID, 'r1');

    expect(mockPrisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          fileAName: { equals: 'a.csv', mode: 'insensitive' },
          fileBName: { equals: 'b.csv', mode: 'insensitive' },
        }),
        orderBy: { runDate: 'desc' },
        take: 14,
      }),
    );
  });

  it('scope: "overall" drops the file-pair filter, comparing all of the org\'s completed runs', async () => {
    mockPrisma.report.findMany.mockResolvedValue([]);

    await getFilePairTrend(USER_ID, 'r1', { scope: 'overall' });

    expect(mockPrisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: ORG_ID, status: 'completed', OR: [{ supersededById: null }, { id: 'r1' }] },
        orderBy: { runDate: 'desc' },
        take: 14,
      }),
    );
  });

  // The bug: every report's trend chart queried "whatever's newest right
  // now" instead of being anchored to the run actually being viewed, so an
  // older report's chart showed the same org-wide latest N runs as every
  // other report instead of its own history.
  it('anchors the window to the viewed run\'s runDate, not the current latest runs', async () => {
    const runDate = new Date('2026-06-01T00:00:00Z');
    mockPrisma.report.findFirst.mockResolvedValueOnce({
      id: 'r1',
      organizationId: ORG_ID,
      status: 'completed',
      fileAName: 'a.csv',
      fileBName: 'b.csv',
      runDate,
    });
    mockPrisma.report.findMany.mockResolvedValue([]);

    await getFilePairTrend(USER_ID, 'r1');

    expect(mockPrisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ runDate: { lte: runDate } }),
      }),
    );
  });

  it('honors a custom limit, taking 2x for the current+prior windows and splitting at that boundary', async () => {
    // 10 runs total, most-recent-first — with limit:5, current should be
    // runs[0..4] (reversed) and prior should be runs[5..9] (reversed), not
    // the default 7/14 split.
    const runs = Array.from({ length: 10 }, (_, i) => ({
      totalRows: 100,
      matchedCount: 90 + i,
      totalBreakValue: 10 * i,
    }));
    mockPrisma.report.findMany.mockResolvedValue(runs);

    const trend = await getFilePairTrend(USER_ID, 'r1', { limit: 5 });

    expect(mockPrisma.report.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10 }));
    expect(trend.matchRateTrend.current).toHaveLength(5);
    expect(trend.matchRateTrend.prior).toHaveLength(5);
    expect(trend.matchRateTrend.current[4]).toBe(90);
    expect(trend.matchRateTrend.current[0]).toBe(94);
    expect(trend.matchRateTrend.prior[0]).toBe(99);
  });

  // The actual bug this covers: the frontend used to label chart points by
  // array position ("Run 1".."Run N") regardless of which runs were
  // actually plotted — at run #9 looking at the latest 5, that showed "Run
  // 1..5" instead of "Run 5..9". Exposing the raw stored sequenceNumber
  // fixed that, but introduced a different confusion: sequenceNumber is
  // permanent (an invoice-number-style reference — see the schema comment),
  // so a deleted earlier run leaves a visible gap (e.g. "...Run 12, Run
  // 17"), which reads as broken even though nothing's wrong. runLabels is a
  // dense rank recomputed fresh from what currently exists instead — always
  // contiguous, and reflects true recency (not just position within this
  // one chart) since it's ranked against the full matching history, not
  // just the slice fetched for display.
  it('ranks each point by its position among currently-existing runs, oldest to newest', async () => {
    const runs = Array.from({ length: 5 }, () => ({ totalRows: 100, matchedCount: 90, totalBreakValue: 0 }));
    mockPrisma.report.findMany.mockResolvedValue(runs);
    mockPrisma.report.count.mockResolvedValue(5);

    const trend = await getFilePairTrend(USER_ID, 'r1', { limit: 5 });

    expect(trend.runLabels.current).toEqual([1, 2, 3, 4, 5]);
  });

  // The motivating case: 8 runs total exist, "last 7" should read as a
  // clean 2-8 (2nd through 8th of everything that currently exists) — not
  // 1-7 (which would misleadingly look like the very start of history) and
  // not whatever gapped historical numbers those 7 runs happened to keep.
  it('reflects true recency against the full matching history, not just the fetched window — last 7 of 8 total reads as 2-8', async () => {
    const runs = Array.from({ length: 8 }, () => ({ totalRows: 100, matchedCount: 90, totalBreakValue: 0 }));
    mockPrisma.report.findMany.mockResolvedValue(runs);
    mockPrisma.report.count.mockResolvedValue(8);

    const trend = await getFilePairTrend(USER_ID, 'r1', { limit: 7 });

    expect(trend.runLabels.current).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(trend.runLabels.prior).toEqual([1]);
  });
});

describe('updateReportTag', () => {
  it('updates the tag on a completed report in the org', async () => {
    mockPrisma.report.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', tag: 'bank' });

    const result = await updateReportTag(USER_ID, 'r1', 'bank');

    expect(result).toEqual({ id: 'r1', tag: 'bank' });
    expect(mockPrisma.report.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', organizationId: ORG_ID, status: 'completed' },
      data: { tag: 'bank' },
    });
  });

  it('allows clearing a tag with null', async () => {
    mockPrisma.report.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', tag: null });

    await updateReportTag(USER_ID, 'r1', null);

    expect(mockPrisma.report.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { tag: null } }));
  });

  it('throws NotFoundError when the report is missing, still a draft, or not in the org', async () => {
    mockPrisma.report.updateMany.mockResolvedValue({ count: 0 });

    await expect(updateReportTag(USER_ID, 'missing', 'bank')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('updateReportTag / updateReportName audit', () => {
  const before = { tag: 'bank', name: 'June Bank', sequenceYear: 2026, sequenceNumber: 3 };

  it('logs report.tag.update with the from/to tag when it changes', async () => {
    mockPrisma.report.findFirst.mockResolvedValueOnce(before).mockResolvedValueOnce({ id: 'r1', tag: 'mobile-money' });
    mockPrisma.report.updateMany.mockResolvedValue({ count: 1 });

    await updateReportTag(USER_ID, 'r1', 'mobile-money', { ip: '10.0.0.1', userAgent: 'UA' });

    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'report.tag.update',
      entityType: 'report',
      entityId: 'r1',
      ip: '10.0.0.1',
      userAgent: 'UA',
      metadata: {
        changes: { tag: { from: 'bank', to: 'mobile-money' } },
        subject: { name: 'June Bank', code: 'REC-2026-000003' },
      },
    });
  });

  it('logs report.rename under the new name, with the old one in the diff', async () => {
    mockPrisma.report.findFirst.mockResolvedValueOnce(before).mockResolvedValueOnce({ id: 'r1', name: 'June Bank (GTB)' });
    mockPrisma.report.updateMany.mockResolvedValue({ count: 1 });

    await updateReportName(USER_ID, 'r1', 'June Bank (GTB)');

    expect(mockLogAuditSafely).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        action: 'report.rename',
        metadata: {
          changes: { name: { from: 'June Bank', to: 'June Bank (GTB)' } },
          subject: { name: 'June Bank (GTB)', code: 'REC-2026-000003' },
        },
      }),
    );
  });

  it('does not log when the value is unchanged', async () => {
    mockPrisma.report.findFirst.mockResolvedValue(before);
    mockPrisma.report.updateMany.mockResolvedValue({ count: 1 });

    await updateReportTag(USER_ID, 'r1', 'bank');
    await updateReportName(USER_ID, 'r1', 'June Bank');

    expect(mockLogAuditSafely).not.toHaveBeenCalled();
  });

  it('does not log or write when the report is not a completed report in the org', async () => {
    mockPrisma.report.findFirst.mockResolvedValue(null);

    await expect(updateReportTag(USER_ID, 'r1', 'x')).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.report.updateMany).not.toHaveBeenCalled();
    expect(mockLogAuditSafely).not.toHaveBeenCalled();
  });
});

describe('updateReportName', () => {
  it('renames a completed report in the org', async () => {
    mockPrisma.report.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', name: 'July Bank Reconciliation' });

    const result = await updateReportName(USER_ID, 'r1', 'July Bank Reconciliation');

    expect(result).toEqual({ id: 'r1', name: 'July Bank Reconciliation' });
    expect(mockPrisma.report.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', organizationId: ORG_ID, status: 'completed' },
      data: { name: 'July Bank Reconciliation' },
    });
  });

  it('throws NotFoundError when the report is missing, still a draft, or not in the org', async () => {
    mockPrisma.report.updateMany.mockResolvedValue({ count: 0 });

    await expect(updateReportName(USER_ID, 'missing', 'New Name')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('addFavorite / removeFavorite', () => {
  it('addFavorite upserts a favorite row after checking visibility', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', status: 'completed', rows: [] });
    mockPrisma.reportFavorite.upsert.mockResolvedValue({ id: 'fav-1' });

    await addFavorite(USER_ID, 'r1');

    expect(mockPrisma.reportFavorite.upsert).toHaveBeenCalledWith({
      where: { userId_reportId: { userId: USER_ID, reportId: 'r1' } },
      create: { userId: USER_ID, reportId: 'r1' },
      update: {},
    });
  });

  it("addFavorite throws NotFoundError instead of favoriting an inaccessible report", async () => {
    mockPrisma.report.findFirst.mockResolvedValue(null);

    await expect(addFavorite(USER_ID, 'missing')).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.reportFavorite.upsert).not.toHaveBeenCalled();
  });

  it("addFavorite can't reach another user's private draft", async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', status: 'draft', userId: OTHER_USER_ID, rows: [] });

    await expect(addFavorite(USER_ID, 'r1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('removeFavorite deletes the favorite row after checking visibility', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', status: 'completed', rows: [] });
    mockPrisma.reportFavorite.deleteMany.mockResolvedValue({ count: 1 });

    await removeFavorite(USER_ID, 'r1');

    expect(mockPrisma.reportFavorite.deleteMany).toHaveBeenCalledWith({ where: { userId: USER_ID, reportId: 'r1' } });
  });

  it('removeFavorite is a no-op, not an error, when nothing was favorited', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', status: 'completed', rows: [] });
    mockPrisma.reportFavorite.deleteMany.mockResolvedValue({ count: 0 });

    await expect(removeFavorite(USER_ID, 'r1')).resolves.toBeUndefined();
  });
});

describe('report file cleanup in R2', () => {
  beforeEach(() => {
    // Both test users are org members; no other report shares these files unless a test says so.
    mockPrisma.member.findMany.mockResolvedValue([{ userId: USER_ID }, { userId: OTHER_USER_ID }]);
    mockPrisma.report.findMany.mockResolvedValue([]);
  });

  const owned = {
    id: 'r1',
    userId: USER_ID,
    name: 'June Bank',
    fileAName: 'a.csv',
    fileBName: 'b.csv',
    fileAKey: `uploads/${USER_ID}/1-a.csv`,
    fileBKey: `uploads/${USER_ID}/1-b.csv`,
    status: 'completed',
    sequenceYear: 2026,
    sequenceNumber: 4,
  };

  it("deletes the report's uploads and stored exports after the rows are gone", async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
    mockPrisma.report.findFirst.mockResolvedValue(owned);
    mockPrisma.reportExport.findMany.mockResolvedValueOnce([{ fileKey: `exports/${ORG_ID}/r1/x.pdf` }]);
    mockPrisma.report.deleteMany.mockResolvedValue({ count: 1 });

    await deleteReport(USER_ID, 'r1');

    expect(mockPrisma.reportExport.findMany).toHaveBeenCalledWith({
      where: { reportId: { in: ['r1'] }, organizationId: ORG_ID, fileKey: { not: null } },
      select: { fileKey: true },
    });
    expect(mockDeleteR2Objects).toHaveBeenCalledWith([owned.fileAKey, owned.fileBKey, `exports/${ORG_ID}/r1/x.pdf`]);
    expect(mockPrisma.report.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(mockDeleteR2Objects.mock.invocationCallOrder[0]);
  });

  it("never deletes a stored key outside the report's own upload and export prefixes", async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
    mockPrisma.report.findFirst.mockResolvedValue({ ...owned, fileBKey: 'uploads/someone-else/1-b.csv' });
    mockPrisma.reportExport.findMany.mockResolvedValueOnce([{ fileKey: 'exports/other-org/r9/x.pdf' }]);
    mockPrisma.report.deleteMany.mockResolvedValue({ count: 1 });

    await deleteReport(USER_ID, 'r1');

    expect(mockDeleteR2Objects).toHaveBeenCalledWith([owned.fileAKey]);
  });

  it('deletes no files when the delete itself is refused', async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
    mockPrisma.report.findFirst.mockResolvedValue({ ...owned, userId: OTHER_USER_ID });
    mockPrisma.report.deleteMany.mockResolvedValue({ count: 0 });

    await expect(deleteReport(USER_ID, 'r1')).rejects.toBeInstanceOf(NotFoundError);
    expect(mockDeleteR2Objects).not.toHaveBeenCalled();
  });

  it('still completes the delete when R2 cleanup fails, logging it for follow-up', async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
    mockPrisma.report.findFirst.mockResolvedValue(owned);
    mockPrisma.report.deleteMany.mockResolvedValue({ count: 1 });
    mockDeleteR2Objects.mockRejectedValueOnce(new Error('R2 unreachable'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(deleteReport(USER_ID, 'r1')).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('keeps an upload that a rerun of this report still uses', async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
    mockPrisma.report.findFirst.mockResolvedValue(owned);
    mockPrisma.report.deleteMany.mockResolvedValue({ count: 1 });
    // The rerun points at both of the source's files.
    mockPrisma.report.findMany.mockResolvedValue([{ fileAKey: owned.fileAKey, fileBKey: owned.fileBKey }]);

    await deleteReport(USER_ID, 'r1');

    expect(mockPrisma.report.findMany).toHaveBeenCalledWith({
      where: { id: { notIn: ['r1'] }, OR: [{ fileAKey: { in: [owned.fileAKey, owned.fileBKey] } }, { fileBKey: { in: [owned.fileAKey, owned.fileBKey] } }] },
      select: { fileAKey: true, fileBKey: true },
    });
    expect(mockDeleteR2Objects).toHaveBeenCalledWith([]);
  });

  it("deletes a rerun's inherited uploads once no report uses them, even though they sit under the source owner's prefix", async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'admin' });
    mockPrisma.report.findFirst.mockResolvedValue({ ...owned, id: 'rerun-1', userId: OTHER_USER_ID });
    mockPrisma.report.deleteMany.mockResolvedValue({ count: 1 });

    await deleteReport(USER_ID, 'rerun-1');

    expect(mockDeleteR2Objects).toHaveBeenCalledWith([owned.fileAKey, owned.fileBKey]);
  });

  it("bulk: a non-admin's request only removes files of their own reports", async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
    mockPrisma.report.findMany.mockResolvedValueOnce([
      owned,
      { ...owned, id: 'r2', userId: OTHER_USER_ID, fileAKey: `uploads/${OTHER_USER_ID}/2-a.csv`, fileBKey: `uploads/${OTHER_USER_ID}/2-b.csv` },
    ]);
    mockPrisma.report.deleteMany.mockResolvedValue({ count: 1 });

    await bulkDeleteReports(USER_ID, ['r1', 'r2']);

    expect(mockPrisma.reportExport.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ reportId: { in: ['r1'] } }) }));
    expect(mockDeleteR2Objects).toHaveBeenCalledWith([owned.fileAKey, owned.fileBKey]);
  });

  it('bulk: deleting a source and its rerun together removes their shared files once', async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'admin' });
    mockPrisma.report.findMany.mockResolvedValueOnce([owned, { ...owned, id: 'rerun-1', userId: OTHER_USER_ID }]);
    mockPrisma.report.deleteMany.mockResolvedValue({ count: 2 });

    await bulkDeleteReports(USER_ID, ['r1', 'rerun-1']);

    // Survivors exclude both reports being deleted, so neither keeps the other's files alive.
    expect(mockPrisma.report.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { notIn: ['r1', 'rerun-1'] } }) }));
    expect(mockDeleteR2Objects).toHaveBeenCalledWith([owned.fileAKey, owned.fileBKey]);
  });
});

describe('updateDraft file key ownership', () => {
  it("rejects a file key that wasn't issued to this user, before touching the draft", async () => {
    await expect(updateDraft(USER_ID, 'draft-1', { fileAKey: 'uploads/someone-else/1-a.csv' })).rejects.toBeInstanceOf(ValidationError);
    await expect(updateDraft(USER_ID, 'draft-1', { fileBKey: 'exports/org-x/r/x.pdf' })).rejects.toBeInstanceOf(ValidationError);
    expect(mockPrisma.report.updateMany).not.toHaveBeenCalled();
  });

  it("accepts the caller's own upload key", async () => {
    mockPrisma.report.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'draft-1', status: 'draft' });

    await updateDraft(USER_ID, 'draft-1', { fileAKey: `uploads/${USER_ID}/1-a.csv` });

    expect(mockPrisma.report.updateMany).toHaveBeenCalled();
  });
});

describe('bulkDeleteReports', () => {
  it('scopes bulk-delete to own reports when the role is not admin, logging formatted references not raw ids', async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
    mockPrisma.report.findMany.mockResolvedValue([
      { id: 'r1', userId: USER_ID, sequenceYear: 2026, sequenceNumber: 8 },
      { id: 'r2', userId: USER_ID, sequenceYear: null, sequenceNumber: null },
    ]);
    mockPrisma.report.deleteMany.mockResolvedValue({ count: 2 });

    const result = await bulkDeleteReports(USER_ID, ['r1', 'r2']);

    expect(result).toEqual({ deletedCount: 2 });
    expect(mockPrisma.report.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1', 'r2'] }, organizationId: ORG_ID, userId: USER_ID },
    });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'report.bulk_delete',
      entityType: 'report',
      status: 'success',
      ip: undefined,
      metadata: { references: ['REC-2026-000008', 'r2'], count: 2 },
    });
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('lets an admin bulk-delete across owners, notifying each distinct owner once with a count', async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'admin' });
    mockPrisma.report.findMany.mockResolvedValue([
      { id: 'r1', userId: OTHER_USER_ID },
      { id: 'r2', userId: OTHER_USER_ID },
      { id: 'r3', userId: USER_ID },
    ]);
    mockPrisma.report.deleteMany.mockResolvedValue({ count: 3 });

    await bulkDeleteReports(USER_ID, ['r1', 'r2', 'r3']);

    expect(mockPrisma.report.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1', 'r2', 'r3'] }, organizationId: ORG_ID },
    });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ action: 'report.bulk_delete', status: 'warning' }),
    );
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      OTHER_USER_ID,
      expect.objectContaining({ type: 'report.deleted_by_admin', message: expect.stringContaining('2') }),
    );
  });
});

describe('getReportsByIds', () => {
  it('returns reports in the requested order, org-scoped', async () => {
    mockPrisma.report.findMany.mockResolvedValue([
      { id: 'r2', status: 'completed', rows: [] },
      { id: 'r1', status: 'completed', rows: [] },
    ]);

    const result = await getReportsByIds(USER_ID, ['r1', 'r2']);

    expect(result.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('throws NotFoundError when any requested id is missing or inaccessible', async () => {
    mockPrisma.report.findMany.mockResolvedValue([{ id: 'r1', status: 'completed', rows: [] }]);

    await expect(getReportsByIds(USER_ID, ['r1', 'missing'])).rejects.toBeInstanceOf(NotFoundError);
  });

  it("excludes another user's private draft, 404ing if it was requested", async () => {
    mockPrisma.report.findMany.mockResolvedValue([
      { id: 'r1', status: 'draft', userId: OTHER_USER_ID, rows: [] },
    ]);

    await expect(getReportsByIds(USER_ID, ['r1'])).rejects.toBeInstanceOf(NotFoundError);
  });

  it('applies a completed-only filter when requireCompleted is true', async () => {
    mockPrisma.report.findMany.mockResolvedValue([{ id: 'r1', status: 'completed', rows: [] }]);

    await getReportsByIds(USER_ID, ['r1'], { requireCompleted: true });

    expect(mockPrisma.report.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1'] }, organizationId: ORG_ID, status: 'completed' },
      include: {
        rows: { include: { resolution: { select: { kind: true, note: true } } } },
        corrections: expect.objectContaining({ where: { applied: true } }),
      },
    });
  });
});

describe('getComparisonReports', () => {
  it('loads the reports without rows and attaches per-run figures from one grouped query', async () => {
    mockPrisma.report.findMany.mockResolvedValue([
      { id: 'r1', status: 'completed' },
      { id: 'r2', status: 'completed' },
    ]);
    mockPrisma.$queryRaw.mockResolvedValue([
      { reportId: 'r1', largestBreak: new Prisma.Decimal('60.25'), unmatchedACount: 2, unmatchedBCount: 1, duplicateRowCount: 3 },
    ]);

    const result = await getComparisonReports(USER_ID, ['r1', 'r2']);

    expect(mockPrisma.report.findMany).toHaveBeenCalledWith(expect.objectContaining({ include: undefined }));
    expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$queryRaw.mock.calls[0]).toContainEqual(['r1', 'r2']);
    expect(result[0].rowStats).toEqual({
      largestBreak: new Prisma.Decimal('60.25'),
      unmatchedACount: 2,
      unmatchedBCount: 1,
      duplicateRowCount: 3,
    });
    // A run with no rows gets no group from the query, so it reads as zeros.
    expect(result[1].rowStats).toEqual({ largestBreak: new Prisma.Decimal(0), unmatchedACount: 0, unmatchedBCount: 0, duplicateRowCount: 0 });
  });

  it('never runs the stats query when any id is not a visible completed report', async () => {
    mockPrisma.report.findMany.mockResolvedValue([{ id: 'r1', status: 'completed' }]);

    await expect(getComparisonReports(USER_ID, ['r1', 'other-org'])).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('corrections', () => {
  const REPORT = {
    id: 'r1',
    organizationId: ORG_ID,
    userId: USER_ID,
    status: 'completed',
    supersededById: null,
    name: 'June',
    fileAKey: 'uploads/u/a.csv',
    fileBKey: 'uploads/u/b.csv',
    columnMapping: { fileA: { referenceNumber: 'Ref', amount: 'Amt' }, fileB: { referenceNumber: 'Reference', amount: 'Amount' } },
  };
  const ROW = { ref: 'INV-22', rawA: { Ref: 'INV-22', Amt: '10' }, rawB: { Reference: 'INV-2231', Amount: '12' }, rowIndexA: 4, rowIndexB: 7 };
  const STORED = {
    id: 'c1',
    side: 'B',
    rowIndex: 7,
    rowReference: 'INV-2231',
    field: 'amount',
    originalValue: '12',
    correctedValue: '10.00',
    reason: 'Bank export added a fee',
    applied: false,
    createdAt: new Date('2026-10-28T10:00:00Z'),
    createdByUser: { id: USER_ID, name: 'Ada' },
  };
  const input = { rowId: 'row-1', side: 'B', field: 'amount', correctedValue: '10.00', reason: 'Bank export added a fee' };

  beforeEach(() => {
    mockPrisma.report.findFirst.mockResolvedValue(REPORT);
    mockPrisma.reportRow.findFirst.mockResolvedValue(ROW);
    mockPrisma.reportCorrection.upsert.mockResolvedValue(STORED);
  });

  describe('createCorrection', () => {
    it("404s on another organization's report without reading a row or writing", async () => {
      mockPrisma.report.findFirst.mockResolvedValue(null);

      await expect(createCorrection(USER_ID, 'foreign', input)).rejects.toBeInstanceOf(NotFoundError);
      expect(mockPrisma.report.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'foreign', organizationId: ORG_ID } }));
      expect(mockPrisma.reportRow.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.reportCorrection.upsert).not.toHaveBeenCalled();
    });

    it('404s on a row from another report', async () => {
      mockPrisma.reportRow.findFirst.mockResolvedValue(null);

      await expect(createCorrection(USER_ID, 'r1', input)).rejects.toBeInstanceOf(NotFoundError);
      expect(mockPrisma.reportRow.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'row-1', reportId: 'r1' } }));
    });

    it('derives the row position, file, reference and original value on the server, replacing any pending correction', async () => {
      const result = await createCorrection(USER_ID, 'r1', input);

      const values = {
        fileKey: 'uploads/u/b.csv',
        rowReference: 'INV-2231',
        originalValue: '12',
        correctedValue: '10.00',
        reason: 'Bank export added a fee',
        createdBy: USER_ID,
      };
      expect(mockPrisma.reportCorrection.upsert).toHaveBeenCalledWith({
        where: { reportId_side_rowIndex_field_applied: { reportId: 'r1', side: 'B', rowIndex: 7, field: 'amount', applied: false } },
        create: { reportId: 'r1', side: 'B', rowIndex: 7, field: 'amount', applied: false, ...values },
        update: { ...values, createdAt: expect.any(Date) },
        select: expect.any(Object),
      });
      expect(result).toEqual(expect.objectContaining({ id: 'c1', rowReference: 'INV-2231', createdBy: { id: USER_ID, name: 'Ada' } }));
      expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
        action: 'report.correction.create',
        metadata: expect.objectContaining({ field: 'amount', side: 'B', transactionRef: 'INV-2231', originalValue: '12', correctedValue: '10.00' }),
      }));
    });

    it.each([
      ['an amount the engine cannot parse', { field: 'amount', correctedValue: '1.2.3' }],
      ['a date the engine cannot parse', { field: 'date', correctedValue: 'not a date' }],
    ])('rejects %s with a ValidationError', async (_label, change) => {
      await expect(createCorrection(USER_ID, 'r1', { ...input, ...change })).rejects.toBeInstanceOf(ValidationError);
      expect(mockPrisma.reportCorrection.upsert).not.toHaveBeenCalled();
    });

    it('rejects a side the row has no data for with a ValidationError', async () => {
      mockPrisma.reportRow.findFirst.mockResolvedValue({ ...ROW, rawB: null, rowIndexB: null });

      await expect(createCorrection(USER_ID, 'r1', input)).rejects.toBeInstanceOf(ValidationError);
    });

    it.each([
      ['a report that is not completed', { report: { status: 'failed' } }],
      ['a superseded report', { report: { supersededById: 'r2' } }],
      ['a row from a run before corrections existed', { row: { rowIndexB: null } }],
    ])('409s on %s', async (_label, { report = {}, row = {} }) => {
      mockPrisma.report.findFirst.mockResolvedValue({ ...REPORT, ...report });
      mockPrisma.reportRow.findFirst.mockResolvedValue({ ...ROW, ...row });

      await expect(createCorrection(USER_ID, 'r1', input)).rejects.toBeInstanceOf(ConflictError);
      expect(mockPrisma.reportCorrection.upsert).not.toHaveBeenCalled();
    });
  });

  describe('deleteCorrection', () => {
    it('404s on a correction that is not on this report', async () => {
      mockPrisma.reportCorrection.findFirst.mockResolvedValue(null);

      await expect(deleteCorrection(USER_ID, 'r1', 'c-other')).rejects.toBeInstanceOf(NotFoundError);
      expect(mockPrisma.reportCorrection.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'c-other', reportId: 'r1' } }));
    });

    it('409s on an applied correction without deleting it', async () => {
      mockPrisma.reportCorrection.findFirst.mockResolvedValue({ ...STORED, applied: true });

      await expect(deleteCorrection(USER_ID, 'r1', 'c1')).rejects.toBeInstanceOf(ConflictError);
      expect(mockPrisma.reportCorrection.deleteMany).not.toHaveBeenCalled();
    });

    it('409s while the report is running', async () => {
      mockPrisma.report.findFirst.mockResolvedValue({ ...REPORT, status: 'processing' });

      await expect(deleteCorrection(USER_ID, 'r1', 'c1')).rejects.toBeInstanceOf(ConflictError);
    });

    it('deletes only while still pending, and 409s if a run applied it in the meantime', async () => {
      mockPrisma.reportCorrection.findFirst.mockResolvedValue(STORED);
      mockPrisma.reportCorrection.deleteMany.mockResolvedValue({ count: 0 });

      await expect(deleteCorrection(USER_ID, 'r1', 'c1')).rejects.toBeInstanceOf(ConflictError);
      expect(mockPrisma.reportCorrection.deleteMany).toHaveBeenCalledWith({ where: { id: 'c1', reportId: 'r1', applied: false } });
    });

    it('audits the removal', async () => {
      mockPrisma.reportCorrection.findFirst.mockResolvedValue(STORED);
      mockPrisma.reportCorrection.deleteMany.mockResolvedValue({ count: 1 });

      await deleteCorrection(USER_ID, 'r1', 'c1');

      expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, expect.objectContaining({
        action: 'report.correction.delete',
        metadata: expect.objectContaining({ correctionId: 'c1', transactionRef: 'INV-2231' }),
      }));
    });
  });

  describe('listCorrections', () => {
    it("404s on another organization's report", async () => {
      mockPrisma.report.findFirst.mockResolvedValue(null);

      await expect(listCorrections(USER_ID, 'foreign')).rejects.toBeInstanceOf(NotFoundError);
      expect(mockPrisma.reportCorrection.findMany).not.toHaveBeenCalled();
    });

    it("pages the report's corrections", async () => {
      mockPrisma.reportCorrection.findMany.mockResolvedValue([STORED]);

      const result = await listCorrections(USER_ID, 'r1', { limit: 20, offset: 40 });

      expect(mockPrisma.reportCorrection.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { reportId: 'r1' }, take: 20, skip: 40 }));
      expect(result).toHaveLength(1);
    });
  });

  describe('read paths', () => {
    beforeEach(() => {
      mockBuildShortReason.mockReturnValue({ type: 'Other', reason: '' });
      mockBuildMatchAnalysis.mockReturnValue([]);
    });

    it("badges a page of explorer rows from one corrections query over the page's positions", async () => {
      mockPrisma.reportRow.findMany.mockResolvedValue([
        { id: 'row-1', ref: 'INV-22', status: 'mismatched', rowIndexA: 4, rowIndexB: 7 },
        { id: 'row-2', ref: 'INV-30', status: 'unmatched_a', rowIndexA: 5, rowIndexB: null },
      ]);
      mockPrisma.reportRow.count.mockResolvedValue(2);
      mockPrisma.reportCorrection.findMany.mockResolvedValue([{ side: 'B', rowIndex: 7, field: 'amount', applied: true }]);

      const { rows } = await getTransactions(USER_ID, 'r1');

      expect(mockPrisma.reportCorrection.findMany).toHaveBeenCalledTimes(1);
      expect(mockPrisma.reportCorrection.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { reportId: 'r1', OR: [{ side: 'A', rowIndex: { in: [4, 5] } }, { side: 'B', rowIndex: { in: [7] } }] },
      }));
      expect(rows[0].corrections).toEqual([{ field: 'amount', side: 'B', applied: true }]);
      expect(rows[1].corrections).toEqual([]);
    });

    it('skips the corrections query for rows from a run before corrections existed', async () => {
      mockPrisma.reportRow.findMany.mockResolvedValue([{ id: 'row-1', ref: 'X', status: 'matched', rowIndexA: null, rowIndexB: null }]);
      mockPrisma.reportRow.count.mockResolvedValue(1);

      const { rows } = await getTransactions(USER_ID, 'r1');

      expect(mockPrisma.reportCorrection.findMany).not.toHaveBeenCalled();
      expect(rows[0].corrections).toEqual([]);
    });

    it("returns the row's corrections and only the sides it has data and a position for", async () => {
      mockPrisma.reportRow.findFirst.mockResolvedValue({ id: 'row-1', ...ROW, status: 'unmatched_a', rawB: null, rowIndexB: null });
      mockPrisma.reportCorrection.findMany.mockResolvedValue([{ ...STORED, side: 'A', rowIndex: 4 }]);

      const result = await getTransaction(USER_ID, 'r1', 'row-1');

      expect(result.correctableSides).toEqual(['A']);
      expect(result.corrections).toEqual([expect.objectContaining({ id: 'c1', side: 'A', createdBy: { id: USER_ID, name: 'Ada' } })]);
    });

    it('has no correctable sides on a row from a run before corrections existed', async () => {
      mockPrisma.reportRow.findFirst.mockResolvedValue({ id: 'row-1', ...ROW, status: 'mismatched', rowIndexA: null, rowIndexB: null });

      const result = await getTransaction(USER_ID, 'r1', 'row-1');

      expect(result.correctableSides).toEqual([]);
      expect(result.corrections).toEqual([]);
    });
  });
});

describe('dashboard aggregates', () => {
  // The SQL each call ran, so a test can check which runs it counts and which windows it sums.
  const sqlOf = (call) => Prisma.sql(call[0], ...call.slice(1));
  const raw = () => mockPrisma.$queryRaw.mock.calls.map(sqlOf);
  // One row of aggregateCompletedWindows' result, as Postgres returns it (COUNT/SUM as bigint, money as Decimal).
  const windowRow = (windows) =>
    Object.fromEntries(
      Object.entries(windows).flatMap(([name, w]) => [
        [`${name}.count`, BigInt(w.count)],
        [`${name}.totalRows`, BigInt(w.totalRows)],
        [`${name}.matched`, BigInt(w.matched)],
        [`${name}.unmatchedTransactions`, BigInt(w.unmatchedTransactions)],
        [`${name}.totalBreakValue`, new Prisma.Decimal(w.totalBreakValue)],
      ]),
    );
  const EMPTY = { count: 0, totalRows: 0, matched: 0, unmatchedTransactions: 0, totalBreakValue: 0 };

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-15T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('counts only the org\'s current completed runs, in every dashboard query', async () => {
    mockPrisma.$queryRaw.mockResolvedValue([windowRow({ allTime: EMPTY, currentMonth: EMPTY, previousMonth: EMPTY })]);
    await getReportsSummary(USER_ID);
    mockPrisma.$queryRaw.mockResolvedValue([{ matched: 0n, mismatched: 0n, unmatched: 0n, duplicates: 0n }]);
    await getReportsTrend(USER_ID);
    mockPrisma.$queryRaw.mockResolvedValue([{ b0: 0, b1: 0, b2: 0, b3: 0 }]);
    await getMatchRateDistribution(USER_ID);
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await getTopFilePairs(USER_ID);

    expect(raw()).toHaveLength(5);
    for (const sql of raw()) {
      expect(sql.sql).toContain("organization_id = ? AND status = 'completed' AND superseded_by_id IS NULL");
      expect(sql.values).toContain(ORG_ID);
    }
  });

  describe('getReportsSummary', () => {
    it('reports all-time totals with a current vs previous calendar month delta, from one query', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        windowRow({
          allTime: { count: 3, totalRows: 300, matched: 240, unmatchedTransactions: 60, totalBreakValue: '1500.0000' },
          currentMonth: { count: 2, totalRows: 200, matched: 190, unmatchedTransactions: 10, totalBreakValue: '500.0000' },
          previousMonth: { count: 1, totalRows: 100, matched: 50, unmatchedTransactions: 50, totalBreakValue: '1000.0000' },
        }),
      ]);

      const summary = await getReportsSummary(USER_ID);

      // All time is unfiltered; this month and last month are each a [start, end) runDate range.
      const [sql] = raw();
      expect(sql.sql).toMatch(/COUNT\(\*\)\s+AS "allTime.count"/);
      expect(new Set(sql.values.map(String))).toEqual(
        new Set([
          String(new Date('2026-06-01T00:00:00Z')),
          String(new Date('2026-07-01T00:00:00Z')),
          String(new Date('2026-08-01T00:00:00Z')),
          ORG_ID,
        ]),
      );
      expect(summary.totalReconciliations).toEqual({ current: 3, previous: 1, deltaPercent: 100 });
      expect(summary.avgMatchRate.current).toBeCloseTo(80);
      expect(summary.avgMatchRate.previous).toBeCloseTo(50);
      expect(summary.avgMatchRate.deltaPercent).toBeCloseTo(90);
      expect(summary.unmatchedTransactions).toEqual({ current: 60, previous: 50, deltaPercent: -80 });
      expect(summary.totalBreakValue).toEqual({ current: 1500, previous: 1000, deltaPercent: -50 });
      expect(summary.totalTransactions).toBe(300);
    });

    it('suppresses deltaPercent when the current month has no completed reports yet', async () => {
      const june = { count: 1, totalRows: 100, matched: 50, unmatchedTransactions: 50, totalBreakValue: '1000' };
      mockPrisma.$queryRaw.mockResolvedValueOnce([windowRow({ allTime: june, currentMonth: EMPTY, previousMonth: june })]);

      const summary = await getReportsSummary(USER_ID);

      expect(summary.totalReconciliations).toEqual({ current: 1, previous: 1, deltaPercent: null });
      expect(summary.avgMatchRate).toEqual({ current: 50, previous: 50, deltaPercent: null });
      expect(summary.totalBreakValue).toEqual({ current: 1000, previous: 1000, deltaPercent: null });
    });
  });

  describe('getReportsTrend', () => {
    it('fills every month in the window, keyed by UTC month, with the all-time category breakdown', async () => {
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ month: '2026-07', count: 1, totalRows: 50n, matched: 40n }])
        .mockResolvedValueOnce([{ matched: 120n, mismatched: 8n, unmatched: 20n, duplicates: 2n }]);

      const trend = await getReportsTrend(USER_ID, { months: 2 });

      expect(raw()[0].values).toEqual([ORG_ID, new Date('2026-06-01T00:00:00Z')]);
      expect(trend.matchRateSeries).toEqual([
        { month: '2026-06', value: 0 },
        { month: '2026-07', value: 80 },
      ]);
      expect(trend.volumeSeries).toEqual([
        { month: '2026-06', value: 0 },
        { month: '2026-07', value: 1 },
      ]);
      expect(trend.categoryBreakdown).toEqual({ matched: 120, mismatched: 8, unmatched: 20, duplicates: 2 });
    });

    it('defaults to 6 months', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([{ matched: 0n, mismatched: 0n, unmatched: 0n, duplicates: 0n }]);

      const trend = await getReportsTrend(USER_ID);

      expect(trend.matchRateSeries.map((p) => p.month)).toEqual(['2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07']);
    });
  });

  describe('getHistoryStats', () => {
    it('returns all-time totals with a rolling 30-vs-previous-30-day delta', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        windowRow({
          allTime: { count: 3, totalRows: 300, matched: 240, unmatchedTransactions: 60, totalBreakValue: '1500' },
          current: { count: 1, totalRows: 100, matched: 90, unmatchedTransactions: 10, totalBreakValue: '250' },
          previous: { count: 1, totalRows: 100, matched: 50, unmatchedTransactions: 50, totalBreakValue: '1000' },
        }),
      ]);

      const stats = await getHistoryStats(USER_ID);

      expect(stats.totalReconciliations).toEqual({ value: 3, deltaPercent: 0 });
      expect(stats.avgMatchRate).toEqual({ value: 80, deltaPercent: 80 });
      expect(stats.totalBreakValue).toEqual({ value: 1500, deltaPercent: -75 });
      expect(stats.totalTransactions).toEqual({ value: 300, deltaPercent: 0 });
    });
  });

  describe('getWeeklyDigestStats', () => {
    it('takes organizationId directly and sums the current and prior 7-day windows in one query', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        windowRow({
          current: { count: 1, totalRows: 100, matched: 95, unmatchedTransactions: 5, totalBreakValue: '50' },
          prior: EMPTY,
        }),
      ]);

      const stats = await getWeeklyDigestStats(ORG_ID);

      expect(mockPrisma.member.findFirst).not.toHaveBeenCalled();
      expect(raw()).toHaveLength(1);
      expect(stats.current).toEqual({ count: 1, totalTransactions: 100, avgMatchRate: 95, unmatchedTransactions: 5, totalBreakValue: 50 });
      expect(stats.prior).toEqual({ count: 0, totalTransactions: 0, avgMatchRate: 0, unmatchedTransactions: 0, totalBreakValue: 0 });
    });
  });

  describe('getMatchRateDistribution', () => {
    it('maps the bucket counts in order and adds a Failed bucket, with percents of every non-draft run', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ b0: 1, b1: 1, b2: 0, b3: 1 }]);
      mockPrisma.report.count.mockResolvedValueOnce(1);

      const distribution = await getMatchRateDistribution(USER_ID);

      expect(mockPrisma.report.count).toHaveBeenCalledWith({ where: { organizationId: ORG_ID, status: 'failed' } });
      expect(distribution).toEqual([
        { label: '≥ 99%', value: 1, percent: '25.0%' },
        { label: '95% - 98.99%', value: 1, percent: '25.0%' },
        { label: '90% - 94.99%', value: 0, percent: '0.0%' },
        { label: '< 90%', value: 1, percent: '25.0%' },
        { label: 'Failed', value: 1, percent: '25.0%' },
      ]);
    });

    it('returns all-zero buckets with 0.0% when there are no runs', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ b0: 0, b1: 0, b2: 0, b3: 0 }]);
      mockPrisma.report.count.mockResolvedValueOnce(0);

      const distribution = await getMatchRateDistribution(USER_ID);

      expect(distribution.every((b) => b.value === 0 && b.percent === '0.0%')).toBe(true);
    });
  });

  describe('getTopFilePairs', () => {
    it('labels the top groups and folds the rest into "Other File Pairs"', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([
        { fileA: 'a.csv', fileB: 'b.csv', count: 3, groupCount: 4, runCount: 7 },
        { fileA: 'c.csv', fileB: null, count: 2, groupCount: 4, runCount: 7 },
      ]);

      const pairs = await getTopFilePairs(USER_ID, { limit: 2 });

      expect(raw()[0].values).toEqual([ORG_ID, 2]);
      expect(pairs).toEqual([
        { label: 'a.csv vs b.csv', count: 3 },
        { label: 'c.csv vs ', count: 2 },
        { label: 'Other File Pairs', count: 2 },
      ]);
    });

    it('omits "Other File Pairs" when every group is shown', async () => {
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ fileA: 'a.csv', fileB: 'b.csv', count: 3, groupCount: 1, runCount: 3 }]);

      expect(await getTopFilePairs(USER_ID)).toEqual([{ label: 'a.csv vs b.csv', count: 3 }]);
    });
  });
});

