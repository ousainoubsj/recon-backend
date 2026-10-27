import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.config.js';
import { NotFoundError, ValidationError, ConflictError } from '../errors.js';
import { getUserMembership } from './organizationService.js';
import { logAuditSafely } from './auditLogService.js';
import { withSubject } from '../utils/audit.js';
import { reportSubject } from '../utils/reportReference.js';
import { createNotification } from './notificationService.js';
import { downloadFromR2, parseTabularFile } from '../utils/fileParser.js';
import { deleteR2Objects } from '../utils/r2Client.js';
import {
  runMatch,
  extrapolatePreview,
  buildMatchAnalysis,
  buildRecommendedAction,
  buildShortReason,
  deriveDescription,
} from './matchingEngine.js';
import { suggestMapping, mappingFromSuggestions, computeValidationSummary } from './columnMappingService.js';
import { copyReportRowsIn, deleteReportRows } from './reportRowBulkInsert.js';
import { enqueueReconciliationJob } from '../queues/reconciliationQueue.js';
import { setSampleRows, getSampleRows, clearSampleRows } from './mappingSampleCache.js';

// Cap on how many rows of each file get cached on the draft at
// mapping-preview time, for the rule-preview endpoint to reuse cheaply as
// sliders move without re-parsing the full file each time.
// Now that repeated reads go through Redis (mappingSampleCache.js) rather
// than a Postgres JSON column, this mostly just bounds Redis memory per
// draft rather than being the fix for the repeated-read cost it used to be
// — 300 rows is still a reasonable sample for a "cheap estimate" panel.
const SAMPLE_ROW_CAP = 300;

const toNum = (decimal) => (decimal == null ? 0 : Number(decimal));

// A report's own config always wins; this only seeds one when the frontend
// hasn't set amountTolerance/dateToleranceDays yet (a brand-new draft with no
// saved template applied — e.g. "Upload New Files"/"Try Sample", both of
// which call createDraft with no config at all). If the org has an
// admin-designated default MatchRuleTemplate, that's the seed (its full
// config — tolerances, toggles, duplicate handling — not just the two
// tolerance numbers), so the "default" applies uniformly to everyone
// starting a fresh reconciliation, not just non-admins who get it enforced.
// Falls back to the org's plain Reconciliation Defaults settings when there's
// no default template. Explicitly-picked-template drafts (config already has
// both tolerance fields) skip this entirely via the early return, so picking
// a *different* saved template is never silently overwritten.
async function withOrgToleranceDefaults(organizationId, config) {
  if (config?.amountTolerance !== undefined && config?.dateToleranceDays !== undefined) return config;
  const org = await prisma.organization.findFirst({
    where: { id: organizationId },
    select: { defaultAmountTolerance: true, defaultDateToleranceDays: true, enforcedMatchRuleTemplateId: true },
  });

  let seed = {
    amountTolerance: org?.defaultAmountTolerance?.toNumber(),
    dateToleranceDays: org?.defaultDateToleranceDays,
  };
  if (org?.enforcedMatchRuleTemplateId) {
    const defaultTemplate = await prisma.matchRuleTemplate.findFirst({
      where: { id: org.enforcedMatchRuleTemplateId, organizationId },
      select: { config: true },
    });
    if (defaultTemplate) seed = defaultTemplate.config;
  }

  return { ...seed, ...config };
}

// The real enforcement behind an org's admin-designated default MatchRuleTemplate
// — MatchingRulesSidebar.tsx already renders read-only for non-admins when one
// is set, but a non-admin hitting the run/complete-draft endpoints directly
// with a different config must still get the enforced config applied, not
// whatever they submitted. Admins always pass their own config through
// untouched (they're the ones who set the policy). Only used at the two
// points where a reconciliation actually executes (completeDraft,
// runReconciliation) — saveDraft/saveReport aren't the authoritative "this
// is what ran" step, so they're left as before.
async function resolveRunConfig(organizationId, role, config) {
  if (role !== 'admin') {
    const org = await prisma.organization.findFirst({
      where: { id: organizationId },
      select: { enforcedMatchRuleTemplateId: true },
    });
    if (org?.enforcedMatchRuleTemplateId) {
      const enforced = await prisma.matchRuleTemplate.findFirst({
        where: { id: org.enforcedMatchRuleTemplateId, organizationId },
        select: { config: true },
      });
      if (enforced) return enforced.config;
    }
  }
  return withOrgToleranceDefaults(organizationId, config);
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
// Per-status values for Results' stat tiles, summed in SQL once at completion rather than on every page load.
// Stored as JSON numbers, the shape every existing report already has.
async function computeValueBreakdown(tx, reportId) {
  const [sums] = await tx.$queryRaw`
    SELECT
      COALESCE(SUM(COALESCE(amount_a, amount_b)) FILTER (WHERE status = 'matched'), 0) AS "matchedValue",
      COALESCE(SUM(COALESCE(amount_a, amount_b)) FILTER (WHERE status IN ('unmatched_a', 'unmatched_b')), 0) AS "unmatchedValue",
      COALESCE(SUM(COALESCE(amount_a, amount_b)) FILTER (WHERE status = 'duplicate'), 0) AS "duplicateValue"
    FROM report_rows
    WHERE report_id = ${reportId}::uuid`;
  return {
    matchedValue: Number(sums.matchedValue),
    unmatchedValue: Number(sums.unmatchedValue),
    duplicateValue: Number(sums.duplicateValue),
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
    amountDiff: r.amountA != null && r.amountB != null ? new Prisma.Decimal(r.amountA).minus(r.amountB) : null,
    dateA: r.dateA ? new Date(r.dateA) : null,
    dateB: r.dateB ? new Date(r.dateB) : null,
    rawA: r.rawA ?? undefined,
    rawB: r.rawB ?? undefined,
    breakReason: r.breakReason ?? null,
  }));
}

// A single createMany becomes a single INSERT with one bound parameter per
// column per row — Postgres caps a query at 65535 total bound parameters, so
// a large-enough file pair (e.g. thousands of output rows across a wide
// source file) can blow past that limit in one shot and throw. Batching
// keeps every INSERT under the cap; batch size is derived from the actual
// row shape (not hardcoded) so it self-adjusts if reportRowsForInsert's
// field count ever changes. Multiple createMany calls inside the same `tx`
// stay within the caller's transaction, so this is still all-or-nothing.
const POSTGRES_MAX_QUERY_PARAMS = 65535;

