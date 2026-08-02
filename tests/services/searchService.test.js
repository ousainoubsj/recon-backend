import { jest } from '@jest/globals';

const mockPrisma = {
  report: { findMany: jest.fn() },
  member: { findMany: jest.fn(), findFirst: jest.fn() },
};

jest.unstable_mockModule('../../config/prisma.config.js', () => ({ prisma: mockPrisma }));

const { search } = await import('../../services/searchService.js');

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.member.findFirst.mockResolvedValue({ organizationId: ORG_ID, role: 'analyst' });
});

describe('search', () => {
  it('returns empty results without querying when the query is empty or whitespace', async () => {
    const result = await search(USER_ID, '   ');

    expect(result).toEqual({ reports: [], members: [] });
    expect(mockPrisma.report.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.member.findMany).not.toHaveBeenCalled();
  });

  it('searches reports by file name and members by name/email, scoped to the org', async () => {
    const reports = [{ id: 'r1', fileAName: 'Bank_June.csv', fileBName: 'Internal_June.csv' }];
    const members = [{ id: 'm1', role: 'admin', user: { id: 'u2', name: 'Amie J.', email: 'amie@example.com' } }];
    mockPrisma.report.findMany.mockResolvedValue(reports);
    mockPrisma.member.findMany.mockResolvedValue(members);

    const result = await search(USER_ID, 'amie');

    expect(result).toEqual({ reports, members });
    expect(mockPrisma.report.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG_ID,
        status: 'completed',
        OR: [
          { fileAName: { contains: 'amie', mode: 'insensitive' } },
          { fileBName: { contains: 'amie', mode: 'insensitive' } },
        ],
      },
      select: { id: true, fileAName: true, fileBName: true, runDate: true },
      orderBy: { runDate: 'desc' },
      take: 5,
    });
    expect(mockPrisma.member.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG_ID,
        user: { OR: [{ name: { contains: 'amie', mode: 'insensitive' } }, { email: { contains: 'amie', mode: 'insensitive' } }] },
      },
      select: { id: true, role: true, user: { select: { id: true, name: true, email: true } } },
      take: 5,
    });
  });

  it('trims the query before searching', async () => {
    mockPrisma.report.findMany.mockResolvedValue([]);
    mockPrisma.member.findMany.mockResolvedValue([]);

    await search(USER_ID, '  bank  ');

    expect(mockPrisma.report.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: [{ fileAName: { contains: 'bank', mode: 'insensitive' } }, { fileBName: { contains: 'bank', mode: 'insensitive' } }] }),
      }),
    );
  });
});
