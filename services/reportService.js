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
  parseAmount,
  parseDate,
} from './matchingEngine.js';
import { suggestMapping, mappingFromSuggestions, computeValidationSummary } from './columnMappingService.js';
import { copyReportRowsIn, deleteReportRows } from './reportRowBulkInsert.js';
import { enqueueReconciliationJob } from '../queues/reconciliationQueue.js';
import { enqueueFilePreview } from '../queues/filePreviewQueue.js';
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
// point where a reconciliation actually executes (enqueueReconciliationRun) —
// saveDraft isn't the authoritative "this is what ran" step, so it's left as before.
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

// Every org-wide figure counts a reconciliation once: a report superseded by a completed rerun is left out.
const CURRENT_COMPLETED = { status: 'completed', supersededById: null };

// The org's current completed runs (superseded runs excluded), for the dashboard aggregates below.
function currentCompletedWhere(organizationId) {
  return Prisma.sql`organization_id = ${organizationId} AND status = 'completed' AND superseded_by_id IS NULL`;
}

// Totals per named window, all in one query. A window is a [start, end) runDate range, or null for all time.
async function aggregateCompletedWindows(organizationId, windows) {
  const columns = Object.entries(windows).map(([name, range]) => {
    const filter = range ? Prisma.sql`FILTER (WHERE run_date >= ${range.start} AND run_date < ${range.end})` : Prisma.empty;
    const as = (field) => Prisma.raw(`"${name}.${field}"`);
    return Prisma.sql`
      COUNT(*) ${filter} AS ${as('count')},
      COALESCE(SUM(total_rows) ${filter}, 0)::bigint AS ${as('totalRows')},
      COALESCE(SUM(matched_count) ${filter}, 0)::bigint AS ${as('matched')},
      COALESCE(SUM(unmatched_count + mismatched_count) ${filter}, 0)::bigint AS ${as('unmatchedTransactions')},
      COALESCE(SUM(total_break_value) ${filter}, 0) AS ${as('totalBreakValue')}`;
  });
  const [row] = await prisma.$queryRaw`SELECT ${Prisma.join(columns)} FROM reports WHERE ${currentCompletedWhere(organizationId)}`;

  return Object.fromEntries(
    Object.keys(windows).map((name) => {
      const totalRows = Number(row[`${name}.totalRows`]);
      const matched = Number(row[`${name}.matched`]);
      return [
        name,
        {
          count: Number(row[`${name}.count`]),
          totalTransactions: totalRows,
          avgMatchRate: totalRows > 0 ? (matched / totalRows) * 100 : 0,
          unmatchedTransactions: Number(row[`${name}.unmatchedTransactions`]),
          totalBreakValue: new Prisma.Decimal(row[`${name}.totalBreakValue`]).toNumber(),
        },
      ];
    }),
  );
}

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

// Promotes a draft into a completed report with the rows executeReconciliationRun computed.
// `dto.name` must already be resolved by the caller (e.g.
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
    const existing = await tx.report.findUnique({ where: { id: reportId }, select: { sequenceNumber: true, sourceReportId: true } });
    const needsSequence = existing?.sequenceNumber == null;
    const year = new Date().getUTCFullYear();
    const sequenceNumber = needsSequence ? await nextSequenceNumber(tx, year, dto.organizationId) : undefined;

    const completed = await tx.report.update({
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
        // Cleared once a run completes — no longer needed after the full
        // files have been re-parsed for the real result.
        fileASampleRows: null,
        fileBSampleRows: null,
        valueBreakdown: await computeValueBreakdown(tx, reportId),
        ...(needsSequence ? { sequenceYear: year, sequenceNumber } : {}),
      },
    });

    // Marked here, not before the run: a failed run leaves its corrections pending for the retry.
    if (dto.appliedCorrectionIds?.length) {
      await tx.reportCorrection.updateMany({ where: { id: { in: dto.appliedCorrectionIds }, reportId }, data: { applied: true } });
    }

    // Same transaction as the completion: a rerun is never complete without having replaced its predecessor.
    if (existing?.sourceReportId) await supersedeNewestInChain(tx, existing.sourceReportId, reportId);
    return completed;
  });
}

// Chains are short (each rerun needs a human); the cap only guards against a cycle in corrupted data.
const MAX_SUPERSEDE_HOPS = 50;

// A completing rerun replaces the newest run in its source's chain: normally the source itself, or an
// earlier rerun of the same source that completed first. Locking the source row serialises two reruns of
// one source finishing together, so neither can claim the same predecessor.
async function supersedeNewestInChain(tx, sourceReportId, rerunId) {
  await tx.$queryRaw`SELECT id FROM reports WHERE id = ${sourceReportId}::uuid FOR UPDATE`;

  let newestId = sourceReportId;
  for (let hop = 0; hop < MAX_SUPERSEDE_HOPS; hop += 1) {
    const newest = await tx.report.findUnique({ where: { id: newestId }, select: { supersededById: true } });
    // The source was deleted while this rerun ran: there's nothing left to replace.
    if (!newest) return;
    // A retried completion of this same rerun already did the job.
    if (newest.supersededById === rerunId) return;
    if (!newest.supersededById) {
      await tx.report.update({ where: { id: newestId }, data: { supersededById: rerunId } });
      return;
    }
    newestId = newest.supersededById;
  }
  throw new Error(`Supersede chain from report ${sourceReportId} exceeds ${MAX_SUPERSEDE_HOPS} runs`);
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
      supersededBy: { select: SUPERSEDED_BY_SELECT },
    },
    orderBy: { runDate: 'desc' },
    ...(offset ? { skip: offset } : {}),
    ...(limit ? { take: limit } : {}),
  });

  return reports.map(({ favorites, supersededBy, ...report }) => ({
    ...report,
    isFavorited: favorites.length > 0,
    supersededBy: mapSupersededBy(supersededBy),
  }));
}

