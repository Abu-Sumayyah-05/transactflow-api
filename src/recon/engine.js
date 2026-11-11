// Module 11: the reconciliation engine. One run = one bank, one settlement
// file, five stages:
//
//   1. ingest      get the bank's file; keep it exactly as received (+ hash)
//   2. normalise   parse it defensively (mt940.js) into plain entries, and
//                  load our own completed payments in the same shape.
//                  Unreadable lines are logged and flagged. If the balance
//                  check fails the run HALTS here: nothing in the file is used.
//   3. match       pair the two sides by reference
//   4. classify    one class per reference (classify.js)
//   5. resolve and report
//                  save the items, close what tonight's file settled, count
//                  the classes, write the audit trail. Breaks stay open
//                  until a person resolves them with a note.
//
// Stages 3 to 5 are one database transaction: a run is either fully
// recorded or not at all.
const crypto = require('crypto');
const { pool, withTransaction } = require('../db/pool');
const { AppError } = require('../errors');
const config = require('../config');
const gateway = require('../gateway/gateway');
const outbox = require('../outbox/outbox');
const { parseStatement } = require('./mt940');
const { classify, BREAKS } = require('./classify');

const BANKS = new Set(['A', 'B']);

async function audit(db, { runId = null, itemId = null, action, detail = {}, actor = null }) {
  await db.query('INSERT INTO recon_audit (run_id, item_id, action, detail, actor) VALUES ($1, $2, $3, $4, $5)', [
    runId,
    itemId,
    action,
    JSON.stringify(detail),
    actor,
  ]);
}

async function endRun(db, runId, status, fields = {}) {
  const cols = ['status = $2', 'finished_at = now()'];
  const values = [runId, status];
  for (const [k, v] of Object.entries(fields)) {
    values.push(v);
    cols.push(`${k} = $${values.length}`);
  }
  const { rows } = await db.query(`UPDATE recon_runs SET ${cols.join(', ')} WHERE id = $1 RETURNING *`, values);
  return rows[0];
}

// Our side, in the same shape as the file's entries. Candidates are
// completed payments at this bank that are not settled yet (no item, or an
// item still PENDING_SETTLEMENT / MISSING_FROM_BANK), plus whatever payment
// we hold for each reference the file mentions.
async function loadInternal(client, bank, fileRefs, since) {
  const { rows } = await client.query(
    `SELECT p.id AS payment_id, p.reference, p.status, p.type, p.gateway_amount_kobo AS gateway_kobo,
            (SELECT e.at FROM payment_events e WHERE e.payment_id = p.id AND e.to_status = 'COMPLETED' ORDER BY e.id LIMIT 1) AS completed_at,
            -- From the ledger, not from payments.amount_kobo: recon checks the books.
            (SELECT COALESCE(SUM(l.amount_kobo), 0)::bigint FROM ledger_entries l
              WHERE l.transaction_id = p.ledger_transaction_id AND l.direction = 'DEBIT') AS internal_kobo
       FROM payments p
       LEFT JOIN recon_items i ON i.bank = p.bank AND i.reference = p.reference
      WHERE p.bank = $1
        AND (p.reference = ANY($2::text[])
             OR (p.status = 'COMPLETED'
                 AND (i.id IS NULL OR (i.class IN ('PENDING_SETTLEMENT', 'MISSING_FROM_BANK') AND i.resolved_at IS NULL))
                 AND ($3::timestamptz IS NULL OR p.updated_at >= $3)))`,
    [bank, fileRefs, since]
  );
  return rows.map((r) => ({
    ...r,
    // A card charge is money the bank owes us (credit); a transfer is money
    // it paid out for us (debit).
    direction: r.type === 'CARD_TOPUP' ? 'C' : 'D',
    completed_at: r.completed_at ? new Date(r.completed_at) : new Date(0),
  }));
}

