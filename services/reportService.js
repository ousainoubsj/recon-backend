import { prisma } from '../config/prisma.config.js';
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

// A report's own config always wins; this only fills in amountTolerance/
// dateToleranceDays when the frontend hasn't set them yet (a brand-new draft
// with no saved template applied) — the org's Reconciliation Defaults settings
// exist specifically to seed this case, but nothing read them until now.
async function withOrgToleranceDefaults(organizationId, config) {
  if (config?.amountTolerance !== undefined && config?.dateToleranceDays !== undefined) return config;
  const org = await prisma.organization.findFirst({
    where: { id: organizationId },
    select: { defaultAmountTolerance: true, defaultDateToleranceDays: true },
  });
  return {
    ...config,
    amountTolerance: config?.amountTolerance ?? org?.defaultAmountTolerance?.toNumber(),
    dateToleranceDays: config?.dateToleranceDays ?? org?.defaultDateToleranceDays,
  };
}

// Mirrors the frontend's formatReportReference (recon-frontend/lib/format.ts)
// exactly — audit-log metadata should show the same human-readable
// REC-YYYY-NNNNNN reference the UI does, not the raw UUID. Exported since
// controllers/reports.controller.js needs the identical formatting for its
// own audit-log calls (bulk export).
export function formatReportReference(sequenceYear, sequenceNumber) {
  if (sequenceYear == null || sequenceNumber == null) return null;
  return `REC-${sequenceYear}-${String(sequenceNumber).padStart(6, '0')}`;
}

const CANONICAL_MAPPING_FIELDS = ['referenceNumber', 'amount', 'transactionDate', 'currency'];

// Same "only log fields that actually changed value" idea as
// settingsService.js's diffFields — the frontend always saves the full
// column mapping/rule config, not just what the user touched, so a naive
// log would falsely claim every field changed on every save.
function diffColumnMapping(before, after) {
  const changes = {};
  for (const side of ['fileA', 'fileB']) {
    const beforeSide = before?.[side] ?? {};
    const afterSide = after?.[side] ?? {};
    for (const field of CANONICAL_MAPPING_FIELDS) {
      const oldValue = beforeSide[field] ?? null;
      const newValue = afterSide[field] ?? null;
      if (oldValue !== newValue) {
        changes[`${side}${field[0].toUpperCase()}${field.slice(1)}`] = { from: oldValue, to: newValue };
      }
    }
  }
  return changes;
}

function diffConfigFields(before, after) {
  const changes = {};
  for (const [field, newValue] of Object.entries(after ?? {})) {
    const oldValue = before?.[field] ?? null;
    if (oldValue !== newValue) changes[field] = { from: oldValue, to: newValue };
  }
  return changes;
}

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
// Per-status dollar sums for Results' stat tiles (Matched/Unmatched/
// Duplicates each show a count + a value) — computed once here from the
// match engine's in-memory row output, since summing per-status amounts
// from persisted rows on every Results page load would mean scanning
// potentially 100k+ rows each time.
function computeValueBreakdown(rows) {
  const sum = (predicate) =>
    rows.filter(predicate).reduce((total, r) => total + (r.amountA ?? r.amountB ?? 0), 0);
  return {
    matchedValue: sum((r) => r.status === 'matched'),
    unmatchedValue: sum((r) => r.status === 'unmatched_a' || r.status === 'unmatched_b'),
    duplicateValue: sum((r) => r.status === 'duplicate'),
  };
}

// The frontend wizard never PATCHes a `progress` value at any step (files
// uploaded, mapping saved, rules saved) — deriving it here from which
// fields are actually populated means it can never drift out of sync with
// reality, unlike trusting the client to report an arbitrary number.
// Completed/failed reports keep whatever's already stored (100, by the
// column's default) — this only overrides the value for still-in-progress
// drafts.
function withDraftProgress(report) {
  if (report.status !== 'draft') return report;
  const hasFiles = Boolean(report.fileAKey && report.fileBKey);
  const hasMapping = Boolean(report.columnMapping);
  const hasConfig = Boolean(report.config);
  const progress = hasFiles && hasMapping && hasConfig ? 90 : hasFiles && hasMapping ? 66 : hasFiles ? 33 : 0;
  return { ...report, progress };
}

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

