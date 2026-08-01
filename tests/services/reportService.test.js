import { jest } from '@jest/globals';

const mockTx = {
  report: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
  reportRow: { createMany: jest.fn() },
  reportSequence: { upsert: jest.fn() },
};

const mockPrisma = {
  $transaction: jest.fn(async (fn) => fn(mockTx)),
  report: {
    create: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    count: jest.fn(),
    deleteMany: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn(),
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
  member: {
    findFirst: jest.fn(),
  },
  auditLog: {
    findMany: jest.fn().mockResolvedValue([]),
  },
};

jest.unstable_mockModule('../../db/index.js', () => ({ prisma: mockPrisma }));

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
}));

const mockSuggestMapping = jest.fn();
const mockMappingFromSuggestions = jest.fn();
const mockComputeValidationSummary = jest.fn();
jest.unstable_mockModule('../../services/columnMappingService.js', () => ({
  suggestMapping: mockSuggestMapping,
  mappingFromSuggestions: mockMappingFromSuggestions,
  computeValidationSummary: mockComputeValidationSummary,
}));

const {
  saveReport,
  listReports,
  getReport,
  deleteReport,
  getReportsSummary,
  getReportsTrend,
  saveDraft,
  updateDraft,
  listDrafts,
  completeDraft,
  runReconciliation,
  getMappingPreview,
  getRulePreview,
  getTransactions,
  getTransaction,
  markRowReviewed,
  getBreakBreakdown,
  getFilePairTrend,
  getHistoryStats,
  getMatchRateDistribution,
  getTopFilePairs,
  updateReportTag,
  updateReportName,
  addFavorite,
  removeFavorite,
  bulkDeleteReports,
  getReportsByIds,
} = await import('../../services/reportService.js');
const { NotFoundError, ValidationError, ConflictError } = await import('../../errors.js');

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const ORG_ID = 'org-1';

const dto = {
  name: 'June Bank Reconciliation',
  fileAName: 'a.csv',
  fileBName: 'b.csv',
  summary: {
    total: 2,
    matched: 1,
    mismatched: 0,
    unmatchedA: 1,
    unmatchedB: 0,
    duplicates: 0,
    matchRate: 0.5,
    totalBreakValue: 50,
    durationMs: 12,
  },
  rows: [
    { ref: 'REF1', status: 'matched', amountA: 100, amountB: 100, amountDiff: 0, dateA: '2026-01-01', dateB: '2026-01-01' },
    { ref: 'REF2', status: 'unmatched_a', amountA: 50, amountB: null, amountDiff: null },
  ],
  config: { amountTolerance: 0.01, dateToleranceDays: 1 },
};

const CURRENT_YEAR = new Date().getUTCFullYear();

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockTx));
  mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
  mockTx.reportSequence.upsert.mockResolvedValue({ year: CURRENT_YEAR, lastValue: 1 });
  // Default: already has a sequence number, so persistCompletedRun's
  // (completeDraft/runReconciliation) needsSequence check is false and the
  // existing literal-match assertions on tx.report.update's payload below
  // don't need to account for sequenceYear/sequenceNumber being added.
  mockTx.report.findUnique.mockResolvedValue({ sequenceNumber: 42 });
});