// options: { bank, fileText?, trigger = 'MANUAL', actorId = null, since = null }
// fileText lets an admin (or a test) reconcile a file they supply; otherwise
// the bank is asked for today's.
async function run({ bank, fileText = null, trigger = 'MANUAL', actorId = null, since = null }) {
  if (!BANKS.has(bank)) throw new AppError(400, 'INVALID_BANK', 'bank must be A or B');
  const sinceDate = since ? new Date(since) : config.reconStart;
  if (sinceDate && Number.isNaN(sinceDate.getTime())) throw new AppError(400, 'INVALID_SINCE', 'since must be an ISO time');

  const { rows: started } = await pool.query(
    'INSERT INTO recon_runs (bank, trigger, started_by) VALUES ($1, $2, $3) RETURNING id',
    [bank, trigger, actorId]
  );
  const runId = started[0].id;
  await audit(pool, { runId, action: 'RUN_STARTED', detail: { bank, trigger }, actor: actorId });

  // ---- 1. ingest ----------------------------------------------------------
  let text = fileText;
  if (text === null) {
    const fetched = await gateway.fetchSettlement(bank);
    if (!fetched.ok) {
      await audit(pool, { runId, action: 'RUN_FAILED', detail: { reason: fetched.reason } });
      return endRun(pool, runId, 'FAILED', { halt_reason: `Could not fetch the settlement file from bank ${bank} (${fetched.reason})` });
    }
    text = fetched.text;
  }
  const sha = crypto.createHash('sha256').update(String(text)).digest('hex');
  await pool.query('UPDATE recon_runs SET raw_file = $2, file_sha256 = $3 WHERE id = $1', [runId, String(text).slice(0, 5_000_000), sha]);
  await audit(pool, { runId, action: 'FILE_INGESTED', detail: { sha256: sha, bytes: String(text).length } });

  // ---- 2. normalise ---------------------------------------------------------
  const st = parseStatement(text);
  for (const f of st.flagged) {
    console.warn(`recon run ${runId} (bank ${bank}): line ${f.line} flagged: ${f.reason}: ${f.text}`);
    await audit(pool, { runId, action: 'LINE_FLAGGED', detail: f });
  }
  const header = {
    statement_ref: st.reference,
    statement_date: st.statement_date,
    cutoff: st.cutoff,
    opening_kobo: st.opening_kobo,
    closing_kobo: st.closing_kobo,
    entries_count: st.entries.length,
    flagged_lines: JSON.stringify(st.flagged),
  };
  if (!st.ok) {
    console.error(`recon run ${runId} (bank ${bank}) HALTED: ${st.halt}`);
    await audit(pool, { runId, action: 'RUN_HALTED', detail: { reason: st.halt } });
    return endRun(pool, runId, 'HALTED', { ...header, halt_reason: st.halt });
  }

  // The same statement twice would make every item look posted twice.
  const { rows: seen } = await pool.query(
    "SELECT id FROM recon_runs WHERE bank = $1 AND statement_ref = $2 AND file_sha256 = $3 AND status = 'COMPLETED' LIMIT 1",
    [bank, st.reference, sha]
  );
  if (seen[0]) {
    await audit(pool, { runId, action: 'RUN_SKIPPED', detail: { same_as_run: Number(seen[0].id) } });
    return endRun(pool, runId, 'SKIPPED', { ...header, halt_reason: `Statement ${st.reference} was already reconciled in run ${seen[0].id}` });
  }

  // ---- 3 to 5, in one transaction ---------------------------------------------
  return withTransaction(async (client) => {
    // 3. match: both sides, keyed by reference.
    const fileRefs = [...new Set(st.entries.map((e) => e.reference))];
    const internal = await loadInternal(client, bank, fileRefs, sinceDate);
    const { rows: settled } = await client.query(
      "SELECT reference, statement_ref FROM recon_items WHERE bank = $1 AND reference = ANY($2::text[]) AND class = 'MATCHED'",
      [bank, fileRefs]
    );

    // 4. classify.
    const verdicts = classify({
      internal,
      entries: st.entries,
      cutoff: st.cutoff,
      graceMs: config.reconCutoffGraceMs,
      alreadySettled: new Map(settled.map((s) => [s.reference, s.statement_ref])),
    });

    // 5. resolve and report.
    const counts = { MATCHED: 0, PENDING_SETTLEMENT: 0, MISSING_FROM_SWITCH: 0, MISSING_FROM_BANK: 0, AMOUNT_MISMATCH: 0, DUPLICATE_POSTING: 0 };
    for (const v of verdicts) {
      counts[v.class] += 1;
      const { rows: before } = await client.query('SELECT id, class, resolved_at FROM recon_items WHERE bank = $1 AND reference = $2 FOR UPDATE', [bank, v.reference]);
      const old = before[0];
      const inFile = v.bank_amount !== null;
      // Tonight's file settled something that was waiting: close it.
      const settledNow = v.class === 'MATCHED' && old && old.class !== 'MATCHED' && !old.resolved_at;
      const { rows: saved } = await client.query(
        `INSERT INTO recon_items (bank, reference, payment_id, internal_amount, gateway_amount, bank_amount, class, detail,
                                  statement_ref, first_run_id, last_run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
         ON CONFLICT (bank, reference) DO UPDATE SET
           payment_id = EXCLUDED.payment_id, internal_amount = EXCLUDED.internal_amount,
           gateway_amount = EXCLUDED.gateway_amount,
           bank_amount = COALESCE(EXCLUDED.bank_amount, recon_items.bank_amount),
           class = EXCLUDED.class, detail = EXCLUDED.detail,
           statement_ref = COALESCE(recon_items.statement_ref, EXCLUDED.statement_ref),
           last_run_id = EXCLUDED.last_run_id, updated_at = now(),
           resolved_at = CASE WHEN $11 THEN now() ELSE recon_items.resolved_at END,
           resolution_note = CASE WHEN $11 THEN $12 ELSE recon_items.resolution_note END
         RETURNING id`,
        [bank, v.reference, v.payment_id, v.internal_amount, v.gateway_amount, v.bank_amount, v.class, v.detail,
          inFile ? st.reference : null, runId, settledNow, `Settled by statement ${st.reference}`]
      );
      if (!old || old.class !== v.class) {
        await audit(client, { runId, itemId: saved[0].id, action: 'ITEM_CLASSIFIED', detail: { reference: v.reference, from: old?.class ?? null, to: v.class } });
      }
    }

    const breaks = BREAKS.reduce((n, c) => n + counts[c], 0);
    await audit(client, { runId, action: 'RUN_COMPLETED', detail: { counts, breaks, flagged_lines: st.flagged.length } });
    await outbox.add(client, 'recon.completed', runId, { run_id: Number(runId), bank, statement_ref: st.reference, counts, breaks });
    return endRun(client, runId, 'COMPLETED', { ...header, counts: JSON.stringify(counts) });
  });
}

