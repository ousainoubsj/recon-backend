import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
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
