import { jest } from '@jest/globals';

const mockPrisma = {
  reportTemplate: {
    findMany: jest.fn(),
    create: jest.fn(),
    deleteMany: jest.fn(),
    findFirst: jest.fn(),
  },
  member: { findFirst: jest.fn() },
};

jest.unstable_mockModule('../../config/prisma.config.js', () => ({ prisma: mockPrisma }));

const { listTemplates, createTemplate, deleteTemplate, resolveSections, SECTION_KEYS } = await import(
  '../../services/reportTemplateService.js'
);
const { NotFoundError } = await import('../../errors.js');

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
});

describe('listTemplates', () => {
  it('lists system templates plus the org\'s own, system-first', async () => {
    const templates = [{ id: 't1', isSystem: true }, { id: 't2', isSystem: false }];
    mockPrisma.reportTemplate.findMany.mockResolvedValue(templates);

    const result = await listTemplates(USER_ID);

    expect(result).toBe(templates);
    expect(mockPrisma.reportTemplate.findMany).toHaveBeenCalledWith({
      where: { OR: [{ organizationId: null }, { organizationId: ORG_ID }] },
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    });
  });
});

describe('createTemplate', () => {
  it('creates an org-scoped, non-system template with default-filled sections', async () => {
    mockPrisma.reportTemplate.create.mockResolvedValue({ id: 't1' });

    await createTemplate(USER_ID, { name: 'My Template', sections: { summary: false } });

    expect(mockPrisma.reportTemplate.create).toHaveBeenCalledWith({
      data: {
        organizationId: ORG_ID,
        isSystem: false,
        name: 'My Template',
        description: null,
        sections: {
          summary: false,
          matchStatistics: true,
          breakAnalysis: true,
          unmatchedDetails: true,
          chartsAndGraphs: true,
        },
      },
    });
  });
});

describe('deleteTemplate', () => {
  it("deletes the org's own template", async () => {
    mockPrisma.reportTemplate.deleteMany.mockResolvedValue({ count: 1 });

    await expect(deleteTemplate(USER_ID, 't1')).resolves.toBeUndefined();
    expect(mockPrisma.reportTemplate.deleteMany).toHaveBeenCalledWith({ where: { id: 't1', organizationId: ORG_ID } });
  });

  it('throws NotFoundError for a system template (organizationId never matches) or anything not owned', async () => {
    mockPrisma.reportTemplate.deleteMany.mockResolvedValue({ count: 0 });

    await expect(deleteTemplate(USER_ID, 'system-template')).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('resolveSections', () => {
  it('defaults every section to true when nothing is given', async () => {
    const sections = await resolveSections({ organizationId: ORG_ID });

    expect(sections).toEqual(Object.fromEntries(SECTION_KEYS.map((key) => [key, true])));
  });

  it("uses the template's sections when a visible templateId is given", async () => {
    mockPrisma.reportTemplate.findFirst.mockResolvedValue({
      id: 't1',
      sections: { summary: true, matchStatistics: false, breakAnalysis: false, unmatchedDetails: false, chartsAndGraphs: false },
    });

    const sections = await resolveSections({ organizationId: ORG_ID, templateId: 't1' });

    expect(mockPrisma.reportTemplate.findFirst).toHaveBeenCalledWith({
      where: { id: 't1', OR: [{ organizationId: null }, { organizationId: ORG_ID }] },
    });
    expect(sections.matchStatistics).toBe(false);
  });

  it('throws NotFoundError when the template is missing or not visible to the org', async () => {
    mockPrisma.reportTemplate.findFirst.mockResolvedValue(null);

    await expect(resolveSections({ organizationId: ORG_ID, templateId: 'missing' })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('lets an explicit override win over both the template and the defaults, per key', async () => {
    mockPrisma.reportTemplate.findFirst.mockResolvedValue({
      id: 't1',
      sections: { summary: true, matchStatistics: true, breakAnalysis: true, unmatchedDetails: true, chartsAndGraphs: true },
    });

    const sections = await resolveSections({
      organizationId: ORG_ID,
      templateId: 't1',
      overrideSections: { summary: false },
    });

    expect(sections).toEqual({
      summary: false,
      matchStatistics: true,
      breakAnalysis: true,
      unmatchedDetails: true,
      chartsAndGraphs: true,
    });
  });
});
