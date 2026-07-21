import { prisma } from '../db/index.js';
import { NotFoundError } from '../errors.js';
import { getUserMembership } from './organizationService.js';
import { logAuditSafely } from './auditLogService.js';
import { createNotification } from './notificationService.js';

const toNum = (decimal) => (decimal == null ? 0 : Number(decimal));

function deltaPercent(current, previous) {
  if (previous === 0) return null; // no baseline to compare against
  return ((current - previous) / previous) * 100;
}

function monthRange(monthsAgo) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo + 1, 1));
  return { start, end };
}

// amountDiff is computed here rather than via a Postgres GENERATED column —
// see the note at the top of prisma/schema.prisma. Shared by saveReport and
// completeDraft since both bulk-insert rows the same way.
function reportRowsForInsert(reportId, rows) {
  return rows.map((r) => ({
    reportId,
    ref: r.ref,
    status: r.status,
    amountA: r.amountA,
    amountB: r.amountB,
    amountDiff: r.amountA != null && r.amountB != null ? r.amountA - r.amountB : null,
    dateA: r.dateA ? new Date(r.dateA) : null,
    dateB: r.dateB ? new Date(r.dateB) : null,
    rawA: r.rawA ?? undefined,
    rawB: r.rawB ?? undefined,
  }));
}

function aggregatePeriod(reports) {
  const count = reports.length;
  const totalRows = reports.reduce((sum, r) => sum + r.totalRows, 0);
  const matchedCount = reports.reduce((sum, r) => sum + r.matchedCount, 0);
  const unmatchedTransactions = reports.reduce((sum, r) => sum + r.unmatchedCount + r.mismatchedCount, 0);
  const totalBreakValue = reports.reduce((sum, r) => sum + toNum(r.totalBreakValue), 0);
  const avgMatchRate = totalRows > 0 ? (matchedCount / totalRows) * 100 : 0;

  return { count, totalTransactions: totalRows, avgMatchRate, unmatchedTransactions, totalBreakValue };
}

/**
 * @param {string} userId
 * @param {import('../types/recon.js').SaveReportDto} dto
 * @returns {Promise<string>} the new report's id
 */
export async function saveReport(userId, dto) {
  const { organizationId } = await getUserMembership(userId);

  const report = await prisma.$transaction(async (tx) => {
    // 1. Insert summary row
    const report = await tx.report.create({
      data: {
        userId,
        organizationId,
        name: dto.name ?? null,
        fileAName: dto.fileAName,
        fileBName: dto.fileBName,
        totalRows: dto.summary.total,
        matchedCount: dto.summary.matched,
        unmatchedCount: dto.summary.unmatchedA + dto.summary.unmatchedB,
        mismatchedCount: dto.summary.mismatched,
        duplicateCount: dto.summary.duplicates,
        totalBreakValue: dto.summary.totalBreakValue,
        amountTolerance: dto.config.amountTolerance,
        dateToleranceDays: dto.config.dateToleranceDays ?? null,
        config: dto.config,
      },
    });

    // 2. Bulk-insert rows (createMany = single INSERT statement).
    await tx.reportRow.createMany({ data: reportRowsForInsert(report.id, dto.rows) });

    return report;
  });

  await logAuditSafely(userId, { action: 'report.create', entityType: 'report', entityId: report.id });

  return report.id;
}

export async function listReports(userId, { limit } = {}) {
  const { organizationId } = await getUserMembership(userId);
  return prisma.report.findMany({
    where: { organizationId, status: 'completed' },
    orderBy: { runDate: 'desc' },
    ...(limit ? { take: limit } : {}),
  });
}

