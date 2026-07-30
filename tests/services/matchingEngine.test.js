import {
  normalizeRef,
  parseAmount,
  parseDate,
  runMatch,
  buildMatchAnalysis,
  buildRecommendedAction,
  buildShortReason,
  deriveDescription,
  extrapolatePreview,
} from '../../services/matchingEngine.js';

const mapping = { referenceNumber: 'ref', amount: 'amount', transactionDate: 'date', currency: 'currency' };

function row(ref, amount, date, currency = 'USD') {
  return { ref, amount, date, currency };
}

describe('normalizeRef', () => {
  it('lowercases when ignoreCase is true', () => {
    expect(normalizeRef('TRX-001', { ignoreCase: true, ignoreSpaces: false, trimLeadingZeros: false })).toBe(
      'trx-001',
    );
  });

  it('strips whitespace when ignoreSpaces is true', () => {
    expect(normalizeRef(' TRX 001 ', { ignoreCase: false, ignoreSpaces: true, trimLeadingZeros: false })).toBe(
      'TRX001',
    );
  });

  it('trims leading zeros followed by a digit', () => {
    expect(normalizeRef('00042', { ignoreCase: false, ignoreSpaces: false, trimLeadingZeros: true })).toBe('42');
  });

  it('leaves refs that do not start with zero untouched by trimLeadingZeros', () => {
    expect(
      normalizeRef('TRX-0001258', { ignoreCase: false, ignoreSpaces: false, trimLeadingZeros: true }),
    ).toBe('TRX-0001258');
  });

  it('applies all three toggles together', () => {
    expect(normalizeRef(' TRX-0042 ', { ignoreCase: true, ignoreSpaces: true, trimLeadingZeros: true })).toBe(
      'trx-0042',
    );
  });

  it('defaults all toggles to true when omitted', () => {
    expect(normalizeRef(' 0042 ')).toBe('42');
  });
});

describe('parseAmount', () => {
  it('strips currency symbols and commas', () => {
    expect(parseAmount('$12,450.00')).toBe(12450);
  });

  it('handles negative values', () => {
    expect(parseAmount('-12.50')).toBe(-12.5);
  });

  it('returns null for empty/nullish input', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
  });

  it('returns null for unparseable input', () => {
    expect(parseAmount('N/A')).toBeNull();
  });
});

describe('parseDate', () => {
  it('parses ISO dates', () => {
    expect(parseDate('2026-06-30')?.getUTCFullYear()).toBe(2026);
  });

  it('disambiguates DD/MM/YYYY when the first component exceeds 12', () => {
    const d = parseDate('25/06/2026');
    expect(d.getUTCDate()).toBe(25);
    expect(d.getUTCMonth()).toBe(5);
  });

  it('disambiguates MM/DD/YYYY when the second component exceeds 12', () => {
    const d = parseDate('06/25/2026');
    expect(d.getUTCDate()).toBe(25);
    expect(d.getUTCMonth()).toBe(5);
  });

  it('defaults to DD/MM/YYYY when genuinely ambiguous', () => {
    const d = parseDate('03/04/2026');
    expect(d.getUTCDate()).toBe(3);
    expect(d.getUTCMonth()).toBe(3);
  });

  it('returns null for empty/nullish input', () => {
    expect(parseDate('')).toBeNull();
    expect(parseDate(null)).toBeNull();
  });
});

describe('runMatch — amount tolerance boundary', () => {
  const baseConfig = { amountTolerance: 0.5, dateToleranceDays: 1, duplicateHandling: 'keep-first' };

  it('matches when the difference exactly equals the tolerance', () => {
    const fileA = { rows: [row('R1', '100.00', '2026-06-30')] };
    const fileB = { rows: [row('R1', '100.50', '2026-06-30')] };
    const { rows, summary } = runMatch(fileA, fileB, mapping, mapping, baseConfig);
    expect(rows[0].status).toBe('matched');
    expect(summary.matched).toBe(1);
  });

  it('mismatches when the difference exceeds the tolerance', () => {
    const fileA = { rows: [row('R1', '100.00', '2026-06-30')] };
    const fileB = { rows: [row('R1', '100.51', '2026-06-30')] };
    const { rows, summary } = runMatch(fileA, fileB, mapping, mapping, baseConfig);
    expect(rows[0].status).toBe('mismatched');
    expect(rows[0].breakReason).toBe('amount_mismatch');
    expect(summary.mismatched).toBe(1);
  });
});

