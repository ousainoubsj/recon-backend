import { jest } from '@jest/globals';

const mockTx = {
  report: { create: jest.fn() },
  reportRow: { createMany: jest.fn() },
};

const mockPrisma = {
  $transaction: jest.fn(async (fn) => fn(mockTx)),
  report: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
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

const { saveReport, listReports, getReport, deleteReport } = await import(
  '../../services/reportService.js'
);
const { NotFoundError } = await import('../../errors.js');

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

const dto = {
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
  it('inserts the report summary then bulk-inserts rows in a single transaction, returning the report id', async () => {
    mockTx.report.create.mockResolvedValue({ id: 'report-1' });

    const id = await saveReport(USER_ID, dto);

    expect(id).toBe('report-1');
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);

    expect(mockTx.report.create).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        organizationId: ORG_ID,
        fileAName: 'a.csv',
        fileBName: 'b.csv',
        totalRows: 2,
        matchedCount: 1,
        unmatchedCount: 1,
        mismatchedCount: 0,
        duplicateCount: 0,
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
    });
  });
});

describe('listReports', () => {
  it("queries all reports in the user's organization, newest first", async () => {
    const reports = [{ id: 'r1' }, { id: 'r2' }];
    mockPrisma.report.findMany.mockResolvedValue(reports);

    const result = await listReports(USER_ID);

    expect(result).toBe(reports);
    expect(mockPrisma.report.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID },
      orderBy: { runDate: 'desc' },
    });
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
});

describe('deleteReport', () => {
  it('scopes deletion to the report creator when the role is not admin', async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
    mockPrisma.report.deleteMany.mockResolvedValue({ count: 1 });

    await expect(deleteReport(USER_ID, 'r1')).resolves.toBeUndefined();
    expect(mockPrisma.report.deleteMany).toHaveBeenCalledWith({
      where: { id: 'r1', organizationId: ORG_ID, userId: USER_ID },
    });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'report.delete',
      entityType: 'report',
      entityId: 'r1',
    });
  });

  it('lets an admin delete any report in the org, not just their own', async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'admin' });
    mockPrisma.report.deleteMany.mockResolvedValue({ count: 1 });

    await expect(deleteReport(USER_ID, 'r1')).resolves.toBeUndefined();
    expect(mockPrisma.report.deleteMany).toHaveBeenCalledWith({
      where: { id: 'r1', organizationId: ORG_ID },
    });
  });

  it('throws NotFoundError when nothing matched (not found, not in org, or not owned) and does not log', async () => {
    mockPrisma.report.deleteMany.mockResolvedValue({ count: 0 });

    await expect(deleteReport(USER_ID, 'missing')).rejects.toBeInstanceOf(NotFoundError);
    expect(mockLogAuditSafely).not.toHaveBeenCalled();
  });
});
