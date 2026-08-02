import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { formatReportReference } from './reportReference.js';
import {
  BREAK_REASON_LABELS,
  MAX_DETAIL_ROWS,
  NON_MATCHED_STATUSES,
  computeCategoryStats,
  getBreakRows,
  getNonMatchedRows,
} from './reportSections.js';

// Same asset pdfReport.js embeds — copied into this repo (rather than
// referenced from recon-frontend/public) so generation doesn't depend on a
// shared filesystem between the two separately-deployable services.
const LOGO_SYM_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../assets/logo-sym.png');
const RECONCIL_LOGO_BUFFER = fs.readFileSync(LOGO_SYM_PATH);

// 12 columns (not 8) so the 4-tile Executive Summary row (span 3 each) and
// the 3-tile Summary row (span 4 each) both divide evenly and fill the full
// width — see writeStatTiles.
const TOTAL_COLS = 12;

// Same palette as pdfReport.js, in ARGB (ExcelJS's fill/font color format)
// instead of react-pdf's #RRGGBB.
const CATEGORY_COLORS = {
  Matched: 'FF34D399',
  Mismatched: 'FF6366F1',
  Unmatched: 'FF3B82F6',
  Duplicates: 'FFF43F5E',
};

const BRAND_TEAL = 'FF0D9488';
const BRAND_INDIGO = 'FF6366F1';
const TEXT_DARK = 'FF111827';
const TEXT_GRAY = 'FF6B7280';
const TEXT_LIGHT_GRAY = 'FF9CA3AF';
const BORDER = 'FFE5E7EB';
const TINT_GRAY = 'FFF9FAFB';
const TINT_INDIGO = 'FFEEF2FF';
const STATUS_GREEN = 'FF059669';
const STATUS_RED = 'FFDC2626';
const WHITE = 'FFFFFFFF';
const LOGO_FALLBACK_GRAY = 'FF9CA3AF';

const CURRENCY_FMT = '"$"#,##0.00';

const STATUS_LABELS = {
  matched: 'Matched',
  mismatched: 'Mismatched',
  unmatched_a: 'Unmatched (A)',
  unmatched_b: 'Unmatched (B)',
  duplicate: 'Duplicates',
};

const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
function formatCurrency(value) {
  return currencyFormatter.format(Number(value));
}

// Same relative-percent-change formula as pdfReport.js's local copy (itself
// mirroring reportService.js's canonical version).
function deltaPercent(current, previous) {
  if (!previous) return null;
  return ((current - previous) / previous) * 100;
}

function deltaText(delta) {
  return `${delta >= 0 ? '+' : '-'}${Math.abs(delta).toFixed(1)}%`;
}

function colLetter(n) {
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Only PNG/JPEG/GIF can be embedded as an ExcelJS image (unlike react-pdf's
// <Image>, which can also render SVG) — an org logo uploaded as SVG (allowed
// by settings.controller.js's LOGO_ALLOWED_CONTENT_TYPES) just falls back to
// the monogram tile below instead of failing the whole export.
async function loadLogoForEmbed(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    const extension = contentType.includes('png')
      ? 'png'
      : contentType.includes('jpeg') || contentType.includes('jpg')
        ? 'jpeg'
        : contentType.includes('gif')
          ? 'gif'
          : null;
    if (!extension) return null;
    return { buffer: Buffer.from(await res.arrayBuffer()), extension };
  } catch (err) {
    console.error('Failed to fetch organization logo for xlsx export', err);
    return null;
  }
}

function mergeText(ws, row, startCol, endCol, value, { bold, italic, size, color, valign } = {}) {
  if (endCol > startCol) ws.mergeCells(row, startCol, row, endCol);
  const cell = ws.getCell(row, startCol);
  cell.value = value;
  cell.font = { bold, italic, size, color: { argb: color ?? TEXT_DARK } };
  cell.alignment = { vertical: valign ?? 'middle' };
  return cell;
}

function applyBoxBorder(ws, r1, c1, r2, c2, argb) {
  const style = { style: 'thin', color: { argb } };
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      const cell = ws.getCell(r, c);
      cell.border = {
        ...cell.border,
        ...(r === r1 ? { top: style } : {}),
        ...(r === r2 ? { bottom: style } : {}),
        ...(c === c1 ? { left: style } : {}),
        ...(c === c2 ? { right: style } : {}),
      };
    }
  }
}