describe('saveReport', () => {
  it('inserts the report summary (including totalBreakValue) then bulk-inserts rows in a single transaction, returning the report id', async () => {
    mockTx.report.create.mockResolvedValue({
      id: 'report-1',
      fileAName: 'a.csv',
      fileBName: 'b.csv',
      totalRows: 2,
      matchedCount: 1,
    });

    const id = await saveReport(USER_ID, dto);

    expect(id).toBe('report-1');
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);

    expect(mockTx.report.create).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        organizationId: ORG_ID,
        name: 'June Bank Reconciliation',
        fileAName: 'a.csv',
        fileBName: 'b.csv',
        totalRows: 2,
        matchedCount: 1,
        unmatchedCount: 1,
        mismatchedCount: 0,
        duplicateCount: 0,
        totalBreakValue: 50,
        amountTolerance: 0.01,
        dateToleranceDays: 1,
        config: dto.config,
        sequenceYear: CURRENT_YEAR,
        sequenceNumber: 1,
      },
    });
    expect(mockTx.reportSequence.upsert).toHaveBeenCalledWith({
      where: { year: CURRENT_YEAR },
      create: { year: CURRENT_YEAR, lastValue: 1 },
      update: { lastValue: { increment: 1 } },
    });

    expect(mockTx.reportRow.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          reportId: 'report-1',
          ref: 'REF1',
          amountDiff: 0,
          dateA: new Date('2026-01-01'),
          dateB: new Date('2026-01-01'),
        }),
        expect.objectContaining({
          reportId: 'report-1',
          ref: 'REF2',
          amountA: 50,
          amountB: null,
          amountDiff: null,
          dateA: null,
          dateB: null,
        }),
      ],
    });

    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'report.create',
      entityType: 'report',
      entityId: 'report-1',
      ip: undefined,
      metadata: { filePair: 'a.csv vs b.csv', matchRate: '50.00%' },
    });
  });
});

