import { jest } from '@jest/globals';

const mockPrisma = {
  matchRuleTemplate: {
    findMany: jest.fn(),
    create: jest.fn(),
    deleteMany: jest.fn(),
    updateMany: jest.fn(),
  },
  member: { findFirst: jest.fn() },
};

jest.unstable_mockModule('../../db/index.js', () => ({ prisma: mockPrisma }));

const { listTemplates, createTemplate, deleteTemplate, recordUsage } = await import('../../services/matchRuleTemplateService.js');
const { NotFoundError } = await import('../../errors.js');

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
});

describe('listTemplates', () => {
  it("lists only the caller's own templates in the org, alphabetically", async () => {
    const templates = [{ id: 't1', name: 'A' }];
    mockPrisma.matchRuleTemplate.findMany.mockResolvedValue(templates);

    const result = await listTemplates(USER_ID);

    expect(result).toBe(templates);
    expect(mockPrisma.matchRuleTemplate.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, userId: USER_ID },
      orderBy: { name: 'asc' },
    });
  });
});

describe('createTemplate', () => {
  it('creates a template scoped to the caller and their org', async () => {
    mockPrisma.matchRuleTemplate.create.mockResolvedValue({ id: 't1' });
    const config = { amountTolerance: 0.5, dateToleranceDays: 1 };

    await createTemplate(USER_ID, { name: 'Bank Recon Rules', config });

    expect(mockPrisma.matchRuleTemplate.create).toHaveBeenCalledWith({
      data: { organizationId: ORG_ID, userId: USER_ID, name: 'Bank Recon Rules', description: null, config },
    });
  });
});

describe('deleteTemplate', () => {
  it("deletes the caller's own template", async () => {
    mockPrisma.matchRuleTemplate.deleteMany.mockResolvedValue({ count: 1 });

    await expect(deleteTemplate(USER_ID, 't1')).resolves.toBeUndefined();
    expect(mockPrisma.matchRuleTemplate.deleteMany).toHaveBeenCalledWith({ where: { id: 't1', userId: USER_ID } });
  });

  it("throws NotFoundError for another user's template", async () => {
    mockPrisma.matchRuleTemplate.deleteMany.mockResolvedValue({ count: 0 });

    await expect(deleteTemplate(USER_ID, 'not-mine')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('recordUsage', () => {
  it("bumps lastUsedAt and useCount on the caller's own template", async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-29T12:00:00Z'));
    mockPrisma.matchRuleTemplate.updateMany.mockResolvedValue({ count: 1 });

    await expect(recordUsage(USER_ID, 't1')).resolves.toBeUndefined();

    expect(mockPrisma.matchRuleTemplate.updateMany).toHaveBeenCalledWith({
      where: { id: 't1', userId: USER_ID },
      data: { lastUsedAt: new Date('2026-07-29T12:00:00Z'), useCount: { increment: 1 } },
    });
    jest.useRealTimers();
  });

  it("throws NotFoundError for another user's template", async () => {
    mockPrisma.matchRuleTemplate.updateMany.mockResolvedValue({ count: 0 });

    await expect(recordUsage(USER_ID, 'not-mine')).rejects.toBeInstanceOf(NotFoundError);
  });
});
