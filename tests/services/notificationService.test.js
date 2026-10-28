import { jest } from '@jest/globals';

const mockPrisma = {
  notification: {
    create: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
    groupBy: jest.fn(),
    updateMany: jest.fn(),
  },
  member: { findFirst: jest.fn() },
};

jest.unstable_mockModule('../../config/prisma.config.js', () => ({ prisma: mockPrisma }));

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
  beforeEach(() => {
    mockPrisma.notification.count.mockResolvedValue(3);
    mockPrisma.notification.groupBy.mockResolvedValue([
      { type: 'report.deleted_by_admin', _count: { _all: 2 } },
      { type: 'member.role_changed', _count: { _all: 1 } },
    ]);
  });

  it("returns one page of the caller's own notifications, newest first, with per-type counts", async () => {
    mockPrisma.notification.findMany.mockResolvedValue([{ id: 'n1' }, { id: 'n2' }]);

    const result = await listNotifications(USER_ID, { limit: 2 });

    expect(mockPrisma.notification.findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
    });
    expect(mockPrisma.notification.groupBy).toHaveBeenCalledWith({ by: ['type'], where: { userId: USER_ID }, _count: { _all: true } });
    expect(result).toEqual({
      items: [{ id: 'n1' }, { id: 'n2' }],
      total: 3,
      nextCursor: null,
      countsByType: { 'report.deleted_by_admin': 2, 'member.role_changed': 1 },
    });
  });

  it('returns the last row as the next cursor when another page exists, and continues after a cursor', async () => {
    mockPrisma.notification.findMany.mockResolvedValue([{ id: 'n1' }, { id: 'n2' }, { id: 'n3' }]);

    const first = await listNotifications(USER_ID, { limit: 2 });
    await listNotifications(USER_ID, { limit: 2, cursor: 'n2' });

    expect(first.items).toEqual([{ id: 'n1' }, { id: 'n2' }]);
    expect(first.nextCursor).toBe('n2');
    expect(mockPrisma.notification.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: { id: 'n2' }, skip: 1 }));
  });

  it('filters to the given types, or everything but the excluded ones, still scoped to the caller', async () => {
    mockPrisma.notification.findMany.mockResolvedValue([]);

    await listNotifications(USER_ID, { types: ['report.deleted_by_admin'] });
    await listNotifications(USER_ID, { excludeTypes: ['report.deleted_by_admin'] });

    const [[included], [excluded]] = mockPrisma.notification.findMany.mock.calls;
    expect(included.where).toEqual({ userId: USER_ID, type: { in: ['report.deleted_by_admin'] } });
    expect(excluded.where).toEqual({ userId: USER_ID, type: { notIn: ['report.deleted_by_admin'] } });
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
