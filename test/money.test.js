// Module 3: money is integer kobo, never floats.
const { nairaToKobo, assertKobo, formatNaira } = require('../src/money');

describe('money (Module 3)', () => {
  test('converts naira strings to integer kobo without floating point', () => {
    expect(nairaToKobo('1')).toBe(100);
    expect(nairaToKobo('0.10')).toBe(10);
    expect(nairaToKobo('1,234.56')).toBe(123456);
    // 0.1 + 0.2 style bugs: 19.99 * 100 is 1998.9999999999998 in floats
    expect(nairaToKobo('19.99')).toBe(1999);
  });

  test('rejects more than two decimal places and junk input', () => {
    expect(() => nairaToKobo('1.005')).toThrow();
    expect(() => nairaToKobo('abc')).toThrow();
    expect(() => nairaToKobo('')).toThrow();
    expect(() => nairaToKobo('-5')).toThrow();
  });

  test('assertKobo accepts only positive safe integers', () => {
    expect(assertKobo(1)).toBe(1);
    for (const bad of [0, -1, 1.5, '100', NaN, Infinity, null, 2 ** 53]) {
      expect(() => assertKobo(bad)).toThrow();
    }
  });

  test('formats kobo as naira for display', () => {
    expect(formatNaira(123456)).toBe('₦1,234.56');
    expect(formatNaira(5)).toBe('₦0.05');
    expect(formatNaira(-250)).toBe('-₦2.50');
  });
});
