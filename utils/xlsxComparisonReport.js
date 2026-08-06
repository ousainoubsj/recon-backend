import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import ExcelJS from 'exceljs';
import { computeCategoryStats } from './reportSections.js';

// Deliberately self-contained rather than importing from xlsxReport.js — a
// comparison report's shape (a list of reports, no merged rows, no
// per-status sheets) is different enough from a single report that bending
// the existing renderer to fit caused real scope creep the first time this
// was attempted. Keeps its own small copies of the handful of generic
// primitives it needs, same convention pdfReport.js already uses for its own
// local deltaPercent/CATEGORY_COLORS/formatCurrency (kept dependency-free
// from xlsxReport.js on purpose).
const LOGO_SYM_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '../assets/logo-sym.png');
const RECONCIL_LOGO_BUFFER = fs.readFileSync(LOGO_SYM_PATH);

const TOTAL_COLS = 12;

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
const WHITE = 'FFFFFFFF';
const LOGO_FALLBACK_GRAY = 'FF9CA3AF';

const CURRENCY_FMT = '"$"#,##0.00';

const currencyFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
function formatCurrency(value) {
  return currencyFormatter.format(Number(value));
}

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
    console.error('Failed to fetch organization logo for comparison xlsx export', err);
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
      labelCell.value = tile.label;
      labelCell.font = { size: 8, color: { argb: TEXT_GRAY } };
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

// Simple block-bar visualization, one row per reconciliation — same
// lightweight stand-in ExcelJS's free tier already uses for category charts
// (no native chart API), just keyed by run instead of category.
function writeTrendBars(ws, startRow, label, runs, valueOf, formatValue) {
  let row = startRow;
  const maxValue = Math.max(1, ...runs.map(valueOf));

  mergeText(ws, row, 1, TOTAL_COLS, label, { bold: true, size: 9, color: TEXT_DARK });
  row += 1;

  runs.forEach((run) => {
    const value = valueOf(run);
    ws.mergeCells(row, 1, row, 4);
    const nameCell = ws.getCell(row, 1);
    nameCell.value = run.name;
    nameCell.font = { size: 8.5, color: { argb: TEXT_DARK } };

    ws.mergeCells(row, 5, row, 9);
    const barCell = ws.getCell(row, 5);
    const blocks = Math.max(1, Math.round((value / maxValue) * 30));
    barCell.value = '█'.repeat(blocks);
    barCell.font = { name: 'Consolas', size: 9, color: { argb: BRAND_INDIGO } };

    ws.mergeCells(row, 10, row, 12);
    const valueCell = ws.getCell(row, 10);
    valueCell.value = formatValue(value);
    valueCell.font = { size: 8.5, color: { argb: TEXT_DARK } };
    valueCell.alignment = { horizontal: 'right' };

    ws.getRow(row).height = 14;
    row += 1;
  });

  return row + 1;
}

// Per-run derived stats — the handful of comparison numbers that need a
// scan over that report's own rows (largest break, which side an unmatched
// row is missing from). Not exposing the rows themselves anywhere in the
// output, only these aggregate scalars, per the stats-only decision.
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

/**
 * @param {object[]} reports - completed Report rows (with `rows` included), any order
 * @param {{summary: boolean, matchStatistics: boolean, breakAnalysis: boolean, unmatchedDetails: boolean, chartsAndGraphs: boolean}} sections
 * @param {{generatedByName?: string, organizationName?: string, organizationLogo?: string, organizationType?: string}} meta
 * @returns {Promise<Buffer>}
 */
