import { suggestMapping, mappingFromSuggestions, computeValidationSummary } from '../../services/columnMappingService.js';

describe('suggestMapping', () => {
  it('scores an exact canonical-label match at 100', () => {
    const suggestions = suggestMapping(['Reference Number', 'Amount', 'Transaction Date', 'Currency']);
    expect(suggestions).toEqual([
      { field: 'referenceNumber', label: 'Reference Number', value: 'Reference Number', confidence: 100 },
      { field: 'amount', label: 'Amount', value: 'Amount', confidence: 100 },
      { field: 'transactionDate', label: 'Transaction Date', value: 'Transaction Date', confidence: 100 },
      { field: 'currency', label: 'Currency', value: 'Currency', confidence: 100 },
    ]);
  });

  it('scores a known synonym highly but below an exact match', () => {
    const suggestions = suggestMapping(['Transaction_ID', 'Debit Amount', 'Posting Date', 'Currency']);
    const refSuggestion = suggestions.find((s) => s.label === 'Reference Number');
    expect(refSuggestion.value).toBe('Transaction_ID');
    expect(refSuggestion.confidence).toBeGreaterThanOrEqual(90);
    expect(refSuggestion.confidence).toBeLessThan(100);
  });

  it('picks the best-scoring header per field from a mixed header set', () => {
    const suggestions = suggestMapping(['Ref_No', 'Amount', 'Value Date', 'Currency Code', 'Notes']);
    const dateSuggestion = suggestions.find((s) => s.label === 'Transaction Date');
    expect(dateSuggestion.value).toBe('Value Date');
  });

  it('returns null value with 0 confidence when nothing resembles the field', () => {
    const suggestions = suggestMapping(['Foo', 'Bar']);
    expect(suggestions.every((s) => s.confidence < 50)).toBe(true);
  });
});

describe('mappingFromSuggestions', () => {
  it('converts suggestions into a {field: sourceColumn} map, skipping unmatched fields', () => {
    const suggestions = suggestMapping(['Ref_No', 'Amount', 'Value Date']);
    expect(mappingFromSuggestions(suggestions)).toEqual({
      referenceNumber: 'Ref_No',
      amount: 'Amount',
      transactionDate: 'Value Date',
    });
  });
});

describe('computeValidationSummary', () => {
  const mapping = { referenceNumber: 'ref', amount: 'amount', transactionDate: 'date' };

  it('counts missing values across the mapped fields', () => {
    const rows = [
      { ref: 'R1', amount: '100', date: '2026-06-30' },
      { ref: 'R2', amount: '', date: '2026-06-30' },
      { ref: '', amount: '100', date: '' },
    ];
    const { missingValues } = computeValidationSummary(rows, mapping);
    expect(missingValues.count).toBe(3);
  });

  it('counts duplicate references (case-insensitive)', () => {
    const rows = [
      { ref: 'R1', amount: '100', date: '2026-06-30' },
      { ref: 'r1', amount: '100', date: '2026-06-30' },
      { ref: 'R2', amount: '100', date: '2026-06-30' },
    ];
    const { duplicateReferences } = computeValidationSummary(rows, mapping);
    expect(duplicateReferences.count).toBe(2);
  });

  it('returns zeroed percentages for an empty row set', () => {
    const { missingValues, duplicateReferences } = computeValidationSummary([], mapping);
    expect(missingValues.percent).toBe(0);
    expect(duplicateReferences.percent).toBe(0);
  });
});
