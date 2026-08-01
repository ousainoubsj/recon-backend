import React from 'react';
import { Circle, Document, Line, Page, Path, StyleSheet, Svg, Text, View, renderToBuffer } from '@react-pdf/renderer';
import { formatReportReference } from './reportReference.js';
import { computeCategoryStats, getBreakRows, getNonMatchedRows } from './reportSections.js';

// No JSX transform is configured for this backend (plain Node ESM, no
// build step) — React.createElement directly, same component model minus
// the JSX sugar.
const h = React.createElement;

const MAX_DETAIL_ROWS = 200; // keep the PDF a sane length for very large runs

// Matches the app's canonical category palette (ChartsOverview.tsx,
// ReportPreviewCard.tsx) so a category reads the same color whether you're
// looking at the dashboard or a generated PDF.
const CATEGORY_COLORS = {
  Matched: '#34D399',
  Mismatched: '#6366F1',
  Unmatched: '#3B82F6',
  Duplicates: '#F43F5E',
};
const BREAK_REASON_LABELS = {
  amount_mismatch: 'Amount Mismatch',
  missing_counterparty: 'Missing in Counterparty',
  missing_internal: 'Missing Internally',
  date_mismatch: 'Date Mismatch',
  duplicate: 'Duplicate',
  other: 'Other',
};

const BRAND_TEAL = '#0D9488';
const BRAND_INDIGO = '#6366F1';
const TEXT_DARK = '#111827';
const TEXT_GRAY = '#6B7280';
const TEXT_LIGHT_GRAY = '#9CA3AF';
const BORDER = '#E5E7EB';
const TINT_GRAY = '#F9FAFB';
const TINT_INDIGO = '#EEF2FF';
const STATUS_GREEN = '#059669';
const STATUS_GREEN_BG = '#ECFDF5';
const STATUS_GREEN_BORDER = '#A7F3D0';

const CONTENT_WIDTH = 612 - 40 * 2; // Letter width minus left/right page padding