function writeSectionHeader(ws, row, title) {
  ws.mergeCells(row, 1, row, TOTAL_COLS);
  const cell = ws.getCell(row, 1);
  cell.value = title;
  cell.font = { bold: true, size: 12, color: { argb: TEXT_DARK } };
  cell.border = { left: { style: 'medium', color: { argb: BRAND_INDIGO } } };
  cell.alignment = { indent: 1, vertical: 'middle' };
  ws.getRow(row).height = 18;
  return row + 2;
}

function writeNote(ws, row, text) {
  ws.mergeCells(row, 1, row, TOTAL_COLS);
  const cell = ws.getCell(row, 1);
  cell.value = text;
  cell.font = { italic: true, size: 8.5, color: { argb: TEXT_GRAY } };
  return row + 1;
}

// value + label (+ optional real "vs previous run" delta, inline before the
// label, colored) — matches pdfReport.js's StatTile visual language.
function writeStatTiles(ws, startRow, tiles, columns) {
  const span = TOTAL_COLS / columns;
  let row = startRow;

  for (let i = 0; i < tiles.length; i += columns) {
    const rowTiles = tiles.slice(i, i + columns);
    const valueRow = row;
    const labelRow = row + 1;

    rowTiles.forEach((tile, idx) => {
      const s = idx * span + 1;
      const e = s + span - 1;

      ws.mergeCells(valueRow, s, valueRow, e);
      const valueCell = ws.getCell(valueRow, s);
      valueCell.value = tile.value;
      valueCell.font = { bold: true, size: 13, color: { argb: TEXT_DARK } };
      valueCell.alignment = { vertical: 'middle', indent: 1 };

      ws.mergeCells(labelRow, s, labelRow, e);
      const labelCell = ws.getCell(labelRow, s);
      labelCell.value =
        tile.delta != null
          ? {
              richText: [
                {
                  font: { size: 8, bold: true, color: { argb: tile.deltaGood ? STATUS_GREEN : STATUS_RED } },
                  text: `${deltaText(tile.delta)} `,
                },
                { font: { size: 8, color: { argb: TEXT_GRAY } }, text: tile.label },
              ],
            }
          : tile.label;
      if (tile.delta == null) labelCell.font = { size: 8, color: { argb: TEXT_GRAY } };
      labelCell.alignment = { vertical: 'middle', indent: 1 };

      applyBoxBorder(ws, valueRow, s, labelRow, e, BORDER);
      for (let r = valueRow; r <= labelRow; r++) {
        for (let c = s; c <= e; c++) ws.getCell(r, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TINT_GRAY } };
      }
    });

    ws.getRow(valueRow).height = 20;
    ws.getRow(labelRow).height = 14;
    row = labelRow + 2;
  }

  return row;
}

