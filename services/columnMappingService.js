// Heuristic column-mapping suggestions + per-file validation counts for the
// mapping-preview step. Deterministic (exact match / synonym list /
// Levenshtein fallback), not a trained model — sufficient for the mock's
// cosmetic confidence badges, not an ML accuracy claim.

const CANONICAL_FIELDS = {
  referenceNumber: {
    label: 'Reference Number',
    synonyms: ['ref no', 'ref_no', 'reference', 'transaction id', 'transaction_id', 'txn ref', 'reference no', 'ref'],
  },
  amount: {
    label: 'Amount',
    synonyms: ['debit amount', 'credit amount', 'net amount', 'txn amount', 'value'],
  },
  transactionDate: {
    label: 'Transaction Date',
    synonyms: ['posting date', 'value date', 'txn date', 'date'],
  },
  currency: {
    label: 'Currency',
    synonyms: ['currency code', 'ccy'],
  },
};

function normalizeHeader(header) {
  return String(header).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

function scoreHeaderForField(header, fieldKey) {
  const field = CANONICAL_FIELDS[fieldKey];
  const norm = normalizeHeader(header);
  const canonicalNorm = normalizeHeader(field.label);
  if (norm === canonicalNorm) return 100;
  if (field.synonyms.some((s) => normalizeHeader(s) === norm)) return 96;
  const best = Math.max(
    similarity(norm, canonicalNorm),
    ...field.synonyms.map((s) => similarity(norm, normalizeHeader(s))),
  );
  return Math.round(best * 85);
}

// Below this, the Levenshtein fallback is just noise — e.g. a totally
// unrelated header can still score a few points against any field purely by
// sharing a couple of characters. Anything under this bar means "no
// confident suggestion," not "a weak one."
const MIN_CONFIDENCE = 40;

// Returns the single best-scoring header per canonical field — null value
// when nothing clears MIN_CONFIDENCE (the frontend still lets the user pick
// manually in that case). `field` is the canonical key used elsewhere
// (mappingFromSuggestions, the fileColumnMappingSchema shape); it's extra
// alongside the mock's own {label,value,confidence} shape.
export function suggestMapping(headers) {
  return Object.entries(CANONICAL_FIELDS).map(([fieldKey, field]) => {
    let best = { value: null, confidence: 0 };
    for (const header of headers) {
      const confidence = scoreHeaderForField(header, fieldKey);
      if (confidence > best.confidence) best = { value: header, confidence };
    }
    if (best.confidence < MIN_CONFIDENCE) best = { value: null, confidence: 0 };
    return { field: fieldKey, label: field.label, value: best.value, confidence: best.confidence };
  });
}

// Converts suggestMapping's output into the {referenceNumber, amount,
// transactionDate, currency?} shape used everywhere else (fileColumnMappingSchema,
// computeValidationSummary, the matching engine). Skips fields with no
// confident match rather than mapping to null.
export function mappingFromSuggestions(suggestions) {
  const mapping = {};
  for (const suggestion of suggestions) {
    if (suggestion.value) mapping[suggestion.field] = suggestion.value;
  }
  return mapping;
}

// mapping here is a single file's {referenceNumber, amount, transactionDate,
// currency?} — the source column name chosen for each canonical field.
export function computeValidationSummary(rows, mapping) {
  const fields = ['referenceNumber', 'amount', 'transactionDate', 'currency'].filter((f) => mapping[f]);
  let missingCount = 0;
  const refCounts = new Map();

  for (const row of rows) {
    for (const field of fields) {
      const value = row[mapping[field]];
      if (value == null || String(value).trim() === '') missingCount += 1;
    }
    const ref = row[mapping.referenceNumber];
    if (ref != null && String(ref).trim() !== '') {
      const key = String(ref).trim().toLowerCase();
      refCounts.set(key, (refCounts.get(key) ?? 0) + 1);
    }
  }

  const duplicateReferences = [...refCounts.values()]
    .filter((count) => count > 1)
    .reduce((sum, count) => sum + count, 0);
  const totalChecks = rows.length * fields.length;

  return {
    missingValues: {
      count: missingCount,
      percent: totalChecks > 0 ? Number(((missingCount / totalChecks) * 100).toFixed(2)) : 0,
    },
    duplicateReferences: {
      count: duplicateReferences,
      percent: rows.length > 0 ? Number(((duplicateReferences / rows.length) * 100).toFixed(2)) : 0,
    },
  };
}
