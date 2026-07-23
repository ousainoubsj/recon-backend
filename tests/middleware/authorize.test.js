import { jest } from '@jest/globals';

const mockGetUserMembership = jest.fn();
jest.unstable_mockModule('../../services/organizationService.js', () => ({
  getUserMembership: mockGetUserMembership,
}));

const mockLogAuditSafely = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/auditLogService.js', () => ({
  logAuditSafely: mockLogAuditSafely,
}));

const { requirePermission } = await import('../../middleware/authorize.js');
const { AuthorisationError } = await import('../../errors.js');

beforeEach(() => jest.clearAllMocks());

describe('requirePermission', () => {
  it('calls next() when the role has the permission', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'analyst' });
    const req = { session: { user: { id: 'user-1' } }, params: {}, ip: '10.0.0.1' };
    const next = jest.fn();

    await requirePermission('report', 'create')(req, {}, next);

    expect(next).toHaveBeenCalledWith();
    expect(mockLogAuditSafely).not.toHaveBeenCalled();
  });

  it('calls next(AuthorisationError) and logs a failed denial when the role lacks the permission', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });
    const req = { session: { user: { id: 'user-1' } }, params: { id: 'r1' }, ip: '10.0.0.1' };
    const next = jest.fn();

    await requirePermission('report', 'delete')(req, {}, next);

    expect(next).toHaveBeenCalledWith(expect.any(AuthorisationError));
    expect(mockLogAuditSafely).toHaveBeenCalledWith('user-1', {
      action: 'report.delete.denied',
      entityType: 'report',
      entityId: 'r1',
      status: 'failed',
      ip: '10.0.0.1',
      metadata: { role: 'viewer', reason: 'insufficient_role' },
    });
  });

  it('defaults entityId to null when there is no :id param', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });
    const req = { session: { user: { id: 'user-1' } }, params: {}, ip: '10.0.0.1' };
    const next = jest.fn();

    await requirePermission('auditLog', 'read')(req, {}, next);

    expect(mockLogAuditSafely).toHaveBeenCalledWith('user-1', expect.objectContaining({ entityId: null }));
  });

  it('denies an inactive member even when their role would otherwise have permission', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin', status: 'inactive' });
    const req = { session: { user: { id: 'user-1' } }, params: {}, ip: '10.0.0.1' };
    const next = jest.fn();

    await requirePermission('report', 'create')(req, {}, next);

    expect(next).toHaveBeenCalledWith(expect.any(AuthorisationError));
    expect(mockLogAuditSafely).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ metadata: { role: 'admin', reason: 'inactive' } }),
    );
  });
});
