import * as XLSX from 'xlsx';
import { buildXlsxReport } from '../../utils/xlsxReport.js';

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

function sheetNames(buffer) {
  return XLSX.read(buffer, { type: 'buffer' }).SheetNames;
}

describe('buildXlsxReport', () => {
  it('always includes the matched sheet, even with every section off', () => {
    const buffer = buildXlsxReport(report, NO_SECTIONS);

    expect(sheetNames(buffer)).toEqual(['matched']);
  });

  it('adds one sheet per enabled section, plus a data sheet in place of a real chart', () => {
    const buffer = buildXlsxReport(report, ALL_SECTIONS);
    const names = sheetNames(buffer);

    expect(names).toEqual(
      expect.arrayContaining([
        'matched',
        'Summary',
        'Match Statistics',
        'Break Analysis',
        'mismatched',
        'unmatched_a',
        'unmatched_b',
        'duplicate',
        'Chart Data',
      ]),
    );
  });

  it('omits a section sheet when its toggle is off', () => {
    const buffer = buildXlsxReport(report, { ...ALL_SECTIONS, summary: false });

    expect(sheetNames(buffer)).not.toContain('Summary');
  });
});
