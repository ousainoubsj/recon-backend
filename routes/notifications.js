import { Router } from 'express';
import { authenticate } from '../middleware/authenticate.js';
import { catchAsync } from '../utils/catchAsync.js';
import * as notificationController from '../controllers/notification.controller.js';

// No RBAC resource here (unlike reports/files/audit-logs) — notifications
// are inherently per-recipient, not org-wide-visible, so every authenticated
// user manages only their own regardless of role.
export const notificationsRouter = Router();

notificationsRouter.get('/', authenticate, catchAsync(notificationController.listNotifications));

notificationsRouter.get('/unread-count', authenticate, catchAsync(notificationController.getUnreadCount));

notificationsRouter.post('/read-all', authenticate, catchAsync(notificationController.markAllAsRead));

notificationsRouter.post('/:id/read', authenticate, catchAsync(notificationController.markAsRead));
