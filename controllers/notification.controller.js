import * as notificationService from '../services/notificationService.js';

export const listNotifications = async (req, res) => {
  const notifications = await notificationService.listNotifications(req.session.user.id);
  res.json(notifications);
};

export const getUnreadCount = async (req, res) => {
  const count = await notificationService.countUnread(req.session.user.id);
  res.json({ count });
};

export const markAsRead = async (req, res) => {
  await notificationService.markAsRead(req.session.user.id, req.params.id);
  res.status(204).end();
};

export const markAllAsRead = async (req, res) => {
  await notificationService.markAllAsRead(req.session.user.id);
  res.status(204).end();
};