const styles = StyleSheet.create({
  page: { paddingTop: 46, paddingBottom: 50, paddingHorizontal: 40, fontSize: 9, fontFamily: 'Helvetica', color: TEXT_DARK },
  topBand: { position: 'absolute', top: 0, left: 0, right: 0, height: 6, backgroundColor: BRAND_INDIGO },

  headerRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  brandBlock: { flexDirection: 'row', alignItems: 'center', width: 160 },
  brandMarkText: { color: '#FFFFFF', fontFamily: 'Helvetica-Bold', fontSize: 15 },
  brandTextBlock: { marginLeft: 8 },
  brandName: { fontSize: 14, fontFamily: 'Helvetica-Bold', color: BRAND_TEAL },
  brandTagline: { fontSize: 6, color: TEXT_LIGHT_GRAY, letterSpacing: 0.8, marginTop: 3 },

  titleBlock: { width: 220 },
  title: { fontSize: 15, fontFamily: 'Helvetica-Bold', color: TEXT_DARK },
  subtitle: { fontSize: 8, color: TEXT_GRAY, marginTop: 3 },

  metaBlock: { width: 150 },
  metaRow: { marginBottom: 6 },
  metaLabel: { fontSize: 6.5, fontFamily: 'Helvetica-Bold', color: BRAND_INDIGO, letterSpacing: 0.4 },
  metaValue: { fontSize: 8, color: TEXT_DARK, marginTop: 1 },

  divider: { borderBottomWidth: 1, borderBottomColor: BORDER, marginBottom: 12 },

  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4, marginBottom: 8 },
  sectionAccent: { width: 3, height: 13, backgroundColor: BRAND_INDIGO, marginRight: 8 },
  sectionTitle: { fontSize: 12, fontFamily: 'Helvetica-Bold', color: TEXT_DARK },

  tileGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  tile: { borderRadius: 5, borderWidth: 1, borderColor: BORDER, backgroundColor: TINT_GRAY, padding: 8, marginRight: 10, marginBottom: 10, flexDirection: 'row' },
  tileIconWrap: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  tileTextWrap: { flex: 1, justifyContent: 'center' },
  tileValue: { fontSize: 14, fontFamily: 'Helvetica-Bold', color: TEXT_DARK },
  tileLabel: { fontSize: 7, color: TEXT_GRAY, marginTop: 2 },
  tileDelta: { fontSize: 6.5, fontFamily: 'Helvetica-Bold', marginTop: 2 },

  overviewRow: { flexDirection: 'row', marginBottom: 4 },
  overviewText: { fontSize: 9.5, color: TEXT_DARK, lineHeight: 1.5, width: 340 },
  statusBadge: { flex: 1, marginLeft: 20, borderRadius: 4, borderWidth: 1, borderColor: STATUS_GREEN_BORDER, backgroundColor: STATUS_GREEN_BG, padding: 8, flexDirection: 'row', alignItems: 'center' },
  statusTextWrap: { marginLeft: 8 },
  statusTitle: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: STATUS_GREEN },
  statusSubtitle: { fontSize: 6.5, color: STATUS_GREEN, marginTop: 2 },

  table: { borderWidth: 1, borderColor: BORDER, borderRadius: 3, overflow: 'hidden' },
  tableHeaderRow: { flexDirection: 'row', backgroundColor: TINT_INDIGO },
  tableHeaderCell: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#3730A3', padding: 5 },
  tableRow: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: BORDER },
  tableRowAlt: { backgroundColor: TINT_GRAY },
  tableCell: { fontSize: 8.5, color: TEXT_DARK, padding: 5 },
  tableEmpty: { fontSize: 8.5, color: TEXT_GRAY, padding: 8 },

  analyticsPanelRow: { flexDirection: 'row' },
  analyticsPanel: { flex: 1, borderWidth: 1, borderColor: BORDER, borderRadius: 5, padding: 10 },
  analyticsPanelTitle: { fontSize: 9, fontFamily: 'Helvetica-Bold', color: TEXT_DARK, marginBottom: 8 },
  legendRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 5 },
  legendSwatch: { width: 7, height: 7, marginRight: 6 },
  legendLabel: { fontSize: 8, color: TEXT_DARK },

  barRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  barTrack: { flex: 1, height: 12, borderRadius: 3, backgroundColor: TINT_GRAY },
  barFill: { height: 12, borderRadius: 3 },
  barLabel: { fontSize: 7.5, color: TEXT_DARK, marginLeft: 8, width: 130 },

  footer: { position: 'absolute', bottom: 22, left: 40, right: 40, borderTopWidth: 0.5, borderTopColor: BORDER, paddingTop: 6 },
  footerRow: { flexDirection: 'row', justifyContent: 'space-between' },
  footerText: { fontSize: 6.5, color: TEXT_LIGHT_GRAY, marginTop: 2 },
});

function SvgIcon({ variant, color, size = 20 }) {
  const r = size / 2;
  if (variant === 'check') {
    return h(
      Svg,
      { width: size, height: size },
      h(Circle, { cx: r, cy: r, r, fill: color }),
      h(Path, {
        d: `M ${r - r * 0.45} ${r} L ${r - r * 0.1} ${r + r * 0.35} L ${r + r * 0.5} ${r - r * 0.35}`,
        stroke: '#FFFFFF',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        fill: 'none',
      }),
    );
  }
  if (variant === 'cross') {
    return h(
      Svg,
      { width: size, height: size },
      h(Circle, { cx: r, cy: r, r, fill: color }),
      h(Line, { x1: r - r * 0.35, y1: r - r * 0.35, x2: r + r * 0.35, y2: r + r * 0.35, stroke: '#FFFFFF', strokeWidth: 1.6, strokeLinecap: 'round' }),
      h(Line, { x1: r + r * 0.35, y1: r - r * 0.35, x2: r - r * 0.35, y2: r + r * 0.35, stroke: '#FFFFFF', strokeWidth: 1.6, strokeLinecap: 'round' }),
    );
  }
  return h(Svg, { width: size, height: size }, h(Circle, { cx: r, cy: r, r, fill: color }));
}

function SectionHeader({ title }) {
  return h(View, { style: styles.sectionHeaderRow }, h(View, { style: styles.sectionAccent }), h(Text, { style: styles.sectionTitle }, title));
}

