import { jest } from '@jest/globals';

const mockSend = jest.fn();
class MockResend {
  constructor() {
    this.emails = { send: mockSend };
  }
}
jest.unstable_mockModule('resend', () => ({ Resend: MockResend }));

const { sendReportEmail, sendOrgInvitationEmail, sendPasswordResetEmail, sendOtpEmail } = await import(
  '../../services/emailService.js'
);

beforeEach(() => jest.clearAllMocks());

const report = {
  fileAName: 'a.csv',
  fileBName: 'b.csv',
  matchedCount: 8,
  totalRows: 10,
  runDate: new Date('2026-01-01T00:00:00Z'),
};

describe('sendReportEmail', () => {
  it('sends an HTML email with a plain-text fallback', async () => {
    mockSend.mockResolvedValue({ data: { id: 'email-1' }, error: null });

    await sendReportEmail(report, 'analyst@example.com');

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'analyst@example.com',
        from: process.env.EMAIL_FROM,
        subject: 'Reconciliation report — a.csv vs b.csv',
        html: expect.stringContaining('a.csv'),
        text: expect.stringContaining('a.csv'),
      }),
    );
  });

  it('throws when Resend reports an error, instead of silently succeeding', async () => {
    mockSend.mockResolvedValue({ data: null, error: { statusCode: 401, message: 'API key is invalid' } });

    await expect(sendReportEmail(report, 'analyst@example.com')).rejects.toThrow('API key is invalid');
  });
});

describe('sendOrgInvitationEmail', () => {
  const invitationData = {
    id: 'invite-1',
    role: 'analyst',
    email: 'invitee@example.com',
    organization: { name: 'Acme Corp' },
    invitation: { expiresAt: '2026-07-03T00:00:00Z' },
    inviter: { user: { email: 'admin@acme.com' } },
  };

  it('sends an HTML invitation email with the accept link', async () => {
    mockSend.mockResolvedValue({ data: { id: 'email-2' }, error: null });

    await sendOrgInvitationEmail(invitationData);

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'invitee@example.com',
        subject: "You've been invited to join Acme Corp",
        html: expect.stringContaining(`${process.env.FRONTEND_URL}/accept-invite/invite-1`),
      }),
    );
  });

  it('throws when Resend reports an error', async () => {
    mockSend.mockResolvedValue({ data: null, error: { message: 'boom' } });

    await expect(sendOrgInvitationEmail(invitationData)).rejects.toThrow('boom');
  });
});

describe('sendPasswordResetEmail', () => {
  const user = { email: 'user@example.com' };
  const url = 'https://app.example.com/reset-password/abc123';

  it('sends an HTML email containing the reset link', async () => {
    mockSend.mockResolvedValue({ data: { id: 'email-3' }, error: null });

    await sendPasswordResetEmail(user, url);

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        subject: 'Reset your password',
        html: expect.stringContaining(url),
        text: expect.stringContaining(url),
      }),
    );
  });

  it('throws when Resend reports an error', async () => {
    mockSend.mockResolvedValue({ data: null, error: { message: 'boom' } });

    await expect(sendPasswordResetEmail(user, url)).rejects.toThrow('boom');
  });
});

describe('sendOtpEmail', () => {
  it('sends an HTML email containing the OTP code', async () => {
    mockSend.mockResolvedValue({ data: { id: 'email-4' }, error: null });

    await sendOtpEmail({ email: 'user@example.com', otp: '123456', type: 'email-verification' });

    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'user@example.com',
        subject: 'Your verification code',
        html: expect.stringContaining('123456'),
        text: expect.stringContaining('123456'),
      }),
    );
  });

  it('throws when Resend reports an error', async () => {
    mockSend.mockResolvedValue({ data: null, error: { message: 'boom' } });

    await expect(sendOtpEmail({ email: 'user@example.com', otp: '123456' })).rejects.toThrow('boom');
  });
});

describe('dev fallback when Resend is not configured', () => {
  const originalKey = process.env.RESEND_API_KEY;
  let warnSpy;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.RESEND_API_KEY = originalKey;
    warnSpy.mockRestore();
  });

  it.each([['unset', undefined], ['the tracked placeholder', 're_xxx']])(
    'logs the OTP instead of calling Resend when RESEND_API_KEY is %s',
    async (_label, value) => {
      if (value === undefined) delete process.env.RESEND_API_KEY;
      else process.env.RESEND_API_KEY = value;

      await sendOtpEmail({ email: 'user@example.com', otp: '654321', type: 'email-verification' });

      expect(mockSend).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('654321'));
    },
  );

  it('sends via Resend as normal once a real-looking key is set', async () => {
    process.env.RESEND_API_KEY = 're_live_realkey';
    mockSend.mockResolvedValue({ data: { id: 'email-5' }, error: null });

    await sendOtpEmail({ email: 'user@example.com', otp: '111222' });

    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
