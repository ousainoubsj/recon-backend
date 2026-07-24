import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const USER_ID = 'user-1';

jest.unstable_mockModule('../../middleware/authenticate.js', () => ({
  authenticate: (req, res, next) => {
    req.session = { user: { id: USER_ID } };
    next();
  },
}));

const mockGetUserMembership = jest.fn();
jest.unstable_mockModule('../../services/organizationService.js', () => ({
  getUserMembership: mockGetUserMembership,
}));

const mockLogAuditSafely = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/auditLogService.js', () => ({
  logAuditSafely: mockLogAuditSafely,
}));

const mockGetSignedUrl = jest.fn();
jest.unstable_mockModule('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

const mockSettingsService = {
  getOrganizationInfo: jest.fn(),
  updateOrganizationInfo: jest.fn(),
  getReconciliationDefaults: jest.fn(),
  updateReconciliationDefaults: jest.fn(),
  getNotificationPreferences: jest.fn(),
  updateNotificationPreferences: jest.fn(),
};
jest.unstable_mockModule('../../services/settingsService.js', () => mockSettingsService);

const { settingsRouter } = await import('../../routes/settings.js');
const { errorHandler } = await import('../../middleware/errorHandler.js');

const app = express();
app.use(express.json());
app.use('/api/settings', settingsRouter);
app.use(errorHandler);

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'admin' });
  process.env.R2_BUCKET_NAME = 'test-bucket';
  process.env.R2_PUBLIC_URL = 'https://cdn.example.com';
});

describe('GET /api/settings/organization-info', () => {
  it("returns the org's info", async () => {
    const info = { name: 'ReconcilePro Ltd.', orgType: 'Financial Services' };
    mockSettingsService.getOrganizationInfo.mockResolvedValue(info);

    const res = await request(app).get('/api/settings/organization-info');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(info);
    expect(mockSettingsService.getOrganizationInfo).toHaveBeenCalledWith(USER_ID);
  });

  it('is allowed for a viewer (organization:read is granted to all three roles)', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });
    mockSettingsService.getOrganizationInfo.mockResolvedValue({});

    const res = await request(app).get('/api/settings/organization-info');

    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/settings/organization-info', () => {
  it('updates org info for an admin', async () => {
    mockSettingsService.updateOrganizationInfo.mockResolvedValue({ orgType: 'Financial Services' });

    const res = await request(app)
      .patch('/api/settings/organization-info')
      .send({ orgType: 'Financial Services' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orgType: 'Financial Services' });
    expect(mockSettingsService.updateOrganizationInfo).toHaveBeenCalledWith(USER_ID, { orgType: 'Financial Services' });
  });

  it('rejects a non-admin with a 403 RFC 7807 error', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'analyst' });

    const res = await request(app).patch('/api/settings/organization-info').send({ orgType: 'x' });

    expect(res.status).toBe(403);
    expect(res.body.type).toBe('https://recon.app/errors/authorisation-error');
    expect(mockSettingsService.updateOrganizationInfo).not.toHaveBeenCalled();
  });

  it('accepts an empty body (no-op update)', async () => {
    mockSettingsService.updateOrganizationInfo.mockResolvedValue({});

    const res = await request(app).patch('/api/settings/organization-info').send({});

    expect(res.status).toBe(200);
  });

  it('rejects a field over the max length with a 422', async () => {
    const res = await request(app)
      .patch('/api/settings/organization-info')
      .send({ orgType: 'x'.repeat(101) });

    expect(res.status).toBe(422);
    expect(mockSettingsService.updateOrganizationInfo).not.toHaveBeenCalled();
  });
});

describe('GET /api/settings/reconciliation-defaults', () => {
  it("returns the org's reconciliation defaults", async () => {
    const defaults = { defaultAmountTolerance: 0.01, defaultDateToleranceDays: 3, defaultAmountType: 'Net Amount' };
    mockSettingsService.getReconciliationDefaults.mockResolvedValue(defaults);

    const res = await request(app).get('/api/settings/reconciliation-defaults');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(defaults);
  });
});

