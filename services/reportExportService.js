import { prisma } from '../db/index.js';
import { getUserMembership } from './organizationService.js';

/**
 * Best-effort, like logAuditSafely right next to it in the controller — a
 * tracking-write failure must never turn an already-sent file download (or
 * a scheduled run's own error handling) into something worse.
 * @param {{reportId: string, userId: string, organizationId: string, templateId?: string|null, format: 'xlsx'|'pdf', fileSizeBytes?: number|null, source?: 'manual'|'scheduled', scheduleId?: string|null, status?: 'success'|'failed', errorMessage?: string|null}} entry
 */
export async function recordExport(entry) {
  try {
    await prisma.reportExport.create({
      data: {
        reportId: entry.reportId,
        userId: entry.userId,
        organizationId: entry.organizationId,
        templateId: entry.templateId ?? null,
        scheduleId: entry.scheduleId ?? null,
        source: entry.source ?? 'manual',
        format: entry.format,
        status: entry.status ?? 'success',
        errorMessage: entry.errorMessage ?? null,
        fileSizeBytes: entry.fileSizeBytes ?? null,
      },
    });
  } catch (err) {
    console.error('Failed to record report export', entry.reportId, entry.format, err);
  }
}

export async function listExports(userId, { limit, offset, q } = {}) {
  const { organizationId } = await getUserMembership(userId);
  const query = q?.trim();

  return prisma.reportExport.findMany({
    where: {
      organizationId,
      // Matches RecentExports.tsx's search box copy: "by report name or reconciliation"
      ...(query
        ? {
            report: {
              OR: [
                { name: { contains: query, mode: 'insensitive' } },
                { fileAName: { contains: query, mode: 'insensitive' } },
                { fileBName: { contains: query, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    },
    include: {
      report: { select: { name: true, fileAName: true, fileBName: true } },
      user: { select: { name: true } },
      template: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    ...(offset ? { skip: offset } : {}),
    ...(limit ? { take: limit } : {}),
  });
}
