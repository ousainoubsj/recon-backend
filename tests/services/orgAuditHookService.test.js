import { jest } from '@jest/globals';
import { auditOrgAction } from '../../services/orgAuditHookService.js';

function makeDeps({ session = { user: { id: 'user-1' } } } = {}) {
  return {
    getSession: jest.fn().mockResolvedValue(session),
    logAuditSafely: jest.fn().mockResolvedValue(undefined),
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
      metadata: ctx.body,
    });
  });

  it.each([
    ['/organization/remove-member', 'organization.member.remove'],
    ['/organization/update-member-role', 'organization.member.role_update'],
    ['/organization/accept-invitation', 'organization.invitation.accept'],
    ['/organization/cancel-invitation', 'organization.invitation.cancel'],
    ['/organization/update', 'organization.update'],
    ['/organization/delete', 'organization.delete'],
  ])('maps %s to action %s', async (path, expectedAction) => {
    const deps = makeDeps();
    await auditOrgAction({ path, body: {}, headers: {}, context: { returned: {} } }, deps);

    expect(deps.logAuditSafely).toHaveBeenCalledWith('user-1', expect.objectContaining({ action: expectedAction }));
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
});
