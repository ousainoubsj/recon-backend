import { jest } from '@jest/globals';
import Papa from 'papaparse';
import { PassThrough } from 'node:stream';

const mockConnect = jest.fn();
const mockPoolQuery = jest.fn();
jest.unstable_mockModule('../../config/prisma.config.js', () => ({
  pgPool: { connect: mockConnect, query: mockPoolQuery },
}));

const mockCopyFrom = jest.fn((sql) => ({ __copyFromSql: sql }));
jest.unstable_mockModule('pg-copy-streams', () => ({ from: mockCopyFrom }));

const { reportRowToCsvRecord, reportRowsToCsv, copyReportRowsIn, deleteReportRows } = await import(
  '../../services/reportRowBulkInsert.js'
);

const REPORT_ID = 'report-1';

beforeEach(() => {
  jest.clearAllMocks();
});

function parseCsv(csv) {
  return Papa.parse(csv, { header: false }).data;
}

describe('reportRowToCsvRecord', () => {
  it('builds a full record for a matched row with no nulls', () => {
    const record = reportRowToCsvRecord(REPORT_ID, {
      ref: 'REF1',
      status: 'matched',
      amountA: 100,
      amountB: 100,
      dateA: '2026-06-30T00:00:00.000Z',
      dateB: '2026-06-30T00:00:00.000Z',
      rawA: { Ref: 'REF1' },
      rawB: { Ref: 'REF1' },
      breakReason: null,
    });

    expect(record[0]).toBe(REPORT_ID);
    expect(record[1]).toBe('REF1');
    expect(record[2]).toBe('matched');
    expect(record[3]).toBe(100);
    expect(record[4]).toBe(100);
    expect(record[5]).toBe(0); // amountDiff
    expect(record[6]).toBe('2026-06-30T00:00:00.000Z');
    expect(record[9]).toBe('{"Ref":"REF1"}');
    expect(record[10]).toBe('\\N'); // breakReason null
  });

  it('uses the NULL marker for every nullable field that is actually null', () => {
    const record = reportRowToCsvRecord(REPORT_ID, {
      ref: 'REF2',
      status: 'unmatched_a',
      amountA: 50,
      amountB: null,
      dateA: null,
      dateB: null,
      rawA: null,
      rawB: null,
      breakReason: 'missing_counterparty',
    });

    expect(record[4]).toBe('\\N'); // amountB
    expect(record[5]).toBe('\\N'); // amountDiff (can't compute without both amounts)
    expect(record[6]).toBe('\\N'); // dateA
    expect(record[7]).toBe('\\N'); // dateB
    expect(record[8]).toBe('\\N'); // rawA
    expect(record[9]).toBe('\\N'); // rawB
    expect(record[10]).toBe('missing_counterparty');
  });

  it('keeps a genuinely empty (but not null) ref as an empty string, not the NULL marker', () => {
    // A row with no reference at all (matchingEngine.js's incompleteEntries)
    // — ref is NOT NULL in the schema, so this must round-trip as '', never
    // be confused with SQL NULL the way an empty unquoted CSV field would be
    // under the default convention.
    const record = reportRowToCsvRecord(REPORT_ID, {
      ref: '',
      status: 'unmatched_a',
      amountA: 100,
      amountB: null,
    });

    expect(record[1]).toBe('');
    expect(record[1]).not.toBe('\\N');
  });
});

describe('reportRowsToCsv', () => {
  it('round-trips a rawA/rawB value containing a comma, a quote, and a newline', () => {
    const trickyValue = { Description: 'Wire transfer, ref "ABC" \n second line' };
    const csv = reportRowsToCsv(REPORT_ID, [
      { ref: 'REF1', status: 'matched', amountA: 1, amountB: 1, rawA: trickyValue, rawB: null },
    ]);

    const parsed = parseCsv(csv);
    expect(parsed).toHaveLength(1);
    const rawAField = parsed[0][8];
    expect(JSON.parse(rawAField)).toEqual(trickyValue);
  });

  it('produces one CSV row per input row', () => {
    const csv = reportRowsToCsv(REPORT_ID, [
      { ref: 'REF1', status: 'matched', amountA: 1, amountB: 1 },
      { ref: 'REF2', status: 'unmatched_a', amountA: 2, amountB: null },
    ]);

    expect(parseCsv(csv).filter((row) => row.length > 1)).toHaveLength(2);
  });
});

