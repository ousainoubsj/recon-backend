import { jest } from '@jest/globals';

const mockTx = {
  organization: { create: jest.fn(), update: jest.fn() },
  invitation: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn() },
  platformAdminCompany: { create: jest.fn(), createMany: jest.fn(), deleteMany: jest.fn() },
  member: { create: jest.fn(), deleteMany: jest.fn() },
  session: { updateMany: jest.fn(), deleteMany: jest.fn() },
  user: { update: jest.fn() },
};
const mockPrisma = {
  organization: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn() },
  user: { findFirst: jest.fn(), findUnique: jest.fn(), create: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  member: { findFirst: jest.fn(), deleteMany: jest.fn() },
  session: { updateMany: jest.fn() },
  account: { count: jest.fn() },
  platformAdminCompany: { findMany: jest.fn() },
  auditLog: { create: jest.fn().mockResolvedValue({}) },
  $transaction: jest.fn((arg) => (typeof arg === 'function' ? arg(mockTx) : Promise.all(arg))),
};
jest.unstable_mockModule('../../config/prisma.config.js', () => ({ prisma: mockPrisma }));

const mockSendOrgInvitationEmail = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/emailService.js', () => ({ sendOrgInvitationEmail: mockSendOrgInvitationEmail }));

const mockRequestPasswordReset = jest.fn().mockResolvedValue({});
jest.unstable_mockModule('../../auth.js', () => ({ auth: { api: { requestPasswordReset: mockRequestPasswordReset } } }));

const platform = await import('../../services/platformService.js');
const { ConflictError, NotFoundError, ValidationError } = await import('../../errors.js');

const OWNER = { id: 'owner-1', platformRole: 'owner', name: 'Owner', email: 'owner@recon-cil.com' };
const ADMIN = { id: 'admin-1', platformRole: 'admin', name: 'Awa', email: 'awa@recon-cil.com' };
const COMPANY_ROW = {
  id: 'org-a',
  name: 'Atlantic',
  slug: 'co-1',
  status: 'active',
  createdAt: new Date(),
  suspendedAt: null,
  _count: { members: 3, reports: 9 },
};

beforeEach(() => jest.clearAllMocks());

describe('company access (cross-tenant first)', () => {
  it('scopes an admin to assigned companies and 404s every company action on an unassigned one', async () => {
    mockPrisma.organization.findFirst.mockResolvedValue(null);

    for (const action of [
      () => platform.getCompany(ADMIN, 'org-b'),
      () => platform.updateCompany(ADMIN, 'org-b', { name: 'x' }),
      () => platform.setCompanyStatus(ADMIN, 'org-b', 'suspended'),
      () => platform.inviteCompanyUser(ADMIN, 'org-b', { email: 'a@b.co', role: 'viewer' }),
      () => platform.enterCompany(ADMIN, 'org-b'),
    ]) {
      await expect(action()).rejects.toBeInstanceOf(NotFoundError);
    }
    for (const [query] of mockPrisma.organization.findFirst.mock.calls) {
      expect(query.where).toEqual({ AND: [{ id: 'org-b' }, { platformAdmins: { some: { userId: ADMIN.id } } }] });
    }
    expect(mockTx.member.create).not.toHaveBeenCalled();
    expect(mockTx.organization.update).not.toHaveBeenCalled();
  });

  it('lists only assigned companies for an admin (zero assignments returns none), all for the owner', async () => {
    mockPrisma.organization.findMany.mockResolvedValue([]);
    mockPrisma.organization.count.mockResolvedValue(0);

    await platform.listCompanies(ADMIN, {});
    await platform.listCompanies(OWNER, { q: 'atl', status: 'active' });

    expect(mockPrisma.organization.findMany.mock.calls[0][0].where).toEqual({ AND: [{ platformAdmins: { some: { userId: ADMIN.id } } }] });
    expect(mockPrisma.organization.findMany.mock.calls[1][0].where).toEqual({
      AND: [
        {},
        { OR: [{ name: { contains: 'atl', mode: 'insensitive' } }, { slug: { contains: 'atl', mode: 'insensitive' } }] },
        { status: 'active' },
      ],
    });
  });

  it('counts members without support members', async () => {
    mockPrisma.organization.findMany.mockResolvedValue([COMPANY_ROW]);
    mockPrisma.organization.count.mockResolvedValue(1);

    const page = await platform.listCompanies(OWNER, {});

    expect(mockPrisma.organization.findMany.mock.calls[0][0].select._count).toEqual({
      select: { members: { where: { isSupport: false } }, reports: true },
    });
    expect(page.items[0]).toMatchObject({ id: 'org-a', memberCount: 3, reportCount: 9 });
  });
});