// A person closes a break, with the reason. The class stays (it is what
// happened); resolved_at says someone dealt with it.
async function resolveItem({ itemId, note, actorId }) {
  const text = String(note ?? '').trim();
  if (text.length < 5) throw new AppError(400, 'NOTE_REQUIRED', 'Say how the break was resolved (at least 5 characters)');
  if (!Number.isSafeInteger(itemId)) throw new AppError(404, 'NOT_FOUND', 'No such reconciliation item');
  return withTransaction(async (client) => {
    const { rows } = await client.query('SELECT * FROM recon_items WHERE id = $1 FOR UPDATE', [itemId]);
    const item = rows[0];
    if (!item) throw new AppError(404, 'NOT_FOUND', 'No such reconciliation item');
    if (!BREAKS.includes(item.class)) throw new AppError(409, 'NOT_A_BREAK', `A ${item.class} item needs no resolution`);
    if (item.resolved_at) throw new AppError(409, 'ALREADY_RESOLVED', 'This break was already resolved');
    const { rows: updated } = await client.query(
      'UPDATE recon_items SET resolved_at = now(), resolved_by = $2, resolution_note = $3, updated_at = now() WHERE id = $1 RETURNING *',
      [itemId, actorId, text.slice(0, 1000)]
    );
    await audit(client, { runId: item.last_run_id, itemId, action: 'ITEM_RESOLVED', detail: { reference: item.reference, class: item.class, note: text.slice(0, 1000) }, actor: actorId });
    return updated[0];
  });
}

const RUN_COLUMNS = `id, bank, status, trigger, statement_ref, statement_date, cutoff, opening_kobo, closing_kobo,
  entries_count, flagged_lines, halt_reason, counts, started_at, finished_at`;

async function listRuns(limit = 50) {
  const { rows } = await pool.query(`SELECT ${RUN_COLUMNS} FROM recon_runs ORDER BY id DESC LIMIT $1`, [limit]);
  return rows;
}

async function getRun(runId) {
  if (!Number.isSafeInteger(runId)) throw new AppError(404, 'NOT_FOUND', 'No such reconciliation run');
  const { rows } = await pool.query(`SELECT ${RUN_COLUMNS} FROM recon_runs WHERE id = $1`, [runId]);
  if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'No such reconciliation run');
  const { rows: items } = await pool.query('SELECT * FROM recon_items WHERE last_run_id = $1 ORDER BY class, reference', [runId]);
  return { ...rows[0], items };
}

// Open work: unresolved breaks, and items still waiting for settlement.
async function listItems({ cls = null, open = true } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM recon_items
      WHERE ($1::text IS NULL OR class = $1)
        AND (NOT $2 OR (resolved_at IS NULL AND class <> 'MATCHED'))
      ORDER BY created_at DESC LIMIT 500`,
    [cls, open]
  );
  return rows;
}

// Nightly, from the worker: one run per bank once the configured hour (UTC)
// arrives, unless today already has a scheduled run for that bank.
async function runScheduled(now = new Date()) {
  if (now.getUTCHours() !== config.reconHourUtc) return [];
  const done = [];
  for (const bank of BANKS) {
    const { rows } = await pool.query(
      "SELECT 1 FROM recon_runs WHERE bank = $1 AND trigger = 'SCHEDULED' AND started_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' LIMIT 1",
      [bank]
    );
    if (!rows[0]) done.push(await run({ bank, trigger: 'SCHEDULED' }));
  }
  return done;
}

function startLoop() {
  const timer = setInterval(() => {
    runScheduled().catch((err) => console.error(`recon schedule: ${err.message}`));
  }, 60_000);
  timer.unref();
  return timer;
}

module.exports = { run, resolveItem, listRuns, getRun, listItems, runScheduled, startLoop };
