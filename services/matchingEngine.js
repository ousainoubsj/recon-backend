// Pure, side-effect-free reconciliation matching. No db/prisma/R2 imports on
// purpose — everything here is unit-testable in isolation; callers (routes/
// reportService) are responsible for parsing files into {headers, rows} and
// persisting the rows this module produces.

const DAY_MS = 24 * 60 * 60 * 1000;

const BREAK_REASON_TYPE_LABELS = {
  amount_mismatch: 'Amount Mismatch',
  missing_counterparty: 'Missing in Counterparty',
  missing_internal: 'Missing in Internal',
  date_mismatch: 'Date Mismatch',
  duplicate: 'Duplicate',
  other: 'Other',
};

// No canonical "description" field exists in fileColumnMappingSchema (only
// the 4 required canonical fields are mapped) — this is a best-effort
// heuristic over whatever original columns survived into rawA/rawB, not a
// user-configured mapping.
const DESCRIPTION_KEY_PATTERN = /desc|narrat|memo|detail|particular/i;

export function deriveDescription(row) {
  for (const raw of [row.rawA, row.rawB]) {
    if (!raw) continue;
    const key = Object.keys(raw).find((k) => DESCRIPTION_KEY_PATTERN.test(k));
    if (key && raw[key]) return String(raw[key]);
  }
  return '';
}

function withDefaults(config = {}) {
  return {
    amountTolerance: config.amountTolerance ?? 0,
    dateToleranceDays: config.dateToleranceDays ?? null,
    sameCurrencyOnly: config.sameCurrencyOnly ?? true,
    ignoreCase: config.ignoreCase ?? true,
    ignoreSpaces: config.ignoreSpaces ?? true,
    trimLeadingZeros: config.trimLeadingZeros ?? true,
    duplicateHandling: config.duplicateHandling ?? 'keep-first',
  };
}

export function normalizeRef(ref, config = {}) {
  const { ignoreCase = true, ignoreSpaces = true, trimLeadingZeros = true } = config;
  let r = String(ref ?? '');
  if (ignoreSpaces) r = r.replace(/\s+/g, '');
  if (ignoreCase) r = r.toLowerCase();
  // Leading zeros only strip when followed by another digit, so a ref like
  // "TRX-0001258" (doesn't start with 0) is untouched, while "00042"->"42".
  if (trimLeadingZeros) r = r.replace(/^0+(?=\d)/, '');
  return r;
}

