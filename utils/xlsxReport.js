import * as XLSX from 'xlsx';
import { NON_MATCHED_STATUSES, computeCategoryStats, getBreakRows } from './reportSections.js';

function appendStatusSheet(wb, report, status) {
  const filtered = report.rows.filter((r) => r.status === status);
  const ws = XLSX.utils.json_to_sheet(filtered);
  XLSX.utils.book_append_sheet(wb, ws, status);
}

/**
 * @param {object} report - a Report row with its `rows` included
 * @param {{summary: boolean, matchStatistics: boolean, breakAnalysis: boolean, unmatchedDetails: boolean, chartsAndGraphs: boolean}} sections
 * @returns {Buffer}
 */
export function buildXlsxReport(report, sections) {
  const wb = XLSX.utils.book_new();

  // Full matched-row detail is always included — none of the 5 toggles is
  // about hiding the core result, they're additive extras on top of it.
  appendStatusSheet(wb, report, 'matched');

  if (sections.summary) {
    const summaryRows = [
      {
        'File A': report.fileAName,
        'File B': report.fileBName,
        'Run Date': report.runDate,
        'Total Rows': report.totalRows,
        Matched: report.matchedCount,
        Mismatched: report.mismatchedCount,
        Unmatched: report.unmatchedCount,
        Duplicates: report.duplicateCount,
        'Total Break Value': Number(report.totalBreakValue),
      },
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Summary');
  }

  if (sections.matchStatistics) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(computeCategoryStats(report)), 'Match Statistics');
  }

  if (sections.breakAnalysis) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(getBreakRows(report)), 'Break Analysis');
  }

  if (sections.unmatchedDetails) {
    for (const status of NON_MATCHED_STATUSES) appendStatusSheet(wb, report, status);
  }

  if (sections.chartsAndGraphs) {
    // The SheetJS community edition (already in use elsewhere in this repo)
    // can't write native Excel charts — a plain data sheet instead, so this
    // toggle isn't a silent no-op for XLSX exports.
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(computeCategoryStats(report)), 'Chart Data');
  }

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