async function insertReportRowsInBatches(tx, reportId, rows) {
  const records = reportRowsForInsert(reportId, rows);
  if (records.length === 0) return;
  const fieldsPerRow = Object.keys(records[0]).length;
  const batchSize = Math.floor(POSTGRES_MAX_QUERY_PARAMS / fieldsPerRow);
  for (let i = 0; i < records.length; i += batchSize) {
    await tx.reportRow.createMany({ data: records.slice(i, i + batchSize) });
  }
}

// Atomic per-year counter backing Report.sequenceNumber — the upsert's
// `update` branch is a single UPDATE statement guarded by the year's row
// lock, so concurrent completions in the same transaction-per-request model
// never hand out the same number twice.
async function nextSequenceNumber(tx, year, organizationId) {
  const seq = await tx.reportSequence.upsert({
    where: { year_organizationId: { year, organizationId } },
    create: { year, organizationId, lastValue: 1 },
    update: { lastValue: { increment: 1 } },
  });
  return seq.lastValue;
}

// Shared by completeDraft (legacy client-computed rows) and
// executeReconciliationRun (server-computed via the matching engine) — both
// promote a draft into a completed report the same way, just from different
// sources of `rows`. `dto.name` must already be resolved by the caller (e.g.
// `body.name ?? draft.name`) — this function doesn't know about the draft's
// prior name.
//
// Deliberately NOT one big transaction: the bulk row write (copyReportRowsIn)
// runs first, on its own connection, outside any Prisma transaction — a
// large file's worth of rows has no business being bound by Prisma's
// interactive-transaction timeout. Only the small, fast "assign sequence
// number + flip to completed" step is transactional, and it runs *last*, so
// a report only ever reads `completed` once its rows are fully and
// correctly persisted — never before. deleteReportRows first makes this
// safe to call again for the same reportId (a BullMQ retry after a crash
// mid-COPY) without risking duplicate rows.
async function persistCompletedRun(reportId, dto, { onCopyProgress } = {}) {
  await deleteReportRows(reportId);
  await copyReportRowsIn(reportId, dto.rows, { onProgress: onCopyProgress });
  // The mapping-preview sample has no further use once the real result
  // exists — frees it immediately rather than waiting out its TTL.
  await clearSampleRows(reportId);

  return prisma.$transaction(async (tx) => {
    // A retry of a previously-failed run reuses this same reportId — only
    // assign a sequence number the first time it actually completes, never
    // reassign one on a later retry.
    const existing = await tx.report.findUnique({ where: { id: reportId }, select: { sequenceNumber: true } });
    const needsSequence = existing?.sequenceNumber == null;
    const year = new Date().getUTCFullYear();
    const sequenceNumber = needsSequence ? await nextSequenceNumber(tx, year, dto.organizationId) : undefined;

    return tx.report.update({
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
        valueBreakdown: await computeValueBreakdown(tx, reportId),
        ...(needsSequence ? { sequenceYear: year, sequenceNumber } : {}),
      },
    });
  });
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
  const totalBreakValue = reports.reduce((sum, r) => sum.plus(r.totalBreakValue ?? 0), new Prisma.Decimal(0)).toNumber();
  const avgMatchRate = totalRows > 0 ? (matchedCount / totalRows) * 100 : 0;

  return { count, totalTransactions: totalRows, avgMatchRate, unmatchedTransactions, totalBreakValue };
}

/**
 * @param {string} userId
 * @param {import('../types/recon.js').SaveReportDto} dto
 * @returns {Promise<string>} the new report's id
 */