// All-time totals for the dashboard's headline stat cards (Total
// Reconciliations, Avg Match Rate, Unmatched Transactions, Total Break
// Value), each paired with a deltaPercent trend still measured current vs
// previous calendar month — every window summed in one SQL query.
export async function getReportsSummary(userId) {
  const { organizationId } = await getUserMembership(userId);
  const current = monthRange(0);
  const previous = monthRange(1);

  const {
    allTime: allTimeStats,
    currentMonth: currentMonthStats,
    previousMonth: previousMonthStats,
  } = await aggregateCompletedWindows(organizationId, { allTime: null, currentMonth: current, previousMonth: previous });

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
// merges unmatched_a + unmatched_b at completion (persistCompletedRun), so
// the category breakdown here is a 4-way split (Matched / Mismatched /
// Unmatched / Duplicates), not the 5-way split that would need a
// per-ReportRow query.
export async function getReportsTrend(userId, { months = 6 } = {}) {
  const { organizationId } = await getUserMembership(userId);
  const { start } = monthRange(months - 1);

  // run_date is stored in UTC, so date_trunc's month is the UTC month the buckets below are keyed by.
  const [monthly, [categories]] = await Promise.all([
    prisma.$queryRaw`
      SELECT
        to_char(date_trunc('month', run_date), 'YYYY-MM') AS month,
        COUNT(*)::int AS count,
        COALESCE(SUM(total_rows), 0)::bigint AS "totalRows",
        COALESCE(SUM(matched_count), 0)::bigint AS matched
      FROM reports
      WHERE ${currentCompletedWhere(organizationId)} AND run_date >= ${start}
      GROUP BY 1`,
    prisma.$queryRaw`
      SELECT
        COALESCE(SUM(matched_count), 0)::bigint AS matched,
        COALESCE(SUM(mismatched_count), 0)::bigint AS mismatched,
        COALESCE(SUM(unmatched_count), 0)::bigint AS unmatched,
        COALESCE(SUM(duplicate_count), 0)::bigint AS duplicates
      FROM reports
      WHERE ${currentCompletedWhere(organizationId)}`,
  ]);
  const byMonth = new Map(monthly.map((m) => [m.month, m]));

  const matchRateSeries = [];
  const volumeSeries = [];
  for (let i = months - 1; i >= 0; i--) {
    const { start: bucketStart } = monthRange(i);
    const month = `${bucketStart.getUTCFullYear()}-${String(bucketStart.getUTCMonth() + 1).padStart(2, '0')}`;
    const stats = byMonth.get(month);
    const totalRows = Number(stats?.totalRows ?? 0);
    matchRateSeries.push({ month, value: totalRows > 0 ? (Number(stats.matched) / totalRows) * 100 : 0 });
    volumeSeries.push({ month, value: stats?.count ?? 0 });
  }

  const categoryBreakdown = {
    matched: Number(categories.matched),
    mismatched: Number(categories.mismatched),
    unmatched: Number(categories.unmatched),
    duplicates: Number(categories.duplicates),
  };

  return { matchRateSeries, volumeSeries, categoryBreakdown };
}

// History's headline stat cards: all-time cumulative totals (not a single
// period, unlike the dashboard's month-over-month cards above), each paired
// with a rolling 30-vs-previous-30-day growth rate for the "vs last 30 days"
// trend label.
export async function getHistoryStats(userId) {
  const { organizationId } = await getUserMembership(userId);

  const {
    allTime: allTimeStats,
    current: currentStats,
    previous: previousStats,
  } = await aggregateCompletedWindows(organizationId, { allTime: null, current: dayRange(0, 30), previous: dayRange(30, 30) });

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
// window, summed in one query like getHistoryStats above. Takes organizationId directly (not userId +
// getUserMembership) since the digest job already has every org's id
// resolved before calling this — it isn't running inside a user request.
export async function getWeeklyDigestStats(organizationId) {
  const current = dayRange(0, 7);
  const prior = dayRange(7, 7);
  const { current: currentStats, prior: priorStats } = await aggregateCompletedWindows(organizationId, { current, prior });

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
  const [[rates], failedCount] = await Promise.all([
    prisma.$queryRaw`
      SELECT
        COUNT(*) FILTER (WHERE rate >= 99)::int AS "b0",
        COUNT(*) FILTER (WHERE rate >= 95 AND rate < 99)::int AS "b1",
        COUNT(*) FILTER (WHERE rate >= 90 AND rate < 95)::int AS "b2",
        COUNT(*) FILTER (WHERE rate < 90)::int AS "b3"
      FROM (
        SELECT CASE WHEN total_rows > 0 THEN matched_count * 100.0 / total_rows ELSE 0 END AS rate
        FROM reports
        WHERE ${currentCompletedWhere(organizationId)}
      ) runs`,
    prisma.report.count({ where: { organizationId, status: 'failed' } }),
  ]);
  // Same order as MATCH_RATE_BUCKETS, whose bounds the FILTERs above repeat.
  const counts = [rates.b0, rates.b1, rates.b2, rates.b3];

  const total = counts.reduce((sum, n) => sum + n, 0) + failedCount;
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
// whichever casing ran first.
export async function getTopFilePairs(userId, { limit = 4 } = {}) {
  const { organizationId } = await getUserMembership(userId);
  // groupCount and runCount are taken over every group before the LIMIT, so "Other File Pairs" needs no second query.
  const pairs = await prisma.$queryRaw`
    SELECT
      (array_agg(file_a_name ORDER BY run_date))[1] AS "fileA",
      (array_agg(file_b_name ORDER BY run_date))[1] AS "fileB",
      COUNT(*)::int AS count,
      (COUNT(*) OVER ())::int AS "groupCount",
      (SUM(COUNT(*)) OVER ())::int AS "runCount"
    FROM reports
    WHERE ${currentCompletedWhere(organizationId)}
    GROUP BY lower(COALESCE(file_a_name, '')), lower(COALESCE(file_b_name, ''))
    ORDER BY count DESC, MIN(run_date)
    LIMIT ${limit}`;

  const top = pairs.map((pair) => ({ label: `${pair.fileA ?? ''} vs ${pair.fileB ?? ''}`, count: pair.count }));
  if (pairs.length > 0 && pairs[0].groupCount > pairs.length) {
    const shownRuns = top.reduce((sum, pair) => sum + pair.count, 0);
    top.push({ label: 'Other File Pairs', count: pairs[0].runCount - shownRuns });
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
const SUPERSEDED_BY_SELECT = { id: true, sequenceYear: true, sequenceNumber: true };

function mapSupersededBy(supersededBy) {
  return supersededBy ? { id: supersededBy.id, reference: formatReportReference(supersededBy.sequenceYear, supersededBy.sequenceNumber) } : null;
}

// Rows as the exports need them: each with the kind and note of its manual resolution, if any.
const ROWS_WITH_RESOLUTION = { include: { resolution: { select: { kind: true, note: true } } } };
// The corrections this report's run used, for the exports' Corrections sheet and Corrected column.
const APPLIED_CORRECTIONS = {
  where: { applied: true },
  orderBy: [{ side: 'asc' }, { rowIndex: 'asc' }, { field: 'asc' }],
  select: {
    side: true,
    rowIndex: true,
    rowReference: true,
    field: true,
    originalValue: true,
    correctedValue: true,
    reason: true,
    createdAt: true,
    createdByUser: { select: { name: true } },
  },
};

export async function getReport(userId, reportId, { includeRows = false } = {}) {
  const { organizationId } = await getUserMembership(userId);
  const report = await prisma.report.findFirst({
    where: { id: reportId, organizationId },
    // Polled every second during a run; the stored mapping preview is served by its own endpoint.
    omit: { mappingPreview: true },
    include: includeRows
      ? { rows: ROWS_WITH_RESOLUTION, corrections: APPLIED_CORRECTIONS, supersededBy: { select: SUPERSEDED_BY_SELECT } }
      : { supersededBy: { select: SUPERSEDED_BY_SELECT } },
  });
  if (!report) throw new NotFoundError();
  // Drafts are private to their creator — org membership alone isn't enough,
  // unlike a completed report which is shared org-wide.
  if (report.status === 'draft' && report.userId !== userId) throw new NotFoundError();

  // "vs last run" compares a rerun against the report it was rerun from. Any other run compares against
  // the most recent completed run in the org overall, matching the "All Reconciliations" default used
  // elsewhere (getFilePairTrend's 'overall' scope).
  let priorRun = null;
  if (report.status === 'completed') {
    const priorWhere = report.sourceReportId
      ? { id: report.sourceReportId, organizationId, status: 'completed' }
      : { organizationId, ...CURRENT_COMPLETED, id: { not: reportId }, runDate: { lt: report.runDate } };
    const prior = await prisma.report.findFirst({
      where: priorWhere,
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

  const rerunOf = report.status === 'completed' ? await getRerunOf(report) : null;
  const correctionSummary =
    report.status === 'processing' ? { pending: 0, applied: 0 } : await getCorrectionSummary(reportId);

  return {
    ...withDraftProgress(report),
    supersededBy: mapSupersededBy(report.supersededBy),
    priorRun,
    runDurationMs,
    resolutionSummary,
    rerunOf,
    correctionSummary,
  };
}

// pending: applied by the next rerun (or, on a draft, by its run). applied: what this report's run used.
async function getCorrectionSummary(reportId) {
  const [counts] = await prisma.$queryRaw`
    SELECT
      COUNT(*) FILTER (WHERE NOT applied)::int AS "pending",
      COUNT(*) FILTER (WHERE applied)::int AS "applied"
    FROM report_corrections
    WHERE report_id = ${reportId}::uuid`;
  return counts;
}

// null for a first run, or once the source is deleted (the FK is ON DELETE SET NULL).
async function getRerunOf(report) {
  if (!report.sourceReportId) return null;
  const source = await prisma.report.findFirst({
    where: { id: report.sourceReportId, organizationId: report.organizationId },
    select: { id: true, name: true, sequenceYear: true, sequenceNumber: true },
  });
  if (!source) return null;
  return { id: source.id, name: source.name, reference: formatReportReference(source.sequenceYear, source.sequenceNumber) };
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

function mapRowForExplorer(row, corrections = []) {
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
    corrections,
  };
}

// The corrections made on these rows, keyed `${side}:${rowIndex}`. One query for a whole page of rows.
async function correctionsByRowPosition(reportId, rows, select) {
  const indicesA = rows.map((row) => row.rowIndexA).filter((index) => index != null);
  const indicesB = rows.map((row) => row.rowIndexB).filter((index) => index != null);
  const byPosition = new Map();
  if (indicesA.length === 0 && indicesB.length === 0) return byPosition;

  const corrections = await prisma.reportCorrection.findMany({
    where: {
      reportId,
      OR: [
        { side: 'A', rowIndex: { in: indicesA } },
        { side: 'B', rowIndex: { in: indicesB } },
      ],
    },
    orderBy: [{ side: 'asc' }, { field: 'asc' }, { applied: 'desc' }],
    select: { ...select, side: true, rowIndex: true },
  });
  for (const correction of corrections) {
    const key = `${correction.side}:${correction.rowIndex}`;
    if (!byPosition.has(key)) byPosition.set(key, []);
    byPosition.get(key).push(correction);
  }
  return byPosition;
}

function rowCorrections(byPosition, row) {
  return [...(byPosition.get(`A:${row.rowIndexA}`) ?? []), ...(byPosition.get(`B:${row.rowIndexB}`) ?? [])];
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

  const corrections = await correctionsByRowPosition(reportId, rows, { field: true, applied: true });
  const rowsWithBadges = rows.map((row) =>
    mapRowForExplorer(
      row,
      rowCorrections(corrections, row).map((c) => ({ field: c.field, side: c.side, applied: c.applied })),
    ),
  );
  return { rows: rowsWithBadges, total };
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

  const corrections = rowCorrections(await correctionsByRowPosition(reportId, [row], CORRECTION_SELECT), row);
  // A side is correctable only where the row has that file's data and the run recorded its position.
  const correctableSides = [];
  if (row.rawA != null && row.rowIndexA != null) correctableSides.push('A');
  if (row.rawB != null && row.rowIndexB != null) correctableSides.push('B');

  return {
    ...mapRowForExplorer(row),
    rawA: row.rawA,
    rawB: row.rawB,
    corrections: corrections.map(mapCorrection),
    correctableSides,
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

const CORRECTION_SELECT = {
  id: true,
  side: true,
  rowIndex: true,
  rowReference: true,
  field: true,
  originalValue: true,
  correctedValue: true,
  reason: true,
  applied: true,
  createdAt: true,
  createdByUser: { select: { id: true, name: true } },
};

function mapCorrection(correction) {
  return {
    id: correction.id,
    side: correction.side,
    rowIndex: correction.rowIndex,
    rowReference: correction.rowReference,
    field: correction.field,
    originalValue: correction.originalValue,
    correctedValue: correction.correctedValue,
    reason: correction.reason,
    applied: correction.applied,
    createdBy: correction.createdByUser ? { id: correction.createdByUser.id, name: correction.createdByUser.name } : null,
    createdAt: correction.createdAt,
  };
}

// The column mapping key each correctable field is read from.
const CORRECTION_FIELD_MAPPING_KEY = { reference: 'referenceNumber', amount: 'amount', date: 'transactionDate', currency: 'currency' };
// Matches the VarChar(500) value columns on report_corrections.
const CORRECTION_VALUE_MAX_LENGTH = 500;

function mappedCell(raw, sideMapping, field) {
  const column = sideMapping?.[CORRECTION_FIELD_MAPPING_KEY[field]];
  const value = column ? raw[column] : null;
  return value == null || value === '' ? null : String(value).slice(0, CORRECTION_VALUE_MAX_LENGTH);
}

// A correction made on a completed report stays pending there and is applied by a rerun of it.
export async function createCorrection(userId, reportId, { rowId, side, field, correctedValue, reason }, { ip, userAgent } = {}) {
  const report = await assertReportAccess(userId, reportId);
  if (report.status !== 'completed') throw new ConflictError('Corrections can only be made on a completed reconciliation');
  if (report.supersededById) throw new ConflictError('A newer run of this reconciliation exists. Make corrections there.');

  const row = await prisma.reportRow.findFirst({
    where: { id: rowId, reportId },
    select: { ref: true, rawA: true, rawB: true, rowIndexA: true, rowIndexB: true },
  });
  if (!row) throw new NotFoundError();
  const raw = side === 'A' ? row.rawA : row.rawB;
  const rowIndex = side === 'A' ? row.rowIndexA : row.rowIndexB;
  if (raw == null) {
    throw new ValidationError(`This transaction has no ${side === 'A' ? 'internal ledger' : 'counterparty'} record to correct`);
  }
  if (rowIndex == null) throw new ConflictError('This reconciliation ran before corrections existed. Rerun it to make corrections.');

  // The engine's own parsers: a value it can't read is rejected now, not discovered at run time.
  if (field === 'amount' && parseAmount(correctedValue) == null) throw new ValidationError('Enter an amount such as 1250.00');
  if (field === 'date' && parseDate(correctedValue) == null) throw new ValidationError('Enter a date such as 2026-10-28');

  const sideMapping = side === 'A' ? report.columnMapping?.fileA : report.columnMapping?.fileB;
  const values = {
    fileKey: side === 'A' ? report.fileAKey : report.fileBKey,
    rowReference: mappedCell(raw, sideMapping, 'reference') ?? (row.ref || null),
    originalValue: mappedCell(raw, sideMapping, field),
    correctedValue,
    reason,
    createdBy: userId,
  };
  // One pending correction per row, side and field: a new one replaces it. Applied ones are never touched.
  const correction = await prisma.reportCorrection.upsert({
    where: {
      reportId_side_rowIndex_field_applied: { reportId, side, rowIndex, field, applied: false },
    },
    create: { reportId, side, rowIndex, field, applied: false, ...values },
    update: { ...values, createdAt: new Date() },
    select: CORRECTION_SELECT,
  });

  await logAuditSafely(userId, {
    action: 'report.correction.create',
    entityType: 'report',
    entityId: reportId,
    status: 'info',
    ip,
    userAgent,
    metadata: withSubject(
      {
        correctionId: correction.id,
        side,
        field,
        transactionRef: correction.rowReference,
        originalValue: correction.originalValue,
        correctedValue,
        reason,
      },
      reportSubject(report),
    ),
  });

  return mapCorrection(correction);
}

// Bounded by the caller's limit; a draft lists what its run will apply.
export async function listCorrections(userId, reportId, { limit, offset } = {}) {
  await assertReportAccess(userId, reportId);
  const corrections = await prisma.reportCorrection.findMany({
    where: { reportId },
    orderBy: [{ side: 'asc' }, { rowIndex: 'asc' }, { field: 'asc' }, { applied: 'desc' }],
    take: limit ?? 100,
    skip: offset ?? 0,
    select: CORRECTION_SELECT,
  });
  return corrections.map(mapCorrection);
}

export async function deleteCorrection(userId, reportId, correctionId, { ip, userAgent } = {}) {
  const report = await assertReportAccess(userId, reportId);
  // A running report has already read its corrections; removing one now would leave the record disagreeing with the run.
  if (report.status === 'processing') throw new ConflictError('This reconciliation is running. Remove corrections once it finishes.');
  if (report.supersededById) throw new ConflictError('A newer run of this reconciliation exists. Make changes there.');

  const correction = await prisma.reportCorrection.findFirst({
    where: { id: correctionId, reportId },
    select: { id: true, side: true, field: true, rowReference: true, originalValue: true, correctedValue: true, applied: true },
  });
  if (!correction) throw new NotFoundError();
  if (correction.applied) throw new ConflictError('An applied correction is part of this run and cannot be removed');

  // applied: false keeps the delete conditional, in case a run marked it applied since the read above.
  const { count } = await prisma.reportCorrection.deleteMany({ where: { id: correctionId, reportId, applied: false } });
  if (count === 0) throw new ConflictError('An applied correction is part of this run and cannot be removed');

  await logAuditSafely(userId, {
    action: 'report.correction.delete',
    entityType: 'report',
    entityId: reportId,
    status: 'warning',
    ip,
    userAgent,
    metadata: withSubject(
      {
        correctionId,
        side: correction.side,
        field: correction.field,
        transactionRef: correction.rowReference,
        originalValue: correction.originalValue,
        correctedValue: correction.correctedValue,
      },
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
    // Superseded runs drop out of the series, except the one being viewed, which always plots itself.
    OR: [{ supersededById: null }, { id: reportId }],
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
  const setsFileKey = dto.fileAKey !== undefined || dto.fileBKey !== undefined;
  const needsBefore = dto.columnMapping !== undefined || dto.config !== undefined || setsFileKey;
  const before = needsBefore
    ? await prisma.report.findFirst({
        where: { id: reportId, userId },
        select: {
          columnMapping: true,
          config: true,
          name: true,
          sequenceYear: true,
          sequenceNumber: true,
          fileAKey: true,
          fileBKey: true,
        },
      })
    : null;

  // A replaced file's columns may not match the old mapping: that side is dropped so the next mapping
  // preview re-suggests it, and its summary and sample marker go with it. A first upload replaces nothing.
  const replacedKeyA = dto.fileAKey !== undefined && before?.fileAKey && before.fileAKey !== dto.fileAKey ? before.fileAKey : null;
  const replacedKeyB = dto.fileBKey !== undefined && before?.fileBKey && before.fileBKey !== dto.fileBKey ? before.fileBKey : null;
  const replacementData = {};
  if (replacedKeyA || replacedKeyB) {
    const { fileA, fileB } = before.columnMapping ?? {};
    if (dto.columnMapping === undefined) replacementData.columnMapping = { fileA: replacedKeyA ? undefined : fileA, fileB: replacedKeyB ? undefined : fileB };
    if (replacedKeyA) Object.assign(replacementData, { fileASummary: null, fileASampleRows: null });
    if (replacedKeyB) Object.assign(replacementData, { fileBSummary: null, fileBSampleRows: null });
  }

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
      ...replacementData,
    },
  });
  if (count === 0) throw new NotFoundError();

  // A first upload or a replaced file needs a fresh preview, once both files are present.
  if (setsFileKey) {
    const fileAKey = dto.fileAKey ?? before?.fileAKey;
    const fileBKey = dto.fileBKey ?? before?.fileBKey;
    const changed = (dto.fileAKey !== undefined && dto.fileAKey !== before?.fileAKey) || (dto.fileBKey !== undefined && dto.fileBKey !== before?.fileBKey);
    if (fileAKey && fileBKey && changed) await queueMappingPreview(reportId, fileAKey, fileBKey);
  }

  if (replacedKeyA || replacedKeyB) {
    // Corrections point at row positions in the old file, which the new one doesn't share.
    const replacedSides = [replacedKeyA ? 'A' : null, replacedKeyB ? 'B' : null].filter(Boolean);
    await prisma.reportCorrection.deleteMany({ where: { reportId, side: { in: replacedSides } } });
    // The old upload is deleted only if nothing else points at it: a rerun's inherited file stays with its source.
    const { organizationId } = await getUserMembership(userId);
    await deleteReportFiles(await reportFileKeys([{ id: reportId, fileAKey: replacedKeyA, fileBKey: replacedKeyB }], organizationId));
  }

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

// Abandoned drafts accumulate per user, so the list is paged; `total` feeds the launcher's draft count.
export async function listDrafts(userId, { limit = 20, offset = 0 } = {}) {
  const { organizationId } = await getUserMembership(userId);
  const where = { userId, organizationId, status: 'draft' };
  const [drafts, total] = await Promise.all([
    prisma.report.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: offset,
      // Same reasoning as findDraftOrFailedRun above: fileASampleRows/
      // fileBSampleRows can be several MB of cached JSON per draft (up to
      // SAMPLE_ROW_CAP rows of every column, from getMappingPreview). This
      // list is the "resume a draft" picker — the frontend's Report type
      // never reads these fields — but without the omit, every draft in the
      // list pays that multi-MB cost, which is what made this endpoint take
      // up to a minute for a user with several large-file-pair drafts.
      omit: { fileASampleRows: true, fileBSampleRows: true, mappingPreview: true },
    }),
    prisma.report.count({ where }),
  ]);
  return { items: drafts.map(withDraftProgress), total };
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
// A completed report becomes a new draft with the same files, mapping and rules; the source is never modified.
// The draft belongs to the caller, so any admin or analyst can rerun a report someone else ran.
export async function rerunReport(userId, sourceReportId, { ip, userAgent } = {}) {
  const { organizationId } = await getUserMembership(userId);
  const source = await prisma.report.findFirst({
    where: { id: sourceReportId, organizationId, status: 'completed' },
    select: {
      id: true,
      name: true,
      tag: true,
      fileAKey: true,
      fileBKey: true,
      fileAName: true,
      fileBName: true,
      fileASummary: true,
      fileBSummary: true,
      columnMapping: true,
      rulesConfig: true,
      config: true,
      sequenceYear: true,
      sequenceNumber: true,
      supersededBy: { select: SUPERSEDED_BY_SELECT },
    },
  });
  if (!source) throw new NotFoundError();
  // Chains stay linear: changes continue from the newest run, never from one it already replaced.
  if (source.supersededBy) {
    const newer = mapSupersededBy(source.supersededBy);
    throw new ConflictError(`A newer run of this reconciliation exists. Rerun ${newer.reference ?? 'it'} instead.`);
  }
  // Reports saved through the legacy client-computed endpoint never had files in R2.
  if (!source.fileAKey || !source.fileBKey) throw new ValidationError('This reconciliation has no stored files to rerun');

  // The source's effective corrections: a pending one overrides the applied one for the same row and field.
  const sourceCorrections = await prisma.reportCorrection.findMany({
    where: { reportId: source.id },
    orderBy: { applied: 'asc' },
    select: {
      side: true,
      rowIndex: true,
      fileKey: true,
      rowReference: true,
      field: true,
      originalValue: true,
      correctedValue: true,
      reason: true,
      createdBy: true,
      createdAt: true,
    },
  });
  const effectiveCorrections = new Map();
  for (const correction of sourceCorrections) {
    const key = `${correction.side}:${correction.rowIndex}:${correction.field}`;
    if (!effectiveCorrections.has(key)) effectiveCorrections.set(key, correction);
  }

  // 'skip' is no longer offered (the engine already runs it as flag-all); carried into the draft as-is, the
  // rules sidebar would show a blank duplicate-handling choice.
  const sourceConfig = source.rulesConfig ?? source.config;
  const rerunConfig =
    sourceConfig?.duplicateHandling === 'skip' ? { ...sourceConfig, duplicateHandling: 'flag-all' } : sourceConfig;

  // A nested create keeps the draft and its corrections in one write.
  const draft = await prisma.report.create({
    data: {
      userId,
      organizationId,
      status: 'draft',
      progress: 0,
      name: source.name,
      tag: source.tag,
      fileAKey: source.fileAKey,
      fileBKey: source.fileBKey,
      fileAName: source.fileAName,
      fileBName: source.fileBName,
      fileASummary: source.fileASummary ?? undefined,
      fileBSummary: source.fileBSummary ?? undefined,
      columnMapping: source.columnMapping ?? undefined,
      config: rerunConfig ?? undefined,
      sourceReportId: source.id,
      corrections: { create: [...effectiveCorrections.values()].map((correction) => ({ ...correction, applied: false })) },
      previewStatus: 'pending',
    },
    select: { id: true },
  });
  // The rerun inherits its source's files, so their preview is built now, before the user reaches the mapping step.
  await enqueueFilePreview({ reportId: draft.id, fileAKey: source.fileAKey, fileBKey: source.fileBKey });

  await logAuditSafely(userId, {
    action: 'report.rerun',
    entityType: 'report',
    entityId: draft.id,
    status: 'info',
    ip,
    userAgent,
    metadata: withSubject(
      {
        sourceReportId: source.id,
        filePair: `${source.fileAName ?? 'File A'} vs ${source.fileBName ?? 'File B'}`,
        correctionsCarried: effectiveCorrections.size,
      },
      reportSubject(source),
    ),
  });

  return { id: draft.id };
}

function findDraftOrFailedRun(userId, reportId) {
  return prisma.report.findFirst({
    where: { id: reportId, userId, status: { in: ['draft', 'failed'] } },
    omit: { fileASampleRows: true, fileBSampleRows: true, mappingPreview: true },
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
// for the cheap rule-preview endpoint), runs the match, and persists it via
// persistCompletedRun. Called only by the BullMQ worker — never
// directly by an HTTP handler; enqueueReconciliationRun (above) is the
// request-facing entry point. Wraps the *entire* pipeline, including
// persistence, in the try/catch: a failure anywhere in here — download,
// parse, match, or the bulk row write — persists a `status: 'failed'` row
// with the real error message rather than leaving the report silently stuck
// in whatever state it was already in.
// The engine's per-side lookup: file row index → the corrected values for that row's mapped fields.
function correctionMaps(corrections) {
  const maps = { A: new Map(), B: new Map() };
  for (const correction of corrections) {
    const sideMap = maps[correction.side];
    if (!sideMap.has(correction.rowIndex)) sideMap.set(correction.rowIndex, {});
    sideMap.get(correction.rowIndex)[correction.field] = correction.correctedValue;
  }
  return maps;
}

export async function executeReconciliationRun({ reportId, userId, ip, userAgent, dto, config, organizationId }) {
  const draft = await prisma.report.findFirst({
    where: { id: reportId },
    omit: { fileASampleRows: true, fileBSampleRows: true, mappingPreview: true },
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

    // Only corrections for the files being run: a replaced file's corrections point at rows it no longer has.
    const corrections = await prisma.reportCorrection.findMany({
      where: {
        reportId,
        applied: false,
        OR: [{ side: 'A', fileKey: draft.fileAKey }, { side: 'B', fileKey: draft.fileBKey }],
      },
      select: { id: true, side: true, rowIndex: true, field: true, correctedValue: true },
    });
    const { summary, rows } = runMatch(fileA, fileB, dto.columnMapping.fileA, dto.columnMapping.fileB, config, correctionMaps(corrections));
    await reportProgress(PROGRESS_MATCHED);

    // organizationId comes from the job payload, resolved once in
    // enqueueReconciliationRun — not re-fetched here. It never changes for
    // an in-flight run, and getUserMembership is a real DB round-trip; this
    // avoids paying it twice per run for the same answer.
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
        appliedCorrectionIds: corrections.map((c) => c.id),
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
          correctionsApplied: corrections.length,
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

// The mapping step's preview. The files are parsed by the file-previews worker (buildMappingPreview, below), so
// this only reads what it stored. A draft from before that existed has no status yet and is queued here.
export async function getMappingPreview(userId, reportId) {
  const draft = await prisma.report.findFirst({
    where: { id: reportId, userId, status: { in: ['draft', 'failed'] } },
    select: { fileAKey: true, fileBKey: true, previewStatus: true, mappingPreview: true, previewError: true },
  });
  if (!draft) throw new NotFoundError();
  if (!draft.fileAKey || !draft.fileBKey) {
    throw new ValidationError('Both files must be uploaded before requesting a mapping preview');
  }

  if (draft.previewStatus == null) {
    await queueMappingPreview(reportId, draft.fileAKey, draft.fileBKey);
    return { status: 'pending', preview: null, error: null };
  }
  return {
    status: draft.previewStatus,
    preview: draft.previewStatus === 'ready' ? draft.mappingPreview : null,
    error: draft.previewStatus === 'failed' ? draft.previewError : null,
  };
}

// Marks the draft's preview pending for these files and queues the parse. Called whenever a draft gets new files.
async function queueMappingPreview(reportId, fileAKey, fileBKey) {
  await prisma.report.updateMany({
    where: { id: reportId, fileAKey, fileBKey },
    data: { previewStatus: 'pending', mappingPreview: Prisma.DbNull, previewError: null },
  });
  await enqueueFilePreview({ reportId, fileAKey, fileBKey });
}

// A file the parser couldn't read: shown to the user as-is, since replacing the file fixes it, and never retried.
export class FilePreviewError extends Error {}

function parseForPreview(buffer, filename) {
  try {
    return parseTabularFile(buffer, filename);
  } catch {
    throw new FilePreviewError(`${filename ?? 'One of the files'} couldn't be read. Check it's a CSV or Excel file with a header row.`);
  }
}

/**
 * The file-previews job: downloads and parses both files, then stores the mapping step's preview, the file
 * summaries, the rule preview's sample and a suggested mapping. Every write requires the report to still have
 * the files this job parsed, so a file replaced mid-parse keeps the newer job's result.
 * A transient failure is recorded only on the last attempt, so a retry that succeeds never flashes an error;
 * an unreadable file is recorded at once, since retrying can't fix it.
 */
export async function buildMappingPreview({ reportId, fileAKey, fileBKey }, { isFinalAttempt = true } = {}) {
  const stillCurrent = { id: reportId, fileAKey, fileBKey, status: { in: ['draft', 'failed'] } };
  const draft = await prisma.report.findFirst({
    where: stillCurrent,
    select: { fileAName: true, fileBName: true, columnMapping: true },
  });
  // Replaced, run or deleted since this was queued: a newer job (or nothing) owns the preview now.
  if (!draft) return;

  try {
    const [fileABuffer, fileBBuffer] = await Promise.all([downloadFromR2(fileAKey), downloadFromR2(fileBKey)]);
    const fileA = parseForPreview(fileABuffer, draft.fileAName);
    const fileB = parseForPreview(fileBBuffer, draft.fileBName);

    const suggestedA = suggestMapping(fileA.headers);
    const suggestedB = suggestMapping(fileB.headers);
    const mappingA = mappingFromSuggestions(suggestedA);
    const mappingB = mappingFromSuggestions(suggestedB);
    const fileASummary = { rows: fileA.rows.length, columns: fileA.headers.length, fileSizeBytes: fileABuffer.length };
    const fileBSummary = { rows: fileB.rows.length, columns: fileB.headers.length, fileSizeBytes: fileBBuffer.length };

    const data = {
      previewStatus: 'ready',
      previewError: null,
      mappingPreview: {
        fileA: {
          filename: draft.fileAName,
          previewRows: fileA.rows.slice(0, 7),
          mappings: suggestedA,
          ...computeValidationSummary(fileA.rows, mappingA),
          ...fileASummary,
        },
        fileB: {
          filename: draft.fileBName,
          previewRows: fileB.rows.slice(0, 7),
          mappings: suggestedB,
          ...computeValidationSummary(fileB.rows, mappingB),
          ...fileBSummary,
        },
      },
      // The sample itself lives in Redis (mappingSampleCache.js); this marker records that it exists and the
      // file's total rows, which extrapolatePreview scales by.
      fileASampleRows: { totalRows: fileA.rows.length },
      fileBSampleRows: { totalRows: fileB.rows.length },
      // Unlike the sample marker, kept after completion: Results' File Summary cards read them.
      fileASummary,
      fileBSummary,
    };
    // Per side: a replaced file clears only its own side (updateDraft), and the other side's saved mapping stays.
    const savedMapping = draft.columnMapping ?? {};
    if (!savedMapping.fileA || !savedMapping.fileB) {
      data.columnMapping = { fileA: savedMapping.fileA ?? mappingA, fileB: savedMapping.fileB ?? mappingB };
    }

    const { count } = await prisma.report.updateMany({ where: stillCurrent, data });
    // Written only for the current files, so a stale job can't replace the sample with the old file's rows.
    if (count > 0) {
      await Promise.all([
        setSampleRows(reportId, 'A', fileA.rows.slice(0, SAMPLE_ROW_CAP)),
        setSampleRows(reportId, 'B', fileB.rows.slice(0, SAMPLE_ROW_CAP)),
      ]);
    }
  } catch (err) {
    if (isFinalAttempt || err instanceof FilePreviewError) {
      const previewError = err instanceof FilePreviewError ? err.message : "Your files couldn't be loaded. Try again in a moment.";
      await prisma.report.updateMany({ where: stillCurrent, data: { previewStatus: 'failed', previewError } });
    }
    throw err;
  }
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
    omit: { mappingPreview: true },
  });
  if (!draft) throw new NotFoundError();
  if (!draft.fileASampleRows || !draft.fileBSampleRows) {
    throw new ConflictError('Your files are still being read. The estimate will appear when they are ready.');
  }
  const mapping = dto.columnMapping ?? draft.columnMapping;
  if (!mapping) throw new ConflictError('No column mapping available — call the mapping-preview endpoint first');

  const [sampleARows, sampleBRows, corrections] = await Promise.all([
    getSampleRows(reportId, 'A'),
    getSampleRows(reportId, 'B'),
    prisma.reportCorrection.findMany({
      where: {
        reportId,
        applied: false,
        OR: [{ side: 'A', fileKey: draft.fileAKey }, { side: 'B', fileKey: draft.fileBKey }],
      },
      select: { side: true, rowIndex: true, field: true, correctedValue: true },
    }),
  ]);
  // The Postgres marker (checked above) can outlive the Redis cache — it's
  // not cleared on TTL expiry, only on run completion — so this is a
  // separate, real "the cache is gone" case, not just defensive padding.
  // The stored preview stays as it is; only the sample is rebuilt, by the same job.
  if (!sampleARows || !sampleBRows) {
    await enqueueFilePreview({ reportId, fileAKey: draft.fileAKey, fileBKey: draft.fileBKey });
    throw new ConflictError('Preparing a fresh sample of your files. The estimate will appear in a few seconds.');
  }

  const { summary } = runMatch(
    { rows: sampleARows },
    { rows: sampleBRows },
    mapping.fileA,
    mapping.fileB,
    dto.config,
    // The sample is the file's first rows, so a correction's row index is its index in the sample too.
    correctionMaps(corrections),
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
 * R2 objects the deleted reports leave behind: their uploads and stored exports. An upload is returned only
 * if it sits under an org member's prefix and no surviving report still points at it (a rerun shares its
 * source's files), so a stored key pointing anywhere else is never deleted.
 */
async function reportFileKeys(reports, organizationId) {
  if (reports.length === 0) return [];
  const reportIds = reports.map((r) => r.id);
  const exports = await prisma.reportExport.findMany({
    where: { reportId: { in: reportIds }, organizationId, fileKey: { not: null } },
    select: { fileKey: true },
  });
  const exportKeys = exports.map((e) => e.fileKey).filter((key) => key.startsWith(`exports/${organizationId}/`));

  // A rerun reuses its source's uploads, which sit under the source owner's prefix, not the rerun owner's.
  const candidateUploadKeys = [...new Set(reports.flatMap((r) => [r.fileAKey, r.fileBKey]).filter((key) => key?.startsWith('uploads/')))];
  if (candidateUploadKeys.length === 0) return exportKeys;

  // Only an org member's uploads are ours to delete; a stray key pointing elsewhere never is.
  const uploaderIds = [...new Set(candidateUploadKeys.map((key) => key.split('/')[1]))];
  const members = await prisma.member.findMany({ where: { organizationId, userId: { in: uploaderIds } }, select: { userId: true } });
  const memberIds = new Set(members.map((m) => m.userId));

  // Not org-scoped on purpose: any surviving report anywhere that points at a key keeps the file alive.
  const survivors = await prisma.report.findMany({
    where: { id: { notIn: reportIds }, OR: [{ fileAKey: { in: candidateUploadKeys } }, { fileBKey: { in: candidateUploadKeys } }] },
    select: { fileAKey: true, fileBKey: true },
  });
  const stillUsedKeys = new Set(survivors.flatMap((r) => [r.fileAKey, r.fileBKey]));

  const uploadKeys = candidateUploadKeys.filter((key) => memberIds.has(key.split('/')[1]) && !stillUsedKeys.has(key));
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

// Fetches several reports with getReport's org-scoping and draft-privacy rule, without rows. Throws
// NotFoundError if any id doesn't resolve: all-or-nothing, so a combined report never silently drops a run.
export async function getReportsByIds(userId, ids, { requireCompleted = false } = {}) {
  const { organizationId } = await getUserMembership(userId);
  const reports = await prisma.report.findMany({
    where: { id: { in: ids }, organizationId, ...(requireCompleted ? { status: 'completed' } : {}) },
    omit: { mappingPreview: true },
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
  const reports = await getReportsByIds(userId, ids, { requireCompleted: true });
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
