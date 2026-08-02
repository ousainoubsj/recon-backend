import { jest } from '@jest/globals';

const mockPrisma = {
  scheduledReport: { findMany: jest.fn(), update: jest.fn().mockResolvedValue(undefined) },
};
jest.unstable_mockModule('../../db/index.js', () => ({ prisma: mockPrisma }));

const mockResolveSections = jest.fn();
const mockGetTemplateName = jest.fn().mockResolvedValue(null);
jest.unstable_mockModule('../../services/reportTemplateService.js', () => ({
  resolveSections: mockResolveSections,
  getTemplateName: mockGetTemplateName,
}));

const mockGetOrganizationBrand = jest.fn().mockResolvedValue({ name: 'Test Org', logo: null });
jest.unstable_mockModule('../../services/organizationService.js', () => ({ getOrganizationBrand: mockGetOrganizationBrand }));

const mockRecordExport = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/reportExportService.js', () => ({ recordExport: mockRecordExport }));

const mockComputeNextRunAt = jest.fn(() => new Date('2099-01-01T00:00:00Z'));
jest.unstable_mockModule('../../services/scheduledReportService.js', () => ({ computeNextRunAt: mockComputeNextRunAt }));

const mockSendScheduledReportEmail = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/emailService.js', () => ({
  sendScheduledReportEmail: mockSendScheduledReportEmail,
}));

const mockBuildXlsxReport = jest.fn(() => Buffer.from('xlsx-bytes'));
jest.unstable_mockModule('../../utils/xlsxReport.js', () => ({ buildXlsxReport: mockBuildXlsxReport }));

const mockBuildPdfReport = jest.fn().mockResolvedValue(Buffer.from('pdf-bytes'));
jest.unstable_mockModule('../../utils/pdfReport.js', () => ({ buildPdfReport: mockBuildPdfReport }));

const { runDueScheduledReports } = await import('../../services/scheduledReportRunner.js');

const NOW = new Date('2026-01-15T00:00:00Z');

function makeSchedule(overrides = {}) {
  return {
    id: 's1',
    reportId: 'r1',
    organizationId: 'org-1',
    userId: 'user-1',
    cadence: 'daily',
    format: 'xlsx',
    templateId: null,
    sections: null,
    recipientEmails: null,
    report: { id: 'r1', status: 'completed', rows: [] },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveSections.mockResolvedValue({ summary: true });
});