// Generic bordered/striped table — column spans (out of TOTAL_COLS) must sum
// to 12, same discipline as pdfReport.js's Table column widths summing to
// CONTENT_WIDTH.
function writeTable(ws, startRow, columns, rows, emptyLabel) {
  let row = startRow;
  let col = 1;
  const starts = columns.map((c) => {
    const s = col;
    col += c.span;
    return s;
  });

  columns.forEach((c, i) => {
    const s = starts[i];
    const e = s + c.span - 1;
    if (e > s) ws.mergeCells(row, s, row, e);
    const cell = ws.getCell(row, s);
    cell.value = c.header;
    cell.font = { bold: true, size: 9, color: { argb: 'FF3730A3' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TINT_INDIGO } };
    cell.alignment = { horizontal: c.align ?? 'left', vertical: 'middle' };
  });
  applyBoxBorder(ws, row, 1, row, TOTAL_COLS, BORDER);
  ws.getRow(row).height = 16;
  row += 1;

  if (rows.length === 0) {
    ws.mergeCells(row, 1, row, TOTAL_COLS);
    const cell = ws.getCell(row, 1);
    cell.value = emptyLabel ?? 'None';
    cell.font = { italic: true, size: 9, color: { argb: TEXT_GRAY } };
    applyBoxBorder(ws, row, 1, row, TOTAL_COLS, BORDER);
    return row + 2;
  }

  rows.forEach((r, ri) => {
    columns.forEach((c, i) => {
      const s = starts[i];
      const e = s + c.span - 1;
      if (e > s) ws.mergeCells(row, s, row, e);
      const cell = ws.getCell(row, s);
      if (c.swatch) {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: c.swatch(r) } };
      } else {
        cell.value = c.render ? c.render(r) : r[c.key];
        if (c.numFmt) cell.numFmt = c.numFmt;
        cell.font = { size: 9, color: { argb: TEXT_DARK } };
        cell.alignment = { horizontal: c.align ?? 'left', vertical: 'middle' };
        if (ri % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TINT_GRAY } };
      }
    });
    applyBoxBorder(ws, row, 1, row, TOTAL_COLS, BORDER);
    row += 1;
  });

  return row + 1;
}

// Sign-off — three side-by-side blocks (Prepared/Reviewed/Approved By),
// each a blank line to sign above (pre-filled with the exporting user's
// name for Prepared By only, per buildReportMeta) plus a blank date line.
// No reviewer/approver identity exists in the data model, so those two are
// intentionally left blank for physical/manual sign-off. Mirrors
// pdfReport.js's SignatureSection.
function writeSignatureSection(ws, startRow, meta) {
  const cols = 3;
  const span = TOTAL_COLS / cols;
  const entries = [
    { label: 'PREPARED BY', name: meta.generatedByName ?? '' },
    { label: 'REVIEWED BY', name: '' },
    { label: 'APPROVED BY', name: '' },
  ];

  const nameRow = startRow;
  const labelRow = startRow + 1;
  const dateRow = startRow + 2;

  entries.forEach((entry, idx) => {
    const s = idx * span + 1;
    const e = s + span - 1;

    ws.mergeCells(nameRow, s, nameRow, e);
    const nameCell = ws.getCell(nameRow, s);
    nameCell.value = entry.name;
    nameCell.font = { size: 10, color: { argb: TEXT_DARK } };
    nameCell.alignment = { vertical: 'bottom', indent: 1 };
    nameCell.border = { bottom: { style: 'thin', color: { argb: TEXT_DARK } } };

    ws.mergeCells(labelRow, s, labelRow, e);
    const labelCell = ws.getCell(labelRow, s);
    labelCell.value = entry.label;
    labelCell.font = { bold: true, size: 7, color: { argb: BRAND_INDIGO } };
    labelCell.alignment = { indent: 1 };

    ws.mergeCells(dateRow, s, dateRow, s + 1);
    const dateLabelCell = ws.getCell(dateRow, s);
    dateLabelCell.value = 'Date:';
    dateLabelCell.font = { size: 8, color: { argb: TEXT_GRAY } };
    dateLabelCell.alignment = { indent: 1 };

    ws.mergeCells(dateRow, s + 2, dateRow, e);
    ws.getCell(dateRow, s + 2).border = { bottom: { style: 'thin', color: { argb: BORDER } } };
  });

  ws.getRow(nameRow).height = 26;
  ws.getRow(labelRow).height = 12;
  ws.getRow(dateRow).height = 16;

  return dateRow + 2;
}

