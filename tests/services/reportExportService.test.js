import { jest } from '@jest/globals';

const mockPrisma = {
  reportExport: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), delete: jest.fn() },
  member: { findFirst: jest.fn() },
};

jest.unstable_mockModule('../../db/index.js', () => ({ prisma: mockPrisma }));

const mockSend = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../utils/r2Client.js', () => ({ r2: { send: mockSend } }));

const { recordExport, listExports, uploadExportFile, getExportForDownload, deleteExport } = await import(
  '../../services/reportExportService.js'
);
const { NotFoundError } = await import('../../errors.js');

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
        fileKey: null,
      },
    });
  });

  it('persists a given fileKey', async () => {
    mockPrisma.reportExport.create.mockResolvedValue({ id: 'exp-1' });

    await recordExport({
      reportId: 'r1',
      userId: USER_ID,
      organizationId: ORG_ID,
      format: 'pdf',
      fileSizeBytes: 1234,
      fileKey: 'exports/org-1/r1/abc.pdf',
    });

    expect(mockPrisma.reportExport.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fileKey: 'exports/org-1/r1/abc.pdf' }) }),
    );
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
        fileKey: null,
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
        user: { select: { name: true, image: true } },
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

  it('passes skip through when an offset is given', async () => {
    mockPrisma.reportExport.findMany.mockResolvedValue([]);

    await listExports(USER_ID, { offset: 20 });

    expect(mockPrisma.reportExport.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20 }));
  });

  it('filters by report name/file names when q is given', async () => {
    mockPrisma.reportExport.findMany.mockResolvedValue([]);

    await listExports(USER_ID, { q: 'june' });

    expect(mockPrisma.reportExport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: ORG_ID,
          report: {
            OR: [
              { name: { contains: 'june', mode: 'insensitive' } },
              { fileAName: { contains: 'june', mode: 'insensitive' } },
              { fileBName: { contains: 'june', mode: 'insensitive' } },
            ],
          },
        },
      }),
    );
  });

  it('ignores a blank/whitespace-only q', async () => {
    mockPrisma.reportExport.findMany.mockResolvedValue([]);

    await listExports(USER_ID, { q: '   ' });

    expect(mockPrisma.reportExport.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG_ID } }),
    );
  });
});

describe('uploadExportFile', () => {
  it('PUTs the buffer to R2 under the given key with the given content type', async () => {
    const buffer = Buffer.from('file bytes');

    await uploadExportFile('exports/org-1/r1/abc.pdf', buffer, 'application/pdf');

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { Bucket: process.env.R2_BUCKET_NAME, Key: 'exports/org-1/r1/abc.pdf', Body: buffer, ContentType: 'application/pdf' },
      }),
    );
  });
});

describe('getExportForDownload', () => {
  it("returns the export row scoped to the caller's org", async () => {
    const exportRow = { id: 'exp-1', organizationId: ORG_ID, fileKey: 'exports/org-1/r1/abc.pdf' };
    mockPrisma.reportExport.findFirst.mockResolvedValue(exportRow);

    const result = await getExportForDownload(USER_ID, 'exp-1');

    expect(result).toBe(exportRow);
    expect(mockPrisma.reportExport.findFirst).toHaveBeenCalledWith({ where: { id: 'exp-1', organizationId: ORG_ID } });
  });

  it('throws NotFoundError when the export does not exist or belongs to another org', async () => {
    mockPrisma.reportExport.findFirst.mockResolvedValue(null);

    await expect(getExportForDownload(USER_ID, 'missing')).rejects.toThrow(NotFoundError);
  });
});

describe('deleteExport', () => {
  it('deletes the stored R2 object and the tracking row', async () => {
    mockPrisma.reportExport.findFirst.mockResolvedValue({
      id: 'exp-1',
      organizationId: ORG_ID,
      fileKey: 'exports/org-1/r1/abc.pdf',
    });

    await deleteExport(USER_ID, 'exp-1');

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ input: { Bucket: process.env.R2_BUCKET_NAME, Key: 'exports/org-1/r1/abc.pdf' } }),
    );
    expect(mockPrisma.reportExport.delete).toHaveBeenCalledWith({ where: { id: 'exp-1' } });
  });

  it('deletes the tracking row without touching R2 when there is no fileKey', async () => {
    mockPrisma.reportExport.findFirst.mockResolvedValue({ id: 'exp-1', organizationId: ORG_ID, fileKey: null });

    await deleteExport(USER_ID, 'exp-1');

    expect(mockSend).not.toHaveBeenCalled();
    expect(mockPrisma.reportExport.delete).toHaveBeenCalledWith({ where: { id: 'exp-1' } });
  });

  it('still deletes the tracking row when deleting the R2 object fails', async () => {
    mockPrisma.reportExport.findFirst.mockResolvedValue({
      id: 'exp-1',
      organizationId: ORG_ID,
      fileKey: 'exports/org-1/r1/abc.pdf',
    });
    mockSend.mockRejectedValueOnce(new Error('R2 unreachable'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await deleteExport(USER_ID, 'exp-1');

    expect(mockPrisma.reportExport.delete).toHaveBeenCalledWith({ where: { id: 'exp-1' } });
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('throws NotFoundError when the export does not exist or belongs to another org', async () => {
    mockPrisma.reportExport.findFirst.mockResolvedValue(null);

    await expect(deleteExport(USER_ID, 'missing')).rejects.toThrow(NotFoundError);
    expect(mockPrisma.reportExport.delete).not.toHaveBeenCalled();
  });
});
