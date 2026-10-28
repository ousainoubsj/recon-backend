// Shared section-content logic between utils/xlsxReport.js and
// utils/pdfReport.js, so the two formats never drift on what each section
// actually contains.

export const NON_MATCHED_STATUSES = ['mismatched', 'unmatched_a', 'unmatched_b', 'duplicate'];

// Keeps very large runs' Break Analysis / Unmatched Details tables (in both
// the PDF and the Excel Overview sheet) at a sane length — full detail still
// lives in the per-status raw sheets/pages either format also includes.
export const MAX_DETAIL_ROWS = 200;

export const BREAK_REASON_LABELS = {
  amount_mismatch: 'Amount Mismatch',
  missing_counterparty: 'Missing in Counterparty',
  missing_internal: 'Missing Internally',
  date_mismatch: 'Date Mismatch',
  duplicate: 'Duplicate',
  duplicated_in_other_file: 'Duplicated in Other File',
  other: 'Other',
};

// The reason key exports group and label by. An unmatched row tagged 'duplicate' is a real break whose partner
// is duplicated in the other file, so it must not be counted with the duplicate rows themselves.
export function exceptionReason(row) {
  const isUnmatched = row.status === 'unmatched_a' || row.status === 'unmatched_b';
  if (isUnmatched && row.breakReason === 'duplicate') return 'duplicated_in_other_file';
  return row.breakReason ?? 'other';
}

export function computeCategoryStats(report) {
  const total = report.totalRows || 0;
  const pct = (n) => (total > 0 ? Number(((n / total) * 100).toFixed(2)) : 0);
  return [
    { category: 'Matched', count: report.matchedCount, percent: pct(report.matchedCount) },
    { category: 'Mismatched', count: report.mismatchedCount, percent: pct(report.mismatchedCount) },
    { category: 'Unmatched', count: report.unmatchedCount, percent: pct(report.unmatchedCount) },
    { category: 'Duplicates', count: report.duplicateCount, percent: pct(report.duplicateCount) },
  ];
}

export function getBreakRows(report) {
  return report.rows.filter((r) => r.amountDiff != null && Number(r.amountDiff) !== 0);
}

export const RESOLUTION_LABELS = { matched: 'Matched manually', explained: 'Explained' };

// Shown beside the exception counts, never subtracted from them: resolving a row leaves its status as reconciled.
export function resolvedSummaryLine(nonMatchedRows) {
  const resolved = nonMatchedRows.filter((row) => row.resolution).length;
  return `Resolved manually: ${resolved} of ${nonMatchedRows.length} exception${nonMatchedRows.length === 1 ? '' : 's'}`;
}

export const CORRECTION_SIDE_LABELS = { A: 'Internal ledger', B: 'Counterparty' };
export const CORRECTION_FIELD_LABELS = { reference: 'Reference', amount: 'Amount', date: 'Date', currency: 'Currency' };

// A row is corrected when the run applied a correction at its position in either file.
export function correctedRowChecker(report) {
  const positions = new Set((report.corrections ?? []).map((c) => `${c.side}:${c.rowIndex}`));
  return (row) => positions.has(`A:${row.rowIndexA}`) || positions.has(`B:${row.rowIndexB}`);
}

export function correctedSummaryLine(report) {
  const isCorrected = correctedRowChecker(report);
  return `Rows corrected: ${report.rows.filter(isCorrected).length}`;
}

export function getNonMatchedRows(report) {
  return report.rows.filter((r) => r.status !== 'matched');
}