// Current vs previous calendar month, for the dashboard's headline stat
// cards (Total Reconciliations, Avg Match Rate, Unmatched Transactions,
// Total Break Value) — aggregated in JS over Report rows (one per run, so
// cheap) rather than a SQL-side aggregate, matching this codebase's existing
// preference for JS-side math (see amountDiff in saveReport above).
export async function getReportsSummary(userId) {
  const { organizationId } = await getUserMembership(userId);
  const current = monthRange(0);
  const previous = monthRange(1);

  const reports = await prisma.report.findMany({
    where: { organizationId, status: 'completed', runDate: { gte: previous.start, lt: current.end } },
    select: {
      runDate: true,
      totalRows: true,
      matchedCount: true,
      unmatchedCount: true,
      mismatchedCount: true,
      totalBreakValue: true,
    },
  });

  const currentReports = reports.filter((r) => r.runDate >= current.start);
  const previousReports = reports.filter((r) => r.runDate >= previous.start && r.runDate < previous.end);

  const currentStats = aggregatePeriod(currentReports);
  const previousStats = aggregatePeriod(previousReports);

  return {
    totalReconciliations: {
      current: currentStats.count,
      previous: previousStats.count,
      deltaPercent: deltaPercent(currentStats.count, previousStats.count),
    },
    avgMatchRate: {
      current: currentStats.avgMatchRate,
      previous: previousStats.avgMatchRate,
      deltaPercent: deltaPercent(currentStats.avgMatchRate, previousStats.avgMatchRate),
    },
    unmatchedTransactions: {
      current: currentStats.unmatchedTransactions,
      previous: previousStats.unmatchedTransactions,
      deltaPercent: deltaPercent(currentStats.unmatchedTransactions, previousStats.unmatchedTransactions),
    },
    totalBreakValue: {
      current: currentStats.totalBreakValue,
      previous: previousStats.totalBreakValue,
      deltaPercent: deltaPercent(currentStats.totalBreakValue, previousStats.totalBreakValue),
    },
    totalTransactions: currentStats.totalTransactions,
  };
}

// Monthly-bucketed series for the dashboard's charts: match-rate trend,
// reconciliation volume, and a category breakdown for the current month
// (matches ChartsOverview.tsx's "Breakdown by Category (This Month)").
// unmatchedCount already merges unmatched_a + unmatched_b at save time (see
// saveReport above), so the category breakdown here is a 4-way split
// (Matched / Mismatched / Unmatched / Duplicates), not the 5-way split that
// would need a per-ReportRow query.
export async function getReportsTrend(userId, { months = 6 } = {}) {
  const { organizationId } = await getUserMembership(userId);
  const { start } = monthRange(months - 1);

  const reports = await prisma.report.findMany({
    where: { organizationId, status: 'completed', runDate: { gte: start } },
    select: {
      runDate: true,
      totalRows: true,
      matchedCount: true,
      unmatchedCount: true,
      mismatchedCount: true,
      duplicateCount: true,
    },
  });

  const buckets = new Map();
  for (let i = months - 1; i >= 0; i--) {
    const { start: bucketStart } = monthRange(i);
    const key = `${bucketStart.getUTCFullYear()}-${String(bucketStart.getUTCMonth() + 1).padStart(2, '0')}`;
    buckets.set(key, []);
  }

  for (const report of reports) {
    const key = `${report.runDate.getUTCFullYear()}-${String(report.runDate.getUTCMonth() + 1).padStart(2, '0')}`;
    buckets.get(key)?.push(report);
  }

  const matchRateSeries = [];
  const volumeSeries = [];
  for (const [month, monthReports] of buckets) {
    const stats = aggregatePeriod(monthReports);
    matchRateSeries.push({ month, value: stats.avgMatchRate });
    volumeSeries.push({ month, value: stats.count });
  }

  const currentMonthReports = buckets.get([...buckets.keys()].at(-1)) ?? [];
  const categoryBreakdown = {
    matched: currentMonthReports.reduce((sum, r) => sum + r.matchedCount, 0),
    mismatched: currentMonthReports.reduce((sum, r) => sum + r.mismatchedCount, 0),
    unmatched: currentMonthReports.reduce((sum, r) => sum + r.unmatchedCount, 0),
    duplicates: currentMonthReports.reduce((sum, r) => sum + r.duplicateCount, 0),
  };

  return { matchRateSeries, volumeSeries, categoryBreakdown };
}

export async function getReport(userId, reportId) {
  const { organizationId } = await getUserMembership(userId);
  const report = await prisma.report.findFirst({
    where: { id: reportId, organizationId },
    include: { rows: true },
  });
  if (!report) throw new NotFoundError();
  // Drafts are private to their creator — org membership alone isn't enough,
  // unlike a completed report which is shared org-wide.
  if (report.status === 'draft' && report.userId !== userId) throw new NotFoundError();
  return report;
}

