import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '../db/index.js';
import { NotFoundError } from '../errors.js';
import { r2 } from '../utils/r2Client.js';
import { getUserMembership } from './organizationService.js';

/**
 * Best-effort, like logAuditSafely right next to it in the controller — a
 * tracking-write failure must never turn an already-sent file download (or
 * a scheduled run's own error handling) into something worse.
 * @param {{reportId: string, userId: string, organizationId: string, templateId?: string|null, format: 'xlsx'|'pdf', fileSizeBytes?: number|null, source?: 'manual'|'scheduled', scheduleId?: string|null, status?: 'success'|'failed', errorMessage?: string|null, fileKey?: string|null}} entry
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
        fileKey: entry.fileKey ?? null,
      },
    });
  } catch (err) {
    console.error('Failed to record report export', entry.reportId, entry.format, err);
  }
}

// Direct server-side PUT (not presigned) — the caller already holds the
// generated buffer in memory, unlike the presign flows in
// files.controller.js/settings.controller.js which hand a browser a URL to
// PUT its own file to. Best-effort like recordExport: a storage failure
// shouldn't turn an already-sent export response into a hard error, so the
// caller wraps this and just proceeds without a fileKey on failure.
export async function uploadExportFile(key, buffer, contentType) {
  await r2.send(new PutObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key, Body: buffer, ContentType: contentType }));
}

// Org-scoped lookup for a redownload — mirrors getReport's
// `if (!x) throw new NotFoundError()` convention (recon-backend/services/reportService.js).
export async function getExportForDownload(userId, exportId) {
  const { organizationId } = await getUserMembership(userId);
  const exportRow = await prisma.reportExport.findFirst({ where: { id: exportId, organizationId } });
  if (!exportRow) throw new NotFoundError();
  return exportRow;
}

// Deletes the tracking row and, best-effort, its stored R2 object (a
// failure to delete the object shouldn't block removing the row the user
// asked to delete — same "don't let storage-side flakiness surface as a
// harder error" reasoning as uploadExportFile's caller).
export async function deleteExport(userId, exportId) {
  const { organizationId } = await getUserMembership(userId);
  const exportRow = await prisma.reportExport.findFirst({ where: { id: exportId, organizationId } });
  if (!exportRow) throw new NotFoundError();

  if (exportRow.fileKey) {
    try {
      await r2.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: exportRow.fileKey }));
    } catch (err) {
      console.error('Failed to delete export file from R2', exportRow.id, exportRow.fileKey, err);
    }
  }

  await prisma.reportExport.delete({ where: { id: exportId } });
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
      user: { select: { name: true, image: true } },
      template: { select: { name: true } },
    },
    orderBy: { createdAt: 'desc' },
    ...(offset ? { skip: offset } : {}),
    ...(limit ? { take: limit } : {}),
  });
}
