import { jest } from '@jest/globals';

const mockSend = jest.fn();
class MockResend {
  constructor() {
    this.emails = { send: mockSend };
  }
}
jest.unstable_mockModule('resend', () => ({ Resend: MockResend }));

const { sendReportEmail, sendOrgInvitationEmail } = await import('../../services/emailService.js');

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
