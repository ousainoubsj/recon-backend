import { jest } from '@jest/globals';

const mockAuth = { api: { getSession: jest.fn() } };

jest.unstable_mockModule('../../auth.js', () => ({ auth: mockAuth }));

const mockTouchLastActive = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/organizationService.js', () => ({
  touchLastActive: mockTouchLastActive,
}));

const { authenticate } = await import('../../middleware/authenticate.js');
const { AccessBlockedError, AuthenticationError } = await import('../../errors.js');

beforeEach(() => jest.clearAllMocks());

describe('authenticate middleware', () => {
  it('attaches the session to req, touches last-active, and calls next() when a session exists', async () => {
    const session = { user: { id: 'user-1' } };
    mockAuth.api.getSession.mockResolvedValue(session);
    const req = { headers: {} };
    const next = jest.fn();

    await authenticate(req, {}, next);

    expect(req.session).toBe(session);
    expect(mockTouchLastActive).toHaveBeenCalledWith('user-1');
    expect(next).toHaveBeenCalledWith();
  });

  it('calls next(AuthenticationError) when there is no session, without touching last-active', async () => {
    mockAuth.api.getSession.mockResolvedValue(null);
    const next = jest.fn();

    await authenticate({ headers: {} }, {}, next);

    expect(next).toHaveBeenCalledWith(expect.any(AuthenticationError));
    expect(mockTouchLastActive).not.toHaveBeenCalled();
  });

  it.each(['suspended', 'removed'])('refuses a %s platform admin with AccessBlockedError', async (platformStatus) => {
    mockAuth.api.getSession.mockResolvedValue({ user: { id: 'admin-1', platformRole: 'admin', platformStatus } });
    const next = jest.fn();

    await authenticate({ headers: {} }, {}, next);

    expect(next).toHaveBeenCalledWith(expect.any(AccessBlockedError));
    expect(mockTouchLastActive).not.toHaveBeenCalled();
  });
});
