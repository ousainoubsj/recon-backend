import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { catchAsync } from '../utils/catchAsync.js';
import * as auditLogController from '../controllers/auditLog.controller.js';

export const auditLogsRouter = Router();

const createAuditLogSchema = z.object({
  action: z.string().min(1).max(100),
  entityType: z.string().max(50).nullable().optional(),
  entityId: z.string().uuid().nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

auditLogsRouter.get(
  '/',
  authenticate,
  catchAsync(requirePermission('auditLog', 'read')),
  catchAsync(auditLogController.listAuditLogs),
);

auditLogsRouter.get(
  '/stats',
  authenticate,
  catchAsync(requirePermission('auditLog', 'read')),
  catchAsync(auditLogController.getAuditLogStats),
);

auditLogsRouter.get(
  '/top-actions',
  authenticate,
  catchAsync(requirePermission('auditLog', 'read')),
  catchAsync(auditLogController.getTopActions),
);

auditLogsRouter.get(
  '/top-users',
  authenticate,
  catchAsync(requirePermission('auditLog', 'read')),
  catchAsync(auditLogController.getTopUsers),
);

auditLogsRouter.post(
  '/',
  authenticate,
  catchAsync(requirePermission('auditLog', 'create')),
  validate(createAuditLogSchema),
  catchAsync(auditLogController.createAuditLog),
);
