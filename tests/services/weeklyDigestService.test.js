import { jest } from '@jest/globals';

const mockPrisma = {
  organization: { findMany: jest.fn() },
  member: { findMany: jest.fn() },
};

jest.unstable_mockModule('../../config/prisma.config.js', () => ({ prisma: mockPrisma }));

const mockGetWeeklyDigestStats = jest.fn();
jest.unstable_mockModule('../../services/reportService.js', () => ({
  getWeeklyDigestStats: mockGetWeeklyDigestStats,
}));

const mockSendWeeklyDigestEmail = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/emailService.js', () => ({
  sendWeeklyDigestEmail: mockSendWeeklyDigestEmail,
}));

const mockCreateNotification = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/notificationService.js', () => ({
  createNotification: mockCreateNotification,
}));

const { sendWeeklyDigests } = await import('../../services/weeklyDigestService.js');

const ACTIVE_STATS = {
  current: { count: 5, avgMatchRate: 92.5, unmatchedTransactions: 3, totalBreakValue: 120 },
  prior: { count: 4, avgMatchRate: 88, unmatchedTransactions: 2, totalBreakValue: 90 },
  weekStart: new Date('2026-07-27'),
  weekEnd: new Date('2026-08-03'),
};

const EMPTY_STATS = {
  current: { count: 0, avgMatchRate: 0, unmatchedTransactions: 0, totalBreakValue: 0 },
  prior: { count: 0, avgMatchRate: 0, unmatchedTransactions: 0, totalBreakValue: 0 },
  weekStart: new Date('2026-07-27'),
  weekEnd: new Date('2026-08-03'),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('sendWeeklyDigests', () => {
  it('only processes orgs with weeklyDigestEnabled on, and only emails/notifies active admins in them', async () => {
    mockPrisma.organization.findMany.mockResolvedValue([{ id: 'org-1', name: 'Datafin' }]);
    mockGetWeeklyDigestStats.mockResolvedValue(ACTIVE_STATS);
    mockPrisma.member.findMany.mockResolvedValue([
      { user: { id: 'admin-1', email: 'admin1@x.com', name: 'Admin One' } },
      { user: { id: 'admin-2', email: 'admin2@x.com', name: 'Admin Two' } },
    ]);

    await sendWeeklyDigests();

    expect(mockPrisma.organization.findMany).toHaveBeenCalledWith({
      where: { weeklyDigestEnabled: true },
      select: { id: true, name: true },
    });
    expect(mockPrisma.member.findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', role: 'admin', status: 'active' },
      select: { user: { select: { id: true, email: true, name: true } } },
    });
    expect(mockSendWeeklyDigestEmail).toHaveBeenCalledTimes(2);
    expect(mockSendWeeklyDigestEmail).toHaveBeenCalledWith(
      { id: 'admin-1', email: 'admin1@x.com', name: 'Admin One' },
      'Datafin',
      ACTIVE_STATS,
    );
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      'admin-1',
      expect.objectContaining({ type: 'organization.weekly_digest_sent', entityType: 'organization', entityId: 'org-1' }),
    );
  });

  it('skips an org entirely (no email/notification to anyone) when it had zero completed reports this week', async () => {
    mockPrisma.organization.findMany.mockResolvedValue([{ id: 'org-1', name: 'Datafin' }]);
    mockGetWeeklyDigestStats.mockResolvedValue(EMPTY_STATS);

    await sendWeeklyDigests();

    expect(mockPrisma.member.findMany).not.toHaveBeenCalled();
    expect(mockSendWeeklyDigestEmail).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("one recipient's send failure doesn't stop the rest of that org's admins or other orgs", async () => {
    mockPrisma.organization.findMany.mockResolvedValue([
      { id: 'org-1', name: 'Datafin' },
      { id: 'org-2', name: 'Other Co' },
    ]);
    mockGetWeeklyDigestStats.mockResolvedValue(ACTIVE_STATS);
    mockPrisma.member.findMany.mockImplementation(async ({ where }) =>
      where.organizationId === 'org-1'
        ? [
            { user: { id: 'admin-1', email: 'admin1@x.com', name: 'Admin One' } },
            { user: { id: 'admin-2', email: 'admin2@x.com', name: 'Admin Two' } },
          ]
        : [{ user: { id: 'admin-3', email: 'admin3@x.com', name: 'Admin Three' } }],
    );
    mockSendWeeklyDigestEmail.mockImplementation(async (user) => {
      if (user.id === 'admin-1') throw new Error('Resend down');
    });

    await sendWeeklyDigests();

    expect(mockSendWeeklyDigestEmail).toHaveBeenCalledTimes(3);
    // admin-1's failure doesn't stop admin-2 (same org) or admin-3 (next org)
    expect(mockCreateNotification).toHaveBeenCalledTimes(2);
    expect(mockCreateNotification).not.toHaveBeenCalledWith('admin-1', expect.anything());
  });
});
