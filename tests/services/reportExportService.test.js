import { jest } from '@jest/globals';

const mockPrisma = {
  reportExport: { create: jest.fn(), findMany: jest.fn() },
  member: { findFirst: jest.fn() },
};

jest.unstable_mockModule('../../db/index.js', () => ({ prisma: mockPrisma }));

const { recordExport, listExports } = await import('../../services/reportExportService.js');

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
});

describe('recordExport', () => {
  it('creates a tracking row for the export', async () => {
    mockPrisma.reportExport.create.mockResolvedValue({ id: 'exp-1' });

    await recordExport({
      reportId: 'r1',
      userId: USER_ID,
      organizationId: ORG_ID,
      templateId: 't1',
      format: 'pdf',
      fileSizeBytes: 1234,
    });

    expect(mockPrisma.reportExport.create).toHaveBeenCalledWith({
      data: {
        reportId: 'r1',
        userId: USER_ID,
        organizationId: ORG_ID,
        templateId: 't1',
        scheduleId: null,
        source: 'manual',
        format: 'pdf',
        status: 'success',
        errorMessage: null,
        fileSizeBytes: 1234,
      },
    });
  });

  it('defaults a missing templateId and scheduleId to null, source to manual, and status to success', async () => {
    mockPrisma.reportExport.create.mockResolvedValue({ id: 'exp-1' });

    await recordExport({ reportId: 'r1', userId: USER_ID, organizationId: ORG_ID, format: 'xlsx', fileSizeBytes: 10 });

    expect(mockPrisma.reportExport.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          templateId: null,
          scheduleId: null,
          source: 'manual',
          status: 'success',
          errorMessage: null,
        }),
      }),
    );
  });

  it('persists a scheduled, failed export with its error message and no file size', async () => {
    mockPrisma.reportExport.create.mockResolvedValue({ id: 'exp-1' });

    await recordExport({
      reportId: 'r1',
      userId: USER_ID,
      organizationId: ORG_ID,
      scheduleId: 's1',
      source: 'scheduled',
      format: 'xlsx',
      status: 'failed',
      errorMessage: 'build blew up',
    });

    expect(mockPrisma.reportExport.create).toHaveBeenCalledWith({
      data: {
        reportId: 'r1',
        userId: USER_ID,
        organizationId: ORG_ID,
        templateId: null,
        scheduleId: 's1',
        source: 'scheduled',
        format: 'xlsx',
        status: 'failed',
        errorMessage: 'build blew up',
        fileSizeBytes: null,
      },
    });
  });

  it('is best-effort — swallows and logs the error instead of throwing', async () => {
    mockPrisma.reportExport.create.mockRejectedValue(new Error('db unavailable'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      recordExport({ reportId: 'r1', userId: USER_ID, organizationId: ORG_ID, format: 'xlsx', fileSizeBytes: 10 }),
    ).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });
});

describe('listExports', () => {
  it("lists the org's exports, newest first, joined to report/user/template", async () => {
    const exports = [{ id: 'exp-1' }, { id: 'exp-2' }];
    mockPrisma.reportExport.findMany.mockResolvedValue(exports);

    const result = await listExports(USER_ID);

    expect(result).toBe(exports);
    expect(mockPrisma.reportExport.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID },
      include: {
        report: { select: { name: true, fileAName: true, fileBName: true } },
        user: { select: { name: true } },
        template: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('passes take through when a limit is given', async () => {
    mockPrisma.reportExport.findMany.mockResolvedValue([]);

    await listExports(USER_ID, { limit: 10 });

    expect(mockPrisma.reportExport.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10 }));
  });
});
