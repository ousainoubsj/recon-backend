import { jest } from '@jest/globals';
import { handleUserCreated, releaseEmptyPersonalOrganization, usableInvitationEmail } from '../../services/signupHookService.js';

const user = { id: 'user-1', email: 'new@example.com' };

function makeDeps({ pendingInvite = null, createOrganization = jest.fn() } = {}) {
  return {
    prisma: { invitation: { findFirst: jest.fn().mockResolvedValue(pendingInvite) } },
    createOrganization,
  };
}

describe('handleUserCreated', () => {
  it('does not create an organization when a pending invitation exists for the email', async () => {
    const createOrganization = jest.fn();
    const deps = makeDeps({ pendingInvite: { id: 'invite-1' }, createOrganization });

    await handleUserCreated(user, deps);

    expect(deps.prisma.invitation.findFirst).toHaveBeenCalledWith({
      where: { email: user.email, status: 'pending', expiresAt: { gt: expect.any(Date) } },
    });
    expect(createOrganization).not.toHaveBeenCalled();
  });

  it('never creates an organization for a platform admin', async () => {
    const createOrganization = jest.fn();
    const deps = makeDeps({ createOrganization });

    await handleUserCreated({ ...user, platformRole: 'admin' }, deps);

    expect(deps.prisma.invitation.findFirst).not.toHaveBeenCalled();
    expect(createOrganization).not.toHaveBeenCalled();
  });

  it('creates an organization for the new user when there is no pending invitation', async () => {
    const createOrganization = jest.fn().mockResolvedValue({});
    const deps = makeDeps({ pendingInvite: null, createOrganization });

    await handleUserCreated(user, deps);

    expect(createOrganization).toHaveBeenCalledWith({
      body: {
        name: `${user.email}'s organization`,
        slug: `org-${user.id}`,
        userId: user.id,
      },
    });
  });

  it('swallows and logs an error instead of throwing if org creation fails', async () => {
    const createOrganization = jest.fn().mockRejectedValue(new Error('boom'));
    const deps = makeDeps({ pendingInvite: null, createOrganization });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handleUserCreated(user, deps)).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });
});

describe('usableInvitationEmail', () => {
  it('returns the address of a pending, unexpired invitation', async () => {
    const prisma = { invitation: { findFirst: jest.fn().mockResolvedValue({ email: 'invitee@example.com' }) } };

    await expect(usableInvitationEmail('inv-1', { prisma })).resolves.toBe('invitee@example.com');
    expect(prisma.invitation.findFirst).toHaveBeenCalledWith({
      where: { id: 'inv-1', status: 'pending', expiresAt: { gt: expect.any(Date) } },
      select: { email: true },
    });
  });

  it('returns null when the invitation is unusable', async () => {
    const prisma = { invitation: { findFirst: jest.fn().mockResolvedValue(null) } };

    await expect(usableInvitationEmail('inv-1', { prisma })).resolves.toBeNull();
  });
});

describe('releaseEmptyPersonalOrganization', () => {
  const joiner = { id: 'user-1' };
  const invitation = { organizationId: 'org-joining' };
  const personalOrg = { id: 'org-personal', name: "a@example.com's organization", slug: 'org-user-1' };

  function makePrisma({ memberships = [], deleted = 1 } = {}) {
    return {
      member: { findMany: jest.fn().mockResolvedValue(memberships) },
      organization: { deleteMany: jest.fn().mockResolvedValue({ count: deleted }) },
      auditLog: { create: jest.fn().mockResolvedValue({}) },
    };
  }

  it('refuses a platform admin without touching their memberships', async () => {
    const prisma = makePrisma();

    await expect(releaseEmptyPersonalOrganization({ id: 'admin-1', platformRole: 'admin' }, invitation, { prisma })).resolves.toBe(false);
    expect(prisma.member.findMany).not.toHaveBeenCalled();
  });

  it('lets a user with no org join without deleting anything', async () => {
    const prisma = makePrisma();

    await expect(releaseEmptyPersonalOrganization(joiner, invitation, { prisma })).resolves.toBe(true);
    expect(prisma.organization.deleteMany).not.toHaveBeenCalled();
  });

  it('deletes an empty personal org only under the emptiness conditions, and audits it against the joined org', async () => {
    const prisma = makePrisma({ memberships: [{ organization: personalOrg }] });

    await expect(releaseEmptyPersonalOrganization(joiner, invitation, { prisma })).resolves.toBe(true);
    expect(prisma.organization.deleteMany).toHaveBeenCalledWith({
      where: {
        id: 'org-personal',
        members: { every: { userId: 'user-1' } },
        reports: { none: {} },
        reportTemplates: { none: {} },
        matchRuleTemplates: { none: {} },
        reportExports: { none: {} },
        invitations: { none: { status: 'pending' } },
      },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        organizationId: 'org-joining',
        action: 'organization.personal.replace',
        entityId: 'org-personal',
        metadata: { replacedOrganizationName: personalOrg.name },
      }),
    });
  });

  it('refuses when the personal org holds anything (the guarded delete matches nothing)', async () => {
    const prisma = makePrisma({ memberships: [{ organization: personalOrg }], deleted: 0 });

    await expect(releaseEmptyPersonalOrganization(joiner, invitation, { prisma })).resolves.toBe(false);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('refuses for an org that is not their auto-created one, without deleting', async () => {
    const prisma = makePrisma({ memberships: [{ organization: { ...personalOrg, slug: 'acme' } }] });

    await expect(releaseEmptyPersonalOrganization(joiner, invitation, { prisma })).resolves.toBe(false);
    expect(prisma.organization.deleteMany).not.toHaveBeenCalled();
  });

  it('refuses for a user already in more than one org', async () => {
    const prisma = makePrisma({ memberships: [{ organization: personalOrg }, { organization: { id: 'o2', slug: 'x' } }] });

    await expect(releaseEmptyPersonalOrganization(joiner, invitation, { prisma })).resolves.toBe(false);
    expect(prisma.organization.deleteMany).not.toHaveBeenCalled();
  });
});