// No native chart API in ExcelJS (same limitation the old code's comment
// noted for the xlsx/SheetJS free tier) — a colored swatch + block-character
// bar is a lightweight, dependency-free stand-in for pdfReport.js's
// CategoryBarChart/DonutChart panels.
function writeAnalyticsTable(ws, startRow, stats) {
  let row = startRow;
  const maxCount = Math.max(1, ...stats.map((s) => s.count));

  stats.forEach((stat) => {
    const color = CATEGORY_COLORS[stat.category] ?? LOGO_FALLBACK_GRAY;

    ws.getCell(row, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };

    ws.mergeCells(row, 2, row, 7);
    const barCell = ws.getCell(row, 2);
    const blocks = Math.max(1, Math.round((stat.count / maxCount) * 24));
    barCell.value = '█'.repeat(blocks);
    barCell.font = { name: 'Consolas', size: 9, color: { argb: color } };

    ws.mergeCells(row, 8, row, 12);
    const labelCell = ws.getCell(row, 8);
    labelCell.value = `${stat.category}  ${stat.count} (${stat.percent}%)`;
    labelCell.font = { size: 9, color: { argb: TEXT_DARK } };
    labelCell.alignment = { horizontal: 'right' };

    ws.getRow(row).height = 14;
    row += 1;
  });

  return row + 1;
}

