import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/authenticate.js';
import { validateParams, validateQuery } from '../middleware/validate.js';
import { catchAsync } from '../utils/catchAsync.js';
import * as notificationController from '../controllers/notification.controller.js';

// No RBAC resource here (unlike reports/files/audit-logs) — notifications
// are inherently per-recipient, not org-wide-visible, so every authenticated
// user manages only their own regardless of role.
export const notificationsRouter = Router();

// A repeated query key arrives as an array, a single one as a string.
const typeList = z.preprocess((value) => (typeof value === 'string' ? [value] : value), z.array(z.string().max(100)).max(50)).optional();
const listQuerySchema = z.object({
  types: typeList,
  excludeTypes: typeList,
  limit: z.string().optional(),
  cursor: z.string().uuid().optional(),
});

notificationsRouter.get('/', authenticate, validateQuery(listQuerySchema), catchAsync(notificationController.listNotifications));

notificationsRouter.get('/unread-count', authenticate, catchAsync(notificationController.getUnreadCount));

notificationsRouter.post('/read-all', authenticate, catchAsync(notificationController.markAllAsRead));

notificationsRouter.post(
  '/:id/read',
  authenticate,
  validateParams(z.object({ id: z.string().uuid() })),
  catchAsync(notificationController.markAsRead),
);
