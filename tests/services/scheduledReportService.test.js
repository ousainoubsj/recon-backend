import { jest } from '@jest/globals';

const mockPrisma = {
  scheduledReport: {
    create: jest.fn(),
    findMany: jest.fn(),
    updateMany: jest.fn(),
    findFirst: jest.fn(),
    deleteMany: jest.fn(),
  },
  member: { findFirst: jest.fn() },
};

jest.unstable_mockModule('../../db/index.js', () => ({ prisma: mockPrisma }));

const mockGetReport = jest.fn();
jest.unstable_mockModule('../../services/reportService.js', () => ({ getReport: mockGetReport }));

const { createSchedule, listSchedules, updateSchedule, deleteSchedule, computeNextRunAt } = await import(
  '../../services/scheduledReportService.js'
);
const { NotFoundError, ConflictError } = await import('../../errors.js');

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
});

describe('computeNextRunAt', () => {
  const from = new Date('2026-01-15T00:00:00Z');

  it('advances a day for daily', () => {
    expect(computeNextRunAt('daily', from)).toEqual(new Date('2026-01-16T00:00:00Z'));
  });

  it('advances a week for weekly', () => {
    expect(computeNextRunAt('weekly', from)).toEqual(new Date('2026-01-22T00:00:00Z'));
  });

  it('advances a month for monthly', () => {
    expect(computeNextRunAt('monthly', from)).toEqual(new Date('2026-02-15T00:00:00Z'));
  });
});

describe('createSchedule', () => {
  it('creates a schedule for a completed report with nextRunAt one cadence out', async () => {
    mockGetReport.mockResolvedValue({ id: 'r1', status: 'completed' });
    mockPrisma.scheduledReport.create.mockResolvedValue({ id: 's1' });

    const result = await createSchedule(USER_ID, 'r1', { cadence: 'daily', recipientEmails: ['a@example.com'] });

    expect(result).toEqual({ id: 's1' });
    expect(mockPrisma.scheduledReport.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reportId: 'r1',
        organizationId: ORG_ID,
        userId: USER_ID,
        cadence: 'daily',
        format: 'xlsx',
        templateId: null,
        recipientEmails: ['a@example.com'],
        nextRunAt: expect.any(Date),
      }),
    });
  });

  it('throws ConflictError when the report is not completed (e.g. still a draft)', async () => {
    mockGetReport.mockResolvedValue({ id: 'r1', status: 'draft' });

    await expect(createSchedule(USER_ID, 'r1', { cadence: 'daily' })).rejects.toBeInstanceOf(ConflictError);
    expect(mockPrisma.scheduledReport.create).not.toHaveBeenCalled();
  });

  it('propagates NotFoundError from getReport for a missing/invisible report', async () => {
    mockGetReport.mockRejectedValue(new NotFoundError());

    await expect(createSchedule(USER_ID, 'missing', { cadence: 'daily' })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('listSchedules', () => {
  it("lists the org's schedules, newest first", async () => {
    const schedules = [{ id: 's1' }, { id: 's2' }];
    mockPrisma.scheduledReport.findMany.mockResolvedValue(schedules);

    const result = await listSchedules(USER_ID);

    expect(result).toBe(schedules);
    expect(mockPrisma.scheduledReport.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID },
      orderBy: { createdAt: 'desc' },
    });
  });
});

describe('updateSchedule', () => {
  it('updates the given fields, scoped to the org', async () => {
    mockPrisma.scheduledReport.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.scheduledReport.findFirst.mockResolvedValue({ id: 's1', isActive: false });

    const result = await updateSchedule(USER_ID, 's1', { isActive: false });

    expect(result).toEqual({ id: 's1', isActive: false });
    expect(mockPrisma.scheduledReport.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', organizationId: ORG_ID },
      data: { isActive: false },
    });
  });

  it('recomputes nextRunAt when cadence changes', async () => {
    mockPrisma.scheduledReport.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.scheduledReport.findFirst.mockResolvedValue({ id: 's1' });

    await updateSchedule(USER_ID, 's1', { cadence: 'weekly' });

    expect(mockPrisma.scheduledReport.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', organizationId: ORG_ID },
      data: { cadence: 'weekly', nextRunAt: expect.any(Date) },
    });
  });

  it('throws NotFoundError when not found or not in the org', async () => {
    mockPrisma.scheduledReport.updateMany.mockResolvedValue({ count: 0 });

    await expect(updateSchedule(USER_ID, 'missing', { isActive: false })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('deleteSchedule', () => {
  it('deletes a schedule scoped to the org', async () => {
    mockPrisma.scheduledReport.deleteMany.mockResolvedValue({ count: 1 });

    await expect(deleteSchedule(USER_ID, 's1')).resolves.toBeUndefined();
    expect(mockPrisma.scheduledReport.deleteMany).toHaveBeenCalledWith({ where: { id: 's1', organizationId: ORG_ID } });
  });

  it('throws NotFoundError when not found or not in the org', async () => {
    mockPrisma.scheduledReport.deleteMany.mockResolvedValue({ count: 0 });

    await expect(deleteSchedule(USER_ID, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});