export async function buildComparisonXlsxReport(reports, sections, meta = {}) {
  const sorted = [...reports].sort((a, b) => new Date(a.runDate) - new Date(b.runDate));
  const runs = sorted.map(deriveRunStats);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Reconcil';
  wb.created = new Date();

  const ws = wb.addWorksheet('Comparison Overview', { views: [{ showGridLines: false }] });
  ws.columns = Array.from({ length: TOTAL_COLS }, () => ({ width: 8 }));
  ws.pageSetup = { fitToPage: true, fitToWidth: 1, fitToHeight: 0, orientation: 'portrait' };

  let row = 1;

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
  mergeText(ws, row, 2, TOTAL_COLS, meta.organizationName ?? 'Your Organization', { bold: true, size: 14, color: TEXT_DARK, valign: 'bottom' });
  row += 1;
  if (meta.organizationType) mergeText(ws, row, 2, TOTAL_COLS, meta.organizationType, { size: 9, color: TEXT_GRAY, valign: 'top' });
  row += 2;

  const reconLogoId = wb.addImage({ buffer: RECONCIL_LOGO_BUFFER, extension: 'png' });
  ws.addImage(reconLogoId, { tl: { col: 0, row: row - 1 }, ext: { width: 24, height: 24 } });
  ws.getRow(row).height = 20;
  mergeText(ws, row, 2, TOTAL_COLS, 'Reconcil', { bold: true, size: 14, color: BRAND_TEAL, valign: 'bottom' });
  row += 1;
  mergeText(ws, row, 2, TOTAL_COLS, 'TRANSACTION RECONCILIATION', { size: 7, color: TEXT_LIGHT_GRAY, valign: 'top' });
  row += 2;

  mergeText(ws, row, 1, TOTAL_COLS, 'Combined Report', { bold: true, size: 15, color: TEXT_DARK });
  row += 1;
  mergeText(ws, row, 1, TOTAL_COLS, `Comparing ${runs.length} reconciliations`, { size: 9, color: TEXT_GRAY });
  row += 2;

  const dateRangeLabel =
    runs.length > 0
      ? `${new Date(runs[0].runDate).toLocaleDateString()} – ${new Date(runs[runs.length - 1].runDate).toLocaleDateString()}`
      : '—';
  const metaItems = [
    ['GENERATED ON', new Date().toLocaleString()],
    ['DATE RANGE', dateRangeLabel],
    ['RUNS COMPARED', String(runs.length)],
    ['PREPARED BY', meta.generatedByName ?? '—'],
  ];
  metaItems.forEach(([label], i) => mergeText(ws, row, i * 3 + 1, i * 3 + 3, label, { bold: true, size: 6.5, color: BRAND_INDIGO }));
  row += 1;
  metaItems.forEach(([, value], i) => mergeText(ws, row, i * 3 + 1, i * 3 + 3, value, { size: 9, color: TEXT_DARK }));
  row += 1;

  for (let c = 1; c <= TOTAL_COLS; c++) ws.getCell(row, c).border = { bottom: { style: 'thin', color: { argb: BORDER } } };
  row += 2;

  const avgMatchRate = runs.length > 0 ? runs.reduce((sum, r) => sum + r.matchPercent, 0) / runs.length : 0;
  const totalBreakValue = runs.reduce((sum, r) => sum + r.breakValue, 0);

  row = writeSectionHeader(ws, row, 'Executive Summary');
  row = writeStatTiles(
    ws,
    row,
    [
      { value: String(runs.length), label: 'Runs Compared' },
      { value: `${avgMatchRate.toFixed(1)}%`, label: 'Average Match Rate' },
      { value: formatCurrency(totalBreakValue), label: 'Total Break Value' },
      { value: dateRangeLabel, label: 'Date Range' },
    ],
    4,
  );

  if (sections.summary) {
    row = writeSectionHeader(ws, row, 'Comparison Overview');
    row = writeTable(
      ws,
      row,
      [
        { header: 'Reconciliation', span: 3, key: 'name' },
        { header: 'Run Date', span: 2, render: (r) => new Date(r.runDate).toLocaleDateString() },
        { header: 'Total Rows', span: 1, key: 'totalRows', align: 'right' },
        { header: 'Matched', span: 1, key: 'matchedCount', align: 'right' },
        { header: 'Mismatched', span: 1, key: 'mismatchedCount', align: 'right' },
        { header: 'Unmatched', span: 1, key: 'unmatchedCount', align: 'right' },
        { header: 'Match Rate', span: 1, render: (r) => `${r.matchPercent.toFixed(1)}%`, align: 'right' },
        { header: 'Break Value', span: 2, render: (r) => formatCurrency(r.breakValue), align: 'right' },
      ],
      runs,
      'No reconciliations to compare.',
    );
  }

  if (sections.matchStatistics) {
    row = writeSectionHeader(ws, row, 'Match Composition by Run');
    row = writeTable(
      ws,
      row,
      [
        { header: '', span: 1, swatch: (r) => CATEGORY_COLORS[r.category] ?? LOGO_FALLBACK_GRAY },
        { header: 'Reconciliation', span: 4, key: 'name' },
        { header: 'Category', span: 3, key: 'category' },
        { header: 'Count', span: 2, key: 'count', align: 'right' },
        { header: 'Percent', span: 2, align: 'right', render: (r) => `${r.percent}%` },
      ],
      runs.flatMap((run) => run.categoryStats.map((stat) => ({ ...stat, name: run.name }))),
      'No category breakdown available.',
    );
  }

  if (sections.breakAnalysis) {
    row = writeSectionHeader(ws, row, 'Break Value by Run');
    row = writeTable(
      ws,
      row,
      [
        { header: 'Reconciliation', span: 4, key: 'name' },
        { header: 'Total Break Value', span: 3, render: (r) => formatCurrency(r.breakValue), align: 'right', numFmt: CURRENCY_FMT },
        { header: 'Avg Break Size', span: 3, render: (r) => formatCurrency(r.avgBreakSize), align: 'right', numFmt: CURRENCY_FMT },
        { header: 'Largest Break', span: 2, render: (r) => formatCurrency(r.largestBreak), align: 'right', numFmt: CURRENCY_FMT },
      ],
      runs,
      'No break data available.',
    );
  }

  if (sections.unmatchedDetails) {
    row = writeSectionHeader(ws, row, 'Exception Direction by Run');
    row = writeTable(
      ws,
      row,
      [
        { header: 'Reconciliation', span: 4, key: 'name' },
        { header: 'Missing in Counterparty', span: 3, key: 'unmatchedACount', align: 'right' },
        { header: 'Missing Internally', span: 3, key: 'unmatchedBCount', align: 'right' },
        { header: 'Duplicates', span: 2, key: 'duplicateRowCount', align: 'right' },
      ],
      runs,
      'No exception data available.',
    );
  }

  if (sections.chartsAndGraphs) {
    row = writeSectionHeader(ws, row, 'Trends');
    row = writeTrendBars(ws, row, 'Match Rate Trend', runs, (r) => r.matchPercent, (v) => `${v.toFixed(1)}%`);
    row = writeTrendBars(ws, row, 'Break Value Trend', runs, (r) => r.breakValue, formatCurrency);
  }

  row = writeSectionHeader(ws, row, 'Sign-off');
  const nameRow = row;
  const labelRow = row + 1;
  mergeText(ws, nameRow, 1, 4, meta.generatedByName ?? '', { size: 10, color: TEXT_DARK, valign: 'bottom' });
  ws.getCell(nameRow, 1).border = { bottom: { style: 'thin', color: { argb: TEXT_DARK } } };
  mergeText(ws, labelRow, 1, 4, 'PREPARED BY', { bold: true, size: 7, color: BRAND_INDIGO });
  row = labelRow + 2;

  mergeText(ws, row, 1, TOTAL_COLS, 'This report is confidential and intended solely for authorized use.', { size: 7, color: TEXT_LIGHT_GRAY });
  row += 1;
  mergeText(ws, row, 1, TOTAL_COLS, `Reconcil — Transaction Reconciliation Platform  ·  Combined Report (${runs.length} runs)`, {
    size: 7,
    color: TEXT_LIGHT_GRAY,
  });

  return wb.xlsx.writeBuffer();
}