async function buildOverviewSheet(wb, report, sections, meta) {
  const ws = wb.addWorksheet('Report Overview', { views: [{ showGridLines: false }] });
  ws.columns = Array.from({ length: TOTAL_COLS }, () => ({ width: 8 }));
  ws.pageSetup = { fitToPage: true, fitToWidth: 1, fitToHeight: 0, orientation: 'portrait' };

  const reference = formatReportReference(report.sequenceYear, report.sequenceNumber) ?? report.id.slice(0, 8).toUpperCase();
  const matchPercent = report.totalRows > 0 ? (report.matchedCount / report.totalRows) * 100 : 0;
  const priorMatchDelta = report.priorRun ? deltaPercent(matchPercent, report.priorRun.matchRate) : null;
  const stats = computeCategoryStats(report);

  let row = 1;

  // Section 1 — the reconciling org's own logo + name + org type, centered
  // in the PDF; here left-anchored (a spreadsheet has no natural "centered
  // header" concept) but otherwise the same three pieces of info.
  const orgLogo = await loadLogoForEmbed(meta.organizationLogo);
  if (orgLogo) {
    const imgId = wb.addImage(orgLogo);
    ws.addImage(imgId, { tl: { col: 0, row: row - 1 }, ext: { width: 40, height: 40 } });
  } else {
    const cell = ws.getCell(row, 1);
    cell.value = (meta.organizationName ?? '?').charAt(0).toUpperCase();
    cell.font = { bold: true, size: 16, color: { argb: WHITE } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LOGO_FALLBACK_GRAY } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  }
  ws.getRow(row).height = 26;
  // Bottom/top-aligned rather than each row's default middle — middle
  // alignment left equal padding above *and* below every line, which read
  // as a gap between the name and the type line sitting right under it.
  mergeText(ws, row, 2, TOTAL_COLS, meta.organizationName ?? 'Your Organization', { bold: true, size: 14, color: TEXT_DARK, valign: 'bottom' });
  row += 1;
  if (meta.organizationType) mergeText(ws, row, 2, TOTAL_COLS, meta.organizationType, { size: 9, color: TEXT_GRAY, valign: 'top' });
  row += 2;

  // Section 2 — Reconcil brand mark, logo-sym.png beside the wordmark.
  const reconLogoId = wb.addImage({ buffer: RECONCIL_LOGO_BUFFER, extension: 'png' });
  ws.addImage(reconLogoId, { tl: { col: 0, row: row - 1 }, ext: { width: 24, height: 24 } });
  ws.getRow(row).height = 20;
  mergeText(ws, row, 2, TOTAL_COLS, 'Reconcil', { bold: true, size: 14, color: BRAND_TEAL, valign: 'bottom' });
  row += 1;
  mergeText(ws, row, 2, TOTAL_COLS, 'TRANSACTION RECONCILIATION', { size: 7, color: TEXT_LIGHT_GRAY, valign: 'top' });
  row += 2;

  // Section 3 — the template used to generate this report + the
  // reconciliation's own name.
  mergeText(ws, row, 1, TOTAL_COLS, meta.templateName ?? 'Custom Report', { bold: true, size: 15, color: TEXT_DARK });
  row += 1;
  mergeText(ws, row, 1, TOTAL_COLS, report.name || 'Reconciliation Report', { size: 9, color: TEXT_GRAY });
  row += 2;

  // Section 4 — metadata, all on one row.
  const metaItems = [
    ['REPORT ID', reference],
    ['GENERATED ON', new Date().toLocaleString()],
    ['RUN DATE', new Date(report.runDate).toLocaleString()],
    ['PREPARED BY', meta.generatedByName ?? '—'],
  ];
  metaItems.forEach(([label], i) => mergeText(ws, row, i * 3 + 1, i * 3 + 3, label, { bold: true, size: 6.5, color: BRAND_INDIGO }));
  row += 1;
  metaItems.forEach(([, value], i) => mergeText(ws, row, i * 3 + 1, i * 3 + 3, value, { size: 9, color: TEXT_DARK }));
  row += 1;

  for (let c = 1; c <= TOTAL_COLS; c++) ws.getCell(row, c).border = { bottom: { style: 'thin', color: { argb: BORDER } } };
  row += 2;

  row = writeSectionHeader(ws, row, 'Executive Summary');
  row = writeStatTiles(
    ws,
    row,
    [
      { value: `${matchPercent.toFixed(1)}%`, label: 'Match Rate', delta: priorMatchDelta, deltaGood: (priorMatchDelta ?? 0) >= 0 },
      { value: String(report.totalRows), label: 'Total Transactions' },
      { value: String(report.matchedCount), label: 'Matched Transactions' },
      { value: String(report.unmatchedCount + report.mismatchedCount), label: 'Unmatched Transactions' },
    ],
    4,
  );

  row = writeSectionHeader(ws, row, 'Reconciliation Overview');
  const unmatchedOrMismatched = report.unmatchedCount + report.mismatchedCount;
  ws.mergeCells(row, 1, row + 1, TOTAL_COLS);
  const overviewCell = ws.getCell(row, 1);
  overviewCell.value =
    `Out of ${report.totalRows} total transactions, ${report.matchedCount} (${matchPercent.toFixed(2)}%) were successfully matched. There ` +
    `${unmatchedOrMismatched === 1 ? 'is' : 'are'} ${unmatchedOrMismatched} unmatched or mismatched ` +
    `transaction${unmatchedOrMismatched === 1 ? '' : 's'} with a total break value of ${formatCurrency(report.totalBreakValue)}.`;
  overviewCell.font = { size: 10, color: { argb: TEXT_DARK } };
  overviewCell.alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(row).height = 30;
  row += 3;

  if (sections.summary) {
    row = writeSectionHeader(ws, row, 'Summary');
    const breakValueDelta = report.priorRun ? deltaPercent(Number(report.totalBreakValue), report.priorRun.totalBreakValue) : null;
    row = writeStatTiles(
      ws,
      row,
      [
        { value: String(report.matchedCount), label: 'Matched' },
        { value: String(report.mismatchedCount), label: 'Mismatched' },
        { value: String(report.unmatchedCount), label: 'Unmatched' },
        { value: String(report.duplicateCount), label: 'Duplicates' },
        { value: String(report.totalRows), label: 'Total Rows' },
        {
          value: formatCurrency(report.totalBreakValue),
          label: 'Total Break Value',
          delta: breakValueDelta,
          deltaGood: (breakValueDelta ?? 0) <= 0,
        },
      ],
      3,
    );
  }

  if (sections.chartsAndGraphs) {
    row = writeSectionHeader(ws, row, 'Reconciliation Analytics');
    row = writeAnalyticsTable(ws, row, stats);
  }

  if (sections.matchStatistics) {
    row = writeSectionHeader(ws, row, 'Match Statistics');
    row = writeTable(
      ws,
      row,
      [
        { header: '', span: 1, swatch: (r) => CATEGORY_COLORS[r.category] ?? LOGO_FALLBACK_GRAY },
        { header: 'Category', span: 4, key: 'category' },
        { header: 'Count', span: 3, key: 'count', align: 'right' },
        { header: 'Percent', span: 4, align: 'right', render: (r) => `${r.percent}%` },
      ],
      stats,
    );
  }

  if (sections.breakAnalysis) {
    row = writeSectionHeader(ws, row, 'Break Analysis');
    const breakRows = getBreakRows(report);
    row = writeNote(
      ws,
      row,
      breakRows.length > MAX_DETAIL_ROWS
        ? `${breakRows.length} rows with an amount break — showing the first ${MAX_DETAIL_ROWS}`
        : `${breakRows.length} rows with an amount break`,
    );
    row = writeTable(
      ws,
      row,
      [
        { header: 'Reference', span: 7, key: 'ref' },
        { header: 'Amount Difference', span: 5, key: 'amountDiff', align: 'right', numFmt: CURRENCY_FMT },
      ],
      breakRows.slice(0, MAX_DETAIL_ROWS).map((r) => ({ ref: r.ref, amountDiff: Number(r.amountDiff) })),
      'No amount breaks found.',
    );
  }

  if (sections.unmatchedDetails) {
    const nonMatched = getNonMatchedRows(report);
    const reasonCounts = new Map();
    for (const r of nonMatched) {
      const key = r.breakReason ?? 'other';
      reasonCounts.set(key, (reasonCounts.get(key) ?? 0) + 1);
    }

    row = writeSectionHeader(ws, row, 'Exception Summary');
    row = writeTable(
      ws,
      row,
      [
        { header: 'Reason', span: 9, key: 'reason', render: (r) => BREAK_REASON_LABELS[r.reason] ?? r.reason },
        { header: 'Count', span: 3, key: 'count', align: 'right' },
      ],
      [...reasonCounts.entries()].map(([reason, count]) => ({ reason, count })),
      'No exceptions found.',
    );

    const sorted = [...nonMatched].sort(
      (a, b) => Math.abs(Number(b.amountA ?? b.amountB ?? 0)) - Math.abs(Number(a.amountA ?? a.amountB ?? 0)),
    );
    row = writeSectionHeader(ws, row, 'Unmatched Details');
    row = writeNote(
      ws,
      row,
      nonMatched.length > MAX_DETAIL_ROWS
        ? `${nonMatched.length} non-matched rows, largest first — showing the first ${MAX_DETAIL_ROWS}`
        : `${nonMatched.length} non-matched rows, largest first`,
    );
    row = writeTable(
      ws,
      row,
      [
        { header: 'Reference', span: 6, key: 'ref' },
        { header: 'Status', span: 3, render: (r) => r.status.replace('_', ' ') },
        { header: 'Amount', span: 3, key: 'amount', align: 'right', numFmt: CURRENCY_FMT },
      ],
      sorted.slice(0, MAX_DETAIL_ROWS).map((r) => ({ ref: r.ref, status: r.status, amount: Number(r.amountA ?? r.amountB ?? 0) })),
      'No unmatched rows.',
    );
  }

  // Always shown, regardless of template/customize toggles — same as the
  // org header, not one of the optional sections.
  row = writeSectionHeader(ws, row, 'Sign-off');
  row = writeSignatureSection(ws, row, meta);

  mergeText(ws, row, 1, TOTAL_COLS, 'This report is confidential and intended solely for authorized use.', { size: 7, color: TEXT_LIGHT_GRAY });
  row += 1;
  mergeText(ws, row, 1, TOTAL_COLS, `Reconcil — Transaction Reconciliation Platform  ·  Report ID: ${reference}`, {
    size: 7,
    color: TEXT_LIGHT_GRAY,
  });

  return ws;
}

