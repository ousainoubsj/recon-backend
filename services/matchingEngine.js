// Pure, side-effect-free reconciliation matching. No db/prisma/R2 imports on
// purpose — everything here is unit-testable in isolation; callers (routes/
// reportService) are responsible for parsing files into {headers, rows} and
// persisting the rows this module produces.
// Prisma.Decimal is only the decimal.js class: importing it opens no db connection.
import { Prisma } from '@prisma/client';

const DAY_MS = 24 * 60 * 60 * 1000;
const AMOUNT_SCALE = 4;

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
const DESCRIPTION_KEY_PATTERN = /desc|narrat|memo|detail|particular|note|comment|remark/i;

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
    // Unlike the other three (always safe to collapse), a prefix can carry
    // real meaning — e.g. which system/channel a transaction came from — so
    // this defaults off rather than assumed-safe, and has to be opted into
    // per run.
    ignoreNonNumericPrefix: config.ignoreNonNumericPrefix ?? false,
    // 'skip' was removed: it dropped every copy of a duplicated reference from the results without a
    // trace. Configs saved with it (runs, templates) now flag those rows instead.
    duplicateHandling: config.duplicateHandling === 'skip' ? 'flag-all' : (config.duplicateHandling ?? 'keep-first'),
  };
}

export function normalizeRef(ref, config = {}) {
  const {
    ignoreCase = true,
    ignoreSpaces = true,
    trimLeadingZeros = true,
    ignoreNonNumericPrefix = false,
  } = config;
  let r = String(ref ?? '');
  if (ignoreSpaces) r = r.replace(/\s+/g, '');
  // Strips a leading non-digit prefix (e.g. "TC82083380406" -> "82083380406")
  // so the same transaction with an inconsistent channel prefix on one side
  // still matches. Runs before trimLeadingZeros so zeros a prefix was
  // masking (e.g. "TC0082083380406") still get trimmed. Only strips when
  // digits actually follow, so a ref with no digits at all isn't collapsed
  // to ''.
  if (ignoreNonNumericPrefix) r = r.replace(/^\D+(?=\d)/, '');
  if (ignoreCase) r = r.toLowerCase();
  // Leading zeros only strip when followed by another digit, so a ref like
  // "TRX-0001258" (doesn't start with 0) is untouched, while "00042"->"42".
  if (trimLeadingZeros) r = r.replace(/^0+(?=\d)/, '');
  return r;
}

