import { fileURLToPath } from 'node:url';
import path from 'node:path';
import React from 'react';
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer';
import { computeCategoryStats } from './reportSections.js';

// Deliberately self-contained rather than importing from pdfReport.js — same
// reasoning as xlsxComparisonReport.js staying independent from
// xlsxReport.js: a comparison report's shape doesn't fit the single-report
// renderer, and this codebase already keeps pdfReport.js/xlsxReport.js
// dependency-free from each other for the same reason (see pdfReport.js's
// own local deltaPercent/CATEGORY_COLORS/formatCurrency).
const h = React.createElement;

const LOGO_SYM_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../assets/logo-sym.png');

const CATEGORY_COLORS = {
  Matched: '#34D399',
  Mismatched: '#6366F1',
  Unmatched: '#3B82F6',
  Duplicates: '#F43F5E',
};

const BRAND_TEAL = '#0D9488';
const BRAND_INDIGO = '#6366F1';
const TEXT_DARK = '#111827';
const TEXT_GRAY = '#6B7280';
const TEXT_LIGHT_GRAY = '#9CA3AF';
const BORDER = '#E5E7EB';
const TINT_GRAY = '#F9FAFB';
const TINT_INDIGO = '#EEF2FF';

const PAGE_PADDING_X = 20;
const CONTENT_WIDTH = 612 - PAGE_PADDING_X * 2;

const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
function formatCurrency(value) {
  return currencyFormatter.format(Number(value));
}

const styles = StyleSheet.create({
  page: { paddingTop: 24, paddingBottom: 28, paddingHorizontal: PAGE_PADDING_X, fontSize: 9, fontFamily: 'Helvetica', color: TEXT_DARK },
  topBand: { position: 'absolute', top: 0, left: 0, right: 0, height: 6, backgroundColor: BRAND_INDIGO },

  headerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  orgSection: { flexDirection: 'row', alignItems: 'center' },
  orgLogo: { width: 30, height: 30, borderRadius: 6, marginRight: 8 },
  orgLogoFallback: { width: 30, height: 30, borderRadius: 6, marginRight: 8, backgroundColor: '#9CA3AF', alignItems: 'center', justifyContent: 'center' },
  orgLogoFallbackText: { color: '#FFFFFF', fontFamily: 'Helvetica-Bold', fontSize: 13 },
  orgName: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: TEXT_DARK },
  orgType: { fontSize: 7.5, color: TEXT_GRAY, marginTop: 2 },

  brandSection: { flexDirection: 'row', alignItems: 'center', marginRight: 24 },
  brandLogoImage: { width: 30, height: 30, marginRight: 8 },
  brandName: { fontSize: 14, fontFamily: 'Helvetica-Bold', color: BRAND_TEAL },
  brandTagline: { fontSize: 6, color: TEXT_LIGHT_GRAY, letterSpacing: 0.8, marginTop: 3 },

  titleSection: { marginBottom: 10 },
  title: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: TEXT_DARK },
  subtitle: { fontSize: 8, color: TEXT_GRAY, marginTop: 3 },

  metaSectionRow: { flexDirection: 'row', marginBottom: 10 },
  metaCol: { marginRight: 30 },
  metaLabel: { fontSize: 6.5, fontFamily: 'Helvetica-Bold', color: BRAND_INDIGO, letterSpacing: 0.4 },
  metaValue: { fontSize: 8, color: TEXT_DARK, marginTop: 1 },

  divider: { borderBottomWidth: 1, borderBottomColor: BORDER, marginBottom: 10 },

  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4, marginBottom: 8 },
  sectionAccent: { width: 3, height: 13, backgroundColor: BRAND_INDIGO, marginRight: 8 },
  sectionTitle: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: TEXT_DARK },

  tileGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  tile: { borderRadius: 5, borderWidth: 1, borderColor: BORDER, backgroundColor: TINT_GRAY, padding: 8, marginRight: 10, marginBottom: 10 },
  tileValue: { fontSize: 13, fontFamily: 'Helvetica-Bold', color: TEXT_DARK },
  tileLabel: { fontSize: 7, color: TEXT_GRAY, marginTop: 2 },

  table: { borderWidth: 1, borderColor: BORDER, borderRadius: 3, overflow: 'hidden' },
  tableHeaderRow: { flexDirection: 'row', backgroundColor: TINT_INDIGO },
  tableHeaderCell: { fontSize: 7.5, fontFamily: 'Helvetica-Bold', color: '#3730A3', padding: 5 },
  tableRow: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: BORDER },
  tableRowAlt: { backgroundColor: TINT_GRAY },
  tableCell: { fontSize: 8, color: TEXT_DARK, padding: 5 },
  tableEmpty: { fontSize: 8.5, color: TEXT_GRAY, padding: 8 },

  barRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  barTrack: { flex: 1, height: 12, borderRadius: 3, backgroundColor: TINT_GRAY },
  barFill: { height: 12, borderRadius: 3, backgroundColor: BRAND_INDIGO },
  barLabel: { fontSize: 7.5, color: TEXT_DARK, marginLeft: 8, width: 150 },
  barValue: { fontSize: 7.5, color: TEXT_GRAY, marginLeft: 8, width: 90, textAlign: 'right' },

  signatureNameLine: { borderBottomWidth: 1, borderBottomColor: TEXT_DARK, paddingBottom: 4, minHeight: 22, justifyContent: 'flex-end', width: 220 },
  signatureName: { fontSize: 9, color: TEXT_DARK },
  signatureRoleLabel: { fontSize: 7, fontFamily: 'Helvetica-Bold', color: BRAND_INDIGO, letterSpacing: 0.4, marginTop: 4 },

  footer: { position: 'absolute', bottom: 12, left: PAGE_PADDING_X, right: PAGE_PADDING_X, borderTopWidth: 0.5, borderTopColor: BORDER, paddingTop: 6 },
  footerRow: { flexDirection: 'row', justifyContent: 'space-between' },
  footerText: { fontSize: 6.5, color: TEXT_LIGHT_GRAY, marginTop: 2 },
});

