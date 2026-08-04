import { jest } from '@jest/globals';

const mockPrisma = {
  user: { findFirst: jest.fn() },
  organization: { findFirst: jest.fn() },
  member: { findFirst: jest.fn() },
};

jest.unstable_mockModule('../../config/prisma.config.js', () => ({ prisma: mockPrisma }));

const mockSendSupportRequestEmail = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/emailService.js', () => ({
  sendSupportRequestEmail: mockSendSupportRequestEmail,
}));

const { sendHelpRequest } = await import('../../services/supportService.js');

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst', status: 'active' });
});

describe('sendHelpRequest', () => {
  it("emails the support address with the caller's name, email, org name, and message", async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ name: 'Ousainou', email: 'ousainou@x.com' });
    mockPrisma.organization.findFirst.mockResolvedValue({ name: 'Datafin' });

    await sendHelpRequest(USER_ID, 'How do I export a report?');

    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({ where: { id: USER_ID }, select: { name: true, email: true } });
    expect(mockPrisma.organization.findFirst).toHaveBeenCalledWith({ where: { id: ORG_ID }, select: { name: true } });
    expect(mockSendSupportRequestEmail).toHaveBeenCalledWith({
      name: 'Ousainou',
      email: 'ousainou@x.com',
      organizationName: 'Datafin',
      message: 'How do I export a report?',
    });
  });

  it('falls back to an em dash when the organization has no name', async () => {
    mockPrisma.user.findFirst.mockResolvedValue({ name: 'Ousainou', email: 'ousainou@x.com' });
    mockPrisma.organization.findFirst.mockResolvedValue(null);

    await sendHelpRequest(USER_ID, 'Hi');

    expect(mockSendSupportRequestEmail).toHaveBeenCalledWith(expect.objectContaining({ organizationName: '—' }));
  });
});