describe('listReports', () => {
  const FAVORITES_INCLUDE = { favorites: { where: { userId: USER_ID }, select: { id: true } } };
  const DEFAULT_STATUS = { in: ['completed', 'failed'] };

  it("queries all completed+failed reports in the user's organization, newest first, unbounded by default, mapping isFavorited", async () => {
    mockPrisma.report.findMany.mockResolvedValue([
      { id: 'r1', favorites: [] },
      { id: 'r2', favorites: [{ id: 'fav-1' }] },
    ]);

    const result = await listReports(USER_ID);

    expect(result).toEqual([
      { id: 'r1', isFavorited: false },
      { id: 'r2', isFavorited: true },
    ]);
    expect(mockPrisma.report.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, status: DEFAULT_STATUS },
      include: FAVORITES_INCLUDE,
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
      include: FAVORITES_INCLUDE,
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
      include: FAVORITES_INCLUDE,
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
  it('returns the report with rows when found within the org', async () => {
    const report = { id: 'r1', rows: [] };
    mockPrisma.report.findFirst.mockResolvedValue(report);

    const result = await getReport(USER_ID, 'r1');

    expect(result).toEqual({ ...report, priorRun: null, runDurationMs: null });
    expect(mockPrisma.report.findFirst).toHaveBeenCalledWith({
      where: { id: 'r1', organizationId: ORG_ID },
      include: { rows: true },
    });
    expect(mockPrisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('resolves priorRun from the most recent other completed report in the org, regardless of file pair', async () => {
    const report = { id: 'r1', status: 'completed', rows: [], runDate: new Date('2026-07-15T00:00:00.000Z') };
    mockPrisma.report.findFirst
      .mockResolvedValueOnce(report)
      .mockResolvedValueOnce({ matchedCount: 45, totalRows: 50, totalBreakValue: 12.5 });

    const result = await getReport(USER_ID, 'r1');

    expect(result.priorRun).toEqual({ matchRate: 90, totalBreakValue: 12.5 });
    expect(mockPrisma.report.findFirst).toHaveBeenNthCalledWith(2, {
      where: { organizationId: ORG_ID, status: 'completed', id: { not: 'r1' }, runDate: { lt: report.runDate } },
      orderBy: { runDate: 'desc' },
      select: { matchedCount: true, totalRows: true, totalBreakValue: true },
    });
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

    await expect(getReport(USER_ID, 'r1')).resolves.toEqual({ ...report, progress: 0, priorRun: null, runDurationMs: null });
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
    });
    mockPrisma.report.deleteMany.mockResolvedValue({ count: 1 });

    await expect(deleteReport(USER_ID, 'r1', { ip: '10.0.0.1' })).resolves.toBeUndefined();
    expect(mockPrisma.report.deleteMany).toHaveBeenCalledWith({
      where: { id: 'r1', organizationId: ORG_ID, userId: USER_ID },
    });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'report.delete',
      entityType: 'report',
      entityId: 'r1',
      status: 'success',
      ip: '10.0.0.1',
      metadata: { reportName: 'June Bank Reconciliation', filePair: 'a.csv vs b.csv' },
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

describe('getReportsSummary', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-15T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('reports all-time totals with a deltaPercent trend from current vs previous calendar month', async () => {
    // Same 3 reports serve both queries here (getAllTimeCompletedReports has
    // no runDate filter, so it happens to return everything the month-range
    // query does too) — `current` totals reflect all 3, while previous/delta
    // are still derived from just the July-vs-June split.
    mockPrisma.report.findMany.mockResolvedValue([
      // This month (July 2026): 2 reports
      { runDate: new Date('2026-07-01T00:00:00Z'), totalRows: 100, matchedCount: 90, unmatchedCount: 8, mismatchedCount: 2, totalBreakValue: 500 },
      { runDate: new Date('2026-07-10T00:00:00Z'), totalRows: 100, matchedCount: 100, unmatchedCount: 0, mismatchedCount: 0, totalBreakValue: 0 },
      // Last month (June 2026): 1 report
      { runDate: new Date('2026-06-15T00:00:00Z'), totalRows: 100, matchedCount: 50, unmatchedCount: 50, mismatchedCount: 0, totalBreakValue: 1000 },
    ]);

    const summary = await getReportsSummary(USER_ID);

    expect(mockPrisma.report.findMany).toHaveBeenNthCalledWith(1, {
      where: { organizationId: ORG_ID, status: 'completed' },
      select: {
        runDate: true,
        totalRows: true,
        matchedCount: true,
        unmatchedCount: true,
        mismatchedCount: true,
        duplicateCount: true,
        totalBreakValue: true,
        fileAName: true,
        fileBName: true,
      },
    });
    expect(mockPrisma.report.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        organizationId: ORG_ID,
        status: 'completed',
        runDate: { gte: new Date('2026-06-01T00:00:00Z'), lt: new Date('2026-08-01T00:00:00Z') },
      },
      select: {
        runDate: true,
        totalRows: true,
        matchedCount: true,
        unmatchedCount: true,
        mismatchedCount: true,
        totalBreakValue: true,
      },
    });

    expect(summary.totalReconciliations).toEqual({ current: 3, previous: 1, deltaPercent: 100 });
    expect(summary.avgMatchRate.current).toBeCloseTo(80); // (90+100+50)/(100+100+100)*100
    expect(summary.avgMatchRate.previous).toBeCloseTo(50);
    expect(summary.avgMatchRate.deltaPercent).toBeCloseTo(90); // (95-50)/50*100
    expect(summary.unmatchedTransactions).toEqual({ current: 60, previous: 50, deltaPercent: -80 });
    expect(summary.totalBreakValue).toEqual({ current: 1500, previous: 1000, deltaPercent: -50 });
    expect(summary.totalTransactions).toBe(300);
  });

  it('returns null deltaPercent when there is no prior-period baseline', async () => {
    mockPrisma.report.findMany.mockResolvedValue([
      { runDate: new Date('2026-07-01T00:00:00Z'), totalRows: 10, matchedCount: 10, unmatchedCount: 0, mismatchedCount: 0, totalBreakValue: 0 },
    ]);

    const summary = await getReportsSummary(USER_ID);

    expect(summary.totalReconciliations).toEqual({ current: 1, previous: 0, deltaPercent: null });
  });

  it('suppresses deltaPercent when the current month has no completed reports yet, even with a nonzero prior month', async () => {
    mockPrisma.report.findMany.mockResolvedValue([
      // Last month (June 2026) only — nothing has run yet this July.
      { runDate: new Date('2026-06-15T00:00:00Z'), totalRows: 100, matchedCount: 50, unmatchedCount: 50, mismatchedCount: 0, totalBreakValue: 1000 },
    ]);

    const summary = await getReportsSummary(USER_ID);

    // All-time current totals still reflect June's report, untouched.
    expect(summary.totalReconciliations).toEqual({ current: 1, previous: 1, deltaPercent: null });
    expect(summary.avgMatchRate).toEqual({ current: 50, previous: 50, deltaPercent: null });
    expect(summary.unmatchedTransactions).toEqual({ current: 50, previous: 50, deltaPercent: null });
    expect(summary.totalBreakValue).toEqual({ current: 1000, previous: 1000, deltaPercent: null });
  });
});

describe('getReportsTrend', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-15T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('buckets reports by month and computes an all-time category breakdown', async () => {
    // Same rows serve both queries here (getAllTimeCompletedReports has no
    // runDate filter, so it happens to return everything the month-range
    // query does too) — categoryBreakdown sums across both months, not just
    // the most recent bucket.
    mockPrisma.report.findMany.mockResolvedValue([
      { runDate: new Date('2026-06-10T00:00:00Z'), totalRows: 100, matchedCount: 80, unmatchedCount: 15, mismatchedCount: 5, duplicateCount: 0 },
      { runDate: new Date('2026-07-05T00:00:00Z'), totalRows: 50, matchedCount: 40, unmatchedCount: 5, mismatchedCount: 3, duplicateCount: 2 },
    ]);

    const trend = await getReportsTrend(USER_ID, { months: 2 });

    expect(trend.matchRateSeries).toEqual([
      { month: '2026-06', value: 80 },
      { month: '2026-07', value: 80 },
    ]);
    expect(trend.volumeSeries).toEqual([
      { month: '2026-06', value: 1 },
      { month: '2026-07', value: 1 },
    ]);
    expect(trend.categoryBreakdown).toEqual({ matched: 120, mismatched: 8, unmatched: 20, duplicates: 2 });
  });

  it('defaults to 6 months and includes empty buckets for months with no reports', async () => {
    mockPrisma.report.findMany.mockResolvedValue([]);

    const trend = await getReportsTrend(USER_ID);

    expect(trend.matchRateSeries).toHaveLength(6);
    expect(trend.volumeSeries.every((point) => point.value === 0)).toBe(true);
    expect(trend.categoryBreakdown).toEqual({ matched: 0, mismatched: 0, unmatched: 0, duplicates: 0 });
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
        config: undefined,
      },
    });
    expect(mockLogAuditSafely).not.toHaveBeenCalled();
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
        config: undefined,
      },
    });
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
      metadata: {
        changes: {
          fileAReferenceNumber: { from: 'Ref', to: 'Reference No' },
          fileBAmount: { from: null, to: 'Amount' },
        },
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
      metadata: { changes: { amountTolerance: { from: 0.5, to: 0.01 } } },
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
    });
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

