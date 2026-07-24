import { jest } from '@jest/globals';

const mockPrisma = {
  organization: { findFirst: jest.fn(), update: jest.fn() },
  user: { findFirst: jest.fn(), update: jest.fn() },
  member: { findFirst: jest.fn() },
};

jest.unstable_mockModule('../../db/index.js', () => ({ prisma: mockPrisma }));

const mockLogAuditSafely = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/auditLogService.js', () => ({
  logAuditSafely: mockLogAuditSafely,
}));

const {
  getOrganizationInfo,
  updateOrganizationInfo,
  getReconciliationDefaults,
  updateReconciliationDefaults,
  getNotificationPreferences,
  updateNotificationPreferences,
} = await import('../../services/settingsService.js');

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'admin' });
});

describe('getOrganizationInfo', () => {
  it("selects name/logo plus the 5 org-info fields, scoped to the caller's org", async () => {
    const info = { name: 'ReconcilePro Ltd.', logo: null, orgType: 'Financial Services' };
    mockPrisma.organization.findFirst.mockResolvedValue(info);

    const result = await getOrganizationInfo(USER_ID);

    expect(result).toBe(info);
    expect(mockPrisma.organization.findFirst).toHaveBeenCalledWith({
      where: { id: ORG_ID },
      select: {
        name: true,
        logo: true,
        orgType: true,
        country: true,
        timezone: true,
        dateFormat: true,
        currency: true,
      },
    });
  });
});

describe('updateOrganizationInfo', () => {
  it('updates only the provided fields and audit-logs the change', async () => {
    mockPrisma.organization.update.mockResolvedValue({ id: ORG_ID, orgType: 'Financial Services' });

    const result = await updateOrganizationInfo(USER_ID, { orgType: 'Financial Services' });

    expect(result).toEqual({ id: ORG_ID, orgType: 'Financial Services' });
    expect(mockPrisma.organization.update).toHaveBeenCalledWith({
      where: { id: ORG_ID },
      data: { orgType: 'Financial Services' },
    });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'settings.organization_info.update',
      entityType: 'organization',
      entityId: ORG_ID,
      metadata: { orgType: 'Financial Services' },
    });
  });

  it('ignores fields not present in the dto', async () => {
    mockPrisma.organization.update.mockResolvedValue({ id: ORG_ID });

    await updateOrganizationInfo(USER_ID, { country: 'United Kingdom' });

    expect(mockPrisma.organization.update).toHaveBeenCalledWith({
      where: { id: ORG_ID },
      data: { country: 'United Kingdom' },
    });
  });
});

describe('getReconciliationDefaults', () => {
  it("selects the 3 reconciliation-default fields, scoped to the caller's org", async () => {
    mockPrisma.organization.findFirst.mockResolvedValue({ defaultAmountTolerance: 0.01 });

    await getReconciliationDefaults(USER_ID);

    expect(mockPrisma.organization.findFirst).toHaveBeenCalledWith({
      where: { id: ORG_ID },
      select: { defaultAmountTolerance: true, defaultDateToleranceDays: true, defaultAmountType: true },
    });
  });
});

describe('updateReconciliationDefaults', () => {
  it('updates only the provided fields and audit-logs the change', async () => {
    mockPrisma.organization.update.mockResolvedValue({ id: ORG_ID, defaultDateToleranceDays: 3 });

    const result = await updateReconciliationDefaults(USER_ID, { defaultDateToleranceDays: 3 });

    expect(result).toEqual({ id: ORG_ID, defaultDateToleranceDays: 3 });
    expect(mockPrisma.organization.update).toHaveBeenCalledWith({
      where: { id: ORG_ID },
      data: { defaultDateToleranceDays: 3 },
    });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'settings.reconciliation_defaults.update',
      entityType: 'organization',
      entityId: ORG_ID,
      metadata: { defaultDateToleranceDays: 3 },
    });
  });
});

describe('getNotificationPreferences', () => {
  it("reads the caller's own User row, not org-scoped", async () => {
    const prefs = { emailNotificationsEnabled: true, weeklyDigestEnabled: false };
    mockPrisma.user.findFirst.mockResolvedValue(prefs);

    const result = await getNotificationPreferences(USER_ID);

    expect(result).toBe(prefs);
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: USER_ID },
      select: { emailNotificationsEnabled: true, weeklyDigestEnabled: true },
    });
    expect(mockPrisma.member.findFirst).not.toHaveBeenCalled();
  });
});

describe('updateNotificationPreferences', () => {
  it("updates the caller's own User row and audit-logs as info", async () => {
    mockPrisma.user.update.mockResolvedValue({
      id: USER_ID,
      emailNotificationsEnabled: false,
      weeklyDigestEnabled: true,
    });

    const result = await updateNotificationPreferences(USER_ID, {
      emailNotificationsEnabled: false,
      weeklyDigestEnabled: true,
    });

    expect(result).toEqual({ emailNotificationsEnabled: false, weeklyDigestEnabled: true });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { emailNotificationsEnabled: false, weeklyDigestEnabled: true },
    });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'settings.notifications.update',
      entityType: 'user',
      entityId: USER_ID,
      status: 'info',
      metadata: { emailNotificationsEnabled: false, weeklyDigestEnabled: true },
    });
  });

  it('updates only the provided field', async () => {
    mockPrisma.user.update.mockResolvedValue({ emailNotificationsEnabled: false, weeklyDigestEnabled: false });

    await updateNotificationPreferences(USER_ID, { emailNotificationsEnabled: false });

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: USER_ID },
      data: { emailNotificationsEnabled: false },
    });
  });
});
