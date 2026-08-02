import { jest } from '@jest/globals';

// auth.js is a config object, not request-handling logic (Better Auth's own
// behavior isn't re-tested here — see tests/routes/auth.routes.test.js).
// These tests only confirm our config is shaped the way we think, so a typo
// or misconfigured option surfaces immediately instead of only at runtime.
const mockPrisma = { member: { findFirst: jest.fn() } };
jest.unstable_mockModule('../config/prisma.config.js', () => ({ prisma: mockPrisma }));

const mockSend = jest.fn();
class MockResend {
  constructor() {
    this.emails = { send: mockSend };
  }
}
jest.unstable_mockModule('resend', () => ({ Resend: MockResend }));

const { auth } = await import('../auth.js');

describe('auth.js config', () => {
  it('requires email verification before /sign-in/email succeeds', () => {
    expect(auth.options.emailAndPassword.requireEmailVerification).toBe(true);
  });

  it('wires a sendResetPassword callback', () => {
    expect(auth.options.emailAndPassword.sendResetPassword).toBeInstanceOf(Function);
  });

  it('installs the email-otp plugin', () => {
    const emailOtpPlugin = auth.options.plugins.find((plugin) => plugin.id === 'email-otp');

    expect(emailOtpPlugin).toBeDefined();
  });
});
