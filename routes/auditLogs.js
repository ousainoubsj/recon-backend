import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/authorize.js';
import { catchAsync } from '../utils/catchAsync.js';
import * as auditLogController from '../controllers/auditLog.controller.js';

export const auditLogsRouter = Router();

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
