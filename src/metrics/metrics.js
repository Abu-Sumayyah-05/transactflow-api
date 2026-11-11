// Module 10: observability. The numbers an operations team watches, computed
// on request from the payments table. Nothing here is cached: a dashboard
// that lies after a crash is worse than a slightly slower one.
//
//   success rate         completed / (completed + failed). A payment still
//                        UNKNOWN or PENDING is not counted either way yet.
//   authorization rate   per bank, for card payments the bank answered:
//                        approved / (approved + declined). Payments our own
//                        fraud rules blocked never reached a bank, so they
//                        are not in any bank's rate.
//   p99 latency          99% of requests finished within this many ms.
//                        The average hides the slow tail; p99 shows it.
//   critical path        our own share of a payment request (everything
//                        except waiting for the bank): target under 200 ms.
const { pool } = require('../db/pool');
const { AppError } = require('../errors');
const { formatNaira } = require('../money');
const gateway = require('../gateway/gateway');
const outbox = require('../outbox/outbox');

const CRITICAL_PATH_TARGET_MS = 200;
const CRITICAL_PATH_STEPS = [
  'idempotency key check (Redis lock + database claim)',
  'fraud check (rules + velocity counters)',
  'payment and state change written to PostgreSQL',
  'bank answer applied: state change + ledger entries in one transaction',
];

const rate = (good, bad) => (good + bad === 0 ? null : Number((good / (good + bad)).toFixed(4)));

// ?since=<ISO time> or ?window=<minutes> (default 60, max 7 days).
function parseWindow(query) {
  if (query.since !== undefined) {
    const since = new Date(String(query.since));
    if (Number.isNaN(since.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(String(query.since))) {
      throw new AppError(400, 'INVALID_WINDOW', 'since must be an ISO time such as 2026-11-11T08:00:00Z');
    }
    return { since, minutes: null };
  }
  const minutes = query.window === undefined ? 60 : Number(query.window);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 7 * 24 * 60) {
    throw new AppError(400, 'INVALID_WINDOW', 'window must be a whole number of minutes between 1 and 10080');
  }
  return { since: null, minutes };
}

async function compute(query = {}) {
  const { since, minutes } = parseWindow(query);
  // The window is measured on the database clock, like every other time.
  const { rows: w } = await pool.query(
    'SELECT COALESCE($1::timestamptz, now() - make_interval(mins => $2::int)) AS since, now() AS until',
    [since, minutes ?? 0]
  );
  const from = w[0].since;

  const { rows: groups } = await pool.query(
    `SELECT bank, type,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
            COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
            COUNT(*) FILTER (WHERE status = 'FAILED' AND response_code IS NOT NULL)::int AS declined,
            COUNT(*) FILTER (WHERE status = 'UNKNOWN')::int AS unknown,
            COUNT(*) FILTER (WHERE status NOT IN ('COMPLETED', 'FAILED'))::int AS unresolved,
            COALESCE(SUM(amount_kobo) FILTER (WHERE status = 'COMPLETED'), 0)::bigint AS completed_kobo,
            COUNT(bank_ms)::int AS samples,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY bank_ms) AS bank_p50,
            percentile_disc(0.99) WITHIN GROUP (ORDER BY bank_ms) AS bank_p99
       FROM payments WHERE created_at >= $1 GROUP BY bank, type`,
    [from]
  );
  const { rows: lat } = await pool.query(
    `SELECT COUNT(total_ms)::int AS samples,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY total_ms) AS p50,
            percentile_disc(0.99) WITHIN GROUP (ORDER BY total_ms) AS p99,
            percentile_disc(0.99) WITHIN GROUP (ORDER BY total_ms - COALESCE(bank_ms, 0)) AS own_p99
       FROM payments WHERE created_at >= $1 AND total_ms IS NOT NULL`,
    [from]
  );
  const { rows: bankLat } = await pool.query(
    `SELECT bank, COUNT(bank_ms)::int AS samples,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY bank_ms) AS p50,
            percentile_disc(0.99) WITHIN GROUP (ORDER BY bank_ms) AS p99
       FROM payments WHERE created_at >= $1 AND bank_ms IS NOT NULL GROUP BY bank`,
    [from]
  );
  const { rows: fraudRows } = await pool.query(
    'SELECT outcome, COUNT(*)::int AS n FROM fraud_decisions WHERE created_at >= $1 GROUP BY outcome',
    [from]
  );

  const sum = (key, filter = () => true) => groups.filter(filter).reduce((n, g) => n + Number(g[key]), 0);
  const breakers = Object.fromEntries(gateway.breakerSnapshots().map((b) => [b.name, b]));

  const byBank = Object.keys(breakers).map((bank) => {
    const card = groups.find((g) => g.bank === bank && g.type === 'CARD_TOPUP');
    const xfer = groups.find((g) => g.bank === bank && g.type === 'BANK_TRANSFER');
    const l = bankLat.find((x) => x.bank === bank);
    return {
      bank,
      breaker: breakers[bank].state,
      card: {
        attempts: card?.total ?? 0,
        approved: card?.completed ?? 0,
        declined: card?.declined ?? 0,
        unknown: card?.unknown ?? 0,
        authorization_rate: rate(card?.completed ?? 0, card?.declined ?? 0),
      },
      transfers: {
        attempts: xfer?.total ?? 0,
        completed: xfer?.completed ?? 0,
        failed: xfer?.failed ?? 0,
        unknown: xfer?.unknown ?? 0,
        success_rate: rate(xfer?.completed ?? 0, xfer?.failed ?? 0),
      },
      // How long the bank itself took to answer (retries included).
      latency_ms: { samples: l?.samples ?? 0, p50: l?.p50 ?? null, p99: l?.p99 ?? null },
    };
  });

  const completed = sum('completed');
  const failed = sum('failed');
  const completedKobo = sum('completed_kobo');
  const fraud = { approved: 0, challenged: 0, blocked: 0 };
  for (const f of fraudRows) fraud[{ APPROVE: 'approved', CHALLENGE: 'challenged', BLOCK: 'blocked' }[f.outcome]] = f.n;

  return {
    window: { since: from, until: w[0].until, minutes },
    success_rate: rate(completed, failed),
    payments: { total: sum('total'), completed, failed, unresolved: sum('unresolved') },
    volume: { completed_count: completed, completed_kobo: completedKobo, completed_display: formatNaira(completedKobo) },
    // The whole request, as the customer experienced it.
    latency_ms: { samples: lat[0].samples, p50: lat[0].p50, p99: lat[0].p99 },
    critical_path: {
      steps: CRITICAL_PATH_STEPS,
      p99_ms: lat[0].own_p99,
      target_ms: CRITICAL_PATH_TARGET_MS,
      within_target: lat[0].own_p99 === null ? null : lat[0].own_p99 <= CRITICAL_PATH_TARGET_MS,
    },
    by_bank: byBank,
    fraud,
    outbox: await outbox.stats(),
  };
}

module.exports = { compute };
