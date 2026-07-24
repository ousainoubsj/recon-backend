import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as settingsService from '../services/settingsService.js';
import { getUserMembership } from '../services/organizationService.js';
import { logAuditSafely } from '../services/auditLogService.js';
import { r2 } from '../utils/r2Client.js';
import { FileTooLargeError, ValidationError } from '../errors.js';

const LOGO_ALLOWED_CONTENT_TYPES = new Set(['image/png', 'image/svg+xml']);
const LOGO_MAX_SIZE_BYTES = 2 * 1024 * 1024;

export const getOrganizationInfo = async (req, res) => {
  const info = await settingsService.getOrganizationInfo(req.session.user.id);
  res.json(info);
};

export const updateOrganizationInfo = async (req, res) => {
  const info = await settingsService.updateOrganizationInfo(req.session.user.id, req.body);
  res.json(info);
};

export const getReconciliationDefaults = async (req, res) => {
  const defaults = await settingsService.getReconciliationDefaults(req.session.user.id);
  res.json(defaults);
};

export const updateReconciliationDefaults = async (req, res) => {
  const defaults = await settingsService.updateReconciliationDefaults(req.session.user.id, req.body);
  res.json(defaults);
};

export const getNotificationPreferences = async (req, res) => {
  const prefs = await settingsService.getNotificationPreferences(req.session.user.id);
  res.json(prefs);
};

export const updateNotificationPreferences = async (req, res) => {
  const prefs = await settingsService.updateNotificationPreferences(req.session.user.id, req.body);
  res.json(prefs);
};

// Presign only — the frontend PUTs the image straight to R2, then persists
// the resulting publicUrl via Better Auth's existing /organization/update
// (logo is already one of its own fields, already audit-logged via
// orgAuditHookService.js). No separate "confirm" endpoint needed.
export const createOrganizationLogoPresignedUpload = async (req, res) => {
  const { filename, contentType, size } = req.body;

  if (typeof size !== 'number' || size > LOGO_MAX_SIZE_BYTES) {
    throw new FileTooLargeError();
  }
  if (!LOGO_ALLOWED_CONTENT_TYPES.has(contentType)) {
    throw new ValidationError('Only PNG and SVG files are accepted');
  }

  const { organizationId } = await getUserMembership(req.session.user.id);
  const key = `org-logos/${organizationId}/${Date.now()}-${filename}`;
  const presignedUrl = await getSignedUrl(
    r2,
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      ContentType: contentType,
    }),
    { expiresIn: 300 },
  );

  res.json({ url: presignedUrl, publicUrl: `${process.env.R2_PUBLIC_URL}/${key}` });

  // Only confirms the presign was issued, not that the browser's direct-to-R2
  // PUT actually succeeded afterward — same framing as file.upload_initiated.
  await logAuditSafely(req.session.user.id, {
    action: 'settings.organization_logo.presign_requested',
    entityType: 'organization',
    entityId: organizationId,
    status: 'info',
    ip: req.ip,
    metadata: { filename, contentType },
  });
};
