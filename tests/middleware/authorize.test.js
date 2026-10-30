import { jest } from '@jest/globals';

const mockGetUserMembership = jest.fn();
jest.unstable_mockModule('../../services/organizationService.js', () => ({
  getUserMembership: mockGetUserMembership,
}));

const mockLogAuditOnce = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/auditLogService.js', () => ({
  logAuditOnce: mockLogAuditOnce,
}));

const { requirePermission, requirePlatformRole } = await import('../../middleware/authorize.js');
const { AuthorisationError } = await import('../../errors.js');

beforeEach(() => jest.clearAllMocks());

describe('requirePermission', () => {
  it('calls next() when the role has the permission', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'analyst' });
    const req = { session: { user: { id: 'user-1' } }, params: {}, ip: '10.0.0.1', get: () => 'Mozilla/5.0' };
    const next = jest.fn();

    await requirePermission('report', 'create')(req, {}, next);

    expect(next).toHaveBeenCalledWith();
    expect(mockLogAuditOnce).not.toHaveBeenCalled();
  });

  it('calls next(AuthorisationError) and logs a failed denial when the role lacks the permission', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });
    const req = { session: { user: { id: 'user-1' } }, params: { id: 'r1' }, ip: '10.0.0.1', get: () => 'Mozilla/5.0' };
    const next = jest.fn();

    await requirePermission('report', 'delete')(req, {}, next);

    expect(next).toHaveBeenCalledWith(expect.any(AuthorisationError));
    // Deduplicated: a refetch or retry of the same refused request inside 5 minutes is one attempt.
    expect(mockLogAuditOnce).toHaveBeenCalledWith(
      'user-1',
      {
        action: 'report.delete.denied',
        entityType: 'report',
        entityId: 'r1',
        status: 'failed',
        ip: '10.0.0.1',
        userAgent: 'Mozilla/5.0',
        metadata: { role: 'viewer', reason: 'insufficient_role' },
      },
      5 * 60 * 1000,
    );
  });

  it('defaults entityId to null when there is no :id param', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });
    const req = { session: { user: { id: 'user-1' } }, params: {}, ip: '10.0.0.1', get: () => 'Mozilla/5.0' };
    const next = jest.fn();

    await requirePermission('auditLog', 'read')(req, {}, next);

    expect(mockLogAuditOnce).toHaveBeenCalledWith('user-1', expect.objectContaining({ entityId: null }), expect.any(Number));
  });

  it('denies an inactive member even when their role would otherwise have permission', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin', status: 'inactive' });
    const req = { session: { user: { id: 'user-1' } }, params: {}, ip: '10.0.0.1', get: () => 'Mozilla/5.0' };
    const next = jest.fn();

    await requirePermission('report', 'create')(req, {}, next);

    expect(next).toHaveBeenCalledWith(expect.any(AuthorisationError));
    expect(mockLogAuditOnce).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ metadata: { role: 'admin', reason: 'inactive' } }),
      expect.any(Number),
    );
  });

  it('lets every role read its own activity, but not an inactive member', async () => {
    const req = { session: { user: { id: 'user-1' } }, params: {}, ip: '10.0.0.1', get: () => 'Mozilla/5.0' };
    for (const role of ['admin', 'analyst', 'viewer']) {
      mockGetUserMembership.mockResolvedValueOnce({ organizationId: 'org-1', role, status: 'active' });
      const next = jest.fn();
      await requirePermission('auditLog', 'readOwn')(req, {}, next);
      expect(next).toHaveBeenCalledWith();
    }

    mockGetUserMembership.mockResolvedValueOnce({ organizationId: 'org-1', role: 'viewer', status: 'inactive' });
    const next = jest.fn();
    await requirePermission('auditLog', 'readOwn')(req, {}, next);
    expect(next).toHaveBeenCalledWith(expect.any(AuthorisationError));
  });
});

describe('requirePlatformRole', () => {
  const run = (user, roles) => {
    const next = jest.fn();
    requirePlatformRole(...roles)({ session: { user } }, {}, next);
    return next.mock.calls[0][0];
  };

  it('lets an active platform user with an allowed role through', () => {
    expect(run({ platformRole: 'admin', platformStatus: 'active' }, ['owner', 'admin'])).toBeUndefined();
  });

  it.each([
    [{ platformRole: null, platformStatus: null }, ['owner', 'admin']],
    [{ platformRole: 'admin', platformStatus: 'active' }, ['owner']],
    [{ platformRole: 'owner', platformStatus: 'suspended' }, ['owner']],
  ])('refuses %o for %o', (user, roles) => {
    expect(run(user, roles)).toBeInstanceOf(AuthorisationError);
  });
});