// icon + value + label (+ optional real "vs previous run" delta) — matches
// the dashboard's stat-tile visual language (StatsOverview.tsx).
function StatTile({ icon = 'dot', color, value, label, delta, deltaGood, width }) {
  return h(
    View,
    { style: [styles.tile, { width }] },
    h(View, { style: styles.tileIconWrap }, h(SvgIcon, { variant: icon, color, size: 20 })),
    h(
      View,
      { style: styles.tileTextWrap },
      h(Text, { style: styles.tileValue }, value),
      h(Text, { style: styles.tileLabel }, label),
      delta != null &&
        h(
          Text,
          { style: [styles.tileDelta, { color: deltaGood ? STATUS_GREEN : '#DC2626' }] },
          `${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta).toFixed(1)}% vs previous run`,
        ),
    ),
  );
}

function StatTileGrid({ tiles, columns = 3 }) {
  const gap = 10;
  const width = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
  return h(View, { style: styles.tileGrid }, ...tiles.map((tile, i) => h(StatTile, { key: i, width, ...tile })));
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
                col.swatch ? h(View, { style: { width: 8, height: 8, marginLeft: 5, marginRight: 5, backgroundColor: col.swatch(row) } }) : null,
                h(Text, { style: [styles.tableCell, { textAlign: col.align ?? 'left', flex: 1 }] }, col.render ? col.render(row) : String(row[col.key] ?? '')),
              ),
            ),
          ),
        ),
  );
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function describeDonutSlicePath(cx, cy, rOuter, rInner, startAngle, endAngle) {
  const largeArc = endAngle - startAngle <= 180 ? 0 : 1;
  const startOuter = polarToCartesian(cx, cy, rOuter, endAngle);
  const endOuter = polarToCartesian(cx, cy, rOuter, startAngle);
  const startInner = polarToCartesian(cx, cy, rInner, endAngle);
  const endInner = polarToCartesian(cx, cy, rInner, startAngle);

  return [
    `M ${startOuter.x} ${startOuter.y}`,
    `A ${rOuter} ${rOuter} 0 ${largeArc} 0 ${endOuter.x} ${endOuter.y}`,
    `L ${endInner.x} ${endInner.y}`,
    `A ${rInner} ${rInner} 0 ${largeArc} 1 ${startInner.x} ${startInner.y}`,
    'Z',
  ].join(' ');
}

// Donut via manual SVG arc paths — react-pdf has no native pie/donut
// primitive. A single 100%-share segment is split into two half-circles so
// the arc math never has to close a degenerate 360° slice.
function DonutChart({ segments, size = 92, thickness = 16, centerValue, centerLabel }) {
  const r = size / 2;
  const rInner = r - thickness;
  const nonZero = segments.filter((s) => s.value > 0);
  const total = nonZero.reduce((sum, s) => sum + s.value, 0);

  const paths = [];
  if (total > 0) {
    if (nonZero.length === 1) {
      paths.push(h(Path, { key: 0, d: describeDonutSlicePath(r, r, r, rInner, 0, 179.9), fill: nonZero[0].color }));
      paths.push(h(Path, { key: 1, d: describeDonutSlicePath(r, r, r, rInner, 180, 359.9), fill: nonZero[0].color }));
    } else {
      let angle = 0;
      nonZero.forEach((seg, i) => {
        const sweep = (seg.value / total) * 360;
        const start = angle + (sweep < 2 ? 0 : 0.6);
        const end = angle + sweep - (sweep < 2 ? 0 : 0.6);
        if (end > start) paths.push(h(Path, { key: i, d: describeDonutSlicePath(r, r, r, rInner, start, end), fill: seg.color }));
        angle += sweep;
      });
    }
  } else {
    paths.push(h(Circle, { key: 0, cx: r, cy: r, r, fill: TINT_GRAY }));
  }

  return h(
    View,
    { style: { width: size, height: size } },
    h(Svg, { width: size, height: size }, ...paths),
    h(
      View,
      { style: { position: 'absolute', top: 0, left: 0, width: size, height: size, alignItems: 'center', justifyContent: 'center' } },
      h(Text, { style: { fontSize: 11, fontFamily: 'Helvetica-Bold', color: TEXT_DARK } }, centerValue),
      h(Text, { style: { fontSize: 6.5, color: TEXT_GRAY, marginTop: 1 } }, centerLabel),
    ),
  );
}

