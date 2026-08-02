import { prisma } from '../config/prisma.config.js';
import { NotFoundError } from '../errors.js';
import { getUserMembership } from './organizationService.js';

// Unlike ReportTemplate (org-shared, with a system/seeded tier), a saved
// rule-config preset is personal to the user who saved it — "Save Template"
// in MatchingRulesSidebar has no sharing concept in the mock.
export async function listTemplates(userId) {
  const { organizationId } = await getUserMembership(userId);
  return prisma.matchRuleTemplate.findMany({
    where: { organizationId, userId },
    orderBy: { name: 'asc' },
  });
}

export async function createTemplate(userId, dto) {
  const { organizationId } = await getUserMembership(userId);
  return prisma.matchRuleTemplate.create({
    data: {
      organizationId,
      userId,
      name: dto.name,
      description: dto.description ?? null,
      config: dto.config,
    },
  });
}

export async function deleteTemplate(userId, templateId) {
  const { count } = await prisma.matchRuleTemplate.deleteMany({ where: { id: templateId, userId } });
  if (count === 0) throw new NotFoundError();
}

// Called when a template is selected to start a new reconciliation (not
// gated on that reconciliation later completing — see schema comment).
export async function recordUsage(userId, templateId) {
  const { count } = await prisma.matchRuleTemplate.updateMany({
    where: { id: templateId, userId },
    data: { lastUsedAt: new Date(), useCount: { increment: 1 } },
  });
  if (count === 0) throw new NotFoundError();
}
