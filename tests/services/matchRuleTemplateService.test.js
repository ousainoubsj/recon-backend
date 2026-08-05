import { jest } from '@jest/globals';

const mockPrisma = {
  matchRuleTemplate: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    deleteMany: jest.fn(),
    updateMany: jest.fn(),
  },
  organization: { findFirst: jest.fn() },
  member: { findFirst: jest.fn() },
};

jest.unstable_mockModule('../../config/prisma.config.js', () => ({ prisma: mockPrisma }));

const { listTemplates, createTemplate, deleteTemplate, recordUsage } = await import('../../services/matchRuleTemplateService.js');
const { NotFoundError, AuthorisationError } = await import('../../errors.js');

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
});

describe('listTemplates', () => {
  it('lists every template in the org, alphabetically, for an admin', async () => {
    mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'admin' });
    const templates = [{ id: 't1', name: 'A' }];
    mockPrisma.matchRuleTemplate.findMany.mockResolvedValue(templates);

    const result = await listTemplates(USER_ID);

    expect(result).toBe(templates);
    expect(mockPrisma.matchRuleTemplate.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID },
      orderBy: { name: 'asc' },
    });
  });

  it("returns only the org's enforced default template for a non-admin", async () => {
    mockPrisma.organization.findFirst.mockResolvedValue({ enforcedMatchRuleTemplateId: 't1' });
    const enforced = { id: 't1', name: 'Standard Rules' };
    mockPrisma.matchRuleTemplate.findFirst.mockResolvedValue(enforced);

    const result = await listTemplates(USER_ID);

    expect(result).toEqual([enforced]);
    expect(mockPrisma.matchRuleTemplate.findFirst).toHaveBeenCalledWith({
      where: { id: 't1', organizationId: ORG_ID },
    });
  });

  it('returns an empty list for a non-admin when the org has no enforced default', async () => {
    mockPrisma.organization.findFirst.mockResolvedValue({ enforcedMatchRuleTemplateId: null });

    const result = await listTemplates(USER_ID);

    expect(result).toEqual([]);
    expect(mockPrisma.matchRuleTemplate.findFirst).not.toHaveBeenCalled();
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
  it('deletes a template in the org', async () => {
    mockPrisma.organization.findFirst.mockResolvedValue({ enforcedMatchRuleTemplateId: null });
    mockPrisma.matchRuleTemplate.deleteMany.mockResolvedValue({ count: 1 });

    await expect(deleteTemplate(USER_ID, 't1')).resolves.toBeUndefined();
    expect(mockPrisma.matchRuleTemplate.deleteMany).toHaveBeenCalledWith({ where: { id: 't1', organizationId: ORG_ID } });
  });

  it("throws NotFoundError for another org's template", async () => {
    mockPrisma.organization.findFirst.mockResolvedValue({ enforcedMatchRuleTemplateId: null });
    mockPrisma.matchRuleTemplate.deleteMany.mockResolvedValue({ count: 0 });

    await expect(deleteTemplate(USER_ID, 'not-mine')).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws AuthorisationError when deleting the org's enforced default template", async () => {
    mockPrisma.organization.findFirst.mockResolvedValue({ enforcedMatchRuleTemplateId: 't1' });

    await expect(deleteTemplate(USER_ID, 't1')).rejects.toBeInstanceOf(AuthorisationError);
    expect(mockPrisma.matchRuleTemplate.deleteMany).not.toHaveBeenCalled();
  });
});

describe('recordUsage', () => {
  it('bumps lastUsedAt and useCount on a template in the org', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-29T12:00:00Z'));
    mockPrisma.matchRuleTemplate.updateMany.mockResolvedValue({ count: 1 });

    await expect(recordUsage(USER_ID, 't1')).resolves.toBeUndefined();

    expect(mockPrisma.matchRuleTemplate.updateMany).toHaveBeenCalledWith({
      where: { id: 't1', organizationId: ORG_ID },
      data: { lastUsedAt: new Date('2026-07-29T12:00:00Z'), useCount: { increment: 1 } },
    });
    jest.useRealTimers();
  });

  it("throws NotFoundError for another org's template", async () => {
    mockPrisma.matchRuleTemplate.updateMany.mockResolvedValue({ count: 0 });

    await expect(recordUsage(USER_ID, 'not-mine')).rejects.toBeInstanceOf(NotFoundError);
  });
});