describe('completeDraft', () => {
  it('promotes a draft to completed, inserts rows, and audit-logs report.create', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'draft-1', name: 'Old name', userId: USER_ID });
    mockTx.report.update.mockResolvedValue({
      id: 'draft-1',
      fileAName: 'a.csv',
      fileBName: 'b.csv',
      totalRows: 2,
      matchedCount: 1,
    });

    const id = await completeDraft(USER_ID, 'draft-1', dto);

    expect(id).toBe('draft-1');
    expect(mockTx.report.update).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: expect.objectContaining({
        status: 'completed',
        progress: 100,
        name: 'June Bank Reconciliation',
        fileAName: 'a.csv',
        fileBName: 'b.csv',
        totalRows: 2,
        valueBreakdown: { matchedValue: 100, unmatchedValue: 50, duplicateValue: 0 },
      }),
    });
    expect(mockTx.reportRow.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([expect.objectContaining({ reportId: 'draft-1', ref: 'REF1' })]),
    });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'report.create',
      entityType: 'report',
      entityId: 'draft-1',
      ip: undefined,
      metadata: { filePair: 'a.csv vs b.csv', matchRate: '50.00%' },
    });
  });

  it('falls back to the draft\'s existing name when the completing DTO omits one', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'draft-1', name: 'Old name', userId: USER_ID });
    mockTx.report.update.mockResolvedValue({ id: 'draft-1' });

    await completeDraft(USER_ID, 'draft-1', { ...dto, name: undefined });

    expect(mockTx.report.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: 'Old name' }) }),
    );
  });

  it("throws NotFoundError when there's no such draft owned by the caller", async () => {
    mockPrisma.report.findFirst.mockResolvedValue(null);

    await expect(completeDraft(USER_ID, 'missing', dto)).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('assigns a sequence number on first completion (no prior sequence on the draft)', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'draft-1', name: 'Old name', userId: USER_ID });
    mockTx.report.findUnique.mockResolvedValue({ sequenceNumber: null });
    mockTx.reportSequence.upsert.mockResolvedValue({ year: CURRENT_YEAR, lastValue: 7 });
    mockTx.report.update.mockResolvedValue({ id: 'draft-1' });

    await completeDraft(USER_ID, 'draft-1', dto);

    expect(mockTx.report.findUnique).toHaveBeenCalledWith({ where: { id: 'draft-1' }, select: { sequenceNumber: true } });
    expect(mockTx.report.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sequenceYear: CURRENT_YEAR, sequenceNumber: 7 }) }),
    );
  });

  it('does not reassign a sequence number on a retry that already has one', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'draft-1', name: 'Old name', userId: USER_ID });
    mockTx.report.findUnique.mockResolvedValue({ sequenceNumber: 42 });
    mockTx.report.update.mockResolvedValue({ id: 'draft-1' });

    await completeDraft(USER_ID, 'draft-1', dto);

    expect(mockTx.reportSequence.upsert).not.toHaveBeenCalled();
    const updateData = mockTx.report.update.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty('sequenceYear');
    expect(updateData).not.toHaveProperty('sequenceNumber');
  });
});