function CategoryBarChart({ stats }) {
  const maxCount = Math.max(1, ...stats.map((s) => s.count));
  return h(
    View,
    null,
    ...stats.map((stat, i) =>
      h(
        View,
        { key: i, style: styles.barRow },
        h(
          View,
          { style: styles.barTrack },
          h(View, { style: [styles.barFill, { width: `${Math.max((stat.count / maxCount) * 100, 2)}%`, backgroundColor: CATEGORY_COLORS[stat.category] ?? '#9CA3AF' }] }),
        ),
        h(Text, { style: styles.barLabel }, `${stat.category}  ${stat.count} (${stat.percent}%)`),
      ),
    ),
  );
}

function ReportHeader({ report, reference, generatedByName }) {
  return h(
    View,
    null,
    h(
      View,
      { style: styles.headerRow },
      h(
        View,
        { style: styles.brandBlock },
        h(View, { style: { width: 30, height: 30, borderRadius: 8, backgroundColor: BRAND_TEAL, alignItems: 'center', justifyContent: 'center' } }, h(Text, { style: styles.brandMarkText }, 'R')),
        h(View, { style: styles.brandTextBlock }, h(Text, { style: styles.brandName }, 'Reconcil'), h(Text, { style: styles.brandTagline }, 'TRANSACTION RECONCILIATION')),
      ),
      h(
        View,
        { style: styles.titleBlock },
        h(Text, { style: styles.title }, report.name || 'Reconciliation Report'),
        h(Text, { style: styles.subtitle }, 'Reconciliation summary and analysis'),
      ),
      h(
        View,
        { style: styles.metaBlock },
        [
          ['Report ID', reference],
          ['Generated On', new Date().toLocaleString()],
          ['Run Date', new Date(report.runDate).toLocaleString()],
          ['Prepared By', generatedByName ?? '—'],
        ].map(([label, value], i) =>
          h(View, { key: i, style: styles.metaRow }, h(Text, { style: styles.metaLabel }, label.toUpperCase()), h(Text, { style: styles.metaValue }, value)),
        ),
      ),
    ),
    h(View, { style: styles.divider }),
  );
}

