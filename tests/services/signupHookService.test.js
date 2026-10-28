import { jest } from '@jest/globals';
import { handleUserCreated, hasOrganization, usableInvitationEmail } from '../../services/signupHookService.js';

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

describe('hasOrganization', () => {
  it.each([
    [0, false],
    [1, true],
  ])('with %i memberships returns %s', async (count, expected) => {
    const prisma = { member: { count: jest.fn().mockResolvedValue(count) } };

    await expect(hasOrganization('user-1', { prisma })).resolves.toBe(expected);
    expect(prisma.member.count).toHaveBeenCalledWith({ where: { userId: 'user-1' } });
  });
});