const runDto = {
  columnMapping: {
    fileA: { referenceNumber: 'Transaction_ID', amount: 'Debit Amount', transactionDate: 'Posting Date' },
    fileB: { referenceNumber: 'Ref_No', amount: 'Amount', transactionDate: 'Value Date' },
  },
  config: { amountTolerance: 0.5, dateToleranceDays: 1 },
};

describe('runReconciliation', () => {
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
    const id = await runReconciliation(USER_ID, 'draft-1', runDto);

    expect(id).toBe('draft-1');
    expect(mockDownloadFromR2).toHaveBeenCalledWith('uploads/u1/a.csv');
    expect(mockDownloadFromR2).toHaveBeenCalledWith('uploads/u1/b.csv');
    expect(mockRunMatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      runDto.columnMapping.fileA,
      runDto.columnMapping.fileB,
      runDto.config,
    );
    expect(mockTx.report.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'draft-1' },
        data: expect.objectContaining({ status: 'completed', columnMapping: runDto.columnMapping }),
      }),
    );
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'report.run.started',
      entityType: 'report',
      entityId: 'draft-1',
      status: 'info',
      ip: undefined,
      metadata: { filePair: 'a.csv vs b.csv' },
    });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'report.run.completed',
      entityType: 'report',
      entityId: 'draft-1',
      ip: undefined,
      metadata: { matchRate: '50.00%', totalBreakValue: 50 },
    });
  });

  it('auto-detects sourceReportId from a completed report sharing the same file pair', async () => {
    mockPrisma.report.findFirst
      .mockResolvedValueOnce(draft) // the draft lookup
      .mockResolvedValueOnce({ id: 'prior-report' }); // findSourceReportId's lookup

    await runReconciliation(USER_ID, 'draft-1', runDto);

    expect(mockTx.report.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ sourceReportId: 'prior-report' }) }),
    );
  });

  it("throws NotFoundError when there's no such draft owned by the caller", async () => {
    mockPrisma.report.findFirst.mockResolvedValue(null);

    await expect(runReconciliation(USER_ID, 'missing', runDto)).rejects.toBeInstanceOf(NotFoundError);
    expect(mockDownloadFromR2).not.toHaveBeenCalled();
  });

  it('throws ValidationError when either file has not been uploaded yet', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...draft, fileBKey: null });

    await expect(runReconciliation(USER_ID, 'draft-1', runDto)).rejects.toBeInstanceOf(ValidationError);
    expect(mockDownloadFromR2).not.toHaveBeenCalled();
  });

  it('accepts a previously failed run for retry (status draft-or-failed)', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...draft, status: 'failed' });

    await runReconciliation(USER_ID, 'draft-1', runDto);

    expect(mockPrisma.report.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'draft-1', userId: USER_ID, status: { in: ['draft', 'failed'] } } }),
    );
  });

  it('clears any prior errorMessage on a successful persisted run', async () => {
    await runReconciliation(USER_ID, 'draft-1', runDto);

    expect(mockTx.report.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ errorMessage: null }) }),
    );
  });

  it('persists a failed Report row and rethrows when the file download fails', async () => {
    const downloadError = new Error('R2 object not found');
    mockDownloadFromR2.mockRejectedValue(downloadError);
    mockPrisma.report.update.mockResolvedValue({ id: 'draft-1', status: 'failed' });

    await expect(runReconciliation(USER_ID, 'draft-1', runDto, { ip: '10.0.0.1' })).rejects.toBe(downloadError);

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
      metadata: { reason: 'R2 object not found' },
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('persists a failed Report row when parsing throws (e.g. an unrecognized file extension)', async () => {
    const parseError = new Error('Unsupported file extension: txt');
    mockParseTabularFile.mockImplementation(() => {
      throw parseError;
    });
    mockPrisma.report.update.mockResolvedValue({ id: 'draft-1', status: 'failed' });

    await expect(runReconciliation(USER_ID, 'draft-1', runDto)).rejects.toBe(parseError);
    expect(mockPrisma.report.update).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: { status: 'failed', errorMessage: 'Unsupported file extension: txt' },
    });
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
    expect(mockPrisma.report.update).toHaveBeenCalledWith({
      where: { id: 'draft-1' },
      data: expect.objectContaining({
        fileASampleRows: { totalRows: 1, rows: [{ Ref: 'R1' }] },
        fileBSampleRows: { totalRows: 1, rows: [{ Ref: 'R1' }] },
        columnMapping: { fileA: { referenceNumber: 'Ref' }, fileB: { referenceNumber: 'Ref' } },
      }),
    });
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
  const sampleRows = { totalRows: 2, rows: [{ ref: 'R1' }] };
  const draft = {
    id: 'draft-1',
    userId: USER_ID,
    fileASampleRows: sampleRows,
    fileBSampleRows: sampleRows,
    columnMapping: runDto.columnMapping,
    status: 'draft',
  };

  beforeEach(() => {
    mockPrisma.report.findFirst.mockResolvedValue(draft);
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
    expect(mockRunMatch).toHaveBeenCalledWith(
      { rows: sampleRows.rows },
      { rows: sampleRows.rows },
      runDto.columnMapping.fileA,
      runDto.columnMapping.fileB,
      runDto.config,
    );
    expect(mockExtrapolatePreview).toHaveBeenCalledWith(expect.anything(), 1, 2, 1, 2);
  });

  it('uses an explicit columnMapping override when provided instead of the cached one', async () => {
    const override = { fileA: { referenceNumber: 'X', amount: 'Y', transactionDate: 'Z' }, fileB: runDto.columnMapping.fileB };

    await getRulePreview(USER_ID, 'draft-1', { config: runDto.config, columnMapping: override });

    expect(mockRunMatch).toHaveBeenCalledWith(expect.anything(), expect.anything(), override.fileA, override.fileB, runDto.config);
  });

  it('throws ConflictError when no sample has been cached yet', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ ...draft, fileASampleRows: null });

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

  it('throws NotFoundError when the row does not belong to the report', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', organizationId: ORG_ID, status: 'completed' });
    mockPrisma.reportRow.findFirst.mockResolvedValue(null);

    await expect(getTransaction(USER_ID, 'r1', 'missing-row')).rejects.toBeInstanceOf(NotFoundError);
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
    mockPrisma.reportRow.findFirst.mockResolvedValue({ id: 'row-1', reviewed: true });

    const result = await markRowReviewed(USER_ID, 'r1', 'row-1', true, { ip: '10.0.0.1' });

    expect(result).toEqual({ id: 'row-1', reviewed: true });
    expect(mockPrisma.reportRow.updateMany).toHaveBeenCalledWith({
      where: { id: 'row-1', reportId: 'r1' },
      data: expect.objectContaining({ reviewed: true, reviewedBy: USER_ID }),
    });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({
        action: 'report.row.review',
        metadata: { reportReference: 'REC-2026-000008', reviewed: true },
      }),
    );
  });

  it('falls back to the raw report id when the report has no sequence number yet', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', organizationId: ORG_ID, status: 'completed', sequenceYear: null, sequenceNumber: null });
    mockPrisma.reportRow.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.reportRow.findFirst.mockResolvedValue({ id: 'row-1', reviewed: true });

    await markRowReviewed(USER_ID, 'r1', 'row-1', true);

    expect(mockLogAuditSafely).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ metadata: { reportReference: 'r1', reviewed: true } }),
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

  it('excludes duplicate from the groupBy query', async () => {
    mockPrisma.reportRow.groupBy.mockResolvedValue([]);

    await getBreakBreakdown(USER_ID, 'r1');

    expect(mockPrisma.reportRow.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { reportId: 'r1', breakReason: { not: null, notIn: ['duplicate'] } } }),
    );
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
        where: { organizationId: ORG_ID, status: 'completed' },
        orderBy: { runDate: 'desc' },
        take: 14,
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
});