// A draft is a minimal Report row with no ReportRows yet — just enough to
// resume later (name, whichever files have been chosen, partial config,
// a progress percentage). Private to its creator, unlike a completed report.
export async function saveDraft(userId, dto) {
  const { organizationId } = await getUserMembership(userId);
  const report = await prisma.report.create({
    data: {
      userId,
      organizationId,
      status: 'draft',
      name: dto.name ?? null,
      fileAName: dto.fileAName ?? null,
      fileBName: dto.fileBName ?? null,
      progress: dto.progress ?? 0,
      config: dto.config ?? undefined,
    },
  });
  return report;
}

export async function updateDraft(userId, reportId, dto) {
  const { count } = await prisma.report.updateMany({
    where: { id: reportId, userId, status: 'draft' },
    data: {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.fileAName !== undefined ? { fileAName: dto.fileAName } : {}),
      ...(dto.fileBName !== undefined ? { fileBName: dto.fileBName } : {}),
      ...(dto.progress !== undefined ? { progress: dto.progress } : {}),
      ...(dto.config !== undefined ? { config: dto.config } : {}),
    },
  });
  if (count === 0) throw new NotFoundError();
  return prisma.report.findFirst({ where: { id: reportId, userId } });
}

export async function listDrafts(userId) {
  const { organizationId } = await getUserMembership(userId);
  return prisma.report.findMany({
    where: { userId, organizationId, status: 'draft' },
    orderBy: { updatedAt: 'desc' },
  });
}

// Promotes a draft into a completed report: same shape as a fresh saveReport,
// applied to the existing draft row instead of a new one.
export async function completeDraft(userId, reportId, dto) {
  const draft = await prisma.report.findFirst({ where: { id: reportId, userId, status: 'draft' } });
  if (!draft) throw new NotFoundError();

  const report = await prisma.$transaction(async (tx) => {
    const report = await tx.report.update({
      where: { id: reportId },
      data: {
        status: 'completed',
        progress: 100,
        name: dto.name ?? draft.name,
        fileAName: dto.fileAName,
        fileBName: dto.fileBName,
        totalRows: dto.summary.total,
        matchedCount: dto.summary.matched,
        unmatchedCount: dto.summary.unmatchedA + dto.summary.unmatchedB,
        mismatchedCount: dto.summary.mismatched,
        duplicateCount: dto.summary.duplicates,
        totalBreakValue: dto.summary.totalBreakValue,
        amountTolerance: dto.config.amountTolerance,
        dateToleranceDays: dto.config.dateToleranceDays ?? null,
        config: dto.config,
      },
    });

    await tx.reportRow.createMany({ data: reportRowsForInsert(report.id, dto.rows) });

    return report;
  });

  await logAuditSafely(userId, { action: 'report.create', entityType: 'report', entityId: report.id });

  return report.id;
}

// Org admins can delete any report in the org; everyone else may only
// delete a report they created themselves.
export async function deleteReport(userId, reportId) {
  const { organizationId, role } = await getUserMembership(userId);

  // Read first to know the original owner (needed for the notification
  // below) — the actual delete stays a single permission-scoped deleteMany,
  // so a report that no longer matches still correctly 404s either way.
  const existing = await prisma.report.findFirst({ where: { id: reportId, organizationId }, select: { userId: true } });
  if (!existing) throw new NotFoundError();

  const { count } = await prisma.report.deleteMany({
    where: { id: reportId, organizationId, ...(role === 'admin' ? {} : { userId }) },
  });
  if (count === 0) throw new NotFoundError();

  await logAuditSafely(userId, { action: 'report.delete', entityType: 'report', entityId: reportId });

  if (role === 'admin' && existing.userId !== userId) {
    await createNotification(existing.userId, {
      type: 'report.deleted_by_admin',
      message: 'One of your reports was deleted by an organization admin.',
      entityType: 'report',
      entityId: reportId,
    });
  }
}
