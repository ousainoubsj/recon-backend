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
  other: 'Other',
};

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

export function getNonMatchedRows(report) {
  return report.rows.filter((r) => r.status !== 'matched');
}
