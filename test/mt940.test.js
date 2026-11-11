// Module 11: defensive parsing of an MT940-style bank statement.
//   - a line we can't read is logged and flagged, never silently skipped
//   - if opening balance + transactions != closing balance, the file is
//     not trusted at all (the run halts)
const { parseStatement, parseAmount } = require('../src/recon/mt940');

const file = (...middle) =>
  [
    ':20:STMT-A-000001',
    ':25:TRANSACTFLOW-A/NGN',
    ':28C:1/1',
    ':13D:2611112200+0000',
    ':60F:C261111NGN1000,00',
    ...middle,
  ].join('\r\n');

const GOOD = file(
  ':61:2611111111C2500,50NTRFTF-AAA-111//A0001',
  ':86:CARD CHARGE TF-AAA-111',
  ':61:2611111111D500,00NTRFPO-0123456789abcdef-7//A0002',
  ':86:TRANSFER PO-0123456789abcdef-7',
  ':62F:C261111NGN3000,50'
);

describe('parseAmount: comma decimals to integer kobo, as text, never floats', () => {
  test.each([
    ['2500,50', 250050],
    ['0,05', 5],
    ['19,99', 1999],
    ['7,', 700],
    ['7,5', 750],
    ['1000000,00', 100000000],
  ])('%s -> %i', (text, kobo) => expect(parseAmount(text)).toBe(kobo));

  test.each(['', '12.50', '1,234', '-5,00', 'abc', '1,2,3'])('%s is refused', (text) => {
    expect(parseAmount(text)).toBe(null);
  });
});

describe('a clean statement', () => {
  const s = parseStatement(GOOD);

  test('header, balances and cut-off time are read', () => {
    expect(s).toMatchObject({
      ok: true,
      halt: null,
      reference: 'STMT-A-000001',
      account: 'TRANSACTFLOW-A/NGN',
      currency: 'NGN',
      opening_kobo: 100000,
      closing_kobo: 300050,
      flagged: [],
    });
    expect(s.cutoff.toISOString()).toBe('2026-11-11T22:00:00.000Z');
    expect(s.statement_date).toBe('2026-11-11');
  });

  test('each :61: line becomes an entry: direction, kobo, our reference, the bank reference', () => {
    expect(s.entries).toEqual([
      { line: 6, direction: 'C', amount_kobo: 250050, reference: 'TF-AAA-111', bank_reference: 'A0001', value_date: '2026-11-11', narrative: 'CARD CHARGE TF-AAA-111' },
      { line: 8, direction: 'D', amount_kobo: 50000, reference: 'PO-0123456789abcdef-7', bank_reference: 'A0002', value_date: '2026-11-11', narrative: 'TRANSFER PO-0123456789abcdef-7' },
    ]);
  });

  test('the balance check: opening + credits - debits = closing', () => {
    expect(s.computed_closing_kobo).toBe(100000 + 250050 - 50000);
  });
});

describe('defensive parsing', () => {
  test('a junk line is flagged with its line number and text; the rest is still read', () => {
    const s = parseStatement(
      file(':61:2611111111C100,00NTRFTF-OK-1//A1', 'THIS LINE IS GARBAGE @@@', ':61:26111XBROKEN', ':62F:C261111NGN1100,00')
    );
    expect(s.ok).toBe(true);
    expect(s.entries).toHaveLength(1);
    expect(s.flagged).toEqual([
      { line: 7, text: 'THIS LINE IS GARBAGE @@@', reason: 'not a tagged line' },
      { line: 8, text: ':61:26111XBROKEN', reason: 'unreadable transaction line' },
    ]);
  });

  test('an unknown tag is flagged, not fatal', () => {
    const s = parseStatement(file(':99Z:SOMETHING NEW', ':62F:C261111NGN1000,00'));
    expect(s.ok).toBe(true);
    expect(s.flagged).toEqual([{ line: 6, text: ':99Z:SOMETHING NEW', reason: 'unknown tag :99Z:' }]);
  });

  test('HALT: the closing balance does not equal opening + transactions', () => {
    const s = parseStatement(file(':61:2611111111C100,00NTRFTF-OK-1//A1', ':62F:C261111NGN1200,00'));
    expect(s.ok).toBe(false);
    expect(s.halt).toMatch(/closing balance.*1200\.00.*1100\.00/i);
  });

  test('HALT: a damaged transaction line makes the balance check fail, so the file is not trusted', () => {
    const s = parseStatement(
      file(':61:2611111111C100,00NTRFTF-OK-1//A1', ':61:2611111111C250,0', ':62F:C261111NGN1350,00')
    );
    expect(s.flagged).toHaveLength(1);
    expect(s.ok).toBe(false);
    expect(s.halt).toMatch(/closing balance/i);
  });

  test.each([
    ['no opening balance', [':20:X', ':62F:C261111NGN0,00'].join('\n'), /opening balance/i],
    ['no closing balance', [':20:X', ':60F:C261111NGN0,00'].join('\n'), /closing balance/i],
    ['an unreadable opening balance', [':20:X', ':60F:C26111NGNxx', ':62F:C261111NGN0,00'].join('\n'), /opening balance/i],
    ['an empty file', '', /empty/i],
  ])('HALT: %s', (_name, text, why) => {
    const s = parseStatement(text);
    expect(s.ok).toBe(false);
    expect(s.halt).toMatch(why);
  });

  test('debit balances (D) are negative; a statement can cross zero', () => {
    const s = parseStatement(
      [':20:X', ':60F:D261111NGN50,00', ':61:2611111111C20,00NTRFTF-1//B1', ':62F:D261111NGN30,00'].join('\n')
    );
    expect(s).toMatchObject({ ok: true, opening_kobo: -5000, closing_kobo: -3000 });
  });

  test('without a :13D: cut-off, the end of the statement day is used', () => {
    const s = parseStatement([':20:X', ':60F:C261111NGN0,00', ':62F:C261111NGN0,00'].join('\n'));
    expect(s.cutoff.toISOString()).toBe('2026-11-11T23:59:59.999Z');
  });

  test('never throws, whatever it is given', () => {
    for (const junk of [null, undefined, 42, ':::', ':61:', '\u0000\u0001', ':60F:', ':62F:C999999NGN1,00']) {
      expect(() => parseStatement(junk)).not.toThrow();
      expect(parseStatement(junk).ok).toBe(false);
    }
  });
});