describe('getHistoryStats', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-15T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns all-time cumulative totals with a rolling 30-vs-previous-30-day delta', async () => {
    mockPrisma.report.findMany
      .mockResolvedValueOnce([
        { totalRows: 100, matchedCount: 90, unmatchedCount: 8, mismatchedCount: 2, duplicateCount: 0, totalBreakValue: 500, fileAName: 'a.csv', fileBName: 'b.csv', runDate: new Date() },
        { totalRows: 100, matchedCount: 100, unmatchedCount: 0, mismatchedCount: 0, duplicateCount: 0, totalBreakValue: 0, fileAName: 'a.csv', fileBName: 'b.csv', runDate: new Date() },
        { totalRows: 100, matchedCount: 50, unmatchedCount: 50, mismatchedCount: 0, duplicateCount: 0, totalBreakValue: 1000, fileAName: 'a.csv', fileBName: 'b.csv', runDate: new Date() },
      ])
      .mockResolvedValueOnce([
        { runDate: new Date('2026-07-10T00:00:00Z'), totalRows: 50, matchedCount: 45, unmatchedCount: 5, mismatchedCount: 0, totalBreakValue: 20 },
        { runDate: new Date('2026-05-20T00:00:00Z'), totalRows: 50, matchedCount: 25, unmatchedCount: 25, mismatchedCount: 0, totalBreakValue: 80 },
      ]);

    const stats = await getHistoryStats(USER_ID);

    expect(mockPrisma.report.findMany).toHaveBeenNthCalledWith(2, {
      where: {
        organizationId: ORG_ID,
        status: 'completed',
        runDate: { gte: new Date('2026-05-16T12:00:00.000Z'), lt: new Date('2026-07-15T12:00:00.000Z') },
      },
      select: {
        runDate: true,
        totalRows: true,
        matchedCount: true,
        unmatchedCount: true,
        mismatchedCount: true,
        totalBreakValue: true,
      },
    });

    expect(stats.totalReconciliations).toEqual({ value: 3, deltaPercent: 0 });
    expect(stats.avgMatchRate).toEqual({ value: 80, deltaPercent: 80 });
    expect(stats.totalBreakValue).toEqual({ value: 1500, deltaPercent: -75 });
    expect(stats.totalTransactions).toEqual({ value: 300, deltaPercent: 0 });
  });
});

