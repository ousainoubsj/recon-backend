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