export async function saveReport(userId, dto, { ip, userAgent } = {}) {
  const { organizationId } = await getUserMembership(userId);
  const config = await withOrgToleranceDefaults(organizationId, dto.config);

  const report = await prisma.$transaction(async (tx) => {
    // This path always creates an already-'completed' report (the schema
    // default), so it always needs a fresh sequence number — unlike
    // persistCompletedRun, there's no draft/retry history to check first.
    const year = new Date().getUTCFullYear();
    const sequenceNumber = await nextSequenceNumber(tx, year, organizationId);

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

    // 2. Bulk-insert rows, batched to stay under Postgres's per-query
    // parameter limit (see insertReportRowsInBatches).
    await insertReportRowsInBatches(tx, report.id, dto.rows);

    return report;
  });

  await logAuditSafely(userId, {
    action: 'report.create',
    entityType: 'report',
    entityId: report.id,
    ip,
    userAgent,
    metadata: withSubject(
      {
        filePair: `${report.fileAName ?? 'File A'} vs ${report.fileBName ?? 'File B'}`,
        matchRate: report.totalRows > 0 ? `${((report.matchedCount / report.totalRows) * 100).toFixed(2)}%` : 'N/A',
      },
      reportSubject(report),
    ),
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
    // Explicit select, not include -- the frontend's Report type (see
    // types/reports.ts) is the contract this endpoint actually needs to
    // satisfy. Without it, every row in this list paid for rulesConfig,
    // fileASampleRows/fileBSampleRows, and the sourceReport relation, none
    // of which HistoryTable or any other listReports consumer reads.
    select: {
      id: true,
      userId: true,
      organizationId: true,
      status: true,
      errorMessage: true,
      fileAName: true,
      fileBName: true,
      name: true,
      tag: true,
      progress: true,
      runDate: true,
      updatedAt: true,
      totalRows: true,
      matchedCount: true,
      unmatchedCount: true,
      mismatchedCount: true,
      duplicateCount: true,
      totalBreakValue: true,
      amountTolerance: true,
      dateToleranceDays: true,
      sequenceYear: true,
      sequenceNumber: true,
      fileAKey: true,
      fileBKey: true,
      columnMapping: true,
      config: true,
      fileASummary: true,
      fileBSummary: true,
      valueBreakdown: true,
      favorites: { where: { userId }, select: { id: true } },
    },
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

// includeRows defaults to false: the vast majority of callers (the polled
// GET /reports/:id that drives useReport, favorite/visibility checks) never
// read the row-level data, but `include: { rows: true }` used to be
// unconditional -- for a report the size of AFTAB (9k+ rows, each carrying
// full rawA/rawB source-column JSON), that meant every single poll during
// and after a run paid the cost of serializing the entire row set for
// nothing. That's what made the progress screen appear to hang right around
// completion for large reports specifically: the moment status flips to
// completed and the rows actually exist, the very next poll's payload jumps
// from empty to several MB. Only the export/email code paths actually build
// row-level content (buildPdfReport/buildXlsxReport/sendReportEmail) and
// opt in explicitly.
export async function getReport(userId, reportId, { includeRows = false } = {}) {
  const { organizationId } = await getUserMembership(userId);
  const report = await prisma.report.findFirst({
    where: { id: reportId, organizationId },
    include: includeRows ? { rows: true } : undefined,
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
  // Only completed reports can carry resolutions; skipping the query keeps the 1s processing poll as cheap as before.
  const resolutionSummary =
    report.status === 'completed' ? await getResolutionSummary(reportId) : { resolvedCount: 0, unresolvedExceptionCount: 0 };

  return { ...withDraftProgress(report), priorRun, runDurationMs, resolutionSummary };
}

// Shown beside the engine's counts, never folded into them: matchedCount and the match rate stay as computed.
async function getResolutionSummary(reportId) {
  const [counts] = await prisma.$queryRaw`
    SELECT
      COUNT(*) FILTER (WHERE resolution_id IS NOT NULL)::int AS "resolvedCount",
      COUNT(*) FILTER (WHERE resolution_id IS NULL AND status <> 'matched')::int AS "unresolvedExceptionCount"
    FROM report_rows
    WHERE report_id = ${reportId}::uuid`;
  return counts;
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
    resolution: row.resolution ? { id: row.resolution.id, kind: row.resolution.kind } : null,
  };
}

const EXPLORER_SORT_FIELD_MAP = { date: 'dateA', amount: 'amountA', reference: 'ref' };

// 'unmatched' covers both sides for the explorer filter; the explicit sides serve the match picker.
const EXPLORER_STATUS_FILTERS = new Map([
  ['matched', 'matched'],
  ['mismatched', 'mismatched'],
  ['unmatched', { in: ['unmatched_a', 'unmatched_b'] }],
  ['unmatched_a', 'unmatched_a'],
  ['unmatched_b', 'unmatched_b'],
  ['duplicate', 'duplicate'],
]);

// Transaction Explorer listing — search/filter/sort/paginate over a single
// report's rows. `status` accepts the mock's 4-way vocabulary
// (matched|mismatched|unmatched|duplicate); 'unmatched' maps to both
// unmatched_a and unmatched_b since ReconRowStatus keeps them distinct.
export async function getTransactions(userId, reportId, filters = {}) {
  await assertReportAccess(userId, reportId);
  const { search, status, resolution, amountMin, amountMax, dateFrom, dateTo, sortBy, sortDir, limit, offset } = filters;

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

  if (resolution === 'resolved') and.push({ resolutionId: { not: null } });
  if (resolution === 'unresolved') and.push({ resolutionId: null });

  // An unknown status is ignored rather than passed to Prisma, which rejects it with a 500.
  const statusFilter = EXPLORER_STATUS_FILTERS.get(status);
  const where = {
    reportId,
    ...(statusFilter ? { status: statusFilter } : {}),
    ...(and.length > 0 ? { AND: and } : {}),
  };
  const orderBy = { [EXPLORER_SORT_FIELD_MAP[sortBy] ?? 'ref']: sortDir === 'desc' ? 'desc' : 'asc' };

  const [rows, total] = await Promise.all([
    prisma.reportRow.findMany({
      where,
      orderBy,
      take: limit ?? 50,
      skip: offset ?? 0,
      include: { resolution: { select: { id: true, kind: true } } },
    }),
    prisma.reportRow.count({ where }),
  ]);

  return { rows: rows.map(mapRowForExplorer), total };
}

// Single-transaction drill-down: raw ledger/counterparty fields plus a
// read-time (never persisted) rule-by-rule match analysis + recommended
// action, derived from the report's own stored rulesConfig.
export async function getTransaction(userId, reportId, rowId) {
  const report = await assertReportAccess(userId, reportId);
  const row = await prisma.reportRow.findFirst({
    where: { id: rowId, reportId },
    include: { resolution: { select: RESOLUTION_SELECT } },
  });
  if (!row) throw new NotFoundError();

  return {
    ...mapRowForExplorer(row),
    rawA: row.rawA,
    rawB: row.rawB,
    matchAnalysis: buildMatchAnalysis(row, report.rulesConfig ?? report.config ?? {}),
    recommendedAction: buildRecommendedAction(row),
    resolution: row.resolution ? mapResolution(row.resolution) : null,
  };
}

const RESOLUTION_SELECT = {
  id: true,
  kind: true,
  note: true,
  resolvedAt: true,
  resolvedByUser: { select: { id: true, name: true } },
  rows: { select: { id: true, ref: true, status: true } },
};

// Only an unmatched_b row exists solely in the counterparty file; every other status has an internal side.
function rowSide(status) {
  return status === 'unmatched_b' ? 'B' : 'A';
}

function mapResolution(resolution) {
  return {
    id: resolution.id,
    kind: resolution.kind,
    note: resolution.note,
    resolvedAt: resolution.resolvedAt,
    resolvedBy: resolution.resolvedByUser ? { id: resolution.resolvedByUser.id, name: resolution.resolvedByUser.name } : null,
    rows: resolution.rows.map((row) => ({ id: row.id, reference: row.ref, side: rowSide(row.status) })),
  };
}

// Resolutions annotate a final result, so they exist only on completed reports.
async function assertCompletedReportAccess(userId, reportId) {
  const report = await assertReportAccess(userId, reportId);
  if (report.status !== 'completed') throw new NotFoundError();
  return report;
}

export async function resolveRows(userId, reportId, { kind, rowIds, note }, { ip, userAgent } = {}) {
  const report = await assertCompletedReportAccess(userId, reportId);
  const rows = await prisma.reportRow.findMany({
    where: { id: { in: rowIds }, reportId },
    select: { id: true, ref: true, status: true, resolutionId: true },
  });
  if (rows.length !== rowIds.length) throw new NotFoundError();
  if (rows.some((row) => row.resolutionId)) throw new ConflictError('One of these transactions is already resolved');
  if (rows.some((row) => row.status === 'matched')) throw new ValidationError('Matched transactions cannot be resolved');
  if (kind === 'matched') {
    const statuses = rows.map((row) => row.status).sort();
    const isOneOfEachSide = statuses.length === 2 && statuses[0] === 'unmatched_a' && statuses[1] === 'unmatched_b';
    if (!isOneOfEachSide) {
      throw new ValidationError('A match pairs one unmatched internal transaction with one unmatched counterparty transaction');
    }
  }

  const resolution = await prisma.$transaction(async (tx) => {
    const created = await tx.reportRowResolution.create({ data: { reportId, kind, note, resolvedBy: userId }, select: { id: true } });
    // resolutionId: null makes the write conditional, so a concurrent resolve of the same row leaves count short.
    const { count } = await tx.reportRow.updateMany({
      where: { id: { in: rowIds }, reportId, resolutionId: null },
      data: { resolutionId: created.id },
    });
    if (count !== rowIds.length) throw new ConflictError('One of these transactions was just resolved by someone else');
    return tx.reportRowResolution.findUnique({ where: { id: created.id }, select: RESOLUTION_SELECT });
  });

  await logAuditSafely(userId, {
    action: 'report.row.resolve',
    entityType: 'report',
    entityId: reportId,
    status: 'info',
    ip,
    userAgent,
    metadata: withSubject({ resolutionId: resolution.id, kind, note, transactionRefs: rows.map((row) => row.ref) }, reportSubject(report)),
  });

  return mapResolution(resolution);
}

export async function unresolve(userId, reportId, resolutionId, { ip, userAgent } = {}) {
  const report = await assertCompletedReportAccess(userId, reportId);
  // Read first: the audit entry records what was undone, and the delete below clears the rows' link.
  const resolution = await prisma.reportRowResolution.findFirst({
    where: { id: resolutionId, reportId },
    select: { id: true, kind: true, note: true, rows: { select: { ref: true } } },
  });
  if (!resolution) throw new NotFoundError();

  // The rows' resolution_id FK is ON DELETE SET NULL, so this one delete unresolves them.
  const { count } = await prisma.reportRowResolution.deleteMany({ where: { id: resolutionId, reportId } });
  if (count === 0) throw new NotFoundError();

  await logAuditSafely(userId, {
    action: 'report.row.unresolve',
    entityType: 'report',
    entityId: reportId,
    status: 'warning',
    ip,
    userAgent,
    metadata: withSubject(
      { resolutionId, kind: resolution.kind, note: resolution.note, transactionRefs: resolution.rows.map((row) => row.ref) },
      reportSubject(report),
    ),
  });
}

export async function markRowReviewed(userId, reportId, rowId, reviewed = true, { ip, userAgent } = {}) {
  const report = await assertReportAccess(userId, reportId);
  const { count } = await prisma.reportRow.updateMany({
    where: { id: rowId, reportId },
    data: reviewed
      ? { reviewed: true, reviewedBy: userId, reviewedAt: new Date() }
      : { reviewed: false, reviewedBy: null, reviewedAt: null },
  });
  if (count === 0) throw new NotFoundError();

  const row = await prisma.reportRow.findFirst({ where: { id: rowId, reportId } });

  await logAuditSafely(userId, {
    action: 'report.row.review',
    entityType: 'reportRow',
    entityId: rowId,
    status: 'info',
    ip,
    userAgent,
    metadata: withSubject({ transactionRef: row.ref, rowStatus: row.status, reviewed }, reportSubject(report)),
  });

  return row;
}

const BREAK_REASON_CATEGORY_LABELS = {
  amount_mismatch: 'Amount Mismatch',
  missing_counterparty: 'Missing in Counterparty File',
  missing_internal: 'Missing in Internal Ledger',
  date_mismatch: 'Date Mismatch',
  other: 'Others',
};

// The 5-bucket "Top Break Causes"/categoryBreakdown shape. Duplicate *rows* are
// deliberately excluded — same rationale as summary.totalBreakValue: a
// duplicate is a data-quality flag, not a value break. An unmatched row whose
// partner is duplicated is a real break, so it gets a sixth bucket, returned
// only when non-zero, and the buckets always sum to the break value. All 5 canonical
// categories are always returned (zero-filled if a reason has no rows this
// run) once there's at least one real break to categorize, so e.g. "Others"
// still shows up at 0/0% rather than silently disappearing — but a report
// with zero breaks at all still returns [] so the empty-state UI still
// applies.
export async function getBreakBreakdown(userId, reportId) {
  await assertReportAccess(userId, reportId);
  const grouped = await prisma.reportRow.groupBy({
    by: ['breakReason', 'status'],
    where: { reportId, breakReason: { not: null }, status: { not: 'duplicate' } },
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
    if (g.breakReason === 'duplicate') return new Prisma.Decimal((g.status === 'unmatched_a' ? g._sum.amountA : g._sum.amountB) ?? 0).abs();
    if (g.breakReason === 'missing_counterparty') return new Prisma.Decimal(g._sum.amountA ?? 0).abs();
    if (g.breakReason === 'missing_internal') return new Prisma.Decimal(g._sum.amountB ?? 0).abs();
    if (g.breakReason === 'date_mismatch' || g.breakReason === 'other') return new Prisma.Decimal(g._sum.amountA ?? 0).abs();
    return new Prisma.Decimal(g._sum.amountDiff ?? 0).abs();
  };

  // Grouping by status too means one reason can span several groups (a duplicated partner on either side).
  const amountByReason = new Map();
  for (const g of grouped) {
    const runningAmount = amountByReason.get(g.breakReason) ?? new Prisma.Decimal(0);
    amountByReason.set(g.breakReason, runningAmount.plus(amountForGroup(g)));
  }
  const buckets = Object.entries(BREAK_REASON_CATEGORY_LABELS).map(([reason, category]) => ({
    category,
    amount: amountByReason.get(reason) ?? new Prisma.Decimal(0),
  }));
  const duplicatedPartnerAmount = amountByReason.get('duplicate');
  if (duplicatedPartnerAmount?.gt(0)) buckets.push({ category: 'Duplicated in Other File', amount: duplicatedPartnerAmount });
  const total = buckets.reduce((sum, b) => sum.plus(b.amount), new Prisma.Decimal(0));

  // Amounts become numbers only here, for the JSON response.
  return buckets
    .sort((a, b) => b.amount.comparedTo(a.amount))
    .map((b) => ({
      category: b.category,
      amount: b.amount.toNumber(),
      percent: total.gt(0) ? b.amount.div(total).times(100).toDecimalPlaces(2).toNumber() : 0,
    }));
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

  const where = {
    organizationId,
    status: 'completed',
    // Anchored to the run being viewed, not "whatever's newest right now" —
    // without this, every report's trend chart showed the same org-wide
    // latest N runs regardless of which report you opened. Bounding by
    // runDate makes the window "the N runs ending at and including this
    // one," so an older report's chart reflects its own history instead of
    // runs that happened after it.
    ...(report.runDate ? { runDate: { lte: report.runDate } } : {}),
    ...(scope === 'overall'
      ? {}
      : {
          fileAName: { equals: report.fileAName ?? '', mode: 'insensitive' },
          fileBName: { equals: report.fileBName ?? '', mode: 'insensitive' },
        }),
  };

  const [runs, totalCount] = await Promise.all([
    prisma.report.findMany({
      where,
      select: { totalRows: true, matchedCount: true, totalBreakValue: true },
      orderBy: { runDate: 'desc' },
      take: limit * 2,
    }),
    prisma.report.count({ where }),
  ]);

  // runs[0] is the most recent, so it's the totalCount'th run that currently
  // exists in this scope; runs[1] is totalCount-1, etc. This is a dense
  // rank recomputed fresh from what currently exists, not the run's
  // permanent Report.sequenceNumber/reference-ID — those two are
  // deliberately different things. sequenceNumber never changes once
  // assigned (so REC-2026-000012 always means the same run, the way an
  // invoice number would) and is intentionally left with gaps if an earlier
  // run gets deleted. This rank is the opposite on purpose: it's only ever
  // used to label *this chart*, always contiguous and always reflecting
  // "how many-th of your currently-existing runs is this," so "last 7"
  // reads as a clean, gapless window (e.g. runs 2-8 of 8) instead of
  // whatever historical numbers those particular runs happened to keep.
  const runsWithRank = runs.map((r, i) => ({ ...r, rank: totalCount - i }));

  // reversed so points render oldest to newest, left to right, matching how
  // the chart reads.
  const currentRuns = runsWithRank.slice(0, limit).reverse();
  const priorRuns = runsWithRank.slice(limit, limit * 2).reverse();

  const matchRateOf = (r) => (r.totalRows > 0 ? (r.matchedCount / r.totalRows) * 100 : 0);
  const breakValueOf = (r) => toNum(r.totalBreakValue);

  return {
    matchRateTrend: { current: currentRuns.map(matchRateOf), prior: priorRuns.map(matchRateOf) },
    breakValueTrend: { current: currentRuns.map(breakValueOf), prior: priorRuns.map(breakValueOf) },
    // Shared by both trends above — they're built from the same
    // currentRuns/priorRuns, so one set of run ranks covers both charts.
    runLabels: { current: currentRuns.map((r) => r.rank), prior: priorRuns.map((r) => r.rank) },
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
// Keys come from the client, so each must be one /files/presign issued to this user. Otherwise a draft
// could point at (and a run would read, and a delete would remove) another organization's upload.
function assertOwnUploadKey(userId, key) {
  if (key !== undefined && !key.startsWith(`uploads/${userId}/`)) {
    throw new ValidationError('File key does not belong to an upload of yours');
  }
}

export async function updateDraft(userId, reportId, dto, { ip, userAgent } = {}) {
  assertOwnUploadKey(userId, dto.fileAKey);
  assertOwnUploadKey(userId, dto.fileBKey);
  const needsBefore = dto.columnMapping !== undefined || dto.config !== undefined;
  const before = needsBefore
    ? await prisma.report.findFirst({
        where: { id: reportId, userId },
        select: { columnMapping: true, config: true, name: true, sequenceYear: true, sequenceNumber: true },
      })
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
        userAgent,
        metadata: withSubject({ changes }, reportSubject(before)),
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
        userAgent,
        metadata: withSubject({ changes }, reportSubject(before)),
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
    // Same reasoning as findDraftOrFailedRun above: fileASampleRows/
    // fileBSampleRows can be several MB of cached JSON per draft (up to
    // SAMPLE_ROW_CAP rows of every column, from getMappingPreview). This
    // list is the "resume a draft" picker — the frontend's Report type
    // never reads these fields — but without the omit, every draft in the
    // list pays that multi-MB cost, which is what made this endpoint take
    // up to a minute for a user with several large-file-pair drafts.
    omit: { fileASampleRows: true, fileBSampleRows: true },
  });
  return drafts.map(withDraftProgress);
}

// Promotes a draft into a completed report: same shape as a fresh saveReport,
// applied to the existing draft row instead of a new one.
export async function completeDraft(userId, reportId, dto, { ip, userAgent } = {}) {
  const draft = await prisma.report.findFirst({ where: { id: reportId, userId, status: 'draft' } });
  if (!draft) throw new NotFoundError();
  const { role } = await getUserMembership(userId);
  const config = await resolveRunConfig(draft.organizationId, role, dto.config);

  const report = await persistCompletedRun(reportId, {
    name: dto.name ?? draft.name,
    fileAName: dto.fileAName,
    fileBName: dto.fileBName,
    organizationId: draft.organizationId,
    summary: dto.summary,
    rows: dto.rows,
    config,
  });

  await logAuditSafely(userId, {
    action: 'report.create',
    entityType: 'report',
    entityId: report.id,
    ip,
    userAgent,
    metadata: withSubject(
      {
        filePair: `${report.fileAName ?? 'File A'} vs ${report.fileBName ?? 'File B'}`,
        matchRate: report.totalRows > 0 ? `${((report.matchedCount / report.totalRows) * 100).toFixed(2)}%` : 'N/A',
      },
      reportSubject(report),
    ),
  });

  return report.id;
}

// A previously failed run behaves like a draft that can be retried — it
// still has fileAKey/fileBKey/columnMapping/sample rows to work with, it
// just needs another attempt.
//
// fileASampleRows/fileBSampleRows can be several MB of JSON for a wide
// source file (getMappingPreview caches up to SAMPLE_ROW_CAP rows of every
// column) — omitted here since none of this helper's callers other than
// getRulePreview ever read them off the row, and fetching them anyway made
// every draft lookup on a large file pair take several seconds for nothing.
// getRulePreview queries directly instead of going through this helper,
// since it's the one place that actually needs the cached sample.
function findDraftOrFailedRun(userId, reportId) {
  return prisma.report.findFirst({
    where: { id: reportId, userId, status: { in: ['draft', 'failed'] } },
    omit: { fileASampleRows: true, fileBSampleRows: true },
  });
}

// Validates and enqueues a reconciliation run for background execution by
// the BullMQ worker (workers/reconciliationWorker.js) — the actual pipeline
// (executeReconciliationRun, below) runs fully decoupled from this request,
// so there's no HTTP-timeout ceiling on how large a file pair can be. Flips
// the report to `processing` synchronously so the caller/poller sees that
// state immediately, without waiting on the worker to even pick the job up.
export async function enqueueReconciliationRun(userId, reportId, dto, { ip, userAgent } = {}) {
  const draft = await findDraftOrFailedRun(userId, reportId);
  if (!draft) throw new NotFoundError();
  if (!draft.fileAKey || !draft.fileBKey) {
    throw new ValidationError('Both files must be uploaded before running reconciliation');
  }

  const { organizationId, role } = await getUserMembership(userId);
  const config = await resolveRunConfig(organizationId, role, dto.config);

  await prisma.report.update({
    where: { id: reportId },
    data: { status: 'processing', progress: 10, errorMessage: null },
  });

  await logAuditSafely(userId, {
    action: 'report.run.started',
    entityType: 'report',
    entityId: reportId,
    status: 'info',
    ip,
    userAgent,
    metadata: withSubject({ filePair: `${draft.fileAName ?? 'File A'} vs ${draft.fileBName ?? 'File B'}` }, reportSubject(draft)),
  });

  await enqueueReconciliationJob({
    reportId,
    userId,
    organizationId,
    ip: ip ?? null,
    userAgent: userAgent ?? null,
    dto: { name: dto.name, columnMapping: dto.columnMapping },
    config,
  });

  return reportId;
}

// Progress ranges for executeReconciliationRun's checkpoints. Download and
// the bulk row write (COPY) get real, proportional progress within their
// range (byte count / row count respectively) — those are the two phases
// that actually scale with file size and can meaningfully take time. Parse
// and match stay flat single-jump checkpoints: both are fast regardless of
// file size in practice, and getting real incremental progress out of them
// (particularly XLSX parsing, which has no per-row hook) would be a much
// bigger rework for a phase that's already over in a second or two.
const PROGRESS_DOWNLOAD_START = 10;
const PROGRESS_DOWNLOAD_END = 40;
const PROGRESS_PARSED = 55;
const PROGRESS_MATCHED = 60;
const PROGRESS_PERSIST_START = 60;
const PROGRESS_PERSIST_END = 95;

// Every progress write — the frequent per-chunk ones from download/COPY
// progress callbacks and the coarse single-shot checkpoints alike — chains
// onto the same promise, so they're strictly serialized in call order.
// That's what keeps a late-resolving "download 38%" write from landing
// after (and clobbering) a "parse complete: 55%" write that logically
// happened later — without needing explicit awaits at every call site.
// Rounding-based dedup keeps the actual write count small regardless of how
// many chunks fire (typically tens per run, not hundreds).
function createProgressReporter(reportId) {
  let last = -1;
  let chain = Promise.resolve();
  return (raw) => {
    const rounded = Math.round(raw);
    if (rounded === last) return chain;
    last = rounded;
    chain = chain
      .then(() => prisma.report.update({ where: { id: reportId }, data: { progress: rounded } }))
      // Best-effort — a transient write failure here shouldn't stall or
      // fail the actual run.
      .catch(() => {});
    return chain;
  };
}

// The actual matching engine entry point: re-downloads+re-parses the full
// files fresh from R2 (never reuses the mapping-preview sample — that's only
// for the cheap rule-preview endpoint), runs the match, and persists exactly
// like completeDraft does. Called only by the BullMQ worker — never
// directly by an HTTP handler; enqueueReconciliationRun (above) is the
// request-facing entry point. Wraps the *entire* pipeline, including
// persistence, in the try/catch: a failure anywhere in here — download,
// parse, match, or the bulk row write — persists a `status: 'failed'` row
// with the real error message rather than leaving the report silently stuck
// in whatever state it was already in.
export async function executeReconciliationRun({ reportId, userId, ip, userAgent, dto, config, organizationId }) {
  const draft = await prisma.report.findFirst({
    where: { id: reportId },
    omit: { fileASampleRows: true, fileBSampleRows: true },
  });
  if (!draft) throw new NotFoundError();

  const reportProgress = createProgressReporter(reportId);

  try {
    // Combined byte progress across both downloads, scaled into the
    // download range — each file's onProgress fires independently
    // (Promise.all runs them concurrently), so this recomputes the
    // combined fraction from whichever side last reported.
    let bytesA = 0;
    let totalA = 0;
    let bytesB = 0;
    let totalB = 0;
    const reportDownloadProgress = () => {
      const total = totalA + totalB;
      if (!total) return;
      const fraction = (bytesA + bytesB) / total;
      reportProgress(PROGRESS_DOWNLOAD_START + fraction * (PROGRESS_DOWNLOAD_END - PROGRESS_DOWNLOAD_START));
    };

    const [fileABuffer, fileBBuffer] = await Promise.all([
      downloadFromR2(draft.fileAKey, {
        onProgress: (bytes, total) => {
          bytesA = bytes;
          if (total != null) totalA = total;
          reportDownloadProgress();
        },
      }),
      downloadFromR2(draft.fileBKey, {
        onProgress: (bytes, total) => {
          bytesB = bytes;
          if (total != null) totalB = total;
          reportDownloadProgress();
        },
      }),
    ]);

    const fileA = parseTabularFile(fileABuffer, draft.fileAName);
    const fileB = parseTabularFile(fileBBuffer, draft.fileBName);
    await reportProgress(PROGRESS_PARSED);

    const { summary, rows } = runMatch(fileA, fileB, dto.columnMapping.fileA, dto.columnMapping.fileB, config);
    await reportProgress(PROGRESS_MATCHED);

    // organizationId comes from the job payload, resolved once in
    // enqueueReconciliationRun — not re-fetched here. It never changes for
    // an in-flight run, and getUserMembership is a real DB round-trip; this
    // avoids paying it twice per run for the same answer.
    const sourceReportId = await findSourceReportId(organizationId, draft.fileAName, draft.fileBName, reportId);

    const report = await persistCompletedRun(
      reportId,
      {
        name: dto.name ?? draft.name,
        fileAName: draft.fileAName,
        fileBName: draft.fileBName,
        organizationId,
        summary,
        rows,
        config,
        columnMapping: dto.columnMapping,
        sourceReportId,
      },
      {
        onCopyProgress: (written, total) => {
          reportProgress(PROGRESS_PERSIST_START + (written / total) * (PROGRESS_PERSIST_END - PROGRESS_PERSIST_START));
        },
      },
    );

    await logAuditSafely(userId, {
      action: 'report.run.completed',
      entityType: 'report',
      entityId: report.id,
      ip,
      userAgent,
      metadata: withSubject(
        {
          matchRate: report.totalRows > 0 ? `${((report.matchedCount / report.totalRows) * 100).toFixed(2)}%` : 'N/A',
          totalBreakValue: toNum(report.totalBreakValue),
        },
        reportSubject(report),
      ),
    });

    return report.id;
  } catch (err) {
    await prisma.report.update({ where: { id: reportId }, data: { status: 'failed', errorMessage: err.message } });
    await logAuditSafely(userId, {
      action: 'report.run.failed',
      entityType: 'report',
      entityId: reportId,
      status: 'failed',
      ip,
      userAgent,
      metadata: withSubject({ reason: err.message }, reportSubject(draft)),
    });
    throw err;
  }
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
    // The actual row data lives in Redis (mappingSampleCache.js) — this is
    // just a small marker recording that a sample exists and how many total
    // rows the source file has (extrapolatePreview's scale factor needs
    // that), without dragging the full sample through Postgres.
    fileASampleRows: { totalRows: fileA.rows.length },
    fileBSampleRows: { totalRows: fileB.rows.length },
    // Unlike the sample-rows marker above, these are NOT cleared at
    // completion — Results' File Summary cards read them long after.
    fileASummary,
    fileBSummary,
  };
  if (!draft.columnMapping) {
    data.columnMapping = { fileA: mappingA, fileB: mappingB };
  }
  await Promise.all([
    prisma.report.update({ where: { id: reportId }, data }),
    setSampleRows(reportId, 'A', fileA.rows.slice(0, SAMPLE_ROW_CAP)),
    setSampleRows(reportId, 'B', fileB.rows.slice(0, SAMPLE_ROW_CAP)),
  ]);

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
  // Queries directly rather than via findDraftOrFailedRun — this is the one
  // caller that actually needs fileASampleRows/fileBSampleRows, which that
  // helper omits (see its comment).
  const draft = await prisma.report.findFirst({
    where: { id: reportId, userId, status: { in: ['draft', 'failed'] } },
  });
  if (!draft) throw new NotFoundError();
  if (!draft.fileASampleRows || !draft.fileBSampleRows) {
    throw new ConflictError('Call the mapping-preview endpoint before requesting a rule preview');
  }
  const mapping = dto.columnMapping ?? draft.columnMapping;
  if (!mapping) throw new ConflictError('No column mapping available — call the mapping-preview endpoint first');

  const [sampleARows, sampleBRows] = await Promise.all([
    getSampleRows(reportId, 'A'),
    getSampleRows(reportId, 'B'),
  ]);
  // The Postgres marker (checked above) can outlive the Redis cache — it's
  // not cleared on TTL expiry, only on run completion — so this is a
  // separate, real "the cache is gone" case, not just defensive padding.
  if (!sampleARows || !sampleBRows) {
    throw new ConflictError('Call the mapping-preview endpoint before requesting a rule preview');
  }

  const { summary } = runMatch(
    { rows: sampleARows },
    { rows: sampleBRows },
    mapping.fileA,
    mapping.fileB,
    dto.config,
  );

  return extrapolatePreview(
    summary,
    sampleARows.length,
    draft.fileASampleRows.totalRows,
    sampleBRows.length,
    draft.fileBSampleRows.totalRows,
  );
}

/**
 * R2 objects a deleted report leaves behind: its two uploads and its stored exports. Only keys under
 * the report's own prefixes are returned, so a stored key pointing anywhere else is never deleted.
 */
async function reportFileKeys(reports, organizationId) {
  if (reports.length === 0) return [];
  const exports = await prisma.reportExport.findMany({
    where: { reportId: { in: reports.map((r) => r.id) }, organizationId, fileKey: { not: null } },
    select: { fileKey: true },
  });
  const uploadKeys = reports.flatMap((r) =>
    [r.fileAKey, r.fileBKey].filter((key) => key?.startsWith(`uploads/${r.userId}/`)),
  );
  const exportKeys = exports.map((e) => e.fileKey).filter((key) => key.startsWith(`exports/${organizationId}/`));
  return [...uploadKeys, ...exportKeys];
}

// After the rows are gone: a failure here leaves orphaned files (logged for cleanup), never a half-deleted report.
async function deleteReportFiles(keys) {
  try {
    await deleteR2Objects(keys);
  } catch (err) {
    console.error('Failed to delete report files from R2', keys.length, err);
  }
}

// Org admins can delete any report in the org; everyone else may only
// delete a report they created themselves.
export async function deleteReport(userId, reportId, { ip, userAgent } = {}) {
  const { organizationId, role } = await getUserMembership(userId);

  // Read first to know the original owner (needed for the notification
  // below) — the actual delete stays a single permission-scoped deleteMany,
  // so a report that no longer matches still correctly 404s either way.
  const existing = await prisma.report.findFirst({
    where: { id: reportId, organizationId },
    select: {
      id: true,
      userId: true,
      name: true,
      fileAName: true,
      fileBName: true,
      fileAKey: true,
      fileBKey: true,
      status: true,
      sequenceYear: true,
      sequenceNumber: true,
    },
  });
  if (!existing) throw new NotFoundError();
  // Read before the delete: its cascade removes the export rows that hold these keys.
  const fileKeys = await reportFileKeys([existing], organizationId);

  const { count } = await prisma.report.deleteMany({
    where: { id: reportId, organizationId, ...(role === 'admin' ? {} : { userId }) },
  });
  if (count === 0) throw new NotFoundError();
  await deleteReportFiles(fileKeys);

  const isAdminActingOnAnother = role === 'admin' && existing.userId !== userId;
  await logAuditSafely(userId, {
    action: 'report.delete',
    entityType: 'report',
    entityId: reportId,
    status: isAdminActingOnAnother ? 'warning' : 'success',
    ip,
    userAgent,
    metadata: withSubject(
      {
        filePair: `${existing.fileAName ?? 'File A'} vs ${existing.fileBName ?? 'File B'}`,
        wasDraft: existing.status === 'draft',
      },
      reportSubject(existing),
    ),
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
export async function updateReportTag(userId, reportId, tag, { ip, userAgent } = {}) {
  const { organizationId } = await getUserMembership(userId);
  const before = await prisma.report.findFirst({
    where: { id: reportId, organizationId, status: 'completed' },
    select: { tag: true, name: true, sequenceYear: true, sequenceNumber: true },
  });
  if (!before) throw new NotFoundError();

  const { count } = await prisma.report.updateMany({
    where: { id: reportId, organizationId, status: 'completed' },
    data: { tag },
  });
  if (count === 0) throw new NotFoundError();

  if (before.tag !== tag) {
    await logAuditSafely(userId, {
      action: 'report.tag.update',
      entityType: 'report',
      entityId: reportId,
      ip,
      userAgent,
      metadata: withSubject({ changes: { tag: { from: before.tag, to: tag } } }, reportSubject(before)),
    });
  }

  return prisma.report.findFirst({ where: { id: reportId, organizationId } });
}

// Same scoping rationale as updateReportTag above — renaming is only ever
// exposed on a completed report (Results page), and a draft's name is
// already covered by the plain draft-update PATCH.
export async function updateReportName(userId, reportId, name, { ip, userAgent } = {}) {
  const { organizationId } = await getUserMembership(userId);
  const before = await prisma.report.findFirst({
    where: { id: reportId, organizationId, status: 'completed' },
    select: { name: true, sequenceYear: true, sequenceNumber: true },
  });
  if (!before) throw new NotFoundError();

  const { count } = await prisma.report.updateMany({
    where: { id: reportId, organizationId, status: 'completed' },
    data: { name },
  });
  if (count === 0) throw new NotFoundError();

  if (before.name !== name) {
    await logAuditSafely(userId, {
      action: 'report.rename',
      entityType: 'report',
      entityId: reportId,
      ip,
      userAgent,
      metadata: withSubject({ changes: { name: { from: before.name, to: name } } }, reportSubject({ ...before, name })),
    });
  }

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
export async function bulkDeleteReports(userId, ids, { ip, userAgent } = {}) {
  const { organizationId, role } = await getUserMembership(userId);

  const existing = await prisma.report.findMany({
    where: { id: { in: ids }, organizationId },
    select: { id: true, userId: true, sequenceYear: true, sequenceNumber: true, fileAKey: true, fileBKey: true },
  });
  // Same rule as the delete below: a non-admin's request only removes their own reports.
  const deletable = role === 'admin' ? existing : existing.filter((r) => r.userId === userId);
  const fileKeys = await reportFileKeys(deletable, organizationId);

  const { count } = await prisma.report.deleteMany({
    where: { id: { in: ids }, organizationId, ...(role === 'admin' ? {} : { userId }) },
  });
  await deleteReportFiles(fileKeys);

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
    userAgent,
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
export async function getReportsByIds(userId, ids, { requireCompleted = false, includeRows = true } = {}) {
  const { organizationId } = await getUserMembership(userId);
  const reports = await prisma.report.findMany({
    where: { id: { in: ids }, organizationId, ...(requireCompleted ? { status: 'completed' } : {}) },
    include: { rows: includeRows },
  });

  const byId = new Map(reports.map((r) => [r.id, r]));
  const visible = ids
    .map((id) => byId.get(id))
    .filter((report) => report && (report.status !== 'draft' || report.userId === userId));

  if (visible.length !== ids.length) throw new NotFoundError();
  return visible;
}

const EMPTY_ROW_STATS = { largestBreak: new Prisma.Decimal(0), unmatchedACount: 0, unmatchedBCount: 0, duplicateRowCount: 0 };

// A Combined Report needs a few figures per run, not its rows: one grouped query instead of loading every row of up to 100 runs.
export async function getComparisonReports(userId, ids) {
  // Throws unless every id is a completed report the caller can see, so the stats query below only reads visible reports.
  const reports = await getReportsByIds(userId, ids, { requireCompleted: true, includeRows: false });
  const stats = await prisma.$queryRaw`
    SELECT
      report_id::text AS "reportId",
      COALESCE(MAX(ABS(amount_diff)), 0) AS "largestBreak",
      COUNT(*) FILTER (WHERE status = 'unmatched_a')::int AS "unmatchedACount",
      COUNT(*) FILTER (WHERE status = 'unmatched_b')::int AS "unmatchedBCount",
      COUNT(*) FILTER (WHERE status = 'duplicate')::int AS "duplicateRowCount"
    FROM report_rows
    WHERE report_id = ANY(${ids}::uuid[])
    GROUP BY report_id`;
  const statsByReportId = new Map(stats.map(({ reportId, ...rowStats }) => [reportId, rowStats]));
  return reports.map((report) => ({ ...report, rowStats: statsByReportId.get(report.id) ?? EMPTY_ROW_STATS }));
}
