import { jest } from '@jest/globals';

const mockPrisma = {
  notification: {
    create: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    updateMany: jest.fn(),
  },
  member: { findFirst: jest.fn() },
};

jest.unstable_mockModule('../../db/index.js', () => ({ prisma: mockPrisma }));

const { createNotification, listNotifications, countUnread, markAsRead, markAllAsRead } = await import(
  '../../services/notificationService.js'
);
const { NotFoundError } = await import('../../errors.js');

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
});

describe('createNotification', () => {
  it("creates an entry scoped to the recipient's organization", async () => {
    mockPrisma.notification.create.mockResolvedValue({ id: 'n1' });

    await createNotification(USER_ID, {
      type: 'member.role_changed',
      message: 'Your role was changed to admin.',
      entityType: 'member',
      entityId: 'member-1',
    });

    expect(mockPrisma.notification.create).toHaveBeenCalledWith({
      data: {
        userId: USER_ID,
        organizationId: ORG_ID,
        type: 'member.role_changed',
        message: 'Your role was changed to admin.',
        entityType: 'member',
        entityId: 'member-1',
      },
    });
  });

  it('is best-effort — swallows and logs the error instead of throwing', async () => {
    mockPrisma.notification.create.mockRejectedValue(new Error('db unavailable'));
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(createNotification(USER_ID, { type: 'x', message: 'y' })).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });
});

describe('listNotifications', () => {
  it("lists the caller's own notifications, newest first", async () => {
    const notifications = [{ id: 'n1' }, { id: 'n2' }];
    mockPrisma.notification.findMany.mockResolvedValue(notifications);

    const result = await listNotifications(USER_ID);

    expect(result).toBe(notifications);
    expect(mockPrisma.notification.findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: { createdAt: 'desc' },
    });
  });
});

describe('countUnread', () => {
  it('counts unread notifications for the caller', async () => {
    mockPrisma.notification.count.mockResolvedValue(3);

    const result = await countUnread(USER_ID);

    expect(result).toBe(3);
    expect(mockPrisma.notification.count).toHaveBeenCalledWith({ where: { userId: USER_ID, read: false } });
  });
});

describe('markAsRead', () => {
  it('marks the notification read when it belongs to the caller', async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 1 });

    await expect(markAsRead(USER_ID, 'n1')).resolves.toBeUndefined();
    expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
      where: { id: 'n1', userId: USER_ID },
      data: { read: true },
    });
  });

  it("throws NotFoundError when it doesn't belong to the caller or doesn't exist", async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 0 });

    await expect(markAsRead(USER_ID, 'missing')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('markAllAsRead', () => {
  it('marks every unread notification for the caller as read', async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 2 });

    await markAllAsRead(USER_ID);

    expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, read: false },
      data: { read: true },
    });
  });
});