// Raw per-status data — full, uncapped detail (unlike the Overview sheet's
// MAX_DETAIL_ROWS-capped summary tables), styled as a real filterable table
// rather than a bare json_to_sheet dump: bold header band, alternating row
// shading, currency/date formats, frozen header row, autofilter.
function appendStatusSheet(wb, report, status) {
  const filtered = report.rows.filter((r) => r.status === status);
  const ws = wb.addWorksheet(STATUS_LABELS[status] ?? status, { views: [{ state: 'frozen', ySplit: 1 }] });

  const columns = [
    { header: 'Reference', key: 'ref', width: 30 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Date A', key: 'dateA', width: 14, numFmt: 'yyyy-mm-dd' },
    { header: 'Date B', key: 'dateB', width: 14, numFmt: 'yyyy-mm-dd' },
    { header: 'Amount A', key: 'amountA', width: 16, numFmt: CURRENCY_FMT },
    { header: 'Amount B', key: 'amountB', width: 16, numFmt: CURRENCY_FMT },
    { header: 'Amount Diff', key: 'amountDiff', width: 16, numFmt: CURRENCY_FMT },
    { header: 'Break Reason', key: 'breakReasonLabel', width: 22 },
    { header: 'Reviewed', key: 'reviewedLabel', width: 12 },
  ];
  ws.columns = columns.map(({ header, key, width }) => ({ header, key, width }));
  // `numFmt` in the columns array above is silently ignored by ExcelJS for
  // cells added later via addRow — it only takes effect set directly on the
  // column object, so each formatted column needs it applied here instead.
  columns.forEach((c, i) => {
    if (c.numFmt) ws.getColumn(i + 1).numFmt = c.numFmt;
  });

  const headerRow = ws.getRow(1);
  headerRow.height = 18;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, size: 10, color: { argb: WHITE } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_INDIGO } };
    cell.alignment = { vertical: 'middle' };
  });

  filtered.forEach((r, i) => {
    const excelRow = ws.addRow({
      ref: r.ref,
      status: STATUS_LABELS[r.status] ?? r.status,
      dateA: r.dateA ?? null,
      dateB: r.dateB ?? null,
      amountA: r.amountA != null ? Number(r.amountA) : null,
      amountB: r.amountB != null ? Number(r.amountB) : null,
      amountDiff: r.amountDiff != null ? Number(r.amountDiff) : null,
      breakReasonLabel: r.breakReason ? (BREAK_REASON_LABELS[r.breakReason] ?? r.breakReason) : '',
      reviewedLabel: r.reviewed ? 'Yes' : 'No',
    });
    if (i % 2 === 1) excelRow.eachCell((cell) => (cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TINT_GRAY } }));
  });

  ws.autoFilter = { from: 'A1', to: `${colLetter(columns.length)}1` };
  return ws;
}

/**
 * @param {object} report - a Report row with its `rows` included, plus `priorRun`
 * @param {{summary: boolean, matchStatistics: boolean, breakAnalysis: boolean, unmatchedDetails: boolean, chartsAndGraphs: boolean}} sections
 * @param {{generatedByName?: string, organizationName?: string, organizationLogo?: string, organizationType?: string, templateName?: string}} meta
 * @returns {Promise<Buffer>}
 */
export async function buildXlsxReport(report, sections, meta = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Reconcil';
  wb.created = new Date();

  await buildOverviewSheet(wb, report, sections, meta);

  // Full matched-row detail is always included — none of the 5 toggles is
  // about hiding the core result, they're additive extras on top of it.
  appendStatusSheet(wb, report, 'matched');

  if (sections.unmatchedDetails) {
    for (const status of NON_MATCHED_STATUSES) appendStatusSheet(wb, report, status);
  }

  return wb.xlsx.writeBuffer();
}
