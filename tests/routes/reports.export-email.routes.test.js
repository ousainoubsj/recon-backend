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

const mockReportService = { getReport: jest.fn() };
jest.unstable_mockModule('../../services/reportService.js', () => mockReportService);

const mockLogAuditSafely = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/auditLogService.js', () => ({
  logAuditSafely: mockLogAuditSafely,
}));

const mockResolveSections = jest.fn();
jest.unstable_mockModule('../../services/reportTemplateService.js', () => ({
  resolveSections: mockResolveSections,
}));

const mockRecordExport = jest.fn().mockResolvedValue(undefined);
const mockListExports = jest.fn();
jest.unstable_mockModule('../../services/reportExportService.js', () => ({
  recordExport: mockRecordExport,
  listExports: mockListExports,
}));

jest.unstable_mockModule('../../services/scheduledReportService.js', () => ({
  createSchedule: jest.fn(),
  listSchedules: jest.fn(),
  updateSchedule: jest.fn(),
  deleteSchedule: jest.fn(),
}));

const mockSend = jest.fn();
class MockResend {
  constructor() {
    this.emails = { send: mockSend };
  }
}
jest.unstable_mockModule('resend', () => ({ Resend: MockResend }));

const { reportsRouter } = await import('../../routes/reports.js');
const { errorHandler } = await import('../../middleware/errorHandler.js');
const { NotFoundError } = await import('../../errors.js');

const app = express();
app.use(express.json());
app.use('/api/reports', reportsRouter);
app.use(errorHandler);

const ALL_SECTIONS = {
  summary: true,
  matchStatistics: true,
  breakAnalysis: true,
  unmatchedDetails: true,
  chartsAndGraphs: true,
};

const sampleReport = {
  id: 'r1',
  organizationId: 'org-1',
  name: 'June Bank Reconciliation',
  fileAName: 'a.csv',
  fileBName: 'b.csv',
  matchedCount: 8,
  mismatchedCount: 1,
  unmatchedCount: 1,
  duplicateCount: 0,
  totalBreakValue: 50,
  totalRows: 10,
  runDate: new Date('2026-01-01T00:00:00Z'),
  rows: [
    { ref: 'REF1', status: 'matched', amountA: 100, amountB: 100, amountDiff: 0 },
    { ref: 'REF2', status: 'unmatched_a', amountA: 50, amountB: null, amountDiff: null },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });
  mockResolveSections.mockResolvedValue(ALL_SECTIONS);
});

describe('POST /api/reports/:id/export', () => {
  it('returns an XLSX workbook by default and records the export', async () => {
    mockReportService.getReport.mockResolvedValue(sampleReport);

    const res = await request(app).post('/api/reports/r1/export').send({});

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain('reconciliation_report_r1.xlsx');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'report.export',
      entityType: 'report',
      entityId: 'r1',
      metadata: { format: 'xlsx', templateId: null },
    });
    expect(mockRecordExport).toHaveBeenCalledWith(
      expect.objectContaining({
        reportId: 'r1',
        userId: USER_ID,
        organizationId: 'org-1',
        format: 'xlsx',
        source: 'manual',
        status: 'success',
        fileSizeBytes: expect.any(Number),
      }),
    );
  });

  it('returns a real PDF when format is "pdf"', async () => {
    mockReportService.getReport.mockResolvedValue(sampleReport);

    const res = await request(app).post('/api/reports/r1/export').send({ format: 'pdf' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('reconciliation_report_r1.pdf');
    expect(Buffer.from(res.body).subarray(0, 4).toString()).toBe('%PDF');
    expect(mockRecordExport).toHaveBeenCalledWith(
      expect.objectContaining({ format: 'pdf', source: 'manual', status: 'success' }),
    );
  });

  it('records a failed export and still propagates a 500 when building the file throws', async () => {
    // `rows` missing makes buildXlsxReport's internal `.filter(...)` throw a
    // real TypeError — exercising the actual failure path instead of mocking it.
    mockReportService.getReport.mockResolvedValue({ ...sampleReport, rows: undefined });

    const res = await request(app).post('/api/reports/r1/export').send({});

    expect(res.status).toBe(500);
    expect(res.body.type).toBe('https://recon.app/errors/internal-error');
    expect(mockRecordExport).toHaveBeenCalledWith(
      expect.objectContaining({
        reportId: 'r1',
        userId: USER_ID,
        organizationId: 'org-1',
        format: 'xlsx',
        source: 'manual',
        status: 'failed',
        errorMessage: expect.any(String),
      }),
    );
  });

  it('passes templateId and sections overrides through to resolveSections', async () => {
    mockReportService.getReport.mockResolvedValue(sampleReport);

    await request(app)
      .post('/api/reports/r1/export')
      .send({ templateId: '123e4567-e89b-12d3-a456-426614174000', sections: { summary: false } });

    expect(mockResolveSections).toHaveBeenCalledWith({
      organizationId: 'org-1',
      templateId: '123e4567-e89b-12d3-a456-426614174000',
      overrideSections: { summary: false },
    });
  });

  it('rejects an invalid format with a 422', async () => {
    const res = await request(app).post('/api/reports/r1/export').send({ format: 'csv' });

    expect(res.status).toBe(422);
    expect(mockReportService.getReport).not.toHaveBeenCalled();
  });

  it('returns a 404 RFC 7807 error when the report is not found', async () => {
    mockReportService.getReport.mockRejectedValue(new NotFoundError());

    const res = await request(app).post('/api/reports/missing/export').send({});

    expect(res.status).toBe(404);
    expect(res.body.type).toBe('https://recon.app/errors/not-found');
  });

  it('returns a 404 when the template does not exist or is not visible to the org', async () => {
    mockReportService.getReport.mockResolvedValue(sampleReport);
    mockResolveSections.mockRejectedValue(new NotFoundError());

    const res = await request(app)
      .post('/api/reports/r1/export')
      .send({ templateId: '123e4567-e89b-12d3-a456-426614174000' });

    expect(res.status).toBe(404);
  });
});

describe('POST /api/reports/:id/email', () => {
  it('emails the report summary and returns 202', async () => {
    mockReportService.getReport.mockResolvedValue(sampleReport);
    mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });

    const res = await request(app)
      .post('/api/reports/r1/email')
      .send({ to: 'analyst@example.com' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ sent: true });
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'analyst@example.com', from: process.env.EMAIL_FROM }),
    );
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'report.email',
      entityType: 'report',
      entityId: 'r1',
      metadata: { to: 'analyst@example.com' },
    });
  });

  it('rejects an invalid recipient address with a 422 and never calls Resend', async () => {
    const res = await request(app).post('/api/reports/r1/email').send({ to: 'not-an-email' });

    expect(res.status).toBe(422);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns a 404 RFC 7807 error when the report is not found', async () => {
    mockReportService.getReport.mockRejectedValue(new NotFoundError());

    const res = await request(app)
      .post('/api/reports/missing/email')
      .send({ to: 'analyst@example.com' });

    expect(res.status).toBe(404);
  });
});
