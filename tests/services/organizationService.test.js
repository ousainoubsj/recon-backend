import { jest } from '@jest/globals';

const mockPrisma = {
  member: { findFirst: jest.fn() },
};

jest.unstable_mockModule('../../db/index.js', () => ({ prisma: mockPrisma }));

const { getUserMembership } = await import('../../services/organizationService.js');
const { NotFoundError } = await import('../../errors.js');

beforeEach(() => jest.clearAllMocks());

describe('getUserMembership', () => {
  it('returns the organizationId and role for the membership', async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });

    const result = await getUserMembership('user-1');

    expect(result).toEqual({ organizationId: 'org-1', role: 'admin' });
    expect(mockPrisma.member.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      select: { organizationId: true, role: true },
    });
  });

  it('throws NotFoundError when the user has no organization membership', async () => {
    mockPrisma.member.findFirst.mockResolvedValue(null);

    await expect(getUserMembership('user-1')).rejects.toBeInstanceOf(NotFoundError);
  });
});
