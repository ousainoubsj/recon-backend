import * as XLSX from 'xlsx';
import { parseTabularFile } from '../../utils/fileParser.js';

describe('parseTabularFile — CSV', () => {
  const csv = 'Ref_No,Amount,Value Date\nR1,100.00,2026-06-30\nR2,200.50,2026-07-01\n';

  it('extracts headers and rows as string-keyed maps', () => {
    const { headers, rows } = parseTabularFile(Buffer.from(csv), 'statement.csv');
    expect(headers).toEqual(['Ref_No', 'Amount', 'Value Date']);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ Ref_No: 'R1', Amount: '100.00', 'Value Date': '2026-06-30' });
  });

  it('preserves values as strings (rawA/rawB fidelity)', () => {
    const { rows } = parseTabularFile(Buffer.from(csv), 'statement.csv');
    expect(typeof rows[0].Amount).toBe('string');
  });
});

describe('parseTabularFile — XLSX', () => {
  function buildXlsxBuffer() {
    const worksheet = XLSX.utils.json_to_sheet([
      { Transaction_ID: 'R1', 'Debit Amount': '100.00', 'Posting Date': '2026-06-30' },
      { Transaction_ID: 'R2', 'Debit Amount': '200.50', 'Posting Date': '2026-07-01' },
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  }

  it('extracts headers and rows from the first worksheet', () => {
    const { headers, rows } = parseTabularFile(buildXlsxBuffer(), 'ledger.xlsx');
    expect(headers).toEqual(['Transaction_ID', 'Debit Amount', 'Posting Date']);
    expect(rows).toHaveLength(2);
    expect(rows[1].Transaction_ID).toBe('R2');
  });

  it('also accepts the legacy .xls extension', () => {
    const { rows } = parseTabularFile(buildXlsxBuffer(), 'ledger.xls');
    expect(rows).toHaveLength(2);
  });
});

describe('parseTabularFile — unsupported extension', () => {
  it('throws for an unrecognized extension', () => {
    expect(() => parseTabularFile(Buffer.from('x'), 'file.txt')).toThrow(/Unsupported file extension/);
  });
});

describe('parseTabularFile — title rows', () => {
  it('skips a CSV title row above the real headers', () => {
    const csv = 'Monthly Bank Statement - August 2026\n\nRef_No,Amount,Value Date\nR1,100.00,2026-06-30\nR2,200.50,2026-07-01\n';
    const { headers, rows } = parseTabularFile(Buffer.from(csv), 'statement.csv');
    expect(headers).toEqual(['Ref_No', 'Amount', 'Value Date']);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ Ref_No: 'R1', Amount: '100.00', 'Value Date': '2026-06-30' });
  });

  it('skips an XLSX title row above the real headers', () => {
    const aoa = [
      ['Monthly Bank Statement - August 2026'],
      ['Transaction_ID', 'Debit Amount', 'Posting Date'],
      ['R1', '100.00', '2026-06-30'],
      ['R2', '200.50', '2026-07-01'],
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(aoa);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    const { headers, rows } = parseTabularFile(buffer, 'ledger.xlsx');
    expect(headers).toEqual(['Transaction_ID', 'Debit Amount', 'Posting Date']);
    expect(rows).toHaveLength(2);
    expect(rows[0].Transaction_ID).toBe('R1');
  });
});

describe('parseTabularFile — blank rows', () => {
  it('drops a CSV row whose cells are present but empty', () => {
    const csv = 'Ref_No,Amount,Value Date\nR1,100.00,2026-06-30\n,,\nR2,200.50,2026-07-01\n';
    const { rows } = parseTabularFile(Buffer.from(csv), 'statement.csv');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.Ref_No)).toEqual(['R1', 'R2']);
  });

  it('drops trailing blank rows in a CSV file', () => {
    const csv = 'Ref_No,Amount,Value Date\nR1,100.00,2026-06-30\n,,\n,,\n';
    const { rows } = parseTabularFile(Buffer.from(csv), 'statement.csv');
    expect(rows).toHaveLength(1);
  });

  it('drops an XLSX row whose cells are present but empty', () => {
    const aoa = [
      ['Ref_No', 'Amount', 'Value Date'],
      ['R1', '100.00', '2026-06-30'],
      ['', '', ''],
      ['R2', '200.50', '2026-07-01'],
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(aoa);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    const { rows } = parseTabularFile(buffer, 'ledger.xlsx');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.Ref_No)).toEqual(['R1', 'R2']);
  });

  it('drops trailing blank rows in an XLSX file', () => {
    const aoa = [
      ['Ref_No', 'Amount', 'Value Date'],
      ['R1', '100.00', '2026-06-30'],
      ['', '', ''],
      [],
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(aoa);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    const { rows } = parseTabularFile(buffer, 'ledger.xlsx');
    expect(rows).toHaveLength(1);
  });
});

