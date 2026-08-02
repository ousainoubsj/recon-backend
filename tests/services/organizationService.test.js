import { jest } from '@jest/globals';

const mockPrisma = {
  member: { findFirst: jest.fn(), updateMany: jest.fn() },
};

jest.unstable_mockModule('../../config/prisma.config.js', () => ({ prisma: mockPrisma }));

const { getUserMembership, touchLastActive } = await import('../../services/organizationService.js');
const { NotFoundError } = await import('../../errors.js');

beforeEach(() => jest.clearAllMocks());

describe('getUserMembership', () => {
  it('returns the organizationId, role, and status for the membership', async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: 'org-1', role: 'admin', status: 'active' });

    const result = await getUserMembership('user-1');

    expect(result).toEqual({ organizationId: 'org-1', role: 'admin', status: 'active' });
    expect(mockPrisma.member.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      select: { organizationId: true, role: true, status: true },
    });
  });

  it('throws NotFoundError when the user has no organization membership', async () => {
    mockPrisma.member.findFirst.mockResolvedValue(null);

    await expect(getUserMembership('user-1')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('touchLastActive', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-23T12:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('updates lastActiveAt for rows that are null or stale', async () => {
    mockPrisma.member.updateMany.mockResolvedValue({ count: 1 });

    await touchLastActive('user-1');

    expect(mockPrisma.member.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: new Date('2026-07-23T11:55:00Z') } }],
      },
      data: { lastActiveAt: new Date('2026-07-23T12:00:00Z') },
    });
  });

  it('is best-effort — swallows and logs the error instead of throwing', async () => {
    mockPrisma.member.updateMany.mockRejectedValue(new Error('db unavailable'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(touchLastActive('user-1')).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });
});