describe('runMatch — date tolerance boundary', () => {
  const baseConfig = { amountTolerance: 0, dateToleranceDays: 2, duplicateHandling: 'keep-first' };

  it('matches when exactly N days apart', () => {
    const fileA = { rows: [row('R1', '100', '2026-06-30')] };
    const fileB = { rows: [row('R1', '100', '2026-07-02')] };
    const { rows } = runMatch(fileA, fileB, mapping, mapping, baseConfig);
    expect(rows[0].status).toBe('matched');
  });

  it('mismatches when N+1 days apart', () => {
    const fileA = { rows: [row('R1', '100', '2026-06-30')] };
    const fileB = { rows: [row('R1', '100', '2026-07-03')] };
    const { rows } = runMatch(fileA, fileB, mapping, mapping, baseConfig);
    expect(rows[0].status).toBe('mismatched');
    expect(rows[0].breakReason).toBe('date_mismatch');
  });

  it('reports amount_mismatch over date_mismatch when both fail', () => {
    const fileA = { rows: [row('R1', '100', '2026-06-30')] };
    const fileB = { rows: [row('R1', '200', '2026-07-10')] };
    const { rows } = runMatch(fileA, fileB, mapping, mapping, { amountTolerance: 0, dateToleranceDays: 1 });
    expect(rows[0].breakReason).toBe('amount_mismatch');
  });
});

describe('runMatch — sameCurrencyOnly', () => {
  it('rejects a same-ref pair with differing currency when true', () => {
    const fileA = { rows: [row('R1', '100', '2026-06-30', 'USD')] };
    const fileB = { rows: [row('R1', '100', '2026-06-30', 'EUR')] };
    const { rows } = runMatch(fileA, fileB, mapping, mapping, { sameCurrencyOnly: true, amountTolerance: 0 });
    expect(rows[0].status).toBe('mismatched');
    expect(rows[0].breakReason).toBe('other');
  });

  it('allows a same-ref pair with differing currency to match normally when false', () => {
    const fileA = { rows: [row('R1', '100', '2026-06-30', 'USD')] };
    const fileB = { rows: [row('R1', '100', '2026-06-30', 'EUR')] };
    const { rows } = runMatch(fileA, fileB, mapping, mapping, { sameCurrencyOnly: false, amountTolerance: 0 });
    expect(rows[0].status).toBe('matched');
  });
});

describe('runMatch — duplicate handling policies', () => {
  const dupFileA = {
    rows: [row('R1', '100', '2026-06-30'), row('R1', '110', '2026-06-30'), row('R1', '120', '2026-06-30')],
  };
  const fileB = { rows: [] };

  it('keep-first keeps the first entry as survivor, rest as duplicates', () => {
    const { rows, summary } = runMatch(dupFileA, fileB, mapping, mapping, { duplicateHandling: 'keep-first' });
    expect(summary.duplicates).toBe(2);
    expect(summary.unmatchedA).toBe(1);
    const survivorRow = rows.find((r) => r.status === 'unmatched_a');
    expect(survivorRow.amountA).toBe(100);
  });

  it('keep-last keeps the last entry as survivor, rest as duplicates', () => {
    const { rows, summary } = runMatch(dupFileA, fileB, mapping, mapping, { duplicateHandling: 'keep-last' });
    expect(summary.duplicates).toBe(2);
    expect(summary.unmatchedA).toBe(1);
    const survivorRow = rows.find((r) => r.status === 'unmatched_a');
    expect(survivorRow.amountA).toBe(120);
  });

  it('flag-all treats every entry in the group as a duplicate, no survivor', () => {
    const { summary } = runMatch(dupFileA, fileB, mapping, mapping, { duplicateHandling: 'flag-all' });
    expect(summary.duplicates).toBe(3);
    expect(summary.unmatchedA).toBe(0);
  });

  it('skip drops the entire group — no duplicate rows, no survivor, reduces total', () => {
    const { rows, summary } = runMatch(dupFileA, fileB, mapping, mapping, { duplicateHandling: 'skip' });
    expect(summary.duplicates).toBe(0);
    expect(summary.unmatchedA).toBe(0);
    expect(rows.length).toBe(0);
  });
});

describe('runMatch — unmatched directionality', () => {
  it('marks A-only rows as unmatched_a/missing_counterparty', () => {
    const fileA = { rows: [row('R1', '100', '2026-06-30')] };
    const fileB = { rows: [] };
    const { rows } = runMatch(fileA, fileB, mapping, mapping, {});
    expect(rows[0].status).toBe('unmatched_a');
    expect(rows[0].breakReason).toBe('missing_counterparty');
  });

  it('marks B-only rows as unmatched_b/missing_internal', () => {
    const fileA = { rows: [] };
    const fileB = { rows: [row('R1', '100', '2026-06-30')] };
    const { rows } = runMatch(fileA, fileB, mapping, mapping, {});
    expect(rows[0].status).toBe('unmatched_b');
    expect(rows[0].breakReason).toBe('missing_internal');
  });
});

