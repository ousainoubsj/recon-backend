import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { requirePlatformRole } from '../middleware/authorize.js';
import { validate, validateParams, validateQuery } from '../middleware/validate.js';
import { catchAsync } from '../utils/catchAsync.js';
import * as superAdminController from '../controllers/superAdmin.controller.js';

// Platform owner/admins (docs/SUPER_ADMIN_PLAN.md). Company routes check per-company access in the service.
export const superAdminRouter = Router();

// Better Auth's ids (orgs, users) are random 32-character strings, not UUIDs.
const entityId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const companyParams = validateParams(z.object({ id: entityId }));
const adminParams = validateParams(z.object({ userId: entityId }));
const pageQuery = { offset: z.string().optional(), limit: z.string().optional(), q: z.string().max(100).optional() };
const email = z.string().trim().email().max(255);

const anyPlatformAdmin = [authenticate, requirePlatformRole('owner', 'admin')];
const ownerOnly = [authenticate, requirePlatformRole('owner')];

superAdminRouter.get(
  '/companies',
  ...anyPlatformAdmin,
  validateQuery(z.object({ ...pageQuery, status: z.enum(['active', 'suspended']).optional() })),
  catchAsync(superAdminController.listCompanies),
);
superAdminRouter.get('/companies/:id', ...anyPlatformAdmin, companyParams, catchAsync(superAdminController.getCompany));
superAdminRouter.post(
  '/companies',
  ...anyPlatformAdmin,
  validate(z.object({ name: z.string().trim().min(1).max(120), firstAdminEmail: email })),
  catchAsync(superAdminController.createCompany),
);
superAdminRouter.patch(
  '/companies/:id',
  ...anyPlatformAdmin,
  companyParams,
  validate(z.object({ name: z.string().trim().min(1).max(120) })),
  catchAsync(superAdminController.updateCompany),
);
// Irreversible: owner only, and the service requires the company to be suspended first.
superAdminRouter.delete('/companies/:id', ...ownerOnly, companyParams, catchAsync(superAdminController.deleteCompany));
superAdminRouter.post('/companies/:id/suspend', ...anyPlatformAdmin, companyParams, catchAsync(superAdminController.suspendCompany));
superAdminRouter.post('/companies/:id/activate', ...anyPlatformAdmin, companyParams, catchAsync(superAdminController.activateCompany));
superAdminRouter.post(
  '/companies/:id/invitations',
  ...anyPlatformAdmin,
  companyParams,
  validate(z.object({ email, role: z.enum(['admin', 'analyst', 'viewer']) })),
  catchAsync(superAdminController.inviteCompanyUser),
);
superAdminRouter.post('/companies/:id/enter', ...anyPlatformAdmin, companyParams, catchAsync(superAdminController.enterCompany));
superAdminRouter.post('/exit', ...anyPlatformAdmin, catchAsync(superAdminController.exitCompany));

superAdminRouter.get('/admins', ...ownerOnly, validateQuery(z.object(pageQuery)), catchAsync(superAdminController.listPlatformAdmins));
superAdminRouter.post(
  '/admins',
  ...ownerOnly,
  validate(z.object({ name: z.string().trim().min(1).max(120), email })),
  catchAsync(superAdminController.invitePlatformAdmin),
);
superAdminRouter.post('/admins/:userId/suspend', ...ownerOnly, adminParams, catchAsync(superAdminController.suspendPlatformAdmin));
superAdminRouter.post('/admins/:userId/activate', ...ownerOnly, adminParams, catchAsync(superAdminController.activatePlatformAdmin));
superAdminRouter.delete('/admins/:userId', ...ownerOnly, adminParams, catchAsync(superAdminController.removePlatformAdmin));
superAdminRouter.get('/admins/:userId/companies', ...ownerOnly, adminParams, catchAsync(superAdminController.getAdminCompanies));
superAdminRouter.put(
  '/admins/:userId/companies',
  ...ownerOnly,
  adminParams,
  validate(z.object({ organizationIds: z.array(entityId).max(1000) })),
  catchAsync(superAdminController.setAdminCompanies),
);