function SectionHeader({ title }) {
  return h(View, { style: styles.sectionHeaderRow }, h(View, { style: styles.sectionAccent }), h(Text, { style: styles.sectionTitle }, title));
}

function StatTile({ value, label, width, last }) {
  return h(
    View,
    { style: [styles.tile, { width }, last && { marginRight: 0 }] },
    h(Text, { style: styles.tileValue }, value),
    h(Text, { style: styles.tileLabel }, label),
  );
}

function StatTileGrid({ tiles, columns = 4 }) {
  const gap = 10;
  const width = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
  const rows = [];
  for (let i = 0; i < tiles.length; i += columns) rows.push(tiles.slice(i, i + columns));

  return h(
    View,
    null,
    ...rows.map((row, ri) =>
      h(
        View,
        { key: ri, style: { flexDirection: 'row' } },
        ...row.map((tile, i) => h(StatTile, { key: i, width, last: i === row.length - 1, ...tile })),
      ),
    ),
  );
}

function Table({ columns, rows, emptyLabel }) {
  return h(
    View,
    { style: styles.table },
    h(
      View,
      { style: styles.tableHeaderRow },
      ...columns.map((col, i) => h(Text, { key: i, style: [styles.tableHeaderCell, { width: col.width, textAlign: col.align ?? 'left' }] }, col.label)),
    ),
    rows.length === 0
      ? h(Text, { style: styles.tableEmpty }, emptyLabel ?? 'None')
      : rows.map((row, i) =>
          h(
            View,
            { key: i, style: [styles.tableRow, i % 2 === 1 && styles.tableRowAlt], wrap: false },
            ...columns.map((col, ci) =>
              h(
                View,
                { key: ci, style: { width: col.width, flexDirection: 'row', alignItems: 'center' } },
                col.swatch ? h(View, { style: { width: 7, height: 7, marginLeft: 5, marginRight: 5, backgroundColor: col.swatch(row) } }) : null,
                h(Text, { style: [styles.tableCell, { textAlign: col.align ?? 'left', flex: 1 }] }, col.render ? col.render(row) : String(row[col.key] ?? '')),
              ),
            ),
          ),
        ),
  );
}