describe('buildMatchAnalysis', () => {
  it('returns a single fail entry for unmatched_a', () => {
    const analysis = buildMatchAnalysis({ status: 'unmatched_a' }, {});
    expect(analysis).toHaveLength(1);
    expect(analysis[0].passed).toBe(false);
  });

  it('returns a single fail entry for unmatched_b', () => {
    const analysis = buildMatchAnalysis({ status: 'unmatched_b' }, {});
    expect(analysis[0].passed).toBe(false);
  });

  it('returns a single fail entry for duplicate', () => {
    const analysis = buildMatchAnalysis({ status: 'duplicate' }, {});
    expect(analysis[0].passed).toBe(false);
  });

  it('reports amount and date pass/fail for a matched row', () => {
    const analysis = buildMatchAnalysis(
      {
        status: 'matched',
        amountDiff: 0,
        dateA: new Date('2026-06-30'),
        dateB: new Date('2026-06-30'),
      },
      { amountTolerance: 0.5, dateToleranceDays: 1 },
    );
    expect(analysis.find((a) => a.text.includes('Reference')).passed).toBe(true);
    expect(analysis.find((a) => a.text.includes('Amount')).passed).toBe(true);
    expect(analysis.find((a) => a.text.includes('Date')).passed).toBe(true);
  });

  it('flags a currency mismatch when breakReason is other', () => {
    const analysis = buildMatchAnalysis({ status: 'mismatched', breakReason: 'other' }, {});
    expect(analysis.some((a) => a.text.includes('Currency') && a.passed === false)).toBe(true);
  });
});

describe('buildRecommendedAction', () => {
  it.each([
    ['amount_mismatch'],
    ['missing_counterparty'],
    ['missing_internal'],
    ['date_mismatch'],
    ['duplicate'],
    ['other'],
    [undefined],
  ])('returns a non-empty string for breakReason=%s', (breakReason) => {
    expect(buildRecommendedAction({ breakReason }).length).toBeGreaterThan(0);
  });
});

describe('buildShortReason', () => {
  it.each([
    ['amount_mismatch', 'Amount Mismatch'],
    ['missing_counterparty', 'Missing in Counterparty'],
    ['missing_internal', 'Missing in Internal'],
    ['date_mismatch', 'Date Mismatch'],
    ['duplicate', 'Duplicate'],
  ])('maps breakReason=%s to type=%s', (breakReason, expectedType) => {
    const { type, reason } = buildShortReason({ breakReason });
    expect(type).toBe(expectedType);
    expect(reason.length).toBeGreaterThan(0);
  });
});

describe('deriveDescription', () => {
  it('picks a description-like column from rawA', () => {
    const desc = deriveDescription({ rawA: { Ref: 'R1', Narration: 'Payment to ABC Supplies' }, rawB: null });
    expect(desc).toBe('Payment to ABC Supplies');
  });

  it('falls back to rawB when rawA has no description-like column', () => {
    const desc = deriveDescription({ rawA: { Ref: 'R1' }, rawB: { Memo: 'Refund' } });
    expect(desc).toBe('Refund');
  });

  it.each(['Notes', 'Comment', 'Remarks'])('recognizes %s as a description-like column', (header) => {
    const desc = deriveDescription({ rawA: { Ref: 'R1', [header]: 'Wire transfer' }, rawB: null });
    expect(desc).toBe('Wire transfer');
  });

  it('returns an empty string when neither side has one', () => {
    expect(deriveDescription({ rawA: { Ref: 'R1' }, rawB: { Amount: '100' } })).toBe('');
  });
});

describe('extrapolatePreview', () => {
  it('scales proportionally from sample to full file size', () => {
    const sampleSummary = { matched: 10, mismatched: 2, duplicates: 1, unmatchedA: 1, unmatchedB: 1 };
    const result = extrapolatePreview(sampleSummary, 15, 150, 15, 150);
    expect(result.estimatedMatches).toBe(100);
    expect(result.possibleMismatches).toBe(20);
    expect(result.potentialDuplicates).toBe(10);
    expect(result.missingReferences).toBe(20);
  });

  it('does not divide by zero when sample size is 0', () => {
    const sampleSummary = { matched: 0, mismatched: 0, duplicates: 0, unmatchedA: 0, unmatchedB: 0 };
    const result = extrapolatePreview(sampleSummary, 0, 100, 0, 100);
    expect(result.estimatedMatches).toBe(0);
  });
});
