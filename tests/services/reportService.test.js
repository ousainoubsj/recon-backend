import { jest } from '@jest/globals';

const mockTx = {
  report: { create: jest.fn(), update: jest.fn() },
  reportRow: { createMany: jest.fn() },
};

const mockPrisma = {
  $transaction: jest.fn(async (fn) => fn(mockTx)),
  report: {
    create: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
    deleteMany: jest.fn(),
    updateMany: jest.fn(),
  },
  reportFavorite: {
    upsert: jest.fn(),
    deleteMany: jest.fn(),
  },
  member: {
    findFirst: jest.fn(),
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
  getHistoryStats,
  getMatchRateDistribution,
  getTopFilePairs,
  updateReportTag,
  addFavorite,
  removeFavorite,
  bulkDeleteReports,
  getReportsByIds,
} = await import('../../services/reportService.js');
const { NotFoundError } = await import('../../errors.js');

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

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockTx));
  mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
});

describe('saveReport', () => {
  it('inserts the report summary (including totalBreakValue) then bulk-inserts rows in a single transaction, returning the report id', async () => {
    mockTx.report.create.mockResolvedValue({ id: 'report-1' });

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
      },
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
    });
  });
});

describe('listReports', () => {
  const FAVORITES_INCLUDE = { favorites: { where: { userId: USER_ID }, select: { id: true } } };

  it("queries all reports in the user's organization, newest first, unbounded by default, mapping isFavorited", async () => {
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
      where: { organizationId: ORG_ID, status: 'completed' },
      include: FAVORITES_INCLUDE,
      orderBy: { runDate: 'desc' },
    });
  });

  it('passes take through when a limit is given', async () => {
    mockPrisma.report.findMany.mockResolvedValue([]);

    await listReports(USER_ID, { limit: 5 });

    expect(mockPrisma.report.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, status: 'completed' },
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
        status: 'completed',
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
      expect.objectContaining({ where: { organizationId: ORG_ID, status: 'completed' } }),
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
      expect.objectContaining({ where: { organizationId: ORG_ID, status: 'completed' } }),
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

    expect(result).toBe(report);
    expect(mockPrisma.report.findFirst).toHaveBeenCalledWith({
      where: { id: 'r1', organizationId: ORG_ID },
      include: { rows: true },
    });
  });

  it('throws NotFoundError when the report does not exist or is not in the org', async () => {
    mockPrisma.report.findFirst.mockResolvedValue(null);

    await expect(getReport(USER_ID, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it("hides another user's draft even within the same org", async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'r1', status: 'draft', userId: OTHER_USER_ID, rows: [] });

    await expect(getReport(USER_ID, 'r1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it("returns the caller's own draft", async () => {
    const report = { id: 'r1', status: 'draft', userId: USER_ID, rows: [] };
    mockPrisma.report.findFirst.mockResolvedValue(report);

    await expect(getReport(USER_ID, 'r1')).resolves.toBe(report);
  });
});

describe('deleteReport', () => {
  it('scopes deletion to the report creator when the role is not admin', async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
    mockPrisma.report.findFirst.mockResolvedValue({ userId: USER_ID });
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
    });
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("lets an admin delete any report in the org, notifying the original owner when it isn't their own", async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'admin' });
    mockPrisma.report.findFirst.mockResolvedValue({ userId: OTHER_USER_ID });
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

  it('aggregates current vs previous calendar month and computes deltas', async () => {
    mockPrisma.report.findMany.mockResolvedValue([
      // This month (July 2026): 2 reports
      { runDate: new Date('2026-07-01T00:00:00Z'), totalRows: 100, matchedCount: 90, unmatchedCount: 8, mismatchedCount: 2, totalBreakValue: 500 },
      { runDate: new Date('2026-07-10T00:00:00Z'), totalRows: 100, matchedCount: 100, unmatchedCount: 0, mismatchedCount: 0, totalBreakValue: 0 },
      // Last month (June 2026): 1 report
      { runDate: new Date('2026-06-15T00:00:00Z'), totalRows: 100, matchedCount: 50, unmatchedCount: 50, mismatchedCount: 0, totalBreakValue: 1000 },
    ]);

    const summary = await getReportsSummary(USER_ID);

    expect(mockPrisma.report.findMany).toHaveBeenCalledWith({
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

    expect(summary.totalReconciliations).toEqual({ current: 2, previous: 1, deltaPercent: 100 });
    expect(summary.avgMatchRate.current).toBeCloseTo(95); // (90+100)/(100+100)*100
    expect(summary.avgMatchRate.previous).toBeCloseTo(50);
    expect(summary.unmatchedTransactions).toEqual({ current: 10, previous: 50, deltaPercent: -80 });
    expect(summary.totalBreakValue).toEqual({ current: 500, previous: 1000, deltaPercent: -50 });
    expect(summary.totalTransactions).toBe(200);
  });

  it('returns null deltaPercent when there is no prior-period baseline', async () => {
    mockPrisma.report.findMany.mockResolvedValue([
      { runDate: new Date('2026-07-01T00:00:00Z'), totalRows: 10, matchedCount: 10, unmatchedCount: 0, mismatchedCount: 0, totalBreakValue: 0 },
    ]);

    const summary = await getReportsSummary(USER_ID);

    expect(summary.totalReconciliations).toEqual({ current: 1, previous: 0, deltaPercent: null });
  });
});

describe('getReportsTrend', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-15T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('buckets reports by month and computes the current month category breakdown', async () => {
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
    expect(trend.categoryBreakdown).toEqual({ matched: 40, mismatched: 3, unmatched: 5, duplicates: 2 });
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
  it('updates only the fields provided, scoped to the caller and status:draft', async () => {
    mockPrisma.report.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'draft-1', name: 'Updated name' });

    const result = await updateDraft(USER_ID, 'draft-1', { name: 'Updated name' });

    expect(result).toEqual({ id: 'draft-1', name: 'Updated name' });
    expect(mockPrisma.report.updateMany).toHaveBeenCalledWith({
      where: { id: 'draft-1', userId: USER_ID, status: 'draft' },
      data: { name: 'Updated name' },
    });
  });

  it("throws NotFoundError when the draft doesn't exist or isn't the caller's", async () => {
    mockPrisma.report.updateMany.mockResolvedValue({ count: 0 });

    await expect(updateDraft(USER_ID, 'missing', { name: 'x' })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('listDrafts', () => {
  it("lists only the caller's own drafts, most recently updated first", async () => {
    const drafts = [{ id: 'draft-1' }, { id: 'draft-2' }];
    mockPrisma.report.findMany.mockResolvedValue(drafts);

    const result = await listDrafts(USER_ID);

    expect(result).toBe(drafts);
    expect(mockPrisma.report.findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, organizationId: ORG_ID, status: 'draft' },
      orderBy: { updatedAt: 'desc' },
    });
  });
});

describe('completeDraft', () => {
  it('promotes a draft to completed, inserts rows, and audit-logs report.create', async () => {
    mockPrisma.report.findFirst.mockResolvedValue({ id: 'draft-1', name: 'Old name', userId: USER_ID });
    mockTx.report.update.mockResolvedValue({ id: 'draft-1' });

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
  it('buckets all-time completed reports by their own match rate', async () => {
    mockPrisma.report.findMany.mockResolvedValue([
      { totalRows: 100, matchedCount: 99 },
      { totalRows: 100, matchedCount: 100 },
      { totalRows: 100, matchedCount: 96 },
      { totalRows: 100, matchedCount: 92 },
      { totalRows: 100, matchedCount: 80 },
    ]);

    const distribution = await getMatchRateDistribution(USER_ID);

    expect(distribution).toEqual([
      { label: '≥ 99%', value: 2, percent: '40.0%' },
      { label: '95% - 98.99%', value: 1, percent: '20.0%' },
      { label: '90% - 94.99%', value: 1, percent: '20.0%' },
      { label: '< 90%', value: 1, percent: '20.0%' },
    ]);
  });

  it('returns all-zero buckets with 0.0% when there are no completed reports', async () => {
    mockPrisma.report.findMany.mockResolvedValue([]);

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
  it('scopes bulk-delete to own reports when the role is not admin', async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
    mockPrisma.report.findMany.mockResolvedValue([
      { id: 'r1', userId: USER_ID },
      { id: 'r2', userId: USER_ID },
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
      metadata: { ids: ['r1', 'r2'], count: 2 },
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
