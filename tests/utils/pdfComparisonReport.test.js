import { Prisma } from '@prisma/client';
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
  rowStats: { largestBreak: new Prisma.Decimal(30), unmatchedACount: 1, unmatchedBCount: 0, duplicateRowCount: 0 },
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
  rowStats: { largestBreak: new Prisma.Decimal(60), unmatchedACount: 0, unmatchedBCount: 1, duplicateRowCount: 0 },
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
