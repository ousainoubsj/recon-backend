import { prisma } from '../db/index.js';
import { NotFoundError } from '../errors.js';

/**
 * @param {string} userId
 * @param {import('../types/recon.js').SaveReportDto} dto
 * @returns {Promise<string>} the new report's id
 */
export async function saveReport(userId, dto) {
  const report = await prisma.$transaction(async (tx) => {
    // 1. Insert summary row
    const report = await tx.report.create({
      data: {
        userId,
        fileAName: dto.fileAName,
        fileBName: dto.fileBName,
        totalRows: dto.summary.total,
        matchedCount: dto.summary.matched,
        unmatchedCount: dto.summary.unmatchedA + dto.summary.unmatchedB,
        mismatchedCount: dto.summary.mismatched,
        duplicateCount: dto.summary.duplicates,
        amountTolerance: dto.config.amountTolerance,
        dateToleranceDays: dto.config.dateToleranceDays ?? null,
        config: dto.config,
      },
    });

    // 2. Bulk-insert rows (createMany = single INSERT statement).
    // amountDiff is computed here rather than via a Postgres GENERATED
    // column — see the note at the top of prisma/schema.prisma.
    await tx.reportRow.createMany({
      data: dto.rows.map((r) => ({
        reportId: report.id,
        ref: r.ref,
        status: r.status,
        amountA: r.amountA,
        amountB: r.amountB,
        amountDiff: r.amountA != null && r.amountB != null ? r.amountA - r.amountB : null,
        dateA: r.dateA ? new Date(r.dateA) : null,
        dateB: r.dateB ? new Date(r.dateB) : null,
        rawA: r.rawA ?? undefined,
        rawB: r.rawB ?? undefined,
      })),
    });

    return report;
  });

  return report.id;
}

export async function listReports(userId) {
  return prisma.report.findMany({
    where: { userId },
    orderBy: { runDate: 'desc' },
  });
}

export async function getReport(userId, reportId) {
  const report = await prisma.report.findFirst({
    where: { id: reportId, userId },
    include: { rows: true },
  });
  if (!report) throw new NotFoundError();
  return report;
}

export async function deleteReport(userId, reportId) {
  const { count } = await prisma.report.deleteMany({ where: { id: reportId, userId } });
  if (count === 0) throw new NotFoundError();
}
