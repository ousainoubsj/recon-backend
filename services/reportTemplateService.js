import { prisma } from '../db/index.js';
import { NotFoundError } from '../errors.js';
import { getUserMembership } from './organizationService.js';

export const SECTION_KEYS = ['summary', 'matchStatistics', 'breakAnalysis', 'unmatchedDetails', 'chartsAndGraphs'];

const DEFAULT_SECTIONS = Object.fromEntries(SECTION_KEYS.map((key) => [key, true]));

// System templates (organizationId: null) are visible to every org; deleting
// scopes to { id, organizationId } so a system template's id never matches
// and 404s like any other not-owned resource — no special-casing needed.
export async function listTemplates(userId) {
  const { organizationId } = await getUserMembership(userId);
  return prisma.reportTemplate.findMany({
    where: { OR: [{ organizationId: null }, { organizationId }] },
    orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
  });
}

export async function createTemplate(userId, dto) {
  const { organizationId } = await getUserMembership(userId);
  return prisma.reportTemplate.create({
    data: {
      organizationId,
      isSystem: false,
      name: dto.name,
      description: dto.description ?? null,
      sections: { ...DEFAULT_SECTIONS, ...(dto.sections ?? {}) },
    },
  });
}

export async function deleteTemplate(userId, templateId) {
  const { organizationId } = await getUserMembership(userId);
  const { count } = await prisma.reportTemplate.deleteMany({ where: { id: templateId, organizationId } });
  if (count === 0) throw new NotFoundError();
}

/**
 * Resolves the final section-inclusion config for an export: all-true
 * defaults, overlaid by a template's saved sections (if given and visible to
 * the caller's org), overlaid by an explicit per-export override (if given).
 * @param {{organizationId: string, templateId?: string|null, overrideSections?: object|null}} args
 */
export async function resolveSections({ organizationId, templateId, overrideSections }) {
  let sections = { ...DEFAULT_SECTIONS };

  if (templateId) {
    const template = await prisma.reportTemplate.findFirst({
      where: { id: templateId, OR: [{ organizationId: null }, { organizationId }] },
    });
    if (!template) throw new NotFoundError();
    sections = { ...sections, ...template.sections };
  }

  if (overrideSections) sections = { ...sections, ...overrideSections };

  return sections;
}

// For display only (e.g. the PDF report header) — same visibility rule as
// resolveSections, but a missing/invisible template quietly resolves to
// null here rather than 404ing (resolveSections already validates this
// exact templateId earlier in the same request; this is presentational).
export async function getTemplateName(organizationId, templateId) {
  if (!templateId) return null;
  const template = await prisma.reportTemplate.findFirst({
    where: { id: templateId, OR: [{ organizationId: null }, { organizationId }] },
    select: { name: true },
  });
  return template?.name ?? null;
}
