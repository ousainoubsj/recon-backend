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

const sampleReport = {
  id: 'r1',
  fileAName: 'a.csv',
  fileBName: 'b.csv',
  matchedCount: 8,
  totalRows: 10,
  runDate: new Date('2026-01-01T00:00:00Z'),
  rows: [
    { ref: 'REF1', status: 'matched', amountA: 100, amountB: 100 },
    { ref: 'REF2', status: 'unmatched_a', amountA: 50, amountB: null },
  ],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });
});

describe('POST /api/reports/:id/export', () => {
  it('returns an XLSX workbook for the report', async () => {
    mockReportService.getReport.mockResolvedValue(sampleReport);

    const res = await request(app).post('/api/reports/r1/export');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain('reconciliation_report_r1.xlsx');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'report.export',
      entityType: 'report',
      entityId: 'r1',
    });
  });

  it('returns a 404 RFC 7807 error when the report is not found', async () => {
    mockReportService.getReport.mockRejectedValue(new NotFoundError());

    const res = await request(app).post('/api/reports/missing/export');

    expect(res.status).toBe(404);
    expect(res.body.type).toBe('https://recon.app/errors/not-found');
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
