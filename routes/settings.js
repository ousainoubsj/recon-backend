import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { catchAsync } from '../utils/catchAsync.js';
import * as settingsController from '../controllers/settings.controller.js';

export const settingsRouter = Router();

// No canonical option list exists anywhere in the frontend mock for any of
// these — plain, unvalidated strings rather than inventing an enum.
const updateOrganizationInfoSchema = z.object({
  orgType: z.string().max(100).nullable().optional(),
  country: z.string().max(100).nullable().optional(),
  timezone: z.string().max(100).nullable().optional(),
  dateFormat: z.string().max(50).nullable().optional(),
  currency: z.string().max(10).nullable().optional(),
});

const updateReconciliationDefaultsSchema = z.object({
  defaultAmountTolerance: z.number().min(0).nullable().optional(),
  defaultDateToleranceDays: z.number().int().min(0).nullable().optional(),
  defaultAmountType: z.string().max(50).nullable().optional(),
});

const updateNotificationPreferencesSchema = z.object({
  emailNotificationsEnabled: z.boolean().optional(),
  weeklyDigestEnabled: z.boolean().optional(),
});

const organizationLogoPresignSchema = z.object({
  filename: z.string().min(1),
  contentType: z.enum(['image/png', 'image/svg+xml']),
  size: z.number().positive(),
});

settingsRouter.get(
  '/organization-info',
  authenticate,
  catchAsync(requirePermission('organization', 'read')),
  catchAsync(settingsController.getOrganizationInfo),
);

settingsRouter.patch(
  '/organization-info',
  authenticate,
  catchAsync(requirePermission('organization', 'update')),
  validate(updateOrganizationInfoSchema),
  catchAsync(settingsController.updateOrganizationInfo),
);

settingsRouter.get(
  '/reconciliation-defaults',
  authenticate,
  catchAsync(requirePermission('organization', 'read')),
  catchAsync(settingsController.getReconciliationDefaults),
);

settingsRouter.patch(
  '/reconciliation-defaults',
  authenticate,
  catchAsync(requirePermission('organization', 'update')),
  validate(updateReconciliationDefaultsSchema),
  catchAsync(settingsController.updateReconciliationDefaults),
);

// No RBAC resource here (unlike the two above) — notification preferences
// are per-user, not org-wide, mirroring routes/notifications.js.
settingsRouter.get(
  '/notifications',
  authenticate,
  catchAsync(settingsController.getNotificationPreferences),
);

settingsRouter.patch(
  '/notifications',
  authenticate,
  validate(updateNotificationPreferencesSchema),
  catchAsync(settingsController.updateNotificationPreferences),
);

// Admin-only, same tier as the other org-info updates — changing org
// branding isn't a per-viewer action.
settingsRouter.post(
  '/organization-logo/presign',
  authenticate,
  catchAsync(requirePermission('organization', 'update')),
  validate(organizationLogoPresignSchema),
  catchAsync(settingsController.createOrganizationLogoPresignedUpload),
);
