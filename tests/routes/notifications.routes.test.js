import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const USER_ID = 'user-1';

jest.unstable_mockModule('../../middleware/authenticate.js', () => ({
  authenticate: (req, res, next) => {
    req.session = { user: { id: USER_ID } };
    next();
  },
}));

const mockNotificationService = {
  listNotifications: jest.fn(),
  countUnread: jest.fn(),
  markAsRead: jest.fn(),
  markAllAsRead: jest.fn(),
};

jest.unstable_mockModule('../../services/notificationService.js', () => mockNotificationService);

const { notificationsRouter } = await import('../../routes/notifications.js');
const { errorHandler } = await import('../../middleware/errorHandler.js');
const { NotFoundError } = await import('../../errors.js');

const app = express();
app.use(express.json());
app.use('/api/notifications', notificationsRouter);
app.use(errorHandler);

beforeEach(() => jest.clearAllMocks());

describe('GET /api/notifications', () => {
  it("returns the caller's own notifications", async () => {
    mockNotificationService.listNotifications.mockResolvedValue([{ id: 'n1' }]);

    const res = await request(app).get('/api/notifications');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'n1' }]);
    expect(mockNotificationService.listNotifications).toHaveBeenCalledWith(USER_ID);
  });
});

describe('GET /api/notifications/unread-count', () => {
  it('returns the unread count', async () => {
    mockNotificationService.countUnread.mockResolvedValue(3);

    const res = await request(app).get('/api/notifications/unread-count');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ count: 3 });
  });
});

describe('POST /api/notifications/:id/read', () => {
  it('marks a notification read and returns 204', async () => {
    mockNotificationService.markAsRead.mockResolvedValue(undefined);

    const res = await request(app).post('/api/notifications/n1/read');

    expect(res.status).toBe(204);
    expect(mockNotificationService.markAsRead).toHaveBeenCalledWith(USER_ID, 'n1');
  });

  it('returns an RFC 7807 404 when not found or not owned', async () => {
    mockNotificationService.markAsRead.mockRejectedValue(new NotFoundError());

    const res = await request(app).post('/api/notifications/missing/read');

    expect(res.status).toBe(404);
    expect(res.body.type).toBe('https://recon.app/errors/not-found');
  });
});

describe('POST /api/notifications/read-all', () => {
  it('marks every unread notification read and returns 204', async () => {
    mockNotificationService.markAllAsRead.mockResolvedValue(undefined);

    const res = await request(app).post('/api/notifications/read-all');

    expect(res.status).toBe(204);
    expect(mockNotificationService.markAllAsRead).toHaveBeenCalledWith(USER_ID);
  });
});
