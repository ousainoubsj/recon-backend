import { jest } from '@jest/globals';

const mockAuth = { api: { getSession: jest.fn() } };

jest.unstable_mockModule('../../auth.js', () => ({ auth: mockAuth }));

const { authenticate } = await import('../../middleware/authenticate.js');
const { AuthenticationError } = await import('../../errors.js');

beforeEach(() => jest.clearAllMocks());

describe('authenticate middleware', () => {
  it('attaches the session to req and calls next() when a session exists', async () => {
    const session = { user: { id: 'user-1' } };
    mockAuth.api.getSession.mockResolvedValue(session);
    const req = { headers: {} };
    const next = jest.fn();

    await authenticate(req, {}, next);

    expect(req.session).toBe(session);
    expect(next).toHaveBeenCalledWith();
  });

  it('calls next(AuthenticationError) when there is no session', async () => {
    mockAuth.api.getSession.mockResolvedValue(null);
    const next = jest.fn();

    await authenticate({ headers: {} }, {}, next);

    expect(next).toHaveBeenCalledWith(expect.any(AuthenticationError));
  });
});
