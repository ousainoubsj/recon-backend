import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/authorize.js';
import { validate, validateParams } from '../middleware/validate.js';
import { catchAsync } from '../utils/catchAsync.js';
import * as teamController from '../controllers/team.controller.js';

export const teamRouter = Router();

teamRouter.get(
  '/members',
  authenticate,
  catchAsync(requirePermission('member', 'read')),
  catchAsync(teamController.listMembers),
);

teamRouter.get(
  '/stats',
  authenticate,
  catchAsync(requirePermission('member', 'read')),
  catchAsync(teamController.getTeamStats),
);

const updateMemberSchema = z.object({
  department: z.string().max(100).nullable().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

teamRouter.patch(
  '/members/:id',
  authenticate,
  catchAsync(requirePermission('member', 'update')),
  validate(updateMemberSchema),
  catchAsync(teamController.updateMember),
);

const updateMemberRoleSchema = z.object({
  role: z.enum(['admin', 'analyst', 'viewer']),
});

teamRouter.patch(
  '/members/:id/role',
  authenticate,
  catchAsync(requirePermission('member', 'update')),
  validate(updateMemberRoleSchema),
  catchAsync(teamController.updateMemberRole),
);

teamRouter.delete(
  '/members/:id',
  authenticate,
  catchAsync(requirePermission('member', 'delete')),
  catchAsync(teamController.removeMember),
);

teamRouter.get(
  '/departments',
  authenticate,
  catchAsync(requirePermission('member', 'read')),
  catchAsync(teamController.getDepartments),
);

const addDepartmentSchema = z.object({
  name: z.string().trim().min(1).max(100),
});

teamRouter.post(
  '/departments',
  authenticate,
  catchAsync(requirePermission('member', 'update')),
  validate(addDepartmentSchema),
  catchAsync(teamController.addDepartment),
);

const invitationParamsSchema = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

// No authenticate: the invitee isn't signed in yet. See teamService.getInvitationPreview.
teamRouter.get(
  '/invitations/:id/preview',
  validateParams(invitationParamsSchema),
  catchAsync(teamController.getInvitationPreview),
);