// Same lightweight stand-in pdfReport.js's CategoryBarChart uses (react-pdf
// has no native chart primitive), keyed by run instead of category.
function RunBarChart({ runs, valueOf, formatValue }) {
  const maxValue = Math.max(1, ...runs.map(valueOf));
  return h(
    View,
    null,
    ...runs.map((run, i) => {
      const value = valueOf(run);
      return h(
        View,
        { key: i, style: styles.barRow },
        h(View, { style: styles.barTrack }, h(View, { style: [styles.barFill, { width: `${Math.max((value / maxValue) * 100, 2)}%` }] })),
        h(Text, { style: styles.barLabel }, run.name),
        h(Text, { style: styles.barValue }, formatValue(value)),
      );
    }),
  );
}

function ComparisonHeader({ runCount, dateRangeLabel, generatedByName, organizationName, organizationLogo, organizationType }) {
  return h(
    View,
    null,
    h(
      View,
      { style: styles.headerRow },
      h(
        View,
        { style: styles.brandSection },
        h(Image, { src: LOGO_SYM_PATH, style: styles.brandLogoImage }),
        h(View, null, h(Text, { style: styles.brandName }, 'Reconcil'), h(Text, { style: styles.brandTagline }, 'TRANSACTION RECONCILIATION')),
      ),
      h(
        View,
        { style: styles.orgSection },
        organizationLogo
          ? h(Image, { src: organizationLogo, style: styles.orgLogo })
          : h(View, { style: styles.orgLogoFallback }, h(Text, { style: styles.orgLogoFallbackText }, (organizationName ?? '?').charAt(0).toUpperCase())),
        h(
          View,
          null,
          h(Text, { style: styles.orgName }, organizationName ?? 'Your Organization'),
          organizationType && h(Text, { style: styles.orgType }, organizationType),
        ),
      ),
    ),

    h(
      View,
      { style: styles.titleSection },
      h(Text, { style: styles.title }, 'Combined Report'),
      h(Text, { style: styles.subtitle }, `Comparing ${runCount} reconciliations`),
    ),

    h(
      View,
      { style: styles.metaSectionRow },
      ...[
        ['Generated On', new Date().toLocaleString()],
        ['Date Range', dateRangeLabel],
        ['Runs Compared', String(runCount)],
        ['Prepared By', generatedByName ?? '—'],
      ].map(([label, value], i) =>
        h(View, { key: i, style: styles.metaCol }, h(Text, { style: styles.metaLabel }, label.toUpperCase()), h(Text, { style: styles.metaValue }, value)),
      ),
    ),

    h(View, { style: styles.divider }),
  );
}

