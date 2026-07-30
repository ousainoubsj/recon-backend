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

const mockScheduledReportService = {
  createSchedule: jest.fn(),
  listSchedules: jest.fn(),
  updateSchedule: jest.fn(),
  deleteSchedule: jest.fn(),
};
jest.unstable_mockModule('../../services/scheduledReportService.js', () => mockScheduledReportService);

jest.unstable_mockModule('../../services/reportTemplateService.js', () => ({ resolveSections: jest.fn() }));
jest.unstable_mockModule('../../services/reportExportService.js', () => ({
  recordExport: jest.fn().mockResolvedValue(undefined),
  listExports: jest.fn(),
}));
jest.unstable_mockModule('../../services/auditLogService.js', () => ({
  logAuditSafely: jest.fn().mockResolvedValue(undefined),
  logResultsViewedOnce: jest.fn().mockResolvedValue(undefined),
}));

const { reportsRouter } = await import('../../routes/reports.js');
const { errorHandler } = await import('../../middleware/errorHandler.js');
const { NotFoundError, ConflictError } = await import('../../errors.js');

const app = express();
app.use(express.json());
app.use('/api/reports', reportsRouter);
app.use(errorHandler);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });
});

describe('POST /api/reports/:id/schedule', () => {
  it('creates a schedule and returns 201', async () => {
    mockScheduledReportService.createSchedule.mockResolvedValue({ id: 's1', cadence: 'daily' });

    const res = await request(app).post('/api/reports/r1/schedule').send({ cadence: 'daily' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 's1', cadence: 'daily' });
    expect(mockScheduledReportService.createSchedule).toHaveBeenCalledWith(USER_ID, 'r1', { cadence: 'daily', format: 'xlsx' });
  });

  it('accepts recipientEmails and an explicit format', async () => {
    mockScheduledReportService.createSchedule.mockResolvedValue({ id: 's1' });

    await request(app)
      .post('/api/reports/r1/schedule')
      .send({ cadence: 'weekly', format: 'pdf', recipientEmails: ['a@example.com'] });

    expect(mockScheduledReportService.createSchedule).toHaveBeenCalledWith(USER_ID, 'r1', {
      cadence: 'weekly',
      format: 'pdf',
      recipientEmails: ['a@example.com'],
    });
  });

  it('rejects a missing cadence with a 422', async () => {
    const res = await request(app).post('/api/reports/r1/schedule').send({});

    expect(res.status).toBe(422);
    expect(mockScheduledReportService.createSchedule).not.toHaveBeenCalled();
  });

  it('rejects an invalid recipient email with a 422', async () => {
    const res = await request(app)
      .post('/api/reports/r1/schedule')
      .send({ cadence: 'daily', recipientEmails: ['not-an-email'] });

    expect(res.status).toBe(422);
  });

  it('rejects a viewer with a 403', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).post('/api/reports/r1/schedule').send({ cadence: 'daily' });

    expect(res.status).toBe(403);
    expect(mockScheduledReportService.createSchedule).not.toHaveBeenCalled();
  });

  it('returns a 409 RFC 7807 error when the report is not completed', async () => {
    mockScheduledReportService.createSchedule.mockRejectedValue(new ConflictError('not completed'));

    const res = await request(app).post('/api/reports/r1/schedule').send({ cadence: 'daily' });

    expect(res.status).toBe(409);
    expect(res.body.type).toBe('https://recon.app/errors/conflict');
  });

  it('returns a 404 RFC 7807 error when the report does not exist', async () => {
    mockScheduledReportService.createSchedule.mockRejectedValue(new NotFoundError());

    const res = await request(app).post('/api/reports/missing/schedule').send({ cadence: 'daily' });

    expect(res.status).toBe(404);
  });
});

describe('GET /api/reports/schedules', () => {
  it("returns the org's schedules", async () => {
    mockScheduledReportService.listSchedules.mockResolvedValue([{ id: 's1' }]);

    const res = await request(app).get('/api/reports/schedules');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 's1' }]);
    expect(mockScheduledReportService.listSchedules).toHaveBeenCalledWith(USER_ID);
  });
});

describe('PATCH /api/reports/schedules/:id', () => {
  it('updates a schedule (e.g. pause) and returns it', async () => {
    mockScheduledReportService.updateSchedule.mockResolvedValue({ id: 's1', isActive: false });

    const res = await request(app).patch('/api/reports/schedules/s1').send({ isActive: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 's1', isActive: false });
    expect(mockScheduledReportService.updateSchedule).toHaveBeenCalledWith(USER_ID, 's1', { isActive: false });
  });

  it('returns a 404 RFC 7807 error when not found or not in the org', async () => {
    mockScheduledReportService.updateSchedule.mockRejectedValue(new NotFoundError());

    const res = await request(app).patch('/api/reports/schedules/missing').send({ isActive: false });

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/reports/schedules/:id', () => {
  it('cancels a schedule and returns 204', async () => {
    mockScheduledReportService.deleteSchedule.mockResolvedValue(undefined);

    const res = await request(app).delete('/api/reports/schedules/s1');

    expect(res.status).toBe(204);
    expect(mockScheduledReportService.deleteSchedule).toHaveBeenCalledWith(USER_ID, 's1');
  });

  it('returns a 404 RFC 7807 error when not found or not in the org', async () => {
    mockScheduledReportService.deleteSchedule.mockRejectedValue(new NotFoundError());

    const res = await request(app).delete('/api/reports/schedules/missing');

    expect(res.status).toBe(404);
  });

  it('rejects a viewer with a 403', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).delete('/api/reports/schedules/s1');

    expect(res.status).toBe(403);
    expect(mockScheduledReportService.deleteSchedule).not.toHaveBeenCalled();
  });
});
