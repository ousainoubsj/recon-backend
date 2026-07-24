import { prisma } from '../db/index.js';
import { NotFoundError, ValidationError, ConflictError } from '../errors.js';
import { getUserMembership } from './organizationService.js';
import { logAuditSafely } from './auditLogService.js';
import { createNotification } from './notificationService.js';
import { downloadFromR2, parseTabularFile } from '../utils/fileParser.js';
import {
  runMatch,
  extrapolatePreview,
  buildMatchAnalysis,
  buildRecommendedAction,
  buildShortReason,
  deriveDescription,
} from './matchingEngine.js';
import { suggestMapping, mappingFromSuggestions, computeValidationSummary } from './columnMappingService.js';

// Cap on how many rows of each file get cached on the draft at
// mapping-preview time, for the rule-preview endpoint to reuse cheaply as
// sliders move without re-parsing the full file each time.
const SAMPLE_ROW_CAP = 2000;

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

// Same idea as monthRange but for History's rolling-window stats (30 days),
// which aren't calendar-aligned the way the dashboard's month-over-month
// cards are. dayRange(0, 30) = the last 30 days; dayRange(30, 30) = the 30
// days before that.
const DAY_MS = 24 * 60 * 60 * 1000;
function dayRange(daysAgo, windowDays = 30) {
  const end = new Date(Date.now() - daysAgo * DAY_MS);
  const start = new Date(end.getTime() - windowDays * DAY_MS);
  return { start, end };
}

const VALID_TAGS = ['bank', 'supplier', 'year_end'];

function getAllTimeCompletedReports(organizationId) {
  return prisma.report.findMany({
    where: { organizationId, status: 'completed' },
    select: {
      runDate: true,
      totalRows: true,
      matchedCount: true,
      unmatchedCount: true,
      mismatchedCount: true,
      duplicateCount: true,
      totalBreakValue: true,
      fileAName: true,
      fileBName: true,
    },
  });
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
    breakReason: r.breakReason ?? null,
  }));
}

// Shared by completeDraft (legacy client-computed rows) and runReconciliation
// (server-computed via the matching engine) — both promote a draft into a
// completed report the same way, just from different sources of `rows`.
// `dto.name` must already be resolved by the caller (e.g. `body.name ??
// draft.name`) — this function doesn't know about the draft's prior name.
async function persistCompletedRun(tx, reportId, dto) {
  const report = await tx.report.update({
    where: { id: reportId },
    data: {
      status: 'completed',
      progress: 100,
      // Clears any prior failed-attempt message when this is a retry.
      errorMessage: null,
      name: dto.name,
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
      columnMapping: dto.columnMapping ?? undefined,
      rulesConfig: dto.config,
      sourceReportId: dto.sourceReportId ?? null,
      // Cleared once a run completes — no longer needed after the full
      // files have been re-parsed for the real result.
      fileASampleRows: null,
      fileBSampleRows: null,
    },
  });

  await tx.reportRow.createMany({ data: reportRowsForInsert(report.id, dto.rows) });

  return report;
}

