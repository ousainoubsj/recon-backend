import { BREAK_REASON_LABELS, correctedRowChecker, correctedSummaryLine, exceptionReason, resolvedSummaryLine } from '../../utils/reportSections.js';

describe('exceptionReason', () => {
  it('separates an unmatched row with a duplicated partner from duplicate rows themselves', () => {
    expect(exceptionReason({ status: 'unmatched_b', breakReason: 'duplicate' })).toBe('duplicated_in_other_file');
    expect(exceptionReason({ status: 'duplicate', breakReason: 'duplicate' })).toBe('duplicate');
    expect(BREAK_REASON_LABELS.duplicated_in_other_file).toBe('Duplicated in Other File');
  });

  it('passes every other reason through, defaulting a missing one to other', () => {
    expect(exceptionReason({ status: 'unmatched_a', breakReason: 'missing_counterparty' })).toBe('missing_counterparty');
    expect(exceptionReason({ status: 'mismatched', breakReason: null })).toBe('other');
  });
});

describe('resolvedSummaryLine', () => {
  it('counts rows carrying a resolution against all exceptions', () => {
    const rows = [{ resolution: { kind: 'matched' } }, { resolution: null }, {}];
    expect(resolvedSummaryLine(rows)).toBe('Resolved manually: 1 of 3 exceptions');
  });

  it('uses the singular for a single exception', () => {
    expect(resolvedSummaryLine([{}])).toBe('Resolved manually: 0 of 1 exception');
  });
});

describe('correctedRowChecker / correctedSummaryLine', () => {
  const report = {
    corrections: [{ side: 'B', rowIndex: 7 }, { side: 'B', rowIndex: 7 }, { side: 'A', rowIndex: 2 }],
    rows: [
      { rowIndexA: 0, rowIndexB: 7 },
      { rowIndexA: 2, rowIndexB: null },
      // A matched index on the wrong side is a different source row.
      { rowIndexA: 7, rowIndexB: 2 },
      { rowIndexA: null, rowIndexB: null },
    ],
  };

  it('counts each corrected row once, matching positions per side', () => {
    const isCorrected = correctedRowChecker(report);
    expect(report.rows.map(isCorrected)).toEqual([true, true, false, false]);
    expect(correctedSummaryLine(report)).toBe('Rows corrected: 2');
  });

  it('reads "Rows corrected: 0" for a report with no corrections', () => {
    expect(correctedSummaryLine({ rows: report.rows })).toBe('Rows corrected: 0');
  });
});
