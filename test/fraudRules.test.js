// Module 9: the scoring rules and the band each score falls in.
const { score, bandOf, isFreeEmail, cardCountryOf } = require('../src/fraud/rules');
const velocity = require('../src/fraud/velocity');
const { redis } = require('../src/redis');

const base = {
  email: 'ada@company.ng',
  billingCountry: 'NG',
  cardCountry: 'NG',
  deviceSeen: true,
  accountAgeDays: 30,
  knownAddress: false,
  velocityBreached: false,
};

describe('bands (0-40 approve, 41-79 challenge, 80+ block)', () => {
  test.each([
    [-50, 'APPROVE'],
    [0, 'APPROVE'],
    [40, 'APPROVE'],
    [41, 'CHALLENGE'],
    [79, 'CHALLENGE'],
    [80, 'BLOCK'],
    [125, 'BLOCK'],
  ])('score %i -> %s', (s, band) => {
    expect(bandOf(s)).toBe(band);
  });
});

describe('each rule adds or removes exactly its points', () => {
  test('a clean payment scores 0 and fires nothing', () => {
    expect(score(base)).toEqual({ score: 0, rulesFired: [], outcome: 'APPROVE' });
  });

  test.each([
    ['billing_mismatch', { billingCountry: 'GB' }, 20],
    ['free_email', { email: 'ada@gmail.com' }, 10],
    ['new_device', { deviceSeen: false }, 15],
    ['account_over_1_year', { accountAgeDays: 400 }, -30],
    ['known_address', { knownAddress: true }, -20],
    ['velocity', { velocityBreached: true }, 80],
  ])('%s', (rule, change, points) => {
    const r = score({ ...base, ...change });
    expect(r.score).toBe(points);
    expect(r.rulesFired).toEqual([expect.objectContaining({ rule, points })]);
  });

  test('a missing billing address counts as a mismatch (it cannot be checked)', () => {
    expect(score({ ...base, billingCountry: null }).rulesFired.map((r) => r.rule)).toEqual(['billing_mismatch']);
  });

  test('exactly one year old does not count as older than one year', () => {
    expect(score({ ...base, accountAgeDays: 365 }).score).toBe(0);
  });
});

describe('PHASE 6 CHECK: scores fall in the right bands', () => {
  test('new device + free email + billing mismatch = 45 -> CHALLENGE', () => {
    expect(score({ ...base, deviceSeen: false, email: 'x@yahoo.com', billingCountry: 'US' })).toMatchObject({
      score: 45,
      outcome: 'CHALLENGE',
    });
  });

  test('the same payment from a 2-year-old account at a known address = -5 -> APPROVE', () => {
    const r = score({ ...base, deviceSeen: false, email: 'x@yahoo.com', billingCountry: 'US', accountAgeDays: 800, knownAddress: true });
    expect(r).toMatchObject({ score: -5, outcome: 'APPROVE' });
    expect(r.rulesFired).toHaveLength(5);
  });

  test('new device + free email = 25 -> APPROVE', () => {
    expect(score({ ...base, deviceSeen: false, email: 'x@gmail.com' })).toMatchObject({ score: 25, outcome: 'APPROVE' });
  });

  test('a velocity breach alone = 80 -> BLOCK, whatever else is true', () => {
    expect(score({ ...base, velocityBreached: true })).toMatchObject({ score: 80, outcome: 'BLOCK' });
  });

  test('velocity is additive (owner decision): an old account at a known address offsets it, 80-30-20 = 30', () => {
    expect(score({ ...base, velocityBreached: true, accountAgeDays: 900, knownAddress: true })).toMatchObject({
      score: 30,
      outcome: 'APPROVE',
    });
  });
});

describe('signals', () => {
  test('free email providers', () => {
    for (const e of ['a@gmail.com', 'a@YAHOO.com', 'a@outlook.com', 'a@hotmail.co.uk', 'a@icloud.com', 'a@proton.me', 'a@aol.com']) {
      expect(isFreeEmail(e)).toBe(true);
    }
    expect(isFreeEmail('a@transactflow.ng')).toBe(false);
    expect(isFreeEmail('a@example.com')).toBe(false);
  });

  test('card issuing country comes from the BIN (first digits)', () => {
    expect(cardCountryOf('5061000000000000')).toBe('NG'); // Verve
    expect(cardCountryOf('4084084084084081')).toBe('NG');
    expect(cardCountryOf('4111111111111111')).toBe('US');
    expect(cardCountryOf('4000056655665556')).toBe('GB');
    expect(cardCountryOf('3530111333300000')).toBe(null); // unknown BIN
  });
});

describe('velocity counters (Redis INCR with a TTL)', () => {
  const limits = { user: { limit: 3, windowSeconds: 60 }, card: { limit: 3, windowSeconds: 600 } };
  afterAll(() => require('../src/redis').close());

  test('counts per user and per card, breaches above the limit, and expires with the window', async () => {
    const u = `u-${Date.now()}`;
    const c = `c-${Date.now()}`;
    const results = [];
    for (let i = 0; i < 4; i += 1) results.push(await velocity.hit({ userId: u, cardFingerprint: c }, limits));
    expect(results.map((r) => r.counts.user)).toEqual([1, 2, 3, 4]);
    expect(results.map((r) => r.breached)).toEqual([false, false, false, true]);
    expect(results[3].breaches).toEqual(['user', 'card']);

    const ttl = await redis().ttl(`vel:user:${u}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  test('clear() resets a user\'s counters (admin marks a block as a false positive)', async () => {
    const u = `u2-${Date.now()}`;
    for (let i = 0; i < 4; i += 1) await velocity.hit({ userId: u, cardFingerprint: 'f' }, limits);
    await velocity.clear({ userId: u });
    expect((await velocity.hit({ userId: u, cardFingerprint: `f2-${u}` }, limits)).counts.user).toBe(1);
  });
});
