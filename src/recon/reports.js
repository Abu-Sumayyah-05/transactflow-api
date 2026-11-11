// Module 11: the four regulatory-style reports. Each is a plain object with
// a `rows` array, so it can be shown on screen or downloaded as CSV.
//
//   summary      one run at a glance: the statement's balances and totals,
//                and how many items (and how much money) fell in each class
//   exceptions   every unresolved break: what differs, by how much, how old
//   outstanding  ageing: unresolved breaks and pending-settlement items,
//                grouped by how long they have been open
//   audit        the trail: every step of a run and every human resolution
const { pool } = require('../db/pool');
const { AppError } = require('../errors');
const { formatNaira } = require('../money');
const { parseStatement } = require('./mt940');
const { BREAKS } = require('./classify');

const NAMES = ['summary', 'exceptions', 'outstanding', 'audit'];
const CLASSES = ['MATCHED', 'PENDING_SETTLEMENT', 'MISSING_FROM_SWITCH', 'MISSING_FROM_BANK', 'AMOUNT_MISMATCH', 'DUPLICATE_POSTING'];

async function runOr404(runId) {
  if (!Number.isSafeInteger(runId)) throw new AppError(400, 'RUN_REQUIRED', 'This report needs ?run=<run id>');
  const { rows } = await pool.query('SELECT * FROM recon_runs WHERE id = $1', [runId]);
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'No such reconciliation run');
  return rows[0];
}

async function summary({ runId }) {
  const run = await runOr404(runId);
  const { rows: byClass } = await pool.query(
    `SELECT class, COUNT(*)::int AS items,
            COALESCE(SUM(COALESCE(bank_amount, internal_amount)), 0)::bigint AS value_kobo
       FROM recon_items WHERE last_run_id = $1 GROUP BY class`,
    [runId]
  );
  // Statement totals come from the stored file itself.
  const st = run.raw_file ? parseStatement(run.raw_file) : null;
  const total = (dir) => (st ? st.entries.filter((e) => e.direction === dir).reduce((n, e) => n + e.amount_kobo, 0) : null);
  const rows = CLASSES.map((cls) => {
    const found = byClass.find((r) => r.class === cls);
    return { class: cls, is_break: BREAKS.includes(cls), items: found?.items ?? 0, value_kobo: found?.value_kobo ?? 0, value_display: formatNaira(found?.value_kobo ?? 0) };
  });
  return {
    report: 'summary',
    title: `Reconciliation summary: bank ${run.bank}, statement ${run.statement_ref ?? '(none)'}`,
    run: {
      id: Number(run.id),
      bank: run.bank,
      status: run.status,
      statement_ref: run.statement_ref,
      statement_date: run.statement_date,
      cutoff: run.cutoff,
      halt_reason: run.halt_reason,
      flagged_lines: run.flagged_lines.length,
    },
    statement: {
      opening_kobo: run.opening_kobo,
      closing_kobo: run.closing_kobo,
      entries: run.entries_count,
      credits_kobo: total('C'),
      debits_kobo: total('D'),
    },
    totals: {
      items: rows.reduce((n, r) => n + r.items, 0),
      matched: rows[0].items,
      pending_settlement: rows[1].items,
      breaks: rows.filter((r) => r.is_break).reduce((n, r) => n + r.items, 0),
    },
    rows,
  };
}

async function exceptions({ runId = null }) {
  if (runId !== null) await runOr404(runId);
  const { rows } = await pool.query(
    `SELECT id, bank, reference, class, detail, internal_amount, gateway_amount, bank_amount, statement_ref,
            last_run_id AS run_id, created_at,
            FLOOR(EXTRACT(EPOCH FROM now() - created_at) / 86400)::int AS age_days
       FROM recon_items
      WHERE resolved_at IS NULL AND class = ANY($1::text[]) AND ($2::bigint IS NULL OR last_run_id = $2)
      ORDER BY created_at, id`,
    [BREAKS, runId]
  );
  return {
    report: 'exceptions',
    title: 'Exceptions: unresolved reconciliation breaks',
    total: rows.length,
    rows: rows.map((r) => ({
      ...r,
      id: Number(r.id),
      run_id: Number(r.run_id),
      // Bank minus ours, when both sides have an amount.
      difference_kobo: r.bank_amount !== null && r.internal_amount !== null ? r.bank_amount - r.internal_amount : null,
    })),
  };
}

const BUCKETS = [
  { label: '0-1 days', max: 1 },
  { label: '2-3 days', max: 3 },
  { label: '4-7 days', max: 7 },
  { label: 'over 7 days', max: Infinity },
];

async function outstanding() {
  const { rows: open } = await pool.query(
    `SELECT class, COALESCE(bank_amount, internal_amount, 0) AS kobo,
            FLOOR(EXTRACT(EPOCH FROM now() - created_at) / 86400)::int AS age_days
       FROM recon_items WHERE resolved_at IS NULL AND class <> 'MATCHED'`
  );
  const rows = [];
  for (const cls of CLASSES.filter((c) => c !== 'MATCHED')) {
    let min = 0;
    for (const b of BUCKETS) {
      const inBucket = open.filter((o) => o.class === cls && o.age_days >= min && o.age_days <= b.max);
      const kobo = inBucket.reduce((n, o) => n + Number(o.kobo), 0);
      rows.push({ class: cls, age: b.label, items: inBucket.length, value_kobo: kobo, value_display: formatNaira(kobo) });
      min = b.max + 1;
    }
  }
  return { report: 'outstanding', title: 'Outstanding items by age', total: open.length, rows };
}

async function auditTrail({ runId = null }) {
  if (runId !== null) await runOr404(runId);
  const { rows } = await pool.query(
    `SELECT a.id, a.at, a.run_id, a.item_id, a.action, a.detail, u.email AS actor
       FROM recon_audit a LEFT JOIN users u ON u.id = a.actor
      WHERE $1::bigint IS NULL OR a.run_id = $1
      ORDER BY a.id DESC LIMIT 1000`,
    [runId]
  );
  return {
    report: 'audit',
    title: runId === null ? 'Audit trail (latest 1000 entries)' : `Audit trail for run ${runId}`,
    total: rows.length,
    rows: rows.reverse().map((r) => ({ ...r, id: Number(r.id), run_id: r.run_id && Number(r.run_id), item_id: r.item_id && Number(r.item_id), actor: r.actor ?? 'system' })),
  };
}

async function build(name, { runId = null } = {}) {
  switch (name) {
    case 'summary':
      return summary({ runId });
    case 'exceptions':
      return exceptions({ runId });
    case 'outstanding':
      return outstanding();
    case 'audit':
      return auditTrail({ runId });
    default:
      throw new AppError(404, 'UNKNOWN_REPORT', `Reports: ${NAMES.join(', ')}`);
  }
}

// rows -> CSV. Objects are written as JSON; cells that a spreadsheet would
// read as a formula are neutralised.
function toCsv(report) {
  const rows = report.rows;
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@]/.test(s) && typeof v !== 'number') s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `${[cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n')}\n`;
}

module.exports = { build, toCsv, NAMES };