// Atomic per-year counter backing Report.sequenceNumber — the upsert's
// `update` branch is a single UPDATE statement guarded by the year's row
// lock, so concurrent completions in the same transaction-per-request model
// never hand out the same number twice.
async function nextSequenceNumber(tx, year) {
  const seq = await tx.reportSequence.upsert({
    where: { year },
    create: { year, lastValue: 1 },
    update: { lastValue: { increment: 1 } },
  });
  return seq.lastValue;
}

// Shared by completeDraft (legacy client-computed rows) and runReconciliation
// (server-computed via the matching engine) — both promote a draft into a
// completed report the same way, just from different sources of `rows`.
// `dto.name` must already be resolved by the caller (e.g. `body.name ??
// draft.name`) — this function doesn't know about the draft's prior name.
async function persistCompletedRun(tx, reportId, dto) {
  // A retry of a previously-failed run reuses this same reportId — only
  // assign a sequence number the first time it actually completes, never
  // reassign one on a later retry.
  const existing = await tx.report.findUnique({ where: { id: reportId }, select: { sequenceNumber: true } });
  const needsSequence = existing?.sequenceNumber == null;
  const year = new Date().getUTCFullYear();
  const sequenceNumber = needsSequence ? await nextSequenceNumber(tx, year) : undefined;

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
      valueBreakdown: computeValueBreakdown(dto.rows),
      ...(needsSequence ? { sequenceYear: year, sequenceNumber } : {}),
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
  const config = await withOrgToleranceDefaults(organizationId, dto.config);

  const report = await prisma.$transaction(async (tx) => {
    // This path always creates an already-'completed' report (the schema
    // default), so it always needs a fresh sequence number — unlike
    // persistCompletedRun, there's no draft/retry history to check first.
    const year = new Date().getUTCFullYear();
    const sequenceNumber = await nextSequenceNumber(tx, year);

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
        amountTolerance: config.amountTolerance,
        dateToleranceDays: config.dateToleranceDays ?? null,
        config,
        sequenceYear: year,
        sequenceNumber,
      },
    });

    // 2. Bulk-insert rows (createMany = single INSERT statement).
    await tx.reportRow.createMany({ data: reportRowsForInsert(report.id, dto.rows) });

    return report;
  });

  await logAuditSafely(userId, {
    action: 'report.create',
    entityType: 'report',
    entityId: report.id,
    ip,
    metadata: {
      filePair: `${report.fileAName ?? 'File A'} vs ${report.fileBName ?? 'File B'}`,
      matchRate: report.totalRows > 0 ? `${((report.matchedCount / report.totalRows) * 100).toFixed(2)}%` : 'N/A',
    },
  });

  return report.id;
}

// History includes both completed and failed runs (a failed run is still a
// real, persisted attempt worth showing up in the log) — drafts never
// appear here regardless. `status`, when given, narrows to just that one
// outcome; omitted entirely (the default "All" quick filter) returns both.
const HISTORY_STATUSES = ['completed', 'failed'];

