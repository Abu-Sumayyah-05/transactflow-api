// Module 6: reading a payout CSV and the pre-send checks that need no bank:
// format, duplicates and amount sanity. (Name enquiry needs the bank, so it
// runs just before each item is sent.)
const { parseCsv, checkRows, namesMatch, HEADER } = require('../src/payouts/csv');

const header = HEADER.join(',');
const csv = (...rows) => [header, ...rows].join('\n');

describe('parseCsv', () => {
  test('reads quoted fields, escaped quotes, CRLF and a BOM', () => {
    const text = `﻿${header}\r\nA,0123456789,"Eze, Ngozi",1500.00,INV-1\r\nB,0000000001,"Ibrahim ""Ibro"" Musa",20,INV-2\r\n`;
    const { rows } = parseCsv(text);
    expect(rows).toEqual([
      { row: 2, fields: { bank: 'A', account_number: '0123456789', account_name: 'Eze, Ngozi', amount: '1500.00', reference: 'INV-1' } },
      { row: 3, fields: { bank: 'B', account_number: '0000000001', account_name: 'Ibrahim "Ibro" Musa', amount: '20', reference: 'INV-2' } },
    ]);
  });

  test('columns may come in any order; extra columns are ignored; blank lines are skipped', () => {
    const text = 'reference,amount,note,account_name,account_number,bank\nR1,10,hi,Ngozi Eze,0123456789,a\n\n';
    expect(parseCsv(text).rows[0].fields).toEqual({ bank: 'a', account_number: '0123456789', account_name: 'Ngozi Eze', amount: '10', reference: 'R1' });
  });

  test('a row with the wrong number of fields is kept and marked malformed, not dropped', () => {
    const { rows } = parseCsv(csv('A,0123456789,Ngozi Eze,10'));
    expect(rows[0]).toMatchObject({ row: 2, malformed: true });
  });

  test('a file without the required columns is refused as a whole', () => {
    expect(() => parseCsv('bank,account_number\nA,0123456789')).toThrow(/missing column.*account_name/i);
    expect(() => parseCsv('')).toThrow(/empty/i);
  });

  test('an unterminated quote is refused as a whole', () => {
    expect(() => parseCsv(csv('A,0123456789,"Ngozi Eze,10,R1'))).toThrow(/quote/i);
  });
});

describe('checkRows: format, duplicates, amount sanity', () => {
  const limits = { minKobo: 100, maxKobo: 500_000_000 };
  const check = (...rows) => checkRows(parseCsv(csv(...rows)).rows, { limits, usedReferences: new Set(['OLD-1']) });

  test('a good row becomes a valid item in integer kobo', () => {
    const [item] = check('a,0123456789,Ngozi Eze,"1,500.50",INV-1');
    expect(item).toEqual({
      row: 2,
      bank: 'A',
      account_number: '0123456789',
      account_name: 'Ngozi Eze',
      amount_kobo: 150050,
      reference: 'INV-1',
      status: 'VALID',
      reason: null,
    });
  });

  test.each([
    ['C,0123456789,Ngozi Eze,10,R1', 'INVALID_BANK'],
    ['A,012345678,Ngozi Eze,10,R1', 'INVALID_ACCOUNT_NUMBER'],
    ['A,0123456789,N,10,R1', 'INVALID_ACCOUNT_NAME'],
    ['A,0123456789,Ngozi Eze,10.001,R1', 'INVALID_AMOUNT'],
    ['A,0123456789,Ngozi Eze,-5,R1', 'INVALID_AMOUNT'],
    ['A,0123456789,Ngozi Eze,abc,R1', 'INVALID_AMOUNT'],
    ['A,0123456789,Ngozi Eze,0.50,R1', 'AMOUNT_TOO_SMALL'],
    ['A,0123456789,Ngozi Eze,5000000.01,R1', 'AMOUNT_TOO_LARGE'],
    ['A,0123456789,Ngozi Eze,10,has space', 'INVALID_REFERENCE'],
    ['A,0123456789,Ngozi Eze,10,OLD-1', 'DUPLICATE_REFERENCE'],
    ['A,0123456789,Ngozi Eze,10', 'MALFORMED_ROW'],
  ])('%s -> %s', (row, reason) => {
    expect(check(row)[0]).toMatchObject({ status: 'REJECTED', reason });
  });

  test('a reference repeated in the file: the first is kept, later ones are rejected', () => {
    const items = check('A,0123456789,Ngozi Eze,10,R1', 'A,0000000001,Ibrahim Musa,20,R1');
    expect(items.map((i) => i.status)).toEqual(['VALID', 'REJECTED']);
    expect(items[1].reason).toBe('DUPLICATE_REFERENCE');
  });

  test('the same account and amount twice is flagged as a likely duplicate payment', () => {
    const items = check('A,0123456789,Ngozi Eze,10,R1', 'A,0123456789,Ngozi Eze,10.00,R2', 'A,0123456789,Ngozi Eze,11,R3');
    expect(items.map((i) => i.reason)).toEqual([null, 'DUPLICATE_PAYMENT', null]);
  });

  test('a rejected row does not count as the "first" of a duplicate pair', () => {
    const items = check('C,0123456789,Ngozi Eze,10,R1', 'A,0123456789,Ngozi Eze,10,R1');
    expect(items.map((i) => i.status)).toEqual(['REJECTED', 'VALID']);
  });
});

describe('namesMatch (name enquiry vs the CSV)', () => {
  test.each([
    ['Ngozi Eze', 'NGOZI EZE', true],
    ['Eze, Ngozi', 'Ngozi Eze', true],
    ['  ngozi   eze ', 'Ngozi Eze', true],
    ['Ngozi Eze', 'Ngozi Okafor', false],
    ['Ngozi', 'Ngozi Eze', false],
  ])('%s vs %s -> %s', (a, b, expected) => {
    expect(namesMatch(a, b)).toBe(expected);
  });
});