describe('copyReportRowsIn', () => {
  it('streams rows into report_rows via COPY, using the explicit NULL marker and FORMAT csv', async () => {
    const written = [];
    const fakeStream = new PassThrough();
    fakeStream.on('data', (chunk) => written.push(chunk.toString()));
    const fakeClient = { query: jest.fn(() => fakeStream), release: jest.fn() };
    mockConnect.mockResolvedValue(fakeClient);

    await copyReportRowsIn(REPORT_ID, [{ ref: 'REF1', status: 'matched', amountA: 1, amountB: 1 }]);

    expect(mockCopyFrom).toHaveBeenCalledWith(
      expect.stringMatching(/^COPY report_rows \(.*\) FROM STDIN WITH \(FORMAT csv, NULL '\\N'\)$/),
    );
    expect(fakeClient.query).toHaveBeenCalledWith({ __copyFromSql: expect.any(String) });
    expect(fakeClient.release).toHaveBeenCalled();
    expect(written.join('')).toContain('REF1');
  });

  it('is a no-op that never acquires a connection when there are no rows', async () => {
    await copyReportRowsIn(REPORT_ID, []);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('releases the client even if the stream write fails', async () => {
    const failingStream = new PassThrough();
    const fakeClient = { query: jest.fn(() => failingStream), release: jest.fn() };
    mockConnect.mockResolvedValue(fakeClient);
    // Cause the destination stream to error out once piping starts.
    process.nextTick(() => failingStream.destroy(new Error('connection reset')));

    await expect(
      copyReportRowsIn(REPORT_ID, [{ ref: 'REF1', status: 'matched', amountA: 1, amountB: 1 }]),
    ).rejects.toThrow('connection reset');
    expect(fakeClient.release).toHaveBeenCalled();
  });

  function manyRows(n) {
    return Array.from({ length: n }, (_, i) => ({
      ref: `REF${i}`,
      status: 'matched',
      amountA: i,
      amountB: i,
    }));
  }

  it('reports (rowsWritten, totalRows) once per chunk, in order, ending at the full count', async () => {
    const fakeStream = new PassThrough();
    fakeStream.resume(); // drain, don't care about the bytes for this test
    const fakeClient = { query: jest.fn(() => fakeStream), release: jest.fn() };
    mockConnect.mockResolvedValue(fakeClient);
    const calls = [];

    // 1200 rows against a 500-row chunk size -> chunks of 500, 500, 200.
    await copyReportRowsIn(REPORT_ID, manyRows(1200), { onProgress: (written, total) => calls.push([written, total]) });

    expect(calls).toEqual([
      [500, 1200],
      [1000, 1200],
      [1200, 1200],
    ]);
  });

  it('does not run rows together across a chunk boundary', async () => {
    const written = [];
    const fakeStream = new PassThrough();
    fakeStream.on('data', (chunk) => written.push(chunk.toString()));
    const fakeClient = { query: jest.fn(() => fakeStream), release: jest.fn() };
    mockConnect.mockResolvedValue(fakeClient);

    // 501 rows -> a 500-row chunk immediately followed by a 1-row chunk;
    // the boundary is exactly where a missing separator would run the last
    // field of chunk 1 into the first field of chunk 2.
    await copyReportRowsIn(REPORT_ID, manyRows(501));

    const rows = parseCsv(written.join('')).filter((row) => row.length > 1);
    expect(rows).toHaveLength(501);
    expect(rows[499][1]).toBe('REF499');
    expect(rows[500][1]).toBe('REF500');
  });
});

describe('deleteReportRows', () => {
  it('deletes all rows for the given reportId', async () => {
    await deleteReportRows(REPORT_ID);
    expect(mockPoolQuery).toHaveBeenCalledWith('DELETE FROM report_rows WHERE report_id = $1', [REPORT_ID]);
  });
});
