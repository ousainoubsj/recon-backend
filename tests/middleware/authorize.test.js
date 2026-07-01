import { jest } from '@jest/globals';

const mockGetUserMembership = jest.fn();
jest.unstable_mockModule('../../services/organizationService.js', () => ({
  getUserMembership: mockGetUserMembership,
}));

const { requirePermission } = await import('../../middleware/authorize.js');
const { AuthorisationError } = await import('../../errors.js');

beforeEach(() => jest.clearAllMocks());

describe('requirePermission', () => {
  it('calls next() when the role has the permission', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'analyst' });
    const req = { session: { user: { id: 'user-1' } } };
    const next = jest.fn();

    await requirePermission('report', 'create')(req, {}, next);

    expect(next).toHaveBeenCalledWith();
  });

  it('calls next(AuthorisationError) when the role lacks the permission', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });
    const req = { session: { user: { id: 'user-1' } } };
    const next = jest.fn();

    await requirePermission('report', 'create')(req, {}, next);

    expect(next).toHaveBeenCalledWith(expect.any(AuthorisationError));
  });
});
