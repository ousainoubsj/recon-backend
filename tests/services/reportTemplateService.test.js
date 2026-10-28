import { jest } from '@jest/globals';

const mockPrisma = {
  reportTemplate: {
    findMany: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    create: jest.fn(),
    deleteMany: jest.fn(),
    findFirst: jest.fn(),
  },
  member: { findFirst: jest.fn() },
};

jest.unstable_mockModule('../../config/prisma.config.js', () => ({ prisma: mockPrisma }));

const mockLogAuditSafely = jest.fn().mockResolvedValue(undefined);
jest.unstable_mockModule('../../services/auditLogService.js', () => ({ logAuditSafely: mockLogAuditSafely }));

const { listTemplates, createTemplate, deleteTemplate, resolveSections, SECTION_KEYS } = await import(
  '../../services/reportTemplateService.js'
);
const { ConflictError, NotFoundError } = await import('../../errors.js');

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
  it('refuses a new template once the org has 100, without creating it', async () => {
    mockPrisma.reportTemplate.count.mockResolvedValueOnce(100);

    await expect(createTemplate(USER_ID, { name: 'One too many', config: {}, sections: {} })).rejects.toBeInstanceOf(ConflictError);
    expect(mockPrisma.reportTemplate.count).toHaveBeenCalledWith({ where: { organizationId: expect.any(String) } });
    expect(mockPrisma.reportTemplate.create).not.toHaveBeenCalled();
  });

  it('creates an org-scoped, non-system template with default-filled sections', async () => {
    mockPrisma.reportTemplate.create.mockResolvedValue({
      id: 't1',
      name: 'My Template',
      sections: { summary: false, matchStatistics: true, breakAnalysis: true, unmatchedDetails: true, chartsAndGraphs: true },
    });

    await createTemplate(USER_ID, { name: 'My Template', sections: { summary: false } }, { ip: '10.0.0.1', userAgent: 'UA' });

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
    expect(mockLogAuditSafely).toHaveBeenCalledWith(USER_ID, {
      action: 'reportTemplate.create',
      entityType: 'reportTemplate',
      entityId: 't1',
      ip: '10.0.0.1',
      userAgent: 'UA',
      metadata: {
        sections: ['matchStatistics', 'breakAnalysis', 'unmatchedDetails', 'chartsAndGraphs'],
        subject: { name: 'My Template' },
      },
    });
  });
});

describe('deleteTemplate', () => {
  it("deletes the org's own template", async () => {
    mockPrisma.reportTemplate.findFirst.mockResolvedValue({ name: 'Monthly Pack' });
    mockPrisma.reportTemplate.deleteMany.mockResolvedValue({ count: 1 });

    await expect(deleteTemplate(USER_ID, 't1')).resolves.toBeUndefined();
    expect(mockPrisma.reportTemplate.deleteMany).toHaveBeenCalledWith({ where: { id: 't1', organizationId: ORG_ID } });
    expect(mockLogAuditSafely).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ action: 'reportTemplate.delete', entityId: 't1', metadata: { subject: { name: 'Monthly Pack' } } }),
    );
  });

  it('throws NotFoundError for a system template (organizationId never matches) or anything not owned', async () => {
    mockPrisma.reportTemplate.findFirst.mockResolvedValue(null);

    await expect(deleteTemplate(USER_ID, 'system-template')).rejects.toBeInstanceOf(NotFoundError);
    expect(mockPrisma.reportTemplate.deleteMany).not.toHaveBeenCalled();
    expect(mockLogAuditSafely).not.toHaveBeenCalled();
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