describe('getMatchRateDistribution', () => {
  it('buckets all-time completed reports by their own match rate, plus a Failed bucket counting failed runs', async () => {
    mockPrisma.report.findMany.mockResolvedValue([
      { totalRows: 100, matchedCount: 99 },
      { totalRows: 100, matchedCount: 100 },
      { totalRows: 100, matchedCount: 96 },
      { totalRows: 100, matchedCount: 92 },
      { totalRows: 100, matchedCount: 80 },
    ]);
    mockPrisma.report.count.mockResolvedValue(5);

    const distribution = await getMatchRateDistribution(USER_ID);

    expect(mockPrisma.report.count).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, status: 'failed' },
    });
    expect(distribution).toEqual([
      { label: '≥ 99%', value: 2, percent: '20.0%' },
      { label: '95% - 98.99%', value: 1, percent: '10.0%' },
      { label: '90% - 94.99%', value: 1, percent: '10.0%' },
      { label: '< 90%', value: 1, percent: '10.0%' },
      { label: 'Failed', value: 5, percent: '50.0%' },
    ]);
  });

  it('returns all-zero buckets with 0.0% when there are no completed or failed reports', async () => {
    mockPrisma.report.findMany.mockResolvedValue([]);
    mockPrisma.report.count.mockResolvedValue(0);

    const distribution = await getMatchRateDistribution(USER_ID);

    expect(distribution.every((b) => b.value === 0 && b.percent === '0.0%')).toBe(true);
  });
});

