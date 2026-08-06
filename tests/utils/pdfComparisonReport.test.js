import { buildComparisonPdfReport } from '../../utils/pdfComparisonReport.js';

const ALL_SECTIONS = {
  summary: true,
  matchStatistics: true,
  breakAnalysis: true,
  unmatchedDetails: true,
  chartsAndGraphs: true,
};

const NO_SECTIONS = {
  summary: false,
  matchStatistics: false,
  breakAnalysis: false,
  unmatchedDetails: false,
  chartsAndGraphs: false,
};

const reportA = {
  id: 'r1',
  name: 'June Bank Reconciliation',
  runDate: new Date('2026-06-01T00:00:00Z'),
  totalRows: 10,
  matchedCount: 8,
  mismatchedCount: 1,
  unmatchedCount: 1,
  duplicateCount: 0,
  totalBreakValue: 50,
  rows: [
    { ref: 'A1', status: 'unmatched_a', amountA: 50, amountB: null, amountDiff: null },
    { ref: 'A2', status: 'mismatched', amountA: 100, amountB: 70, amountDiff: 30 },
  ],
};

const reportB = {
  id: 'r2',
  name: 'July Bank Reconciliation',
  runDate: new Date('2026-07-01T00:00:00Z'),
  totalRows: 12,
  matchedCount: 9,
  mismatchedCount: 2,
  unmatchedCount: 1,
  duplicateCount: 0,
  totalBreakValue: 80,
  rows: [
    { ref: 'B1', status: 'unmatched_b', amountA: null, amountB: 20, amountDiff: null },
    { ref: 'B2', status: 'mismatched', amountA: 100, amountB: 40, amountDiff: 60 },
    { ref: 'B3', status: 'mismatched', amountA: 100, amountB: 80, amountDiff: 20 },
  ],
};

describe('buildComparisonPdfReport', () => {
  it('returns a real PDF buffer with just 2 reconciliations and no sections on', async () => {
    const buffer = await buildComparisonPdfReport([reportA, reportB], NO_SECTIONS, { generatedByName: 'Jane Doe', organizationName: 'Acme Corp' });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('produces a larger document as more sections are enabled', async () => {
    const minimal = await buildComparisonPdfReport([reportA, reportB], NO_SECTIONS);
    const full = await buildComparisonPdfReport([reportA, reportB], ALL_SECTIONS);

    expect(full.length).toBeGreaterThan(minimal.length);
  });

  it('does not crash with 3+ reconciliations', async () => {
    const reportC = { ...reportB, id: 'r3', name: 'August Bank Reconciliation', runDate: new Date('2026-08-01T00:00:00Z') };
    const buffer = await buildComparisonPdfReport([reportA, reportB, reportC], ALL_SECTIONS);

    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
  });
});