export async function listReports(
  userId,
  { limit, offset, q, dateFrom, dateTo, tag, favoritesOnly, status } = {},
) {
  const { organizationId } = await getUserMembership(userId);
  const query = q?.trim();
  const from = dateFrom ? new Date(dateFrom) : null;
  const to = dateTo ? new Date(dateTo) : null;
  const runDateFilter = {
    ...(from && !Number.isNaN(from.getTime()) ? { gte: from } : {}),
    ...(to && !Number.isNaN(to.getTime()) ? { lte: to } : {}),
  };
  const statusFilter = HISTORY_STATUSES.includes(status) ? status : { in: HISTORY_STATUSES };

  const reports = await prisma.report.findMany({
    where: {
      organizationId,
      status: statusFilter,
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

// All-time totals for the dashboard's headline stat cards (Total
// Reconciliations, Avg Match Rate, Unmatched Transactions, Total Break
// Value), each paired with a deltaPercent trend still measured current vs
// previous calendar month — aggregated in JS over Report rows (one per run,
// so cheap) rather than a SQL-side aggregate, matching this codebase's
// existing preference for JS-side math (see amountDiff in saveReport above).
export async function getReportsSummary(userId) {
  const { organizationId } = await getUserMembership(userId);
  const current = monthRange(0);
  const previous = monthRange(1);

  const [allTimeReports, monthReports] = await Promise.all([
    getAllTimeCompletedReports(organizationId),
    prisma.report.findMany({
      where: { organizationId, status: 'completed', runDate: { gte: previous.start, lt: current.end } },
      select: {
        runDate: true,
        totalRows: true,
        matchedCount: true,
        unmatchedCount: true,
        mismatchedCount: true,
        totalBreakValue: true,
      },
    }),
  ]);

  const currentMonthReports = monthReports.filter((r) => r.runDate >= current.start);
  const previousMonthReports = monthReports.filter((r) => r.runDate >= previous.start && r.runDate < previous.end);

  const allTimeStats = aggregatePeriod(allTimeReports);
  const currentMonthStats = aggregatePeriod(currentMonthReports);
  const previousMonthStats = aggregatePeriod(previousMonthReports);

  // Before this month's first completed run, currentMonthStats is all
  // zeros, which against any nonzero prior-month baseline would compute as
  // a flat -100% on every card — a misleading "everything cratered" signal
  // when really nothing has run yet this month. Suppress the trend instead
  // of reporting it.
  const hasCurrentMonthActivity = currentMonthStats.count > 0;

  return {
    totalReconciliations: {
      current: allTimeStats.count,
      previous: previousMonthStats.count,
      deltaPercent: hasCurrentMonthActivity ? deltaPercent(currentMonthStats.count, previousMonthStats.count) : null,
    },
    avgMatchRate: {
      current: allTimeStats.avgMatchRate,
      previous: previousMonthStats.avgMatchRate,
      deltaPercent: hasCurrentMonthActivity
        ? deltaPercent(currentMonthStats.avgMatchRate, previousMonthStats.avgMatchRate)
        : null,
    },
    unmatchedTransactions: {
      current: allTimeStats.unmatchedTransactions,
      previous: previousMonthStats.unmatchedTransactions,
      deltaPercent: hasCurrentMonthActivity
        ? deltaPercent(currentMonthStats.unmatchedTransactions, previousMonthStats.unmatchedTransactions)
        : null,
    },
    totalBreakValue: {
      current: allTimeStats.totalBreakValue,
      previous: previousMonthStats.totalBreakValue,
      deltaPercent: hasCurrentMonthActivity
        ? deltaPercent(currentMonthStats.totalBreakValue, previousMonthStats.totalBreakValue)
        : null,
    },
    totalTransactions: allTimeStats.totalTransactions,
  };
}

// Monthly-bucketed series for the dashboard's charts: match-rate trend and
// reconciliation volume over the selected window, plus an all-time category
// breakdown (matches ChartsOverview.tsx's "Breakdown by Category (All
// Time)") that's independent of the months selector. unmatchedCount already
// merges unmatched_a + unmatched_b at save time (see saveReport above), so
// the category breakdown here is a 4-way split (Matched / Mismatched /
// Unmatched / Duplicates), not the 5-way split that would need a
// per-ReportRow query.
export async function getReportsTrend(userId, { months = 6 } = {}) {
  const { organizationId } = await getUserMembership(userId);
  const { start } = monthRange(months - 1);

  const [reports, allTimeReports] = await Promise.all([
    prisma.report.findMany({
      where: { organizationId, status: 'completed', runDate: { gte: start } },
      select: {
        runDate: true,
        totalRows: true,
        matchedCount: true,
        unmatchedCount: true,
        mismatchedCount: true,
        duplicateCount: true,
      },
    }),
    getAllTimeCompletedReports(organizationId),
  ]);

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

  const categoryBreakdown = {
    matched: allTimeReports.reduce((sum, r) => sum + r.matchedCount, 0),
    mismatched: allTimeReports.reduce((sum, r) => sum + r.mismatchedCount, 0),
    unmatched: allTimeReports.reduce((sum, r) => sum + r.unmatchedCount, 0),
    duplicates: allTimeReports.reduce((sum, r) => sum + r.duplicateCount, 0),
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

// services/weeklyDigestService.js's per-org content — current-vs-prior 7-day
// window, same "one query spanning both windows, filter in JS" shape as
// getHistoryStats above. Takes organizationId directly (not userId +
// getUserMembership) since the digest job already has every org's id
// resolved before calling this — it isn't running inside a user request.
export async function getWeeklyDigestStats(organizationId) {
  const current = dayRange(0, 7);
  const prior = dayRange(7, 7);
  const reports = await prisma.report.findMany({
    where: { organizationId, status: 'completed', runDate: { gte: prior.start, lt: current.end } },
    select: {
      runDate: true,
      totalRows: true,
      matchedCount: true,
      unmatchedCount: true,
      mismatchedCount: true,
      totalBreakValue: true,
    },
  });

  const currentStats = aggregatePeriod(reports.filter((r) => r.runDate >= current.start));
  const priorStats = aggregatePeriod(reports.filter((r) => r.runDate >= prior.start && r.runDate < prior.end));

  return { current: currentStats, prior: priorStats, weekStart: current.start, weekEnd: current.end };
}

// HistorySidebar's donut chart. The first 4 buckets split completed runs by
// match rate; "Failed" is a 5th bucket alongside them (not a match-rate
// bucket itself — a failed run never produced a match rate) counting failed
// runs, so the donut reflects every non-draft attempt, same as the History
// table/list now does.
const MATCH_RATE_BUCKETS = [
  { label: '≥ 99%', min: 99, max: Infinity },
  { label: '95% - 98.99%', min: 95, max: 99 },
  { label: '90% - 94.99%', min: 90, max: 95 },
  { label: '< 90%', min: -Infinity, max: 90 },
];

export async function getMatchRateDistribution(userId) {
  const { organizationId } = await getUserMembership(userId);
  const reports = await getAllTimeCompletedReports(organizationId);
  const failedCount = await prisma.report.count({ where: { organizationId, status: 'failed' } });

  const counts = MATCH_RATE_BUCKETS.map(() => 0);
  for (const report of reports) {
    const matchRate = report.totalRows > 0 ? (report.matchedCount / report.totalRows) * 100 : 0;
    const bucketIndex = MATCH_RATE_BUCKETS.findIndex((b) => matchRate >= b.min && matchRate < b.max);
    if (bucketIndex >= 0) counts[bucketIndex] += 1;
  }

  const total = reports.length + failedCount;
  const buckets = MATCH_RATE_BUCKETS.map(({ label }, i) => ({
    label,
    value: counts[i],
    percent: total > 0 ? `${((counts[i] / total) * 100).toFixed(1)}%` : '0.0%',
  }));
  buckets.push({
    label: 'Failed',
    value: failedCount,
    percent: total > 0 ? `${((failedCount / total) * 100).toFixed(1)}%` : '0.0%',
  });
  return buckets;
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

// No duration column is persisted on Report itself, but the run mutation
// already audit-logs a report.run.started/report.run.completed pair
// (reportService.js's runReconciliation) with real timestamps — this reuses
// those rather than inventing a number. Pairs the latest completed event
// with the latest started event that precedes it, so a run that failed once
// and was retried measures only the successful attempt's duration.
async function getRunDurationMs(reportId) {
  const events = await prisma.auditLog.findMany({
    where: { entityType: 'report', entityId: reportId, action: { in: ['report.run.started', 'report.run.completed'] } },
    orderBy: { ts: 'asc' },
    select: { action: true, ts: true },
  });
  const lastCompleted = [...events].reverse().find((e) => e.action === 'report.run.completed');
  if (!lastCompleted) return null;
  const lastStarted = [...events].reverse().find((e) => e.action === 'report.run.started' && e.ts <= lastCompleted.ts);
  if (!lastStarted) return null;
  return lastCompleted.ts.getTime() - lastStarted.ts.getTime();
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

  // "vs last run" compares against the most recent completed run in the org
  // overall — not scoped to this report's file pair — matching the "All
  // Reconciliations" default used elsewhere (getFilePairTrend's 'overall' scope).
  let priorRun = null;
  if (report.status === 'completed') {
    const prior = await prisma.report.findFirst({
      where: { organizationId, status: 'completed', id: { not: reportId }, runDate: { lt: report.runDate } },
      orderBy: { runDate: 'desc' },
      select: { matchedCount: true, totalRows: true, totalBreakValue: true },
    });
    if (prior) {
      priorRun = {
        matchRate: prior.totalRows > 0 ? (prior.matchedCount / prior.totalRows) * 100 : 0,
        totalBreakValue: toNum(prior.totalBreakValue),
      };
    }
  }

  const runDurationMs = report.status === 'completed' ? await getRunDurationMs(reportId) : null;

  return { ...withDraftProgress(report), priorRun, runDurationMs };
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
  const report = await assertReportAccess(userId, reportId);
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
    metadata: { reportReference: formatReportReference(report.sequenceYear, report.sequenceNumber) ?? reportId, reviewed },
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
// duplicate is a data-quality flag, not a value break. All 5 canonical
// categories are always returned (zero-filled if a reason has no rows this
// run) once there's at least one real break to categorize, so e.g. "Others"
// still shows up at 0/0% rather than silently disappearing — but a report
// with zero breaks at all still returns [] so the empty-state UI still
// applies.
export async function getBreakBreakdown(userId, reportId) {
  await assertReportAccess(userId, reportId);
  const grouped = await prisma.reportRow.groupBy({
    by: ['breakReason'],
    where: { reportId, breakReason: { not: null, notIn: ['duplicate'] } },
    _sum: { amountDiff: true, amountA: true, amountB: true },
  });
  if (grouped.length === 0) return [];

  // date_mismatch/other (currency) rows can only get that breakReason when
  // amountOk was already true (matchingEngine.js's evaluateMatch) — their
  // amountDiff is a tiny within-tolerance leftover, not the actual break, so
  // summing it would understate (often to ~$0) categories whose real issue
  // isn't the amount at all. Use the transaction's face value instead, same
  // idea as missing_counterparty/missing_internal using amountA/amountB
  // rather than a diff.
  const amountForGroup = (g) => {
    if (g.breakReason === 'missing_counterparty') return Math.abs(toNum(g._sum.amountA));
    if (g.breakReason === 'missing_internal') return Math.abs(toNum(g._sum.amountB));
    if (g.breakReason === 'date_mismatch' || g.breakReason === 'other') return Math.abs(toNum(g._sum.amountA));
    return Math.abs(toNum(g._sum.amountDiff));
  };

  const amountByReason = new Map(grouped.map((g) => [g.breakReason, amountForGroup(g)]));
  const buckets = Object.entries(BREAK_REASON_CATEGORY_LABELS).map(([reason, category]) => ({
    category,
    amount: amountByReason.get(reason) ?? 0,
  }));
  const total = buckets.reduce((sum, b) => sum + b.amount, 0);

  return buckets
    .map((b) => ({ ...b, percent: total > 0 ? Number(((b.amount / total) * 100).toFixed(2)) : 0 }))
    .sort((a, b) => b.amount - a.amount);
}

// Match-rate + break-value trend, the 7 most recent actual runs vs the 7
// before those. Deliberately run-indexed, not calendar-day-indexed —
// reconciliation runs are typically weekly/monthly, so a daily calendar view
// is mostly flat, carried-forward filler; comparing actual runs against each
// other is the only version of this chart with real signal in it regardless
// of how sparse or bursty the usage pattern is. Arrays can be shorter than 7
// (or empty for "prior") when fewer runs exist yet — callers must not assume
// a fixed length.
//
// scope: 'filePair' (default) compares this report's file-pair lineage only
// (case-insensitive name match, same convention as getTopFilePairs) — the
// meaningful comparison for a recurring reconciliation (e.g. the same
// monthly bank statement vs. ledger). 'overall' compares the org's last N
// completed runs regardless of file pair — useful when there's no repeat
// history for this exact pair yet.
// limit: how many "current" runs to compare (paired with an equal-sized
// "prior" window just before it) — defaults to 7, but callers with a smaller
// or larger natural window (e.g. Explorer's Break Value Trend) can override it.
export async function getFilePairTrend(userId, reportId, { scope = 'filePair', limit = 7 } = {}) {
  const report = await assertReportAccess(userId, reportId);
  const { organizationId } = await getUserMembership(userId);

  const runs = await prisma.report.findMany({
    where: {
      organizationId,
      status: 'completed',
      ...(scope === 'overall'
        ? {}
        : {
            fileAName: { equals: report.fileAName ?? '', mode: 'insensitive' },
            fileBName: { equals: report.fileBName ?? '', mode: 'insensitive' },
          }),
    },
    select: { totalRows: true, matchedCount: true, totalBreakValue: true },
    orderBy: { runDate: 'desc' },
    take: limit * 2,
  });

  // runs[0] is the most recent — reverse each slice so points render oldest
  // to newest, left to right, matching how the chart reads.
  const currentRuns = runs.slice(0, limit).reverse();
  const priorRuns = runs.slice(limit, limit * 2).reverse();

  const matchRateOf = (r) => (r.totalRows > 0 ? (r.matchedCount / r.totalRows) * 100 : 0);
  const breakValueOf = (r) => toNum(r.totalBreakValue);

  return {
    matchRateTrend: { current: currentRuns.map(matchRateOf), prior: priorRuns.map(matchRateOf) },
    breakValueTrend: { current: currentRuns.map(breakValueOf), prior: priorRuns.map(breakValueOf) },
  };
}

// A draft is a minimal Report row with no ReportRows yet — just enough to
// resume later (name, whichever files have been chosen, partial config,
// a progress percentage). Private to its creator, unlike a completed report.
export async function saveDraft(userId, dto) {
  const { organizationId } = await getUserMembership(userId);
  const config = await withOrgToleranceDefaults(organizationId, dto.config);
  const report = await prisma.report.create({
    data: {
      userId,
      organizationId,
      status: 'draft',
      name: dto.name ?? null,
      fileAName: dto.fileAName ?? null,
      fileBName: dto.fileBName ?? null,
      progress: dto.progress ?? 0,
      config: config ?? undefined,
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
  const needsBefore = dto.columnMapping !== undefined || dto.config !== undefined;
  const before = needsBefore
    ? await prisma.report.findFirst({ where: { id: reportId, userId }, select: { columnMapping: true, config: true } })
    : null;

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
    const changes = diffColumnMapping(before?.columnMapping, dto.columnMapping);
    if (Object.keys(changes).length > 0) {
      await logAuditSafely(userId, {
        action: 'report.column_mapping.updated',
        entityType: 'report',
        entityId: reportId,
        ip,
        metadata: { changes },
      });
    }
  }
  if (dto.config !== undefined) {
    const changes = diffConfigFields(before?.config, dto.config);
    if (Object.keys(changes).length > 0) {
      await logAuditSafely(userId, {
        action: 'report.matching_rules.updated',
        entityType: 'report',
        entityId: reportId,
        ip,
        metadata: { changes },
      });
    }
  }

  return prisma.report.findFirst({ where: { id: reportId, userId } });
}

export async function listDrafts(userId) {
  const { organizationId } = await getUserMembership(userId);
  const drafts = await prisma.report.findMany({
    where: { userId, organizationId, status: 'draft' },
    orderBy: { updatedAt: 'desc' },
  });
  return drafts.map(withDraftProgress);
}

// Promotes a draft into a completed report: same shape as a fresh saveReport,
// applied to the existing draft row instead of a new one.
export async function completeDraft(userId, reportId, dto, { ip } = {}) {
  const draft = await prisma.report.findFirst({ where: { id: reportId, userId, status: 'draft' } });
  if (!draft) throw new NotFoundError();
  const config = await withOrgToleranceDefaults(draft.organizationId, dto.config);

  const report = await prisma.$transaction((tx) =>
    persistCompletedRun(tx, reportId, {
      name: dto.name ?? draft.name,
      fileAName: dto.fileAName,
      fileBName: dto.fileBName,
      summary: dto.summary,
      rows: dto.rows,
      config,
    }),
  );

  await logAuditSafely(userId, {
    action: 'report.create',
    entityType: 'report',
    entityId: report.id,
    ip,
    metadata: {
      filePair: `${report.fileAName ?? 'File A'} vs ${report.fileBName ?? 'File B'}`,
      matchRate: report.totalRows > 0 ? `${((report.matchedCount / report.totalRows) * 100).toFixed(2)}%` : 'N/A',
    },
  });

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
  const config = await withOrgToleranceDefaults(organizationId, dto.config);

  await logAuditSafely(userId, {
    action: 'report.run.started',
    entityType: 'report',
    entityId: reportId,
    status: 'info',
    ip,
    metadata: { filePair: `${draft.fileAName ?? 'File A'} vs ${draft.fileBName ?? 'File B'}` },
  });

  let summary, rows;
  try {
    const [fileABuffer, fileBBuffer] = await Promise.all([
      downloadFromR2(draft.fileAKey),
      downloadFromR2(draft.fileBKey),
    ]);
    const fileA = parseTabularFile(fileABuffer, draft.fileAName);
    const fileB = parseTabularFile(fileBBuffer, draft.fileBName);
    ({ summary, rows } = runMatch(fileA, fileB, dto.columnMapping.fileA, dto.columnMapping.fileB, config));
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
      config,
      columnMapping: dto.columnMapping,
      sourceReportId,
    }),
  );

  await logAuditSafely(userId, {
    action: 'report.run.completed',
    entityType: 'report',
    entityId: report.id,
    ip,
    metadata: {
      matchRate: report.totalRows > 0 ? `${((report.matchedCount / report.totalRows) * 100).toFixed(2)}%` : 'N/A',
      totalBreakValue: toNum(report.totalBreakValue),
    },
  });

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

  const fileASummary = { rows: fileA.rows.length, columns: fileA.headers.length, fileSizeBytes: fileABuffer.length };
  const fileBSummary = { rows: fileB.rows.length, columns: fileB.headers.length, fileSizeBytes: fileBBuffer.length };

  const data = {
    fileASampleRows: { totalRows: fileA.rows.length, rows: fileA.rows.slice(0, SAMPLE_ROW_CAP) },
    fileBSampleRows: { totalRows: fileB.rows.length, rows: fileB.rows.slice(0, SAMPLE_ROW_CAP) },
    // Unlike the sample-rows cache above, these are NOT cleared at
    // completion — Results' File Summary cards read them long after.
    fileASummary,
    fileBSummary,
  };
  if (!draft.columnMapping) {
    data.columnMapping = { fileA: mappingA, fileB: mappingB };
  }
  await prisma.report.update({ where: { id: reportId }, data });

  return {
    fileA: {
      filename: draft.fileAName,
      previewRows: fileA.rows.slice(0, 7),
      mappings: suggestedA,
      ...validationA,
      ...fileASummary,
    },
    fileB: {
      filename: draft.fileBName,
      previewRows: fileB.rows.slice(0, 7),
      mappings: suggestedB,
      ...validationB,
      ...fileBSummary,
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
  const existing = await prisma.report.findFirst({
    where: { id: reportId, organizationId },
    select: { userId: true, name: true, fileAName: true, fileBName: true, status: true },
  });
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
    metadata: {
      reportName: existing.name ?? 'Untitled Reconciliation',
      filePair: `${existing.fileAName ?? 'File A'} vs ${existing.fileBName ?? 'File B'}`,
      wasDraft: existing.status === 'draft',
    },
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

// Same scoping rationale as updateReportTag above — renaming is only ever
// exposed on a completed report (Results page), and a draft's name is
// already covered by the plain draft-update PATCH.
export async function updateReportName(userId, reportId, name) {
  const { organizationId } = await getUserMembership(userId);
  const { count } = await prisma.report.updateMany({
    where: { id: reportId, organizationId, status: 'completed' },
    data: { name },
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
    select: { id: true, userId: true, sequenceYear: true, sequenceNumber: true },
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
    metadata: {
      references: existing.map((r) => formatReportReference(r.sequenceYear, r.sequenceNumber) ?? r.id),
      count,
    },
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