describe('createCompany', () => {
  beforeEach(() => {
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockTx.organization.create.mockResolvedValue(COMPANY_ROW);
    mockTx.invitation.findFirst.mockResolvedValue(null);
    mockTx.invitation.create.mockImplementation(async ({ data }) => data);
  });

  it('creates the company and its first-admin invitation, and assigns it to an admin creator', async () => {
    const company = await platform.createCompany(ADMIN, { name: ' Atlantic ', firstAdminEmail: 'Lead@Atlantic.com' });

    expect(mockTx.invitation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: 'org-a', email: 'lead@atlantic.com', role: 'admin', inviterId: ADMIN.id }),
    });
    expect(mockTx.platformAdminCompany.create).toHaveBeenCalledWith({
      data: { userId: ADMIN.id, organizationId: 'org-a', assignedBy: ADMIN.id },
    });
    expect(mockSendOrgInvitationEmail).toHaveBeenCalledTimes(1);
    expect(company).toMatchObject({ id: 'org-a', memberCount: 3 });
  });

  it('does not assign the owner (they see every company) and keeps the company when the email fails', async () => {
    mockSendOrgInvitationEmail.mockRejectedValueOnce(new Error('resend down'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(platform.createCompany(OWNER, { name: 'X', firstAdminEmail: 'a@b.co' })).resolves.toMatchObject({ id: 'org-a' });
    expect(mockTx.platformAdminCompany.create).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('refuses a platform admin as the first admin', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'staff' });

    await expect(platform.createCompany(OWNER, { name: 'X', firstAdminEmail: 'awa@recon-cil.com' })).rejects.toBeInstanceOf(ConflictError);
    expect(mockTx.organization.create).not.toHaveBeenCalled();
  });
});

describe('setCompanyStatus', () => {
  it('suspends, signing out only non-support members, in one transaction', async () => {
    mockPrisma.organization.findFirst.mockResolvedValue({ id: 'org-a', status: 'active' });
    mockTx.organization.update.mockResolvedValue({ ...COMPANY_ROW, status: 'suspended' });

    await platform.setCompanyStatus(OWNER, 'org-a', 'suspended');

    expect(mockTx.session.deleteMany).toHaveBeenCalledWith({
      where: { user: { members: { some: { organizationId: 'org-a', isSupport: false } } } },
    });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: 'org-a', action: 'platform.company.suspend', userId: OWNER.id }),
    });
  });

  it('409s a no-op status change', async () => {
    mockPrisma.organization.findFirst.mockResolvedValue({ id: 'org-a', status: 'suspended' });

    await expect(platform.setCompanyStatus(OWNER, 'org-a', 'suspended')).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('inviteCompanyUser', () => {
  beforeEach(() => {
    mockPrisma.organization.findFirst.mockResolvedValue({ id: 'org-a', name: 'Atlantic' });
    mockPrisma.user.findFirst.mockResolvedValue(null);
    mockPrisma.member.findFirst.mockResolvedValue(null);
    mockTx.invitation.update.mockImplementation(async ({ data }) => ({ id: 'inv-1', email: 'a@b.co', ...data }));
  });

  it('re-sends an existing pending invitation instead of creating a duplicate', async () => {
    mockTx.invitation.findFirst.mockResolvedValue({ id: 'inv-1' });

    await platform.inviteCompanyUser(ADMIN, 'org-a', { email: 'A@b.co', role: 'analyst' });

    expect(mockTx.invitation.create).not.toHaveBeenCalled();
    expect(mockTx.invitation.update).toHaveBeenCalledWith({
      where: { id: 'inv-1' },
      data: expect.objectContaining({ role: 'analyst', inviterId: ADMIN.id }),
    });
    expect(mockSendOrgInvitationEmail).toHaveBeenCalledTimes(1);
  });

  it('409s an existing member', async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ id: 'm1' });

    await expect(platform.inviteCompanyUser(ADMIN, 'org-a', { email: 'a@b.co', role: 'viewer' })).rejects.toBeInstanceOf(ConflictError);
  });
});

describe('enterCompany / exitCompany', () => {
  it('replaces any other support membership and points every session at the company, in one transaction', async () => {
    mockPrisma.organization.findFirst.mockResolvedValue({ id: 'org-a', name: 'Atlantic' });

    const result = await platform.enterCompany(ADMIN, 'org-a');

    expect(result).toEqual({ organizationId: 'org-a', name: 'Atlantic' });
    expect(mockTx.member.deleteMany).toHaveBeenCalledWith({ where: { userId: ADMIN.id, isSupport: true } });
    expect(mockTx.member.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: 'org-a', userId: ADMIN.id, role: 'admin', status: 'active', isSupport: true }),
    });
    expect(mockTx.session.updateMany).toHaveBeenCalledWith({ where: { userId: ADMIN.id }, data: { activeOrganizationId: 'org-a' } });
  });

  it('exit removes only support memberships', async () => {
    await platform.exitCompany(ADMIN.id);

    expect(mockPrisma.member.deleteMany).toHaveBeenCalledWith({ where: { userId: ADMIN.id, isSupport: true } });
    expect(mockPrisma.session.updateMany).toHaveBeenCalledWith({ where: { userId: ADMIN.id }, data: { activeOrganizationId: null } });
  });
});

