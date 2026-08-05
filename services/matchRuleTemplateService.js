import { prisma } from '../config/prisma.config.js';
import { NotFoundError, AuthorisationError } from '../errors.js';
import { getUserMembership } from './organizationService.js';

// Template creation is admin-only (routes/matchRuleTemplates.js's
// 'matchRuleTemplate:create' permission), so in practice every template in
// an org belongs to an admin — an admin sees the full org catalog (to pick
// which one becomes the enforced default), not just their own. A non-admin
// only ever sees the org's enforced default (Organization.
// enforcedMatchRuleTemplateId), or nothing at all if no default is set —
// unassigned templates aren't visible to members before an admin designates
// one, since that designation is the only thing that makes a template
// "theirs" to use.
export async function listTemplates(userId) {
  const { organizationId, role } = await getUserMembership(userId);
  if (role === 'admin') {
    return prisma.matchRuleTemplate.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
    });
  }
  const org = await prisma.organization.findFirst({
    where: { id: organizationId },
    select: { enforcedMatchRuleTemplateId: true },
  });
  if (!org?.enforcedMatchRuleTemplateId) return [];
  const enforced = await prisma.matchRuleTemplate.findFirst({
    where: { id: org.enforcedMatchRuleTemplateId, organizationId },
  });
  return enforced ? [enforced] : [];
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

// Org-scoped (not creator-scoped) — template management is now a shared,
// admin-only catalog (see listTemplates), so any admin can delete any
// template in their org, not just the one they personally created.
export async function deleteTemplate(userId, templateId) {
  const { organizationId } = await getUserMembership(userId);
  const org = await prisma.organization.findFirst({
    where: { id: organizationId },
    select: { enforcedMatchRuleTemplateId: true },
  });
  if (org?.enforcedMatchRuleTemplateId === templateId) {
    throw new AuthorisationError('Cannot delete the org\'s enforced default template — clear the default first');
  }
  const { count } = await prisma.matchRuleTemplate.deleteMany({ where: { id: templateId, organizationId } });
  if (count === 0) throw new NotFoundError();
}

// Org-scoped (not creator-scoped) — a non-admin "using" the org's enforced
// default template doesn't own it, so this can't be scoped to the caller's
// own templates the way it used to be.
export async function recordUsage(userId, templateId) {
  const { organizationId } = await getUserMembership(userId);
  const { count } = await prisma.matchRuleTemplate.updateMany({
    where: { id: templateId, organizationId },
    data: { lastUsedAt: new Date(), useCount: { increment: 1 } },
  });
  if (count === 0) throw new NotFoundError();
}
