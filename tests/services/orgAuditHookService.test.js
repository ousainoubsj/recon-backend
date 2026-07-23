import { jest } from '@jest/globals';
import { auditOrgAction } from '../../services/orgAuditHookService.js';

function makeDeps({ session = { user: { id: 'user-1', name: 'User One' } }, member, user } = {}) {
  return {
    getSession: jest.fn().mockResolvedValue(session),
    logAuditSafely: jest.fn().mockResolvedValue(undefined),
    createNotification: jest.fn().mockResolvedValue(undefined),
    prisma: {
      member: { findUnique: jest.fn().mockResolvedValue(member) },
      user: { findUnique: jest.fn().mockResolvedValue(user) },
    },
  };
}

describe('auditOrgAction', () => {
  it('logs a mapped, successful org action against the resolved session user', async () => {
    const deps = makeDeps();
    const ctx = {
      path: '/organization/invite-member',
      body: { email: 'invitee@example.com', role: 'analyst' },
      headers: { some: 'headers' },
      context: { returned: { id: 'invite-1', email: 'invitee@example.com' } },
    };

    await auditOrgAction(ctx, deps);

    expect(deps.getSession).toHaveBeenCalledWith({ headers: ctx.headers });
    expect(deps.logAuditSafely).toHaveBeenCalledWith('user-1', {
      action: 'organization.member.invite',
      entityType: 'organization',
      status: 'success',
      ip: null,
      metadata: ctx.body,
    });
  });

  it.each([
    ['/organization/remove-member', 'organization.member.remove', 'warning'],
    ['/organization/update-member-role', 'organization.member.role_update', 'warning'],
    ['/organization/accept-invitation', 'organization.invitation.accept', 'success'],
    ['/organization/cancel-invitation', 'organization.invitation.cancel', 'success'],
    ['/organization/update', 'organization.update', 'success'],
    ['/organization/delete', 'organization.delete', 'warning'],
  ])('maps %s to action %s with status %s', async (path, expectedAction, expectedStatus) => {
    const deps = makeDeps();
    await auditOrgAction({ path, body: {}, headers: {}, context: { returned: {} } }, deps);

    expect(deps.logAuditSafely).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ action: expectedAction, status: expectedStatus }),
    );
  });

  it('does nothing for an unmapped path', async () => {
    const deps = makeDeps();

    await auditOrgAction(
      { path: '/organization/create', body: {}, headers: {}, context: { returned: {} } },
      deps,
    );

    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.logAuditSafely).not.toHaveBeenCalled();
  });

  it('does not log when the action failed (APIError returned)', async () => {
    const deps = makeDeps();
    const ctx = {
      path: '/organization/invite-member',
      body: {},
      headers: {},
      context: { returned: { name: 'APIError', statusCode: 400 } },
    };

    await auditOrgAction(ctx, deps);

    expect(deps.getSession).not.toHaveBeenCalled();
    expect(deps.logAuditSafely).not.toHaveBeenCalled();
  });

  it('does nothing when the session cannot be resolved', async () => {
    const deps = makeDeps({ session: null });
    const ctx = {
      path: '/organization/invite-member',
      body: {},
      headers: {},
      context: { returned: {} },
    };

    await auditOrgAction(ctx, deps);

    expect(deps.logAuditSafely).not.toHaveBeenCalled();
  });

  it('does nothing when resolving the session throws', async () => {
    const deps = makeDeps();
    deps.getSession.mockRejectedValue(new Error('boom'));
    const ctx = {
      path: '/organization/invite-member',
      body: {},
      headers: {},
      context: { returned: {} },
    };

    await expect(auditOrgAction(ctx, deps)).resolves.toBeUndefined();
    expect(deps.logAuditSafely).not.toHaveBeenCalled();
  });

  describe('login actions', () => {
    it.each([
      ['/sign-in/email', 'email'],
      ['/callback/google', 'google'],
      ['/callback/apple', 'apple'],
    ])('logs %s as auth.login without re-fetching the session', async (path, method) => {
      const deps = makeDeps();
      const ctx = {
        path,
        body: {},
        headers: {},
        context: { returned: { user: { id: 'user-1', name: 'User One' }, session: {} } },
      };

      await auditOrgAction(ctx, deps);

      expect(deps.getSession).not.toHaveBeenCalled();
      expect(deps.logAuditSafely).toHaveBeenCalledWith('user-1', {
        action: 'auth.login',
        entityType: null,
        status: 'info',
        ip: null,
        metadata: { method },
      });
    });

    it('does not log a failed sign-in attempt when the email is unknown', async () => {
      const deps = makeDeps({ user: null });
      await auditOrgAction(
        {
          path: '/sign-in/email',
          body: { email: 'nobody@example.com' },
          headers: {},
          context: { returned: { name: 'APIError' } },
        },
        deps,
      );

      expect(deps.prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'nobody@example.com' },
        select: { id: true },
      });
      expect(deps.logAuditSafely).not.toHaveBeenCalled();
    });

    it('does not look up a user or log anything when the failed body has no email (e.g. an OAuth callback)', async () => {
      const deps = makeDeps();
      await auditOrgAction(
        { path: '/sign-in/email', body: {}, headers: {}, context: { returned: { name: 'APIError' } } },
        deps,
      );

      expect(deps.prisma.user.findUnique).not.toHaveBeenCalled();
      expect(deps.logAuditSafely).not.toHaveBeenCalled();
    });

    it('logs a failed login attempt against the resolved user when the email matches an existing account', async () => {
      const deps = makeDeps({ user: { id: 'user-1' } });
      await auditOrgAction(
        {
          path: '/sign-in/email',
          body: { email: 'user1@example.com', password: 'wrong' },
          headers: {},
          context: { returned: { name: 'APIError' } },
        },
        deps,
      );

      expect(deps.prisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: 'user1@example.com' },
        select: { id: true },
      });
      expect(deps.logAuditSafely).toHaveBeenCalledWith('user-1', {
        action: 'auth.login_failed',
        entityType: null,
        status: 'failed',
        ip: null,
        metadata: { method: 'email' },
      });
    });
  });

  describe('role_update notification', () => {
    it("notifies the affected member when someone else's role changes", async () => {
      const deps = makeDeps({ member: { userId: 'user-2' } });
      const ctx = {
        path: '/organization/update-member-role',
        body: { memberId: 'member-2', role: 'admin' },
        headers: {},
        context: { returned: {} },
      };

      await auditOrgAction(ctx, deps);

      expect(deps.prisma.member.findUnique).toHaveBeenCalledWith({ where: { id: 'member-2' }, select: { userId: true } });
      expect(deps.createNotification).toHaveBeenCalledWith('user-2', {
        type: 'member.role_changed',
        message: 'Your role was changed to admin.',
        entityType: 'member',
        entityId: 'member-2',
      });
    });

    it('does not notify when the acting user changed their own role', async () => {
      const deps = makeDeps({ member: { userId: 'user-1' } });
      const ctx = {
        path: '/organization/update-member-role',
        body: { memberId: 'member-1', role: 'admin' },
        headers: {},
        context: { returned: {} },
      };

      await auditOrgAction(ctx, deps);

      expect(deps.createNotification).not.toHaveBeenCalled();
    });
  });

  describe('invitation.accept notification', () => {
    it('notifies the inviter when their invitation is accepted', async () => {
      const deps = makeDeps();
      const ctx = {
        path: '/organization/accept-invitation',
        body: { invitationId: 'invite-1' },
        headers: {},
        context: { returned: { invitation: { inviterId: 'inviter-1' }, member: {} } },
      };

      await auditOrgAction(ctx, deps);

      expect(deps.createNotification).toHaveBeenCalledWith('inviter-1', {
        type: 'invitation.accepted',
        message: 'User One accepted your invitation and joined the organization.',
        entityType: 'invitation',
        entityId: 'invite-1',
      });
    });
  });
});
