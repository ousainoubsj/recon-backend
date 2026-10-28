// Bulk-writes ReportRow records via Postgres COPY instead of parameterized
// INSERTs (createMany) -- the standard fast path for loading thousands of
// rows, and immune to the 65535-bound-parameter-per-query ceiling that
// batched createMany calls have to work around. Split out from
// reportService.js so the CSV-encoding logic (pure, easy to test
// thoroughly) is separate from the raw pg/stream plumbing (thin, mocked at
// the module boundary in reportService.test.js).
import { from as copyFrom } from 'pg-copy-streams';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import Papa from 'papaparse';
import { Prisma } from '@prisma/client';
import { pgPool } from '../config/prisma.config.js';

// Matches ReportRow's DB column names (prisma/schema.prisma's @map/@@map),
// not its Prisma field names -- COPY talks to Postgres directly, bypassing
// Prisma entirely. `id`/`reviewed`/`reviewedBy`/`reviewedAt` are omitted so
// their column defaults apply, same as an INSERT that doesn't mention them.
const REPORT_ROW_COPY_COLUMNS = [
  'report_id',
  'ref',
  'status',
  'amount_a',
  'amount_b',
  'amount_diff',
  'date_a',
  'date_b',
  'raw_a',
  'raw_b',
  'break_reason',
  'row_index_a',
  'row_index_b',
];

// CSV format's default NULL representation is an unquoted empty field --
// but `ref` is NOT NULL while also legitimately able to be an empty string
// (a row with an amount/date but no reference; see matchingEngine.js's
// incompleteEntries), so relying on that default would misread a genuinely
// empty ref as NULL and fail the NOT NULL constraint instead of inserting
// what it actually is. Using an explicit marker (Postgres's own default for
// TEXT-format COPY) for the nullable columns disambiguates the two cases.
const NULL_MARKER = '\\N';

// toFixed() never switches to exponent notation, which Decimal's toString does for very large or small values.
function amountForCopy(amount) {
  return amount == null ? NULL_MARKER : new Prisma.Decimal(amount).toFixed();
}

export function reportRowToCsvRecord(reportId, r) {
  const amountDiff = r.amountA != null && r.amountB != null ? new Prisma.Decimal(r.amountA).minus(r.amountB) : null;
  return [
    reportId,
    r.ref ?? '',
    r.status,
    amountForCopy(r.amountA),
    amountForCopy(r.amountB),
    amountForCopy(amountDiff),
    r.dateA ? new Date(r.dateA).toISOString() : NULL_MARKER,
    r.dateB ? new Date(r.dateB).toISOString() : NULL_MARKER,
    r.rawA != null ? JSON.stringify(r.rawA) : NULL_MARKER,
    r.rawB != null ? JSON.stringify(r.rawB) : NULL_MARKER,
    r.breakReason ?? NULL_MARKER,
    r.rowIndexA ?? NULL_MARKER,
    r.rowIndexB ?? NULL_MARKER,
  ];
}

// Papa.unparse's default quote/escape characters (both `"`) match Postgres
// CSV format's defaults exactly, and it only quotes a field when it actually
// contains the delimiter/quote/newline -- so a rawA/rawB JSON blob
// containing any of those (a free-text memo column is the realistic case)
// round-trips correctly with no custom escaping logic needed here.
export function reportRowsToCsv(reportId, rows) {
  return Papa.unparse(rows.map((r) => reportRowToCsvRecord(reportId, r)), { header: false, newline: '\n' });
}

// Fed into the COPY stream chunk by chunk rather than building one giant
// string up front -- keeps peak memory bounded for very large row counts,
// and gives onProgress a real, meaningful place to report from (rows
// actually handed to the stream), not just a fake tick.
const COPY_CHUNK_ROWS = 500;

async function* csvChunks(reportId, rows, onProgress) {
  for (let i = 0; i < rows.length; i += COPY_CHUNK_ROWS) {
    const chunk = rows.slice(i, i + COPY_CHUNK_ROWS);
    // A trailing '\n' after every chunk (including the last) -- Papa.unparse
    // joins rows with '\n' but doesn't add one after the final row, so
    // without this a chunk boundary would run the last field of one chunk
    // into the first field of the next. A trailing blank line at true EOF is
    // harmless to COPY's CSV format.
    yield `${reportRowsToCsv(reportId, chunk)}\n`;
    onProgress?.(Math.min(i + COPY_CHUNK_ROWS, rows.length), rows.length);
  }
}

/**
 * Streams `rows` into report_rows via COPY, on its own connection from the
 * shared pool -- independent of any Prisma transaction. See
 * persistCompletedRun in reportService.js for why that separation matters
 * (removes the Prisma interactive-transaction timeout ceiling from the bulk
 * write, on top of it just being faster than batched createMany).
 *
 * onProgress(rowsWritten, totalRows) fires as each chunk is handed to the
 * stream -- "handed to," not "confirmed flushed by Postgres," but pipeline's
 * backpressure means this can't run meaningfully ahead of what Postgres is
 * actually consuming.
 */
export async function copyReportRowsIn(reportId, rows, { onProgress } = {}) {
  if (rows.length === 0) return;
  const client = await pgPool.connect();
  try {
    const columnList = REPORT_ROW_COPY_COLUMNS.join(', ');
    const stream = client.query(
      copyFrom(`COPY report_rows (${columnList}) FROM STDIN WITH (FORMAT csv, NULL '${NULL_MARKER}')`),
    );
    await pipeline(Readable.from(csvChunks(reportId, rows, onProgress)), stream);
  } finally {
    client.release();
  }
}

// A no-op on a fresh run; clears any rows left over from a partially-
// completed prior attempt (e.g. a BullMQ retry after a crash mid-COPY) so a
// retry can't create duplicate/orphaned rows for the same report.
export async function deleteReportRows(reportId) {
  await pgPool.query('DELETE FROM report_rows WHERE report_id = $1', [reportId]);
}