describe('parseTabularFile — duplicate/blank headers', () => {
  it('gives blank CSV headers positional placeholders instead of colliding on an empty key', () => {
    // 3 of 5 header cells populated, clearing the header-row-detection fill
    // threshold (>50%) — a 2-of-4 header would be mistaken for a data row.
    const csv = 'Ref,,Amount,,Date\nR1,extra1,100.00,extra2,2026-06-30\n';
    const { headers, rows } = parseTabularFile(Buffer.from(csv), 'statement.csv');
    expect(headers).toEqual(['Ref', 'Column 2', 'Amount', 'Column 4', 'Date']);
    expect(rows[0]).toEqual({
      Ref: 'R1',
      'Column 2': 'extra1',
      Amount: '100.00',
      'Column 4': 'extra2',
      Date: '2026-06-30',
    });
  });

  it('suffixes a duplicate CSV header so both columns keep their own data', () => {
    const csv = 'Ref,Amount,Ref\nR1,100.00,R1-alt\n';
    const { headers, rows } = parseTabularFile(Buffer.from(csv), 'statement.csv');
    expect(headers).toEqual(['Ref', 'Amount', 'Ref (2)']);
    expect(rows[0]).toEqual({ Ref: 'R1', Amount: '100.00', 'Ref (2)': 'R1-alt' });
  });

  it('re-probes the suffix when a blank placeholder collides with a real CSV header', () => {
    const csv = 'Column 2,,X\nA,B,C\n';
    const { headers, rows } = parseTabularFile(Buffer.from(csv), 'statement.csv');
    expect(headers).toEqual(['Column 2', 'Column 2 (2)', 'X']);
    expect(rows[0]).toEqual({ 'Column 2': 'A', 'Column 2 (2)': 'B', X: 'C' });
  });

  it('gives blank XLSX headers positional placeholders instead of colliding on an empty key', () => {
    // 3 of 5 header cells populated, clearing the header-row-detection fill
    // threshold (>50%) — a 2-of-4 header would be mistaken for a data row.
    const aoa = [
      ['Ref', '', 'Amount', '', 'Date'],
      ['R1', 'extra1', '100.00', 'extra2', '2026-06-30'],
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(aoa);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    const { headers, rows } = parseTabularFile(buffer, 'ledger.xlsx');
    expect(headers).toEqual(['Ref', 'Column 2', 'Amount', 'Column 4', 'Date']);
    expect(rows[0]).toEqual({
      Ref: 'R1',
      'Column 2': 'extra1',
      Amount: '100.00',
      'Column 4': 'extra2',
      Date: '2026-06-30',
    });
  });

  it('suffixes a duplicate XLSX header so both columns keep their own data', () => {
    const aoa = [
      ['Ref', 'Amount', 'Ref'],
      ['R1', '100.00', 'R1-alt'],
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(aoa);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    const { headers, rows } = parseTabularFile(buffer, 'ledger.xlsx');
    expect(headers).toEqual(['Ref', 'Amount', 'Ref (2)']);
    expect(rows[0]).toEqual({ Ref: 'R1', Amount: '100.00', 'Ref (2)': 'R1-alt' });
  });

  it('every generated header stays unique even with mixed blanks and duplicates', () => {
    const aoa = [
      ['Ref', '', 'Ref', '', 'Column 2'],
      ['R1', 'a', 'R2', 'b', 'c'],
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(aoa);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    const { headers } = parseTabularFile(buffer, 'ledger.xlsx');
    expect(new Set(headers).size).toBe(headers.length);
  });
});