describe('getTopFilePairs', () => {
  it('groups by file pair case-insensitively, sorted by count, with an "Other" bucket for the remainder', async () => {
    mockPrisma.report.findMany.mockResolvedValue([
      { fileAName: 'Internal Ledger.csv', fileBName: 'Bank Statement.csv' },
      { fileAName: 'internal ledger.csv', fileBName: 'bank statement.csv' },
      { fileAName: 'AP Ledger.csv', fileBName: 'Supplier Statement.csv' },
      { fileAName: 'GL Ledger.csv', fileBName: 'Bank Statement.csv' },
      { fileAName: 'Payroll.csv', fileBName: 'Bank Statement.csv' },
      { fileAName: 'Other X.csv', fileBName: 'Other Y.csv' },
    ]);

    const pairs = await getTopFilePairs(USER_ID, { limit: 4 });

    expect(pairs).toEqual([
      { label: 'Internal Ledger.csv vs Bank Statement.csv', count: 2 },
      { label: 'AP Ledger.csv vs Supplier Statement.csv', count: 1 },
      { label: 'GL Ledger.csv vs Bank Statement.csv', count: 1 },
      { label: 'Payroll.csv vs Bank Statement.csv', count: 1 },
      { label: 'Other File Pairs', count: 1 },
    ]);
  });

  it('omits the "Other" bucket when there are no more than `limit` groups', async () => {
    mockPrisma.report.findMany.mockResolvedValue([
      { fileAName: 'a.csv', fileBName: 'b.csv' },
      { fileAName: 'c.csv', fileBName: 'd.csv' },
    ]);

    const pairs = await getTopFilePairs(USER_ID, { limit: 4 });

    expect(pairs).toEqual([
      { label: 'a.csv vs b.csv', count: 1 },
      { label: 'c.csv vs d.csv', count: 1 },
    ]);
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
      include: { rows: true },
    });
  });
});
