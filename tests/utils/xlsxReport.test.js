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
  name: 'June Bank Reconciliation',
  sequenceYear: 2026,
  sequenceNumber: 1,
  fileAName: 'a.csv',
  fileBName: 'b.csv',
  runDate: new Date('2026-01-01T00:00:00Z'),
  totalRows: 4,
  matchedCount: 1,
  mismatchedCount: 1,
  unmatchedCount: 1,
  duplicateCount: 1,
  totalBreakValue: 25,
  priorRun: null,
  rows: [
    { ref: 'REF1', status: 'matched', amountA: 100, amountB: 100, amountDiff: 0 },
    { ref: 'REF2', status: 'mismatched', amountA: 100, amountB: 90, amountDiff: 10, breakReason: 'amount_mismatch' },
    { ref: 'REF3', status: 'unmatched_a', amountA: 50, amountB: null, amountDiff: null, breakReason: 'missing_counterparty' },
    { ref: 'REF4', status: 'duplicate', amountA: 15, amountB: 15, amountDiff: 0, breakReason: 'duplicate' },
  ],
};

function readWorkbook(buffer) {
  return XLSX.read(buffer, { type: 'buffer' });
}

function overviewCsv(buffer) {
  const wb = readWorkbook(buffer);
  return XLSX.utils.sheet_to_csv(wb.Sheets['Report Overview']);
}

describe('buildXlsxReport', () => {
  it('always includes a Report Overview sheet and the raw Matched sheet, even with every section off', async () => {
    const buffer = await buildXlsxReport(report, NO_SECTIONS);

    expect(readWorkbook(buffer).SheetNames).toEqual(['Report Overview', 'Matched']);
  });

  it('adds the raw per-status sheets and every section to the Overview sheet when unmatchedDetails/sections are on', async () => {
    const buffer = await buildXlsxReport(report, ALL_SECTIONS);
    const names = readWorkbook(buffer).SheetNames;

    expect(names).toEqual(['Report Overview', 'Matched', 'Mismatched', 'Unmatched (A)', 'Unmatched (B)', 'Duplicates']);

    const csv = overviewCsv(buffer);
    expect(csv).toContain('Executive Summary');
    expect(csv).toContain('Reconciliation Overview');
    expect(csv).toContain('Summary');
    expect(csv).toContain('Reconciliation Analytics');
    expect(csv).toContain('Match Statistics');
    expect(csv).toContain('Break Analysis');
    expect(csv).toContain('Exception Summary');
    expect(csv).toContain('Unmatched Details');
  });

  it('omits the per-status raw sheets when unmatchedDetails is off', async () => {
    const buffer = await buildXlsxReport(report, { ...ALL_SECTIONS, unmatchedDetails: false });

    expect(readWorkbook(buffer).SheetNames).toEqual(['Report Overview', 'Matched']);
  });

  it('omits a section from the Overview sheet when its toggle is off', async () => {
    const buffer = await buildXlsxReport(report, { ...ALL_SECTIONS, summary: false });

    const csv = overviewCsv(buffer);
    expect(csv).not.toContain('Summary\n');
  });

  it('formats currency values and computes break/unmatched detail correctly', async () => {
    const buffer = await buildXlsxReport(report, ALL_SECTIONS);
    const csv = overviewCsv(buffer);

    expect(csv).toContain('$10.00'); // REF2's amountDiff
    expect(csv).toContain('$25.00'); // total break value
  });

  it('includes the org/template branding meta in the Overview sheet header', async () => {
    const buffer = await buildXlsxReport(report, NO_SECTIONS, {
      generatedByName: 'Jane Doe',
      organizationName: 'Acme Corp',
      organizationType: 'Financial Services',
      templateName: 'Reconciliation Summary',
    });
    const csv = overviewCsv(buffer);

    expect(csv).toContain('Acme Corp');
    expect(csv).toContain('Financial Services');
    expect(csv).toContain('Reconciliation Summary');
    expect(csv).toContain('Jane Doe');
    expect(csv).toContain('Reconcil');
  });

  it('writes the raw Matched sheet with clean, human-readable columns (not a raw Prisma row dump)', async () => {
    const buffer = await buildXlsxReport(report, NO_SECTIONS);
    const wb = readWorkbook(buffer);
    const csv = XLSX.utils.sheet_to_csv(wb.Sheets['Matched']);

    expect(csv.split('\n')[0]).toBe('Reference,Status,Date A,Date B,Amount A,Amount B,Amount Diff,Break Reason,Reviewed');
    expect(csv).toContain('REF1,Matched');
  });
});
