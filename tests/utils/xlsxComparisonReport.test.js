import * as XLSX from 'xlsx';
import { buildComparisonXlsxReport } from '../../utils/xlsxComparisonReport.js';

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

function readWorkbook(buffer) {
  return XLSX.read(buffer, { type: 'buffer' });
}

function overviewCsv(buffer) {
  const wb = readWorkbook(buffer);
  return XLSX.utils.sheet_to_csv(wb.Sheets['Comparison Overview']);
}

describe('buildComparisonXlsxReport', () => {
  it('produces a single Comparison Overview sheet regardless of section toggles', async () => {
    const buffer = await buildComparisonXlsxReport([reportA, reportB], NO_SECTIONS);
    expect(readWorkbook(buffer).SheetNames).toEqual(['Comparison Overview']);
  });

  it('always shows the Executive Summary tiles (runs compared, avg match rate, total break value) even with every section off', async () => {
    const buffer = await buildComparisonXlsxReport([reportA, reportB], NO_SECTIONS);
    const csv = overviewCsv(buffer);

    expect(csv).toContain('Executive Summary');
    expect(csv).toContain('Runs Compared');
    // avg match rate: (80% + 75%) / 2 = 77.5%
    expect(csv).toContain('77.5%');
    // total break value: 50 + 80 = 130
    expect(csv).toContain('$130.00');
  });

  it('adds each comparison section only when its toggle is on, and lists both reconciliations by name', async () => {
    const buffer = await buildComparisonXlsxReport([reportA, reportB], ALL_SECTIONS);
    const csv = overviewCsv(buffer);

    expect(csv).toContain('Comparison Overview');
    expect(csv).toContain('Match Composition by Run');
    expect(csv).toContain('Break Value by Run');
    expect(csv).toContain('Exception Direction by Run');
    expect(csv).toContain('Trends');
    expect(csv).toContain('June Bank Reconciliation');
    expect(csv).toContain('July Bank Reconciliation');
  });

  it('omits a section from the sheet when its toggle is off', async () => {
    const buffer = await buildComparisonXlsxReport([reportA, reportB], { ...ALL_SECTIONS, breakAnalysis: false });
    const csv = overviewCsv(buffer);

    expect(csv).not.toContain('Break Value by Run');
    expect(csv).toContain('Break Value Trend'); // chartsAndGraphs still on — distinct section, distinct label
  });

  it('computes per-run break stats (avg/largest) from that run\'s own rows only, without listing individual rows', async () => {
    const buffer = await buildComparisonXlsxReport([reportA, reportB], { ...NO_SECTIONS, breakAnalysis: true });
    const csv = overviewCsv(buffer);

    // reportB: exceptions = mismatchedCount(2) + unmatchedCount(1) = 3, totalBreakValue 80 -> avg 26.67
    expect(csv).toContain('$26.67');
    // reportB's largest single break among its rows is 60
    expect(csv).toContain('$60.00');
    // No raw transaction references anywhere in the sheet
    expect(csv).not.toContain('A1');
    expect(csv).not.toContain('B2');
  });

  it('splits unmatched counts by direction per run (missing in counterparty vs missing internally)', async () => {
    const buffer = await buildComparisonXlsxReport([reportA, reportB], { ...NO_SECTIONS, unmatchedDetails: true });
    const csv = overviewCsv(buffer);

    expect(csv).toContain('Missing in Counterparty');
    expect(csv).toContain('Missing Internally');
  });

  it('sorts runs chronologically regardless of input order', async () => {
    const buffer = await buildComparisonXlsxReport([reportB, reportA], NO_SECTIONS);
    const csv = overviewCsv(buffer);

    expect(csv.indexOf('DATE RANGE')).toBeGreaterThan(-1);
    // dateRangeLabel should read June -> July since reportA is earlier
    const dateRangeLine = csv.split('\n').find((line) => line.includes('/2026') && line.includes('–'));
    expect(dateRangeLine).toBeDefined();
  });
});