function ComparisonFooter({ runCount }) {
  return h(
    View,
    { style: styles.footer, fixed: true },
    h(
      View,
      { style: styles.footerRow },
      h(Text, { style: styles.footerText }, 'This report is confidential and intended solely for authorized use.'),
      h(Text, { style: styles.footerText }, `Combined Report (${runCount} runs)`),
    ),
    h(
      View,
      { style: styles.footerRow },
      h(Text, { style: styles.footerText }, 'Reconcil — Transaction Reconciliation Platform'),
      h(Text, { style: styles.footerText, render: ({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}` }),
    ),
  );
}

// Same per-run derivation as xlsxComparisonReport.js's deriveRunStats —
// only aggregate scalars ever leave this function, never the rows
// themselves, per the stats-only decision.
function deriveRunStats(report) {
  const totalRows = report.totalRows ?? 0;
  const matchedCount = report.matchedCount ?? 0;
  const mismatchedCount = report.mismatchedCount ?? 0;
  const unmatchedCount = report.unmatchedCount ?? 0;
  const duplicateCount = report.duplicateCount ?? 0;
  const matchPercent = totalRows > 0 ? (matchedCount / totalRows) * 100 : 0;
  const breakValue = Number(report.totalBreakValue ?? 0);
  const exceptionCount = mismatchedCount + unmatchedCount;
  const avgBreakSize = exceptionCount > 0 ? breakValue / exceptionCount : 0;

  const rows = report.rows ?? [];
  const largestBreak = rows.reduce((max, r) => Math.max(max, Math.abs(Number(r.amountDiff ?? 0))), 0);
  const unmatchedACount = rows.filter((r) => r.status === 'unmatched_a').length;
  const unmatchedBCount = rows.filter((r) => r.status === 'unmatched_b').length;

  return {
    name: report.name || 'Untitled Reconciliation',
    runDate: report.runDate,
    totalRows,
    matchedCount,
    mismatchedCount,
    unmatchedCount,
    duplicateCount,
    matchPercent,
    breakValue,
    avgBreakSize,
    largestBreak,
    unmatchedACount,
    unmatchedBCount,
    duplicateRowCount: rows.filter((r) => r.status === 'duplicate').length,
    categoryStats: computeCategoryStats(report),
  };
}

function ComparisonDocument({ reports, sections, generatedByName, organizationName, organizationLogo, organizationType }) {
  const sorted = [...reports].sort((a, b) => new Date(a.runDate) - new Date(b.runDate));
  const runs = sorted.map(deriveRunStats);
  const dateRangeLabel =
    runs.length > 0
      ? `${new Date(runs[0].runDate).toLocaleDateString()} – ${new Date(runs[runs.length - 1].runDate).toLocaleDateString()}`
      : '—';
  const avgMatchRate = runs.length > 0 ? runs.reduce((sum, r) => sum + r.matchPercent, 0) / runs.length : 0;
  const totalBreakValue = runs.reduce((sum, r) => sum + r.breakValue, 0);

  const children = [
    h(ComparisonHeader, { key: 'header', runCount: runs.length, dateRangeLabel, generatedByName, organizationName, organizationLogo, organizationType }),

    h(SectionHeader, { key: 'exec-header', title: 'Executive Summary' }),
    h(StatTileGrid, {
      key: 'exec-tiles',
      tiles: [
        { value: String(runs.length), label: 'Runs Compared' },
        { value: `${avgMatchRate.toFixed(1)}%`, label: 'Average Match Rate' },
        { value: formatCurrency(totalBreakValue), label: 'Total Break Value' },
        { value: dateRangeLabel, label: 'Date Range' },
      ],
    }),
  ];

  if (sections.summary) {
    children.push(
      h(SectionHeader, { key: 'overview-header', title: 'Comparison Overview' }),
      h(Table, {
        key: 'overview-table',
        columns: [
          { key: 'name', label: 'Reconciliation', width: 150 },
          { width: 70, label: 'Run Date', render: (r) => new Date(r.runDate).toLocaleDateString() },
          { key: 'totalRows', label: 'Total', width: 45, align: 'right' },
          { key: 'matchedCount', label: 'Matched', width: 55, align: 'right' },
          { width: 65, label: 'Match Rate', align: 'right', render: (r) => `${r.matchPercent.toFixed(1)}%` },
          { width: CONTENT_WIDTH - 385, label: 'Break Value', align: 'right', render: (r) => formatCurrency(r.breakValue) },
        ],
        rows: runs,
        emptyLabel: 'No reconciliations to compare.',
      }),
    );
  }

  if (sections.matchStatistics) {
    children.push(
      h(SectionHeader, { key: 'matchstats-header', title: 'Match Composition by Run' }),
      h(Table, {
        key: 'matchstats-table',
        columns: [
          { key: 'name', label: 'Reconciliation', width: 160, swatch: (row) => CATEGORY_COLORS[row.category] ?? '#9CA3AF' },
          { key: 'category', label: 'Category', width: 130 },
          { key: 'count', label: 'Count', width: 100, align: 'right' },
          { width: CONTENT_WIDTH - 390, label: 'Percent', align: 'right', render: (row) => `${row.percent}%` },
        ],
        rows: runs.flatMap((run) => run.categoryStats.map((stat) => ({ ...stat, name: run.name }))),
        emptyLabel: 'No category breakdown available.',
      }),
    );
  }

  if (sections.breakAnalysis) {
    children.push(
      h(SectionHeader, { key: 'break-header', title: 'Break Value by Run' }),
      h(Table, {
        key: 'break-table',
        columns: [
          { key: 'name', label: 'Reconciliation', width: 180 },
          { width: 130, label: 'Total Break Value', align: 'right', render: (row) => formatCurrency(row.breakValue) },
          { width: 130, label: 'Avg Break Size', align: 'right', render: (row) => formatCurrency(row.avgBreakSize) },
          { width: CONTENT_WIDTH - 440, label: 'Largest Break', align: 'right', render: (row) => formatCurrency(row.largestBreak) },
        ],
        rows: runs,
        emptyLabel: 'No break data available.',
      }),
    );
  }

  if (sections.unmatchedDetails) {
    children.push(
      h(SectionHeader, { key: 'unmatched-header', title: 'Exception Direction by Run' }),
      h(Table, {
        key: 'unmatched-table',
        columns: [
          { key: 'name', label: 'Reconciliation', width: 180 },
          { key: 'unmatchedACount', label: 'Missing in Counterparty', width: 130, align: 'right' },
          { key: 'unmatchedBCount', label: 'Missing Internally', width: 130, align: 'right' },
          { key: 'duplicateRowCount', label: 'Duplicates', width: CONTENT_WIDTH - 440, align: 'right' },
        ],
        rows: runs,
        emptyLabel: 'No exception data available.',
      }),
    );
  }

  if (sections.chartsAndGraphs) {
    children.push(
      h(SectionHeader, { key: 'trend-header', title: 'Trends' }),
      h(Text, { key: 'trend-matchrate-label', style: { fontSize: 8.5, fontFamily: 'Helvetica-Bold', color: TEXT_DARK, marginBottom: 6 } }, 'Match Rate Trend'),
      h(RunBarChart, { key: 'trend-matchrate', runs, valueOf: (r) => r.matchPercent, formatValue: (v) => `${v.toFixed(1)}%` }),
      h(Text, { key: 'trend-breakvalue-label', style: { fontSize: 8.5, fontFamily: 'Helvetica-Bold', color: TEXT_DARK, marginTop: 6, marginBottom: 6 } }, 'Break Value Trend'),
      h(RunBarChart, { key: 'trend-breakvalue', runs, valueOf: (r) => r.breakValue, formatValue: formatCurrency }),
    );
  }

  children.push(
    h(SectionHeader, { key: 'signature-header', title: 'Sign-off' }),
    h(
      View,
      { key: 'signature-section', wrap: false },
      h(View, { style: styles.signatureNameLine }, h(Text, { style: styles.signatureName }, generatedByName ?? '')),
      h(Text, { style: styles.signatureRoleLabel }, 'PREPARED BY'),
    ),
  );

  return h(
    Document,
    null,
    h(Page, { size: 'LETTER', style: styles.page }, h(View, { style: styles.topBand, fixed: true }), ...children, h(ComparisonFooter, { runCount: runs.length })),
  );
}

/**
 * @param {object[]} reports - completed Report rows (with `rows` included), any order
 * @param {{summary: boolean, matchStatistics: boolean, breakAnalysis: boolean, unmatchedDetails: boolean, chartsAndGraphs: boolean}} sections
 * @param {{generatedByName?: string, organizationName?: string, organizationLogo?: string, organizationType?: string}} meta
 * @returns {Promise<Buffer>}
 */
export function buildComparisonPdfReport(reports, sections, meta = {}) {
  return renderToBuffer(h(ComparisonDocument, { reports, sections, ...meta }));
}
