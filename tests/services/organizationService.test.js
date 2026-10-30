import { jest } from '@jest/globals';

const mockPrisma = {
  member: { findFirst: jest.fn(), updateMany: jest.fn() },
  user: { findUnique: jest.fn() },
};

jest.unstable_mockModule('../../config/prisma.config.js', () => ({ prisma: mockPrisma }));

const mockCreatePersonalOrganization = jest.fn();
jest.unstable_mockModule('../../services/signupHookService.js', () => ({
  createPersonalOrganizationIfUninvited: mockCreatePersonalOrganization,
}));

const mockCreateOrganization = jest.fn();
jest.unstable_mockModule('../../auth.js', () => ({ auth: { api: { createOrganization: mockCreateOrganization } } }));

const { getUserMembership, touchLastActive } = await import('../../services/organizationService.js');
const { AccessBlockedError, NotFoundError } = await import('../../errors.js');

beforeEach(() => jest.clearAllMocks());

describe('getUserMembership', () => {
  it('returns the organizationId, role, and status for the membership', async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: 'org-1', role: 'admin', status: 'active' });

    const result = await getUserMembership('user-1');

    expect(result).toEqual({ organizationId: 'org-1', role: 'admin', status: 'active' });
    expect(mockPrisma.member.findFirst).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      select: { organizationId: true, role: true, status: true, isSupport: true, organization: { select: { status: true } } },
    });
  });

  it('creates the missing personal org and returns its membership', async () => {
    const membership = { organizationId: 'org-new', role: 'admin', status: 'active' };
    mockPrisma.member.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(membership);
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'a@example.com' });

    await expect(getUserMembership('user-1')).resolves.toEqual(membership);
    expect(mockCreatePersonalOrganization).toHaveBeenCalledWith(
      { id: 'user-1', email: 'a@example.com' },
      expect.objectContaining({ createOrganization: mockCreateOrganization }),
    );
  });

  it('throws NotFoundError when a usable invitation means no org is created', async () => {
    mockPrisma.member.findFirst.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'a@example.com' });

    await expect(getUserMembership('user-1')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns the membership a concurrent request created when its own creation fails', async () => {
    const membership = { organizationId: 'org-new', role: 'admin', status: 'active' };
    mockPrisma.member.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(membership);
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'user-1', email: 'a@example.com' });
    mockCreatePersonalOrganization.mockRejectedValueOnce(new Error('Organization already exists'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(getUserMembership('user-1')).resolves.toEqual(membership);

    consoleError.mockRestore();
  });

  it('throws NotFoundError for an unknown user without trying to create an org', async () => {
    mockPrisma.member.findFirst.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue(null);

    await expect(getUserMembership('user-1')).rejects.toBeInstanceOf(NotFoundError);
    expect(mockCreatePersonalOrganization).not.toHaveBeenCalled();
  });
});

describe('getUserMembership — platform rules', () => {
  it("refuses a member of a suspended company", async () => {
    mockPrisma.member.findFirst.mockResolvedValue({
      organizationId: 'org-1', role: 'admin', status: 'active', isSupport: false, organization: { status: 'suspended' },
    });

    await expect(getUserMembership('user-1')).rejects.toBeInstanceOf(AccessBlockedError);
  });

  it('lets a support member into a suspended company', async () => {
    mockPrisma.member.findFirst.mockResolvedValue({
      organizationId: 'org-1', role: 'admin', status: 'active', isSupport: true, organization: { status: 'suspended' },
    });

    await expect(getUserMembership('admin-1')).resolves.toEqual({ organizationId: 'org-1', role: 'admin', status: 'active' });
  });

  it('never creates a personal org for a platform admin outside any company', async () => {
    mockPrisma.member.findFirst.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'admin-1', email: 'a@recon-cil.com', platformRole: 'admin' });

    await expect(getUserMembership('admin-1')).rejects.toThrow('Select a company to act on');
    expect(mockCreatePersonalOrganization).not.toHaveBeenCalled();
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
