import { buildPdfReport } from '../../utils/pdfReport.js';

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

const report = {
  id: 'r1',
  name: 'June Bank Reconciliation',
  fileAName: 'a.csv',
  fileBName: 'b.csv',
  runDate: new Date('2026-01-01T00:00:00Z'),
  totalRows: 4,
  matchedCount: 1,
  mismatchedCount: 1,
  unmatchedCount: 1,
  duplicateCount: 1,
  totalBreakValue: 25,
  rows: [
    { ref: 'REF1', status: 'matched', amountA: 100, amountB: 100, amountDiff: 0 },
    { ref: 'REF2', status: 'mismatched', amountA: 100, amountB: 90, amountDiff: 10 },
    { ref: 'REF3', status: 'unmatched_a', amountA: 50, amountB: null, amountDiff: null },
    { ref: 'REF4', status: 'duplicate', amountA: 15, amountB: 15, amountDiff: 0 },
  ],
};

describe('buildPdfReport', () => {
  it('returns a real PDF buffer', async () => {
    const buffer = await buildPdfReport(report, NO_SECTIONS);

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(buffer.length).toBeGreaterThan(0);
  });

  it('produces a larger document as more sections are enabled', async () => {
    const minimal = await buildPdfReport(report, NO_SECTIONS);
    const full = await buildPdfReport(report, ALL_SECTIONS);

    expect(full.length).toBeGreaterThan(minimal.length);
  });
});