async function findSourceReportId(organizationId, fileAName, fileBName, excludeReportId) {
  if (!fileAName || !fileBName) return null;
  const match = await prisma.report.findFirst({
    where: {
      organizationId,
      status: 'completed',
      id: { not: excludeReportId },
      fileAName: { equals: fileAName, mode: 'insensitive' },
      fileBName: { equals: fileBName, mode: 'insensitive' },
    },
    orderBy: { runDate: 'desc' },
    select: { id: true },
  });
  return match?.id ?? null;
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
export async function saveReport(userId, dto, { ip } = {}) {
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

  await logAuditSafely(userId, { action: 'report.create', entityType: 'report', entityId: report.id, ip });

  return report.id;
}

export async function listReports(
  userId,
  { limit, offset, q, dateFrom, dateTo, tag, favoritesOnly } = {},
) {
  const { organizationId } = await getUserMembership(userId);
  const query = q?.trim();
  const from = dateFrom ? new Date(dateFrom) : null;
  const to = dateTo ? new Date(dateTo) : null;
  const runDateFilter = {
    ...(from && !Number.isNaN(from.getTime()) ? { gte: from } : {}),
    ...(to && !Number.isNaN(to.getTime()) ? { lte: to } : {}),
  };

  const reports = await prisma.report.findMany({
    where: {
      organizationId,
      status: 'completed',
      ...(query
        ? {
            OR: [
              { name: { contains: query, mode: 'insensitive' } },
              { fileAName: { contains: query, mode: 'insensitive' } },
              { fileBName: { contains: query, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(Object.keys(runDateFilter).length > 0 ? { runDate: runDateFilter } : {}),
      ...(VALID_TAGS.includes(tag) ? { tag } : {}),
      ...(favoritesOnly ? { favorites: { some: { userId } } } : {}),
    },
    include: { favorites: { where: { userId }, select: { id: true } } },
    orderBy: { runDate: 'desc' },
    ...(offset ? { skip: offset } : {}),
    ...(limit ? { take: limit } : {}),
  });

  return reports.map(({ favorites, ...report }) => ({ ...report, isFavorited: favorites.length > 0 }));
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

// History's headline stat cards: all-time cumulative totals (not a single
// period, unlike the dashboard's month-over-month cards above), each paired
// with a rolling 30-vs-previous-30-day growth rate for the "vs last 30 days"
// trend label.
export async function getHistoryStats(userId) {
  const { organizationId } = await getUserMembership(userId);

  const allTimeStats = aggregatePeriod(await getAllTimeCompletedReports(organizationId));

  const last30 = dayRange(0, 30);
  const prior30 = dayRange(30, 30);
  const recentReports = await prisma.report.findMany({
    where: { organizationId, status: 'completed', runDate: { gte: prior30.start, lt: last30.end } },
    select: {
      runDate: true,
      totalRows: true,
      matchedCount: true,
      unmatchedCount: true,
      mismatchedCount: true,
      totalBreakValue: true,
    },
  });

  const currentStats = aggregatePeriod(recentReports.filter((r) => r.runDate >= last30.start));
  const previousStats = aggregatePeriod(
    recentReports.filter((r) => r.runDate >= prior30.start && r.runDate < prior30.end),
  );

  return {
    totalReconciliations: {
      value: allTimeStats.count,
      deltaPercent: deltaPercent(currentStats.count, previousStats.count),
    },
    avgMatchRate: {
      value: allTimeStats.avgMatchRate,
      deltaPercent: deltaPercent(currentStats.avgMatchRate, previousStats.avgMatchRate),
    },
    totalBreakValue: {
      value: allTimeStats.totalBreakValue,
      deltaPercent: deltaPercent(currentStats.totalBreakValue, previousStats.totalBreakValue),
    },
    totalTransactions: {
      value: allTimeStats.totalTransactions,
      deltaPercent: deltaPercent(currentStats.totalTransactions, previousStats.totalTransactions),
    },
  };
}

// HistorySidebar's donut chart. No "Failed" bucket is computed — a Report
// row is only ever created after a successful save (see saveReport), so
// there's no concept of a failed run yet; matches the same call made for
// the "Failed" quick filter right below.
const MATCH_RATE_BUCKETS = [
  { label: '≥ 99%', min: 99, max: Infinity },
  { label: '95% - 98.99%', min: 95, max: 99 },
  { label: '90% - 94.99%', min: 90, max: 95 },
  { label: '< 90%', min: -Infinity, max: 90 },
];

export async function getMatchRateDistribution(userId) {
  const { organizationId } = await getUserMembership(userId);
  const reports = await getAllTimeCompletedReports(organizationId);

  const counts = MATCH_RATE_BUCKETS.map(() => 0);
  for (const report of reports) {
    const matchRate = report.totalRows > 0 ? (report.matchedCount / report.totalRows) * 100 : 0;
    const bucketIndex = MATCH_RATE_BUCKETS.findIndex((b) => matchRate >= b.min && matchRate < b.max);
    if (bucketIndex >= 0) counts[bucketIndex] += 1;
  }

  const total = reports.length;
  return MATCH_RATE_BUCKETS.map(({ label }, i) => ({
    label,
    value: counts[i],
    percent: total > 0 ? `${((counts[i] / total) * 100).toFixed(1)}%` : '0.0%',
  }));
}

// HistorySidebar's "Top File Pairs" widget. Grouped case-insensitively so
// "Report.xlsx" and "report.xlsx" count as the same pair; the label keeps
// whichever casing was seen first.
export async function getTopFilePairs(userId, { limit = 4 } = {}) {
  const { organizationId } = await getUserMembership(userId);
  const reports = await getAllTimeCompletedReports(organizationId);

  const groups = new Map();
  for (const report of reports) {
    const fileA = report.fileAName ?? '';
    const fileB = report.fileBName ?? '';
    const key = `${fileA.toLowerCase()}|${fileB.toLowerCase()}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(key, { label: `${fileA} vs ${fileB}`, count: 1 });
    }
  }

  const sorted = [...groups.values()].sort((a, b) => b.count - a.count);
  const top = sorted.slice(0, limit);
  const rest = sorted.slice(limit);

  if (rest.length > 0) {
    top.push({ label: 'Other File Pairs', count: rest.reduce((sum, g) => sum + g.count, 0) });
  }

  return top;
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

  let priorRun = null;
  if (report.sourceReportId) {
    const prior = await prisma.report.findFirst({
      where: { id: report.sourceReportId },
      select: { matchedCount: true, totalRows: true, totalBreakValue: true },
    });
    if (prior) {
      priorRun = {
        matchRate: prior.totalRows > 0 ? (prior.matchedCount / prior.totalRows) * 100 : 0,
        totalBreakValue: toNum(prior.totalBreakValue),
      };
    }
  }

  return { ...report, priorRun };
}

// Lighter-weight than getReport's own access check (no rows include) — used
// by the Transaction Explorer endpoints below, which query ReportRow
// directly instead of loading every row through the Report relation.
async function assertReportAccess(userId, reportId) {
  const { organizationId } = await getUserMembership(userId);
  const report = await prisma.report.findFirst({ where: { id: reportId, organizationId } });
  if (!report) throw new NotFoundError();
  if (report.status === 'draft' && report.userId !== userId) throw new NotFoundError();
  return report;
}

const EXPLORER_STATUS_LABELS = {
  matched: 'Matched',
  mismatched: 'Mismatched',
  unmatched_a: 'Unmatched',
  unmatched_b: 'Unmatched',
  duplicate: 'Duplicate',
};

function mapRowForExplorer(row) {
  const { type, reason } = buildShortReason(row);
  return {
    id: row.id,
    status: EXPLORER_STATUS_LABELS[row.status] ?? row.status,
    reference: row.ref,
    date: row.dateA ?? row.dateB,
    description: deriveDescription(row),
    ledgerAmount: row.amountA != null ? toNum(row.amountA) : null,
    counterpartyAmount: row.amountB != null ? toNum(row.amountB) : null,
    difference: row.amountDiff != null ? toNum(row.amountDiff) : null,
    hasDifference: row.amountDiff != null && Number(row.amountDiff) !== 0,
    reviewed: row.reviewed,
    type,
    reason,
  };
}

const EXPLORER_SORT_FIELD_MAP = { date: 'dateA', amount: 'amountA', reference: 'ref' };

// Transaction Explorer listing — search/filter/sort/paginate over a single
// report's rows. `status` accepts the mock's 4-way vocabulary
// (matched|mismatched|unmatched|duplicate); 'unmatched' maps to both
// unmatched_a and unmatched_b since ReconRowStatus keeps them distinct.
export async function getTransactions(userId, reportId, filters = {}) {
  await assertReportAccess(userId, reportId);
  const { search, status, amountMin, amountMax, dateFrom, dateTo, sortBy, sortDir, limit, offset } = filters;

  const and = [];
  if (search?.trim()) and.push({ ref: { contains: search.trim(), mode: 'insensitive' } });
  if (amountMin != null || amountMax != null) {
    const range = {};
    if (amountMin != null) range.gte = amountMin;
    if (amountMax != null) range.lte = amountMax;
    and.push({ OR: [{ amountA: range }, { amountB: range }] });
  }
  if (dateFrom || dateTo) {
    const range = {};
    if (dateFrom) range.gte = new Date(dateFrom);
    if (dateTo) range.lte = new Date(dateTo);
    and.push({ OR: [{ dateA: range }, { dateB: range }] });
  }

  const where = {
    reportId,
    ...(status ? { status: status === 'unmatched' ? { in: ['unmatched_a', 'unmatched_b'] } : status } : {}),
    ...(and.length > 0 ? { AND: and } : {}),
  };
  const orderBy = { [EXPLORER_SORT_FIELD_MAP[sortBy] ?? 'ref']: sortDir === 'desc' ? 'desc' : 'asc' };

  const [rows, total] = await Promise.all([
    prisma.reportRow.findMany({ where, orderBy, take: limit ?? 50, skip: offset ?? 0 }),
    prisma.reportRow.count({ where }),
  ]);

  return { rows: rows.map(mapRowForExplorer), total };
}

// Single-transaction drill-down: raw ledger/counterparty fields plus a
// read-time (never persisted) rule-by-rule match analysis + recommended
// action, derived from the report's own stored rulesConfig.
export async function getTransaction(userId, reportId, rowId) {
  const report = await assertReportAccess(userId, reportId);
  const row = await prisma.reportRow.findFirst({ where: { id: rowId, reportId } });
  if (!row) throw new NotFoundError();

  return {
    ...mapRowForExplorer(row),
    rawA: row.rawA,
    rawB: row.rawB,
    matchAnalysis: buildMatchAnalysis(row, report.rulesConfig ?? report.config ?? {}),
    recommendedAction: buildRecommendedAction(row),
  };
}

export async function markRowReviewed(userId, reportId, rowId, reviewed = true, { ip } = {}) {
  await assertReportAccess(userId, reportId);
  const { count } = await prisma.reportRow.updateMany({
    where: { id: rowId, reportId },
    data: reviewed
      ? { reviewed: true, reviewedBy: userId, reviewedAt: new Date() }
      : { reviewed: false, reviewedBy: null, reviewedAt: null },
  });
  if (count === 0) throw new NotFoundError();

  await logAuditSafely(userId, {
    action: 'report.row.review',
    entityType: 'reportRow',
    entityId: rowId,
    status: 'info',
    ip,
    metadata: { reportId, reviewed },
  });

  return prisma.reportRow.findFirst({ where: { id: rowId } });
}

const BREAK_REASON_CATEGORY_LABELS = {
  amount_mismatch: 'Amount Mismatch',
  missing_counterparty: 'Missing in Counterparty File',
  missing_internal: 'Missing in Internal Ledger',
  date_mismatch: 'Date Mismatch',
  other: 'Others',
};

// The 5-bucket "Top Break Causes"/categoryBreakdown shape. Duplicates are
// deliberately excluded — same rationale as summary.totalBreakValue: a
// duplicate is a data-quality flag, not a value break.
export async function getBreakBreakdown(userId, reportId) {
  await assertReportAccess(userId, reportId);
  const grouped = await prisma.reportRow.groupBy({
    by: ['breakReason'],
    where: { reportId, breakReason: { not: null, notIn: ['duplicate'] } },
    _sum: { amountDiff: true, amountA: true, amountB: true },
  });

  const amountForGroup = (g) => {
    if (g.breakReason === 'missing_counterparty') return Math.abs(toNum(g._sum.amountA));
    if (g.breakReason === 'missing_internal') return Math.abs(toNum(g._sum.amountB));
    return Math.abs(toNum(g._sum.amountDiff));
  };

  const buckets = grouped.map((g) => ({
    category: BREAK_REASON_CATEGORY_LABELS[g.breakReason] ?? 'Others',
    amount: amountForGroup(g),
  }));
  const total = buckets.reduce((sum, b) => sum + b.amount, 0);

  return buckets
    .map((b) => ({ ...b, percent: total > 0 ? Number(((b.amount / total) * 100).toFixed(2)) : 0 }))
    .sort((a, b) => b.amount - a.amount);
}

// 7-day match-rate + break-value trend for this report's file-pair lineage
// (case-insensitive name match, same convention as getTopFilePairs),
// current week vs the week before — carry-forward daily values since runs
// are sparse, not daily, mirroring dayRange's current-vs-previous pattern.
export async function getFilePairTrend(userId, reportId) {
  const report = await assertReportAccess(userId, reportId);
  const { organizationId } = await getUserMembership(userId);

  const candidates = await prisma.report.findMany({
    where: {
      organizationId,
      status: 'completed',
      fileAName: { equals: report.fileAName ?? '', mode: 'insensitive' },
      fileBName: { equals: report.fileBName ?? '', mode: 'insensitive' },
    },
    select: { runDate: true, totalRows: true, matchedCount: true, totalBreakValue: true },
    orderBy: { runDate: 'asc' },
  });

  function seriesFor(daysAgoOffset) {
    const points = [];
    for (let i = 6; i >= 0; i--) {
      const day = new Date(Date.now() - (daysAgoOffset + i) * DAY_MS);
      const candidate = [...candidates].reverse().find((c) => c.runDate <= day);
      points.push({
        matchRate: candidate && candidate.totalRows > 0 ? (candidate.matchedCount / candidate.totalRows) * 100 : 0,
        totalBreakValue: candidate ? toNum(candidate.totalBreakValue) : 0,
      });
    }
    return points;
  }

  const current = seriesFor(0);
  const prior = seriesFor(7);

  return {
    matchRateTrend: { current: current.map((p) => p.matchRate), prior: prior.map((p) => p.matchRate) },
    breakValueTrend: { current: current.map((p) => p.totalBreakValue), prior: prior.map((p) => p.totalBreakValue) },
  };
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

// Logs `report.column_mapping.updated`/`report.matching_rules.updated` when
// the corresponding field is actually present in the patch — matches the
// mock Audit Log's granular vocabulary, distinct from the single
// `report.run.*` events below. Not logged on every PATCH, only when that
// specific field is part of it (e.g. a progress-only autosave stays silent).
export async function updateDraft(userId, reportId, dto, { ip } = {}) {
  const { count } = await prisma.report.updateMany({
    where: { id: reportId, userId, status: { in: ['draft', 'failed'] } },
    data: {
      ...(dto.name !== undefined ? { name: dto.name } : {}),
      ...(dto.fileAName !== undefined ? { fileAName: dto.fileAName } : {}),
      ...(dto.fileBName !== undefined ? { fileBName: dto.fileBName } : {}),
      ...(dto.progress !== undefined ? { progress: dto.progress } : {}),
      ...(dto.config !== undefined ? { config: dto.config } : {}),
      ...(dto.fileAKey !== undefined ? { fileAKey: dto.fileAKey } : {}),
      ...(dto.fileBKey !== undefined ? { fileBKey: dto.fileBKey } : {}),
      ...(dto.columnMapping !== undefined ? { columnMapping: dto.columnMapping } : {}),
    },
  });
  if (count === 0) throw new NotFoundError();

  if (dto.columnMapping !== undefined) {
    await logAuditSafely(userId, {
      action: 'report.column_mapping.updated',
      entityType: 'report',
      entityId: reportId,
      ip,
    });
  }
  if (dto.config !== undefined) {
    await logAuditSafely(userId, {
      action: 'report.matching_rules.updated',
      entityType: 'report',
      entityId: reportId,
      ip,
    });
  }

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
export async function completeDraft(userId, reportId, dto, { ip } = {}) {
  const draft = await prisma.report.findFirst({ where: { id: reportId, userId, status: 'draft' } });
  if (!draft) throw new NotFoundError();

  const report = await prisma.$transaction((tx) =>
    persistCompletedRun(tx, reportId, {
      name: dto.name ?? draft.name,
      fileAName: dto.fileAName,
      fileBName: dto.fileBName,
      summary: dto.summary,
      rows: dto.rows,
      config: dto.config,
    }),
  );

  await logAuditSafely(userId, { action: 'report.create', entityType: 'report', entityId: report.id, ip });

  return report.id;
}

// A previously failed run behaves like a draft that can be retried — it
// still has fileAKey/fileBKey/columnMapping/sample rows to work with, it
// just needs another attempt.
function findDraftOrFailedRun(userId, reportId) {
  return prisma.report.findFirst({ where: { id: reportId, userId, status: { in: ['draft', 'failed'] } } });
}

// The actual matching engine entry point: re-downloads+re-parses the full
// files fresh from R2 (never reuses the mapping-preview sample — that's only
// for the cheap rule-preview endpoint), runs the match, and persists exactly
// like completeDraft does. A failure during download/parse/match persists a
// `status: 'failed'` row (with the error message) rather than leaving no
// record at all — the draft stays retryable afterward.
export async function runReconciliation(userId, reportId, dto, { ip } = {}) {
  const draft = await findDraftOrFailedRun(userId, reportId);
  if (!draft) throw new NotFoundError();
  if (!draft.fileAKey || !draft.fileBKey) {
    throw new ValidationError('Both files must be uploaded before running reconciliation');
  }

  const { organizationId } = await getUserMembership(userId);

  await logAuditSafely(userId, {
    action: 'report.run.started',
    entityType: 'report',
    entityId: reportId,
    status: 'info',
    ip,
  });

  let summary, rows;
  try {
    const [fileABuffer, fileBBuffer] = await Promise.all([
      downloadFromR2(draft.fileAKey),
      downloadFromR2(draft.fileBKey),
    ]);
    const fileA = parseTabularFile(fileABuffer, draft.fileAName);
    const fileB = parseTabularFile(fileBBuffer, draft.fileBName);
    ({ summary, rows } = runMatch(fileA, fileB, dto.columnMapping.fileA, dto.columnMapping.fileB, dto.config));
  } catch (err) {
    await prisma.report.update({ where: { id: reportId }, data: { status: 'failed', errorMessage: err.message } });
    await logAuditSafely(userId, {
      action: 'report.run.failed',
      entityType: 'report',
      entityId: reportId,
      status: 'failed',
      ip,
      metadata: { reason: err.message },
    });
    throw err;
  }

  const sourceReportId = await findSourceReportId(organizationId, draft.fileAName, draft.fileBName, reportId);

  const report = await prisma.$transaction((tx) =>
    persistCompletedRun(tx, reportId, {
      name: dto.name ?? draft.name,
      fileAName: draft.fileAName,
      fileBName: draft.fileBName,
      summary,
      rows,
      config: dto.config,
      columnMapping: dto.columnMapping,
      sourceReportId,
    }),
  );

  await logAuditSafely(userId, { action: 'report.run.completed', entityType: 'report', entityId: report.id, ip });

  return report.id;
}

// Downloads+parses the draft's full uploaded files, returns per-file
// preview/validation/mapping-suggestion data for the column-mapping step,
// and caches a bounded row sample on the draft (plus a suggested mapping,
// only if one isn't already saved) for the rule-preview endpoint to reuse.
export async function getMappingPreview(userId, reportId) {
  const draft = await findDraftOrFailedRun(userId, reportId);
  if (!draft) throw new NotFoundError();
  if (!draft.fileAKey || !draft.fileBKey) {
    throw new ValidationError('Both files must be uploaded before requesting a mapping preview');
  }

  const [fileABuffer, fileBBuffer] = await Promise.all([
    downloadFromR2(draft.fileAKey),
    downloadFromR2(draft.fileBKey),
  ]);
  const fileA = parseTabularFile(fileABuffer, draft.fileAName);
  const fileB = parseTabularFile(fileBBuffer, draft.fileBName);

  const suggestedA = suggestMapping(fileA.headers);
  const suggestedB = suggestMapping(fileB.headers);
  const mappingA = mappingFromSuggestions(suggestedA);
  const mappingB = mappingFromSuggestions(suggestedB);

  const validationA = computeValidationSummary(fileA.rows, mappingA);
  const validationB = computeValidationSummary(fileB.rows, mappingB);

  const data = {
    fileASampleRows: { totalRows: fileA.rows.length, rows: fileA.rows.slice(0, SAMPLE_ROW_CAP) },
    fileBSampleRows: { totalRows: fileB.rows.length, rows: fileB.rows.slice(0, SAMPLE_ROW_CAP) },
  };
  if (!draft.columnMapping) {
    data.columnMapping = { fileA: mappingA, fileB: mappingB };
  }
  await prisma.report.update({ where: { id: reportId }, data });

  return {
    fileA: {
      filename: draft.fileAName,
      rows: fileA.rows.length,
      columns: fileA.headers.length,
      fileSizeBytes: fileABuffer.length,
      previewRows: fileA.rows.slice(0, 5),
      mappings: suggestedA,
      ...validationA,
    },
    fileB: {
      filename: draft.fileBName,
      rows: fileB.rows.length,
      columns: fileB.headers.length,
      fileSizeBytes: fileBBuffer.length,
      previewRows: fileB.rows.slice(0, 5),
      mappings: suggestedB,
      ...validationB,
    },
  };
}

// Cheap, sample-based estimate for the "Match Preview (Estimated)" panel —
// reuses the bounded sample cached by getMappingPreview instead of
// re-downloading/re-parsing the full files on every rule-slider tick.
export async function getRulePreview(userId, reportId, dto) {
  const draft = await findDraftOrFailedRun(userId, reportId);
  if (!draft) throw new NotFoundError();
  if (!draft.fileASampleRows || !draft.fileBSampleRows) {
    throw new ConflictError('Call the mapping-preview endpoint before requesting a rule preview');
  }
  const mapping = dto.columnMapping ?? draft.columnMapping;
  if (!mapping) throw new ConflictError('No column mapping available — call the mapping-preview endpoint first');

  const sampleA = draft.fileASampleRows;
  const sampleB = draft.fileBSampleRows;

  const { summary } = runMatch(
    { rows: sampleA.rows },
    { rows: sampleB.rows },
    mapping.fileA,
    mapping.fileB,
    dto.config,
  );

  return extrapolatePreview(summary, sampleA.rows.length, sampleA.totalRows, sampleB.rows.length, sampleB.totalRows);
}

// Org admins can delete any report in the org; everyone else may only
// delete a report they created themselves.
export async function deleteReport(userId, reportId, { ip } = {}) {
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

  const isAdminActingOnAnother = role === 'admin' && existing.userId !== userId;
  await logAuditSafely(userId, {
    action: 'report.delete',
    entityType: 'report',
    entityId: reportId,
    status: isAdminActingOnAnother ? 'warning' : 'success',
    ip,
  });

  if (isAdminActingOnAnother) {
    await createNotification(existing.userId, {
      type: 'report.deleted_by_admin',
      message: 'One of your reports was deleted by an organization admin.',
      entityType: 'report',
      entityId: reportId,
    });
  }
}

// Tags only apply to completed reports (History is the only place they're
// shown) — scoping to status: 'completed' here means this can never be used
// to reach into another user's private draft the way a plain org-scoped
// updateMany could.
export async function updateReportTag(userId, reportId, tag) {
  const { organizationId } = await getUserMembership(userId);
  const { count } = await prisma.report.updateMany({
    where: { id: reportId, organizationId, status: 'completed' },
    data: { tag },
  });
  if (count === 0) throw new NotFoundError();
  return prisma.report.findFirst({ where: { id: reportId, organizationId } });
}

// Both idempotent: favoriting something already favorited, or unfavoriting
// something that isn't, are no-ops rather than errors.
export async function addFavorite(userId, reportId) {
  await getReport(userId, reportId); // org-scoped + draft-privacy visibility check
  await prisma.reportFavorite.upsert({
    where: { userId_reportId: { userId, reportId } },
    create: { userId, reportId },
    update: {},
  });
}

export async function removeFavorite(userId, reportId) {
  await getReport(userId, reportId);
  await prisma.reportFavorite.deleteMany({ where: { userId, reportId } });
}

// Same admin-vs-owner scoping as deleteReport, applied to a set of ids at
// once. Notifies each distinct non-caller owner once (with a count), not
// once per deleted report.
export async function bulkDeleteReports(userId, ids, { ip } = {}) {
  const { organizationId, role } = await getUserMembership(userId);

  const existing = await prisma.report.findMany({
    where: { id: { in: ids }, organizationId },
    select: { id: true, userId: true },
  });

  const { count } = await prisma.report.deleteMany({
    where: { id: { in: ids }, organizationId, ...(role === 'admin' ? {} : { userId }) },
  });

  const deletedCountByOwner = new Map();
  if (role === 'admin') {
    for (const report of existing) {
      if (report.userId !== userId) {
        deletedCountByOwner.set(report.userId, (deletedCountByOwner.get(report.userId) ?? 0) + 1);
      }
    }
  }

  await logAuditSafely(userId, {
    action: 'report.bulk_delete',
    entityType: 'report',
    status: deletedCountByOwner.size > 0 ? 'warning' : 'success',
    ip,
    metadata: { ids, count },
  });

  if (role === 'admin') {
    for (const [ownerId, deletedCount] of deletedCountByOwner) {
      await createNotification(ownerId, {
        type: 'report.deleted_by_admin',
        message: `An organization admin deleted ${deletedCount} of your report${deletedCount > 1 ? 's' : ''}.`,
        entityType: 'report',
        entityId: null,
      });
    }
  }

  return { deletedCount: count };
}

// Bulk-fetch helper for bulk-export: same org-scoping + draft-privacy rule
// as getReport, applied per row, plus an optional completed-only filter
// (a draft has no rows to export). Throws NotFoundError if any requested id
// doesn't resolve — all-or-nothing, so a bulk export never silently omits
// a file the caller asked for.
export async function getReportsByIds(userId, ids, { requireCompleted = false } = {}) {
  const { organizationId } = await getUserMembership(userId);
  const reports = await prisma.report.findMany({
    where: { id: { in: ids }, organizationId, ...(requireCompleted ? { status: 'completed' } : {}) },
    include: { rows: true },
  });

  const byId = new Map(reports.map((r) => [r.id, r]));
  const visible = ids
    .map((id) => byId.get(id))
    .filter((report) => report && (report.status !== 'draft' || report.userId === userId));

  if (visible.length !== ids.length) throw new NotFoundError();
  return visible;
}