function ReportFooter({ reference }) {
  return h(
    View,
    { style: styles.footer, fixed: true },
    h(
      View,
      { style: styles.footerRow },
      h(Text, { style: styles.footerText }, 'This report is confidential and intended solely for authorized use.'),
      h(Text, { style: styles.footerText }, `Report ID: ${reference}`),
    ),
    h(
      View,
      { style: styles.footerRow },
      h(Text, { style: styles.footerText }, 'Reconcil — Transaction Reconciliation Platform'),
      h(Text, { style: styles.footerText, render: ({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}` }),
    ),
  );
}

function ReportDocument({ report, sections, generatedByName }) {
  const reference = formatReportReference(report.sequenceYear, report.sequenceNumber) ?? report.id.slice(0, 8).toUpperCase();
  const matchPercent = report.totalRows > 0 ? (report.matchedCount / report.totalRows) * 100 : 0;
  const priorMatchDelta = report.priorRun ? matchPercent - report.priorRun.matchRate : null;
  const stats = computeCategoryStats(report);

  const children = [
    h(ReportHeader, { key: 'header', report, reference, generatedByName }),

    h(SectionHeader, { key: 'exec-header', title: 'Executive Summary' }),
    h(StatTileGrid, {
      key: 'exec-tiles',
      tiles: [
        { icon: 'dot', color: BRAND_INDIGO, value: `${matchPercent.toFixed(1)}%`, label: 'Match Rate', delta: priorMatchDelta, deltaGood: (priorMatchDelta ?? 0) >= 0 },
        { icon: 'dot', color: TEXT_DARK, value: String(report.totalRows), label: 'Total Transactions' },
        { icon: 'check', color: CATEGORY_COLORS.Matched, value: String(report.matchedCount), label: 'Matched Transactions' },
        { icon: 'cross', color: CATEGORY_COLORS.Unmatched, value: String(report.unmatchedCount + report.mismatchedCount), label: 'Unmatched Transactions' },
      ],
    }),

    h(SectionHeader, { key: 'overview-header', title: 'Reconciliation Overview' }),
    h(
      View,
      { key: 'overview', style: styles.overviewRow },
      h(
        Text,
        { style: styles.overviewText },
        `Out of ${report.totalRows} total transactions, ${report.matchedCount} (${matchPercent.toFixed(2)}%) were successfully matched. There ` +
          `${report.unmatchedCount + report.mismatchedCount === 1 ? 'is' : 'are'} ${report.unmatchedCount + report.mismatchedCount} unmatched or mismatched ` +
          `transaction${report.unmatchedCount + report.mismatchedCount === 1 ? '' : 's'} with a total break value of ${Number(report.totalBreakValue).toFixed(2)}.`,
      ),
      h(
        View,
        { style: styles.statusBadge },
        h(SvgIcon, { variant: 'check', color: STATUS_GREEN, size: 18 }),
        h(View, { style: styles.statusTextWrap }, h(Text, { style: styles.statusTitle }, 'Completed'), h(Text, { style: styles.statusSubtitle }, 'Reconciliation completed successfully')),
      ),
    ),
  ];

  if (sections.summary) {
    children.push(
      h(SectionHeader, { key: 'summary-header', title: 'Summary' }),
      h(StatTileGrid, {
        key: 'summary-tiles',
        columns: 3,
        tiles: [
          { color: CATEGORY_COLORS.Matched, value: String(report.matchedCount), label: 'Matched' },
          { color: CATEGORY_COLORS.Mismatched, value: String(report.mismatchedCount), label: 'Mismatched' },
          { color: CATEGORY_COLORS.Unmatched, value: String(report.unmatchedCount), label: 'Unmatched' },
          { color: CATEGORY_COLORS.Duplicates, value: String(report.duplicateCount), label: 'Duplicates' },
          { color: TEXT_DARK, value: String(report.totalRows), label: 'Total Rows' },
          {
            color: TEXT_DARK,
            value: Number(report.totalBreakValue).toFixed(2),
            label: 'Total Break Value',
            delta: report.priorRun ? Number(report.totalBreakValue) - report.priorRun.totalBreakValue : null,
            deltaGood: report.priorRun ? Number(report.totalBreakValue) <= report.priorRun.totalBreakValue : true,
          },
        ],
      }),
    );
  }

  if (sections.chartsAndGraphs) {
    children.push(
      h(SectionHeader, { key: 'analytics-header', title: 'Reconciliation Analytics' }),
      h(
        View,
        { key: 'analytics', style: styles.analyticsPanelRow, wrap: false },
        h(
          View,
          { style: [styles.analyticsPanel, { marginRight: 10 }] },
          h(Text, { style: styles.analyticsPanelTitle }, 'Match Distribution'),
          h(
            View,
            { style: { flexDirection: 'row', alignItems: 'center' } },
            h(DonutChart, {
              segments: stats.map((s) => ({ value: s.count, color: CATEGORY_COLORS[s.category] })),
              centerValue: String(report.totalRows),
              centerLabel: 'Total',
            }),
            h(
              View,
              { style: { marginLeft: 14, flex: 1 } },
              ...stats.map((stat, i) =>
                h(
                  View,
                  { key: i, style: styles.legendRow },
                  h(View, { style: [styles.legendSwatch, { backgroundColor: CATEGORY_COLORS[stat.category] }] }),
                  h(Text, { style: styles.legendLabel }, `${stat.category}  ${stat.count} (${stat.percent}%)`),
                ),
              ),
            ),
          ),
        ),
        h(
          View,
          { style: styles.analyticsPanel },
          h(Text, { style: styles.analyticsPanelTitle }, 'Category Breakdown'),
          h(CategoryBarChart, { stats }),
        ),
      ),
    );
  }

  if (sections.matchStatistics) {
    children.push(
      h(SectionHeader, { key: 'matchstats-header', title: 'Match Statistics' }),
      h(Table, {
        key: 'matchstats-table',
        columns: [
          { key: 'category', label: 'Category', width: 190, swatch: (row) => CATEGORY_COLORS[row.category] ?? '#9CA3AF' },
          { key: 'count', label: 'Count', width: 130, align: 'right' },
          { width: CONTENT_WIDTH - 320, label: 'Percent', align: 'right', render: (row) => `${row.percent}%` },
        ],
        rows: stats,
      }),
    );
  }

  if (sections.breakAnalysis) {
    const breakRows = getBreakRows(report);
    children.push(
      h(SectionHeader, { key: 'break-header', title: 'Break Analysis' }),
      h(
        Text,
        { key: 'break-count', style: { fontSize: 8.5, color: TEXT_GRAY, marginBottom: 6 } },
        breakRows.length > MAX_DETAIL_ROWS
          ? `${breakRows.length} rows with an amount break — showing the first ${MAX_DETAIL_ROWS}`
          : `${breakRows.length} rows with an amount break`,
      ),
      h(Table, {
        key: 'break-table',
        columns: [
          { key: 'ref', label: 'Reference', width: 300 },
          { width: CONTENT_WIDTH - 300, label: 'Amount Difference', align: 'right', render: (row) => Number(row.amountDiff).toFixed(2) },
        ],
        rows: breakRows.slice(0, MAX_DETAIL_ROWS),
        emptyLabel: 'No amount breaks found.',
      }),
    );
  }

  if (sections.unmatchedDetails) {
    const nonMatched = getNonMatchedRows(report);
    const reasonCounts = new Map();
    for (const row of nonMatched) {
      const key = row.breakReason ?? 'other';
      reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
    }
    const sorted = [...nonMatched].sort((a, b) => Math.abs(Number(b.amountA ?? b.amountB ?? 0)) - Math.abs(Number(a.amountA ?? a.amountB ?? 0)));

    children.push(
      h(SectionHeader, { key: 'exceptions-header', title: 'Exception Summary' }),
      h(Table, {
        key: 'exceptions-table',
        columns: [
          { key: 'reason', label: 'Reason', width: CONTENT_WIDTH - 130, render: (row) => BREAK_REASON_LABELS[row.reason] ?? row.reason },
          { key: 'count', label: 'Count', width: 130, align: 'right' },
        ],
        rows: [...reasonCounts.entries()].map(([reason, count]) => ({ reason, count })),
        emptyLabel: 'No exceptions found.',
      }),

      h(SectionHeader, { key: 'unmatched-header', title: 'Unmatched Details' }),
      h(
        Text,
        { key: 'unmatched-count', style: { fontSize: 8.5, color: TEXT_GRAY, marginBottom: 6 } },
        nonMatched.length > MAX_DETAIL_ROWS
          ? `${nonMatched.length} non-matched rows, largest first — showing the first ${MAX_DETAIL_ROWS}`
          : `${nonMatched.length} non-matched rows, largest first`,
      ),
      h(Table, {
        key: 'unmatched-table',
        columns: [
          { key: 'ref', label: 'Reference', width: 260 },
          { width: 140, label: 'Status', render: (row) => row.status.replace('_', ' ') },
          { width: CONTENT_WIDTH - 400, label: 'Amount', align: 'right', render: (row) => Number(row.amountA ?? row.amountB ?? 0).toFixed(2) },
        ],
        rows: sorted.slice(0, MAX_DETAIL_ROWS),
        emptyLabel: 'No unmatched rows.',
      }),
    );
  }

  return h(
    Document,
    null,
    h(Page, { size: 'LETTER', style: styles.page }, h(View, { style: styles.topBand, fixed: true }), ...children, h(ReportFooter, { reference })),
  );
}

/**
 * @param {object} report - a Report row with its `rows` included, plus `priorRun`
 * @param {{summary: boolean, matchStatistics: boolean, breakAnalysis: boolean, unmatchedDetails: boolean, chartsAndGraphs: boolean}} sections
 * @param {{generatedByName?: string}} meta
 * @returns {Promise<Buffer>}
 */
export function buildPdfReport(report, sections, meta = {}) {
  return renderToBuffer(h(ReportDocument, { report, sections, generatedByName: meta.generatedByName }));
}