export function parseAmount(value) {
  if (value == null || value === '') return null;
  const cleaned = String(value).replace(/[^0-9.\-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const num = Number(cleaned);
  return Number.isNaN(num) ? null : num;
}

// ISO first; else DD/MM/YYYY vs MM/DD/YYYY disambiguated by whichever
// component is >12; a genuinely ambiguous date (both <=12) defaults to
// DD/MM/YYYY. No per-file date-format picker exists in the mock to resolve
// this properly — documented caveat, not a bug.
export function parseDate(value) {
  if (value == null || value === '') return null;
  const str = String(value).trim();

  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    const d = new Date(str);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const m = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (m) {
    let [, first, second, year] = m.map(Number);
    if (year < 100) year += 2000;
    const day = first > 12 ? first : second > 12 ? second : first;
    const month = first > 12 ? second : second > 12 ? first : second;
    const d = new Date(Date.UTC(year, month - 1, day));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const fallback = new Date(str);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

function normalizeCurrency(value) {
  return value == null ? null : String(value).trim().toUpperCase();
}

function extractEntries(file, mapping) {
  return file.rows.map((raw) => ({
    ref: raw[mapping.referenceNumber],
    amount: parseAmount(raw[mapping.amount]),
    date: parseDate(raw[mapping.transactionDate]),
    currency: mapping.currency ? raw[mapping.currency] : null,
    raw,
  }));
}

// Groups a file's rows by normalized reference, then resolves any group with
// more than one entry per the duplicateHandling policy. Returns the single
// survivor entry per ref (only refs with exactly one entry, post-policy) plus
// the entries that get emitted as standalone 'duplicate' rows. 'skip' drops
// its group's entries entirely — not a survivor, not a duplicate row.
function resolveSide(file, mapping, config) {
  const entries = extractEntries(file, mapping);
  const groups = new Map();
  for (const entry of entries) {
    const key = normalizeRef(entry.ref, config);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const survivors = new Map();
  const duplicateEntries = [];
  for (const [key, group] of groups) {
    if (group.length === 1) {
      survivors.set(key, group[0]);
      continue;
    }
    switch (config.duplicateHandling) {
      case 'keep-first':
        survivors.set(key, group[0]);
        duplicateEntries.push(...group.slice(1));
        break;
      case 'keep-last':
        survivors.set(key, group[group.length - 1]);
        duplicateEntries.push(...group.slice(0, -1));
        break;
      case 'flag-all':
        duplicateEntries.push(...group);
        break;
      case 'skip':
      default:
        break;
    }
  }
  return { survivors, duplicateEntries };
}

function makeDuplicateRow(entry, side) {
  return {
    ref: entry.ref,
    status: 'duplicate',
    breakReason: 'duplicate',
    amountA: side === 'A' ? entry.amount : null,
    amountB: side === 'B' ? entry.amount : null,
    amountDiff: null,
    dateA: side === 'A' ? entry.date : null,
    dateB: side === 'B' ? entry.date : null,
    rawA: side === 'A' ? entry.raw : null,
    rawB: side === 'B' ? entry.raw : null,
  };
}

function makeUnmatchedRow(entry, side) {
  return {
    ref: entry.ref,
    status: side === 'A' ? 'unmatched_a' : 'unmatched_b',
    breakReason: side === 'A' ? 'missing_counterparty' : 'missing_internal',
    amountA: side === 'A' ? entry.amount : null,
    amountB: side === 'B' ? entry.amount : null,
    amountDiff: null,
    dateA: side === 'A' ? entry.date : null,
    dateB: side === 'B' ? entry.date : null,
    rawA: side === 'A' ? entry.raw : null,
    rawB: side === 'B' ? entry.raw : null,
  };
}

// Amount is checked before date, so when both fail, breakReason always
// reports 'amount_mismatch' (matches the plan's documented priority).
function evaluateMatch(aEntry, bEntry, config) {
  const amountDiff =
    aEntry.amount != null && bEntry.amount != null ? aEntry.amount - bEntry.amount : null;

  if (config.sameCurrencyOnly && aEntry.currency != null && bEntry.currency != null) {
    if (normalizeCurrency(aEntry.currency) !== normalizeCurrency(bEntry.currency)) {
      return { status: 'mismatched', breakReason: 'other', amountDiff };
    }
  }

  const amountOk = amountDiff != null && Math.abs(amountDiff) <= config.amountTolerance;

  let dateOk = true;
  if (config.dateToleranceDays != null) {
    if (aEntry.date && bEntry.date) {
      const diffDays = Math.abs(aEntry.date.getTime() - bEntry.date.getTime()) / DAY_MS;
      dateOk = diffDays <= config.dateToleranceDays;
    } else {
      dateOk = false;
    }
  }

  if (amountOk && dateOk) return { status: 'matched', breakReason: null, amountDiff };
  return { status: 'mismatched', breakReason: amountOk ? 'date_mismatch' : 'amount_mismatch', amountDiff };
}

/**
 * @param {{headers: string[], rows: Record<string,string>[]}} fileA
 * @param {{headers: string[], rows: Record<string,string>[]}} fileB
 * @param {{referenceNumber: string, amount: string, transactionDate: string, currency?: string}} mappingA
 * @param {{referenceNumber: string, amount: string, transactionDate: string, currency?: string}} mappingB
 * @param {object} rawConfig MatchRuleConfig (partial — defaults are applied)
 */
export function runMatch(fileA, fileB, mappingA, mappingB, rawConfig) {
  const config = withDefaults(rawConfig);
  const sideA = resolveSide(fileA, mappingA, config);
  const sideB = resolveSide(fileB, mappingB, config);

  const rows = [];
  let matched = 0;
  let mismatched = 0;
  let totalBreakValue = 0;

  for (const entry of sideA.duplicateEntries) rows.push(makeDuplicateRow(entry, 'A'));
  for (const entry of sideB.duplicateEntries) rows.push(makeDuplicateRow(entry, 'B'));
  const duplicates = sideA.duplicateEntries.length + sideB.duplicateEntries.length;

  const consumedB = new Set();
  let unmatchedA = 0;
  for (const [ref, aEntry] of sideA.survivors) {
    const bEntry = sideB.survivors.get(ref);
    if (!bEntry) {
      rows.push(makeUnmatchedRow(aEntry, 'A'));
      unmatchedA += 1;
      totalBreakValue += Math.abs(aEntry.amount ?? 0);
      continue;
    }
    consumedB.add(ref);
    const result = evaluateMatch(aEntry, bEntry, config);
    rows.push({
      ref: aEntry.ref,
      status: result.status,
      breakReason: result.breakReason,
      amountA: aEntry.amount,
      amountB: bEntry.amount,
      amountDiff: result.amountDiff,
      dateA: aEntry.date,
      dateB: bEntry.date,
      rawA: aEntry.raw,
      rawB: bEntry.raw,
    });
    if (result.status === 'matched') {
      matched += 1;
    } else {
      mismatched += 1;
      totalBreakValue += Math.abs(result.amountDiff ?? 0);
    }
  }

  let unmatchedB = 0;
  for (const [ref, bEntry] of sideB.survivors) {
    if (consumedB.has(ref)) continue;
    rows.push(makeUnmatchedRow(bEntry, 'B'));
    unmatchedB += 1;
    totalBreakValue += Math.abs(bEntry.amount ?? 0);
  }

  const total = rows.length;
  const matchRate = total > 0 ? (matched / total) * 100 : 0;

  return {
    summary: { total, matched, mismatched, unmatchedA, unmatchedB, duplicates, matchRate, totalBreakValue },
    rows,
  };
}

// Read-time only — never persisted, so it can't drift from the config it's
// meant to explain and never bloats storage across many rows.
export function buildMatchAnalysis(row, rawConfig = {}) {
  const config = withDefaults(rawConfig);
  const analysis = [];

  if (row.status === 'unmatched_a') {
    analysis.push({ text: 'No matching reference found in the counterparty file', passed: false });
    return analysis;
  }
  if (row.status === 'unmatched_b') {
    analysis.push({ text: 'No matching reference found in the internal ledger', passed: false });
    return analysis;
  }
  if (row.status === 'duplicate') {
    analysis.push({ text: 'Duplicate reference detected within the same file', passed: false });
    return analysis;
  }

  analysis.push({ text: 'Reference matched exactly', passed: true });

  if (row.amountDiff != null) {
    const passed = Math.abs(Number(row.amountDiff)) <= config.amountTolerance;
    analysis.push({
      text: passed
        ? `Amount matches within tolerance (±${config.amountTolerance})`
        : `Amount difference exceeds tolerance (±${config.amountTolerance})`,
      passed,
    });
  }

  if (row.dateA && row.dateB) {
    const diffDays = Math.round(
      Math.abs(new Date(row.dateA).getTime() - new Date(row.dateB).getTime()) / DAY_MS,
    );
    const tolerance = config.dateToleranceDays ?? 0;
    const passed = config.dateToleranceDays == null || diffDays <= tolerance;
    analysis.push({
      text: passed
        ? `Date is within tolerance (${tolerance} day${tolerance === 1 ? '' : 's'})`
        : `Date difference exceeds tolerance (${tolerance} day${tolerance === 1 ? '' : 's'})`,
      passed,
    });
  }

  if (row.breakReason === 'other') {
    analysis.push({ text: 'Currency mismatch between files', passed: false });
  }

  return analysis;
}

export function buildRecommendedAction(row) {
  switch (row.breakReason) {
    case 'amount_mismatch':
      return `Review amount in counterparty file. Possible missing fee/charge of ${
        row.amountDiff != null ? Math.abs(Number(row.amountDiff)).toFixed(2) : '0.00'
      }.`;
    case 'missing_counterparty':
      return 'Confirm whether this transaction was recorded in the counterparty file under a different reference.';
    case 'missing_internal':
      return 'Confirm whether this transaction was recorded in the internal ledger under a different reference.';
    case 'date_mismatch':
      return 'Verify posting date vs value date — likely a timing difference rather than a break.';
    case 'duplicate':
      return 'Review duplicate entries and confirm which (if any) should be retained.';
    case 'other':
      return 'Currency mismatch detected — confirm the correct currency before treating this as a break.';
    default:
      return 'No action required.';
  }
}

// One-liner for list views (Results' unmatched-preview table's type/reason).
export function buildShortReason(row) {
  const type = BREAK_REASON_TYPE_LABELS[row.breakReason] ?? 'Other';
  let reason;
  switch (row.breakReason) {
    case 'missing_counterparty':
      reason = 'Not found in counterparty file';
      break;
    case 'missing_internal':
      reason = 'Not found in internal ledger';
      break;
    case 'amount_mismatch':
      reason = `Amount differs by ${
        row.amountDiff != null ? Math.abs(Number(row.amountDiff)).toFixed(2) : '0.00'
      }`;
      break;
    case 'date_mismatch':
      reason = 'Transaction dates do not align within tolerance';
      break;
    case 'duplicate':
      reason = 'Duplicate reference';
      break;
    default:
      reason = 'Currency mismatch between files';
  }
  return { type, reason };
}

// Proportional scaling from a bounded sample to the full file sizes, for the
// live rule-preview panel. Uniform scaling, not a statistically rigorous
// estimator — the mock itself labels this panel "Estimated."
export function extrapolatePreview(sampleSummary, sampleSizeA, totalRowsA, sampleSizeB, totalRowsB) {
  const scaleA = sampleSizeA > 0 ? totalRowsA / sampleSizeA : 1;
  const scaleB = sampleSizeB > 0 ? totalRowsB / sampleSizeB : 1;
  const scale = (scaleA + scaleB) / 2;
  return {
    estimatedMatches: Math.round(sampleSummary.matched * scale),
    possibleMismatches: Math.round(sampleSummary.mismatched * scale),
    potentialDuplicates: Math.round(sampleSummary.duplicates * scale),
    missingReferences: Math.round((sampleSummary.unmatchedA + sampleSummary.unmatchedB) * scale),
  };
}