describe('platform admin management', () => {
  it('never targets yourself, the owner or a removed admin (404)', async () => {
    await expect(platform.setPlatformAdminStatus(OWNER, OWNER.id, 'suspended')).rejects.toBeInstanceOf(NotFoundError);

    mockPrisma.user.findFirst.mockResolvedValue(null);
    await expect(platform.setPlatformAdminStatus(OWNER, 'someone', 'removed')).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'someone', platformRole: 'admin', platformStatus: { not: 'removed' } } }),
    );
  });

  it('remove keeps the user row and clears sessions, support membership and assignments', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'admin-1', name: 'Awa', email: 'awa@recon-cil.com', platformStatus: 'active' });

    await platform.setPlatformAdminStatus(OWNER, 'admin-1', 'removed');

    expect(mockTx.user.update).toHaveBeenCalledWith({ where: { id: 'admin-1' }, data: { platformStatus: 'removed' } });
    expect(mockTx.session.deleteMany).toHaveBeenCalledWith({ where: { userId: 'admin-1' } });
    expect(mockTx.member.deleteMany).toHaveBeenCalledWith({ where: { userId: 'admin-1', isSupport: true } });
    expect(mockTx.platformAdminCompany.deleteMany).toHaveBeenCalledWith({ where: { userId: 'admin-1' } });
    expect(mockPrisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: null, action: 'platform.admin.remove' }),
    });
  });

  it('suspend keeps company assignments', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'admin-1', name: 'Awa', email: 'awa@recon-cil.com', platformStatus: 'active' });

    await platform.setPlatformAdminStatus(OWNER, 'admin-1', 'suspended');

    expect(mockTx.session.deleteMany).toHaveBeenCalled();
    expect(mockTx.platformAdminCompany.deleteMany).not.toHaveBeenCalled();
  });

  it('rewrites assignments and ends a support session in a company no longer assigned', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'admin-1', name: 'Awa', email: 'awa@recon-cil.com', platformStatus: 'active' });
    mockPrisma.organization.count.mockResolvedValue(1);

    await platform.setAdminCompanies(OWNER, 'admin-1', ['org-a', 'org-a']);

    expect(mockTx.platformAdminCompany.createMany).toHaveBeenCalledWith({
      data: [{ userId: 'admin-1', organizationId: 'org-a', assignedBy: OWNER.id }],
    });
    expect(mockTx.member.deleteMany).toHaveBeenCalledWith({ where: { userId: 'admin-1', isSupport: true, organizationId: { notIn: ['org-a'] } } });
  });

  it('allows an empty assignment list (no access) and 422s unknown companies', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ id: 'admin-1', name: 'Awa', email: 'awa@recon-cil.com', platformStatus: 'active' });
    mockPrisma.organization.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await expect(platform.setAdminCompanies(OWNER, 'admin-1', [])).resolves.toEqual({ organizationIds: [] });
    await expect(platform.setAdminCompanies(OWNER, 'admin-1', ['org-a', 'org-x'])).rejects.toBeInstanceOf(ValidationError);
  });

  it('invites an admin with no org and a verified email, then triggers the set-password email', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({ id: 'new-admin' });

    await platform.invitePlatformAdmin(OWNER, { name: ' Lamin ', email: 'Lamin@Recon-cil.com' });

    expect(mockPrisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: 'lamin@recon-cil.com', name: 'Lamin', emailVerified: true, platformRole: 'admin', platformStatus: 'active' }),
      select: { id: true },
    });
    expect(mockRequestPasswordReset).toHaveBeenCalledWith({ body: expect.objectContaining({ email: 'lamin@recon-cil.com' }) });
  });

  it('409s inviting an email that already has an account', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: 'customer' });

    await expect(platform.invitePlatformAdmin(OWNER, { name: 'X', email: 'x@y.co' })).rejects.toBeInstanceOf(ConflictError);
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });
});

describe('signInBlockReason', () => {
  it.each([
    [{ platformRole: 'admin', platformStatus: 'suspended', members: [] }, 'Platform access has been revoked'],
    [{ platformRole: 'admin', platformStatus: 'removed', members: [] }, 'Platform access has been revoked'],
    [{ platformRole: null, platformStatus: null, members: [{ organization: { status: 'suspended' } }] }, "Your company's account has been suspended"],
    [{ platformRole: 'admin', platformStatus: 'active', members: [] }, null],
    [{ platformRole: null, platformStatus: null, members: [{ organization: { status: 'active' } }] }, null],
  ])('%o → %s', async (user, expected) => {
    mockPrisma.user.findUnique.mockResolvedValue(user);

    await expect(platform.signInBlockReason('u1')).resolves.toBe(expected);
    expect(mockPrisma.user.findUnique.mock.calls[0][0].select.members.where).toEqual({ isSupport: false });
  });
});