export function parseAmount(value) {
  if (value == null || value === '') return null;
  const str = String(value).trim();
  if (str === '') return null;

  // Accounting-style negatives. CR/DR suffix conventions ("100.00 CR") are
  // intentionally NOT handled — too locale/column-semantics-dependent to
  // infer safely from the string alone.
  const isParenNegative = str.includes('(') && str.includes(')');
  const isTrailingMinus = str.endsWith('-') && !str.startsWith('-');
  const forceNegative = isParenNegative || isTrailingMinus;

  let cleaned = str.replace(/[^0-9.\-]/g, '');
  if (forceNegative) cleaned = cleaned.replace(/-/g, '');
  // Whatever Number() used to reject ("1.2.3", "5-3") stays unparseable rather than reaching Decimal, which throws.
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;

  // Rounded to the amount columns' scale (Decimal(18, 4)), half away from zero like Postgres, so matching
  // compares the values that get stored rather than ones Postgres would round on insert.
  const amount = new Prisma.Decimal(cleaned).toDecimalPlaces(AMOUNT_SCALE, Prisma.Decimal.ROUND_HALF_UP);
  return forceNegative ? amount.abs().negated() : amount;
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

// A row whose reference, amount, and date all come back empty after parsing
// isn't a transaction — e.g. a mid-file "June 2026" section-divider row that
// isn't a title row caught by the top-of-file header-scan heuristic. Whatever
// text it has is sitting in some unmapped column, so it's dropped before it
// can ever be grouped or matched. "Unparseable" and "blank" intentionally
// collapse to the same outcome here (parseAmount/parseDate already return
// null for both) — that's desired, not an oversight.
function extractEntries(file, mapping) {
  return file.rows
    .map((raw) => ({
      ref: raw[mapping.referenceNumber],
      amount: parseAmount(raw[mapping.amount]),
      date: parseDate(raw[mapping.transactionDate]),
      currency: mapping.currency ? raw[mapping.currency] : null,
      raw,
    }))
    .filter((e) => !(String(e.ref ?? '').trim() === '' && e.amount === null && e.date === null));
}

// Groups a file's rows by normalized reference, then resolves any group with
// more than one entry per the duplicateHandling policy. Returns the single
// survivor entry per ref (only refs with exactly one entry, post-policy) plus
// the entries that get emitted as standalone 'duplicate' rows. Every entry
// ends up in exactly one of those, so nothing in the file can go unreported.
// `flaggedKeys` are refs left with no survivor (flag-all), so the other side
// can say its unmatched row's partner is duplicated rather than missing.
//
// Entries with no reference at all (real amount/date, but nothing to key on)
// are pulled out into incompleteEntries instead of joining the groups map
// under a shared '' key. Grouping them there would falsely flag unrelated
// no-ref rows as duplicates of each other, and — more seriously — would let
// a no-ref row in file A "match" an unrelated no-ref row in file B purely
// because both sides' survivor maps hold the same empty key. Each incomplete
// entry always resolves to missing_counterparty/missing_internal instead
// (matching by an empty ref is meaningless).
function resolveSide(file, mapping, config) {
  const entries = extractEntries(file, mapping);
  const groups = new Map();
  const incompleteEntries = [];
  for (const entry of entries) {
    const key = normalizeRef(entry.ref, config);
    if (key === '') {
      incompleteEntries.push(entry);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }

  const survivors = new Map();
  const duplicateEntries = [];
  const flaggedKeys = new Set();
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
      default:
        // flag-all, and the fallback for any unknown value: never drop a group silently.
        duplicateEntries.push(...group);
        flaggedKeys.add(key);
    }
  }
  return { survivors, duplicateEntries, incompleteEntries, flaggedKeys };
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

// `partnerDuplicated`: the other file has this ref, but more than once, so it was flagged rather than matched.
function makeUnmatchedRow(entry, side, partnerDuplicated = false) {
  const missingReason = side === 'A' ? 'missing_counterparty' : 'missing_internal';
  return {
    ref: entry.ref,
    status: side === 'A' ? 'unmatched_a' : 'unmatched_b',
    breakReason: partnerDuplicated ? 'duplicate' : missingReason,
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
    aEntry.amount != null && bEntry.amount != null ? aEntry.amount.minus(bEntry.amount) : null;

  // A blank mapped currency cell comes through as '' (not null), so a raw
  // != null check doesn't treat it as absent. Normalizing first means blank
  // and whitespace-only currencies fall out as falsy on either side, and get
  // skipped the same way an unmapped currency would — otherwise two blanks
  // trivially "match" and a blank vs. a real currency wrongly reads as a
  // mismatch.
  const aCurrency = normalizeCurrency(aEntry.currency);
  const bCurrency = normalizeCurrency(bEntry.currency);
  if (config.sameCurrencyOnly && aCurrency && bCurrency) {
    if (aCurrency !== bCurrency) {
      return { status: 'mismatched', breakReason: 'other', amountDiff };
    }
  }

  const amountOk = amountDiff != null && amountDiff.abs().lte(config.amountTolerance);

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
  // If either side has no transactionDate mapping, every entry's `date` is
  // always null (extractEntries/parseDate) — evaluateMatch's date check
  // requires both dates present whenever dateToleranceDays is non-null, so
  // leaving a stale/org-default tolerance in place here would silently fail
  // every row on "date_mismatch" rather than skipping the check as intended.
  // Forced here, not just left to the caller, so it holds regardless of
  // what the frontend sends or what org defaults get merged in upstream.
  if (!mappingA.transactionDate || !mappingB.transactionDate) {
    config.dateToleranceDays = null;
  }
  const sideA = resolveSide(fileA, mappingA, config);
  const sideB = resolveSide(fileB, mappingB, config);

  const rows = [];
  let matched = 0;
  let mismatched = 0;
  let totalBreakValue = new Prisma.Decimal(0);
  // A break with no parseable amount still counts as a break, it just adds nothing to the value.
  const addBreak = (amount) => {
    if (amount != null) totalBreakValue = totalBreakValue.plus(amount.abs());
  };

  for (const entry of sideA.duplicateEntries) rows.push(makeDuplicateRow(entry, 'A'));
  for (const entry of sideB.duplicateEntries) rows.push(makeDuplicateRow(entry, 'B'));
  const duplicates = sideA.duplicateEntries.length + sideB.duplicateEntries.length;

  let unmatchedA = 0;
  let unmatchedB = 0;
  // No-ref entries can't be matched against the other side by definition —
  // each surfaces as its own break rather than risking a false match via a
  // shared empty ref key (see resolveSide).
  for (const entry of sideA.incompleteEntries) {
    rows.push(makeUnmatchedRow(entry, 'A'));
    unmatchedA += 1;
    addBreak(entry.amount);
  }
  for (const entry of sideB.incompleteEntries) {
    rows.push(makeUnmatchedRow(entry, 'B'));
    unmatchedB += 1;
    addBreak(entry.amount);
  }

  const consumedB = new Set();
  for (const [ref, aEntry] of sideA.survivors) {
    const bEntry = sideB.survivors.get(ref);
    if (!bEntry) {
      rows.push(makeUnmatchedRow(aEntry, 'A', sideB.flaggedKeys.has(ref)));
      unmatchedA += 1;
      addBreak(aEntry.amount);
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
      addBreak(result.amountDiff);
    }
  }

  for (const [ref, bEntry] of sideB.survivors) {
    if (consumedB.has(ref)) continue;
    rows.push(makeUnmatchedRow(bEntry, 'B', sideA.flaggedKeys.has(ref)));
    unmatchedB += 1;
    addBreak(bEntry.amount);
  }

  const total = rows.length;
  const matchRate = total > 0 ? (matched / total) * 100 : 0;

  return {
    summary: { total, matched, mismatched, unmatchedA, unmatchedB, duplicates, matchRate, totalBreakValue },
    rows,
  };
}

// An unmatched row tagged 'duplicate': its reference exists in the other file, but more than once.
function isPartnerDuplicated(row) {
  return row.breakReason === 'duplicate' && (row.status === 'unmatched_a' || row.status === 'unmatched_b');
}

// Read-time only — never persisted, so it can't drift from the config it's
// meant to explain and never bloats storage across many rows.
export function buildMatchAnalysis(row, rawConfig = {}) {
  const config = withDefaults(rawConfig);
  const analysis = [];

  if (isPartnerDuplicated(row)) {
    analysis.push({ text: 'Reference found in the other file, but more than once, so it was not matched', passed: false });
    return analysis;
  }
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
    const passed = new Prisma.Decimal(row.amountDiff).abs().lte(config.amountTolerance);
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
  if (isPartnerDuplicated(row)) {
    return 'The other file lists this reference more than once. Confirm which of those entries this transaction corresponds to.';
  }
  switch (row.breakReason) {
    case 'amount_mismatch':
      return `Review amount in counterparty file. Possible missing fee/charge of ${
        row.amountDiff != null ? new Prisma.Decimal(row.amountDiff).abs().toFixed(2) : '0.00'
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
      return 'No action required. Just mark as reviewed.';
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
        row.amountDiff != null ? new Prisma.Decimal(row.amountDiff).abs().toFixed(2) : '0.00'
      }`;
      break;
    case 'date_mismatch':
      reason = 'Transaction dates do not align within tolerance';
      break;
    case 'duplicate':
      reason = isPartnerDuplicated(row) ? 'Reference is duplicated in the other file' : 'Duplicate reference';
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
