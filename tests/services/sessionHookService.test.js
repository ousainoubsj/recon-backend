import { jest } from '@jest/globals';
import { repairActiveOrganization } from '../../services/sessionHookService.js';

function makePrisma({ member = null } = {}) {
  return {
    member: { findFirst: jest.fn().mockResolvedValue(member) },
    session: { update: jest.fn().mockResolvedValue({}) },
  };
}

describe('repairActiveOrganization', () => {
  it('does nothing when there is no session', async () => {
    const prisma = makePrisma();

    await repairActiveOrganization(null, { prisma });

    expect(prisma.member.findFirst).not.toHaveBeenCalled();
  });

  it('does nothing when the session already has an active organization', async () => {
    const prisma = makePrisma();

    await repairActiveOrganization({ id: 's1', userId: 'u1', activeOrganizationId: 'org-1' }, { prisma });

    expect(prisma.member.findFirst).not.toHaveBeenCalled();
    expect(prisma.session.update).not.toHaveBeenCalled();
  });

  it('does nothing when the user has no organization membership yet', async () => {
    const prisma = makePrisma({ member: null });

    await repairActiveOrganization({ id: 's1', userId: 'u1', activeOrganizationId: null }, { prisma });

    expect(prisma.member.findFirst).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      select: { organizationId: true },
    });
    expect(prisma.session.update).not.toHaveBeenCalled();
  });

  it("sets activeOrganizationId from the user's membership when missing", async () => {
    const prisma = makePrisma({ member: { organizationId: 'org-1' } });

    await repairActiveOrganization({ id: 's1', userId: 'u1', activeOrganizationId: null }, { prisma });

    expect(prisma.session.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { activeOrganizationId: 'org-1' },
    });
  });
});