describe('PATCH /api/settings/reconciliation-defaults', () => {
  it('updates the defaults for an admin', async () => {
    mockSettingsService.updateReconciliationDefaults.mockResolvedValue({ defaultDateToleranceDays: 5 });

    const res = await request(app)
      .patch('/api/settings/reconciliation-defaults')
      .send({ defaultDateToleranceDays: 5 });

    expect(res.status).toBe(200);
    expect(mockSettingsService.updateReconciliationDefaults).toHaveBeenCalledWith(USER_ID, {
      defaultDateToleranceDays: 5,
    });
  });

  it('rejects a non-admin with a 403', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });

    const res = await request(app).patch('/api/settings/reconciliation-defaults').send({ defaultDateToleranceDays: 5 });

    expect(res.status).toBe(403);
    expect(mockSettingsService.updateReconciliationDefaults).not.toHaveBeenCalled();
  });

  it('rejects a negative tolerance with a 422', async () => {
    const res = await request(app)
      .patch('/api/settings/reconciliation-defaults')
      .send({ defaultAmountTolerance: -1 });

    expect(res.status).toBe(422);
  });
});

describe('GET /api/settings/notifications', () => {
  it("returns the caller's own notification preferences regardless of role", async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });
    const prefs = { emailNotificationsEnabled: true, weeklyDigestEnabled: false };
    mockSettingsService.getNotificationPreferences.mockResolvedValue(prefs);

    const res = await request(app).get('/api/settings/notifications');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(prefs);
    expect(mockSettingsService.getNotificationPreferences).toHaveBeenCalledWith(USER_ID);
  });
});

describe('PATCH /api/settings/notifications', () => {
  it('updates preferences regardless of role (no RBAC resource on this route)', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'viewer' });
    mockSettingsService.updateNotificationPreferences.mockResolvedValue({ emailNotificationsEnabled: false });

    const res = await request(app)
      .patch('/api/settings/notifications')
      .send({ emailNotificationsEnabled: false });

    expect(res.status).toBe(200);
    expect(mockSettingsService.updateNotificationPreferences).toHaveBeenCalledWith(USER_ID, {
      emailNotificationsEnabled: false,
    });
  });

  it('rejects a non-boolean value with a 422', async () => {
    const res = await request(app).patch('/api/settings/notifications').send({ emailNotificationsEnabled: 'yes' });

    expect(res.status).toBe(422);
    expect(mockSettingsService.updateNotificationPreferences).not.toHaveBeenCalled();
  });
});

describe('POST /api/settings/organization-logo/presign', () => {
  const validBody = { filename: 'logo.png', contentType: 'image/png', size: 1024 };

  it('returns a presigned PUT url and the resulting public url for an admin', async () => {
    mockGetSignedUrl.mockResolvedValue('https://r2.example.com/signed-put-url');

    const res = await request(app).post('/api/settings/organization-logo/presign').send(validBody);

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://r2.example.com/signed-put-url');
    expect(res.body.publicUrl).toMatch(/^https:\/\/cdn\.example\.com\/org-logos\/org-1\/\d+-logo\.png$/);
    expect(mockLogAuditSafely).toHaveBeenCalledWith('user-1', {
      action: 'settings.organization_logo.presign_requested',
      entityType: 'organization',
      entityId: 'org-1',
      status: 'info',
      ip: expect.any(String),
      metadata: { filename: 'logo.png', contentType: 'image/png' },
    });
  });

  it('accepts image/svg+xml too', async () => {
    mockGetSignedUrl.mockResolvedValue('https://r2.example.com/signed-put-url');

    const res = await request(app)
      .post('/api/settings/organization-logo/presign')
      .send({ filename: 'logo.svg', contentType: 'image/svg+xml', size: 1024 });

    expect(res.status).toBe(200);
  });

  it('rejects a disallowed content type with a 422', async () => {
    const res = await request(app)
      .post('/api/settings/organization-logo/presign')
      .send({ ...validBody, contentType: 'image/jpeg' });

    expect(res.status).toBe(422);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('rejects a file over 2MB with a 413 RFC 7807 error', async () => {
    const res = await request(app)
      .post('/api/settings/organization-logo/presign')
      .send({ ...validBody, size: 3 * 1024 * 1024 });

    expect(res.status).toBe(413);
    expect(res.body.type).toBe('https://recon.app/errors/file-too-large');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('rejects a non-admin with a 403 RFC 7807 error', async () => {
    mockGetUserMembership.mockResolvedValue({ organizationId: 'org-1', role: 'analyst' });

    const res = await request(app).post('/api/settings/organization-logo/presign').send(validBody);

    expect(res.status).toBe(403);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });
});