describe('runDueScheduledReports', () => {
  it('queries only active, due schedules with the report and its rows included', async () => {
    mockPrisma.scheduledReport.findMany.mockResolvedValue([]);

    await runDueScheduledReports(NOW);

    expect(mockPrisma.scheduledReport.findMany).toHaveBeenCalledWith({
      where: { isActive: true, nextRunAt: { lte: NOW } },
      include: { report: { include: { rows: true } } },
    });
  });

  it('builds an XLSX export, records it, emails recipients, and advances the schedule', async () => {
    const schedule = makeSchedule({ recipientEmails: ['a@example.com'] });
    mockPrisma.scheduledReport.findMany.mockResolvedValue([schedule]);

    const count = await runDueScheduledReports(NOW);

    expect(count).toBe(1);
    expect(mockBuildXlsxReport).toHaveBeenCalledWith(schedule.report, { summary: true }, {
      generatedByName: 'Automated (Scheduled Report)',
      organizationName: 'Test Org',
      organizationLogo: null,
      organizationType: null,
      templateName: null,
    });
    expect(mockBuildPdfReport).not.toHaveBeenCalled();
    expect(mockRecordExport).toHaveBeenCalledWith({
      reportId: 'r1',
      userId: 'user-1',
      organizationId: 'org-1',
      templateId: null,
      scheduleId: 's1',
      source: 'scheduled',
      format: 'xlsx',
      status: 'success',
      fileSizeBytes: Buffer.from('xlsx-bytes').length,
    });
    expect(mockSendScheduledReportEmail).toHaveBeenCalledWith(schedule.report, expect.any(Buffer), 'xlsx', [
      'a@example.com',
    ]);
    expect(mockComputeNextRunAt).toHaveBeenCalledWith('daily', NOW);
    expect(mockPrisma.scheduledReport.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { lastRunAt: NOW, nextRunAt: expect.any(Date) },
    });
  });

  it('builds a PDF export when format is "pdf"', async () => {
    const schedule = makeSchedule({ format: 'pdf' });
    mockPrisma.scheduledReport.findMany.mockResolvedValue([schedule]);

    await runDueScheduledReports(NOW);

    expect(mockBuildPdfReport).toHaveBeenCalledWith(schedule.report, { summary: true }, {
      generatedByName: 'Automated (Scheduled Report)',
      organizationName: 'Test Org',
      organizationLogo: null,
      organizationType: null,
      templateName: null,
    });
    expect(mockBuildXlsxReport).not.toHaveBeenCalled();
  });

  it('does not email when recipientEmails is empty or absent, but still records the export', async () => {
    const schedule = makeSchedule({ recipientEmails: null });
    mockPrisma.scheduledReport.findMany.mockResolvedValue([schedule]);

    await runDueScheduledReports(NOW);

    expect(mockSendScheduledReportEmail).not.toHaveBeenCalled();
    expect(mockRecordExport).toHaveBeenCalledTimes(1);
  });

  it('skips building/emailing but records a failed export and still advances when the report is missing', async () => {
    const schedule = makeSchedule({ report: null });
    mockPrisma.scheduledReport.findMany.mockResolvedValue([schedule]);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await runDueScheduledReports(NOW);

    expect(mockBuildXlsxReport).not.toHaveBeenCalled();
    expect(mockSendScheduledReportEmail).not.toHaveBeenCalled();
    expect(mockRecordExport).toHaveBeenCalledWith(
      expect.objectContaining({
        reportId: 'r1',
        scheduleId: 's1',
        source: 'scheduled',
        status: 'failed',
        errorMessage: expect.any(String),
      }),
    );
    expect(mockPrisma.scheduledReport.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { lastRunAt: NOW, nextRunAt: expect.any(Date) },
    });

    consoleError.mockRestore();
  });

  it('skips but records a failed export and still advances when the report is not completed (e.g. somehow still a draft)', async () => {
    const schedule = makeSchedule({ report: { id: 'r1', status: 'draft', rows: [] } });
    mockPrisma.scheduledReport.findMany.mockResolvedValue([schedule]);
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await runDueScheduledReports(NOW);

    expect(mockRecordExport).toHaveBeenCalledWith(
      expect.objectContaining({ reportId: 'r1', scheduleId: 's1', source: 'scheduled', status: 'failed' }),
    );
    expect(mockPrisma.scheduledReport.update).toHaveBeenCalledTimes(1);

    consoleError.mockRestore();
  });

  it('isolates a failing schedule so the rest of the run still completes, and still advances the failed one', async () => {
    const badSchedule = makeSchedule({ id: 's-bad' });
    const goodSchedule = makeSchedule({ id: 's-good' });
    mockPrisma.scheduledReport.findMany.mockResolvedValue([badSchedule, goodSchedule]);
    mockResolveSections.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ summary: true });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    const count = await runDueScheduledReports(NOW);

    expect(count).toBe(2);
    expect(mockRecordExport).toHaveBeenCalledTimes(2);
    expect(mockRecordExport).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: 's-bad', status: 'failed', errorMessage: 'boom' }),
    );
    expect(mockRecordExport).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: 's-good', status: 'success' }),
    );
    expect(mockPrisma.scheduledReport.update).toHaveBeenCalledTimes(2);
    expect(mockPrisma.scheduledReport.update).toHaveBeenCalledWith({ where: { id: 's-bad' }, data: expect.anything() });
    expect(mockPrisma.scheduledReport.update).toHaveBeenCalledWith({ where: { id: 's-good' }, data: expect.anything() });
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });
});
