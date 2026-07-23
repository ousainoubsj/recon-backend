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

export async function listExports(userId, { limit } = {}) {
  const { organizationId } = await getUserMembership(userId);
  return prisma.reportExport.findMany({
    where: { organizationId },
    include: {
      report: { select: { name: true, fileAName: true, fileBName: true } },
      user: { select: { name: true } },
      template: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    ...(limit ? { take: limit } : {}),
  });
}
