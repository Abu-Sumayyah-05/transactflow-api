// Module 11: reconciliation, end to end against the mock bank's settlement file.
//
// PHASE 9 CHECK: each simulator settlement mode produces the expected
// classes, and a wrong closing balance halts the run.
const { randomUUID } = require('crypto');
const { pool } = require('../src/db/pool');
const recon = require('../src/recon/engine');
const gateway = require('../src/gateway/gateway');
const { buildStatement } = require('../mockbank/settlement');
const { app, request, registerAndLogin, addCard, fundWallet, makeAdmin } = require('./helpers');
const { startBank } = require('./bankHelper');

let bank;
let admin;
let user;
let card;
let since; // each test only reconciles the payments it made
let gapMs; // long enough to be "clearly before/after" on both clocks

beforeAll(async () => {
  bank = await startBank('A');
  admin = await makeAdmin(await registerAndLogin('Recon Analyst'));
  user = await registerAndLogin('Recon Payer');
  card = await addCard(user);
  await fundWallet(user.accountId, 10_000_000);
  // The bank stamps entries with this machine's clock; our payments are
  // stamped by the database's. Measure the difference and wait it out.
  const { rows } = await pool.query('SELECT now() AS t');
  gapMs = 400 + Math.abs(Date.now() - new Date(rows[0].t).getTime());
});
afterAll(async () => {
  await bank.stop();
  await pool.end();
});
beforeEach(async () => {
  bank.reset();
  since = (await pool.query('SELECT now() AS t')).rows[0].t.toISOString();
});

const gap = () => new Promise((r) => setTimeout(r, gapMs));

async function charge(amount) {
  const res = await request(app)
    .post('/api/v1/payments')
    .set('Authorization', `Bearer ${user.token}`)
    .set('Idempotency-Key', randomUUID())
    .send({ card_token: card.token, amount_kobo: amount });
  return res.body;
}
async function transfer(amount) {
  const res = await request(app)
    .post('/api/v1/transfers')
    .set('Authorization', `Bearer ${user.token}`)
    .set('Idempotency-Key', randomUUID())
    .send({ bank: 'A', account_number: '0123456789', amount_kobo: amount });
  return res.body;
}

const run = (extra = {}) => recon.run({ bank: 'A', since, actorId: admin.userId, ...extra });
const NONE = { MATCHED: 0, PENDING_SETTLEMENT: 0, MISSING_FROM_SWITCH: 0, MISSING_FROM_BANK: 0, AMOUNT_MISMATCH: 0, DUPLICATE_POSTING: 0 };
const item = async (reference) => (await pool.query("SELECT * FROM recon_items WHERE bank = 'A' AND reference = $1", [reference])).rows[0];
const auditOf = async (runId) => (await pool.query('SELECT action, detail FROM recon_audit WHERE run_id = $1 ORDER BY id', [runId])).rows;

describe('PHASE 9 CHECK: each settlement mode produces the expected classes', () => {
  test('clean file: everything MATCHED on all three amounts; balances recorded', async () => {
    const a = await charge(250000);
    const b = await charge(100050);
    const t = await transfer(40000);
    await gap();
    const r = await run();

    expect(r).toMatchObject({ status: 'COMPLETED', statement_ref: 'STMT-A-000001', opening_kobo: 0, closing_kobo: 250000 + 100050 - 40000, entries_count: 3, flagged_lines: [] });
    expect(r.counts).toEqual({ ...NONE, MATCHED: 3 });
    expect(await item(a.reference)).toMatchObject({ class: 'MATCHED', internal_amount: 250000, gateway_amount: 250000, bank_amount: 250000, payment_id: a.id, resolved_at: null });
    expect(await item(b.reference)).toMatchObject({ class: 'MATCHED', bank_amount: 100050 });
    expect(await item(t.reference)).toMatchObject({ class: 'MATCHED', internal_amount: 40000, bank_amount: 40000 });
  });

  test('late settlement: items after the cut-off are PENDING SETTLEMENT, not breaks; the next file settles them', async () => {
    const early = await charge(5000);
    await gap();
    const cutoff = new Date().toISOString();
    await gap();
    const late = await charge(7000);

    bank.setMode({ settlement: { cutoff } });
    const first = await run();
    expect(first.counts).toEqual({ ...NONE, MATCHED: 1, PENDING_SETTLEMENT: 1 });
    expect(await item(early.reference)).toMatchObject({ class: 'MATCHED' });
    expect(await item(late.reference)).toMatchObject({ class: 'PENDING_SETTLEMENT', bank_amount: null, resolved_at: null });

    // Tomorrow's file carries it.
    bank.setMode({});
    await gap();
    const second = await run();
    expect(second).toMatchObject({ status: 'COMPLETED', statement_ref: 'STMT-A-000002', opening_kobo: 5000, closing_kobo: 12000 });
    expect(second.counts).toEqual({ ...NONE, MATCHED: 1 });
    const settled = await item(late.reference);
    expect(settled).toMatchObject({ class: 'MATCHED', bank_amount: 7000, statement_ref: 'STMT-A-000002', resolution_note: 'Settled by statement STMT-A-000002' });
    expect(settled.resolved_at).not.toBeNull();
    expect(await auditOf(second.id)).toContainEqual({ action: 'ITEM_CLASSIFIED', detail: { reference: late.reference, from: 'PENDING_SETTLEMENT', to: 'MATCHED' } });
  });

  test('missing item: completed before the cut-off but not in the file -> MISSING_FROM_BANK', async () => {
    const a = await charge(3000);
    const b = await charge(4000);
    await gap();
    bank.setMode({ settlement: { missing: b.reference } });
    const r = await run();
    expect(r.counts).toEqual({ ...NONE, MATCHED: 1, MISSING_FROM_BANK: 1 });
    expect(await item(a.reference)).toMatchObject({ class: 'MATCHED' });
    expect(await item(b.reference)).toMatchObject({ class: 'MISSING_FROM_BANK', internal_amount: 4000, bank_amount: null });
  });

  test('bad line: logged and flagged, the run still completes on the readable lines', async () => {
    const a = await charge(1000);
    const b = await charge(2000);
    await gap();
    bank.setMode({ settlement: { badLine: true } });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await run();
    const logged = warn.mock.calls.map((c) => c[0]).join('\n');
    warn.mockRestore();

    expect(r.status).toBe('COMPLETED');
    expect(r.flagged_lines).toEqual([{ line: 8, text: '#### CORRUPTED RECORD 0x7F ####', reason: 'not a tagged line' }]);
    expect(logged).toMatch(/line 8 flagged: not a tagged line/);
    expect(r.counts).toEqual({ ...NONE, MATCHED: 2 });
    expect(await auditOf(r.id)).toContainEqual({ action: 'LINE_FLAGGED', detail: r.flagged_lines[0] });
    expect(await item(a.reference)).toBeDefined();
    expect(await item(b.reference)).toBeDefined();
  });

  test('wrong closing balance: the run HALTS and nothing from the file is used', async () => {
    const a = await charge(1500);
    await gap();
    bank.setMode({ settlement: { wrongClosing: true } });
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const r = await run();
    error.mockRestore();

    expect(r.status).toBe('HALTED');
    expect(r.halt_reason).toMatch(/closing balance in the file is 16\.00 .* comes to 15\.00/);
    expect(r.counts).toBeNull();
    expect(await item(a.reference)).toBeUndefined();
    const trail = await auditOf(r.id);
    expect(trail.map((t) => t.action)).toEqual(['RUN_STARTED', 'FILE_INGESTED', 'RUN_HALTED']);
    // The file is kept exactly as received, for whoever investigates.
    const { rows } = await pool.query('SELECT raw_file, file_sha256 FROM recon_runs WHERE id = $1', [r.id]);
    expect(rows[0].raw_file).toBe(bank.state.settlement.latest);
    expect(rows[0].file_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test('wrong amount -> AMOUNT_MISMATCH with all three amounts', async () => {
    const a = await charge(8000);
    await gap();
    bank.setMode({ settlement: { wrongAmount: a.reference } });
    const r = await run();
    expect(r.counts).toEqual({ ...NONE, AMOUNT_MISMATCH: 1 });
    const i = await item(a.reference);
    expect(i).toMatchObject({ class: 'AMOUNT_MISMATCH', internal_amount: 8000, gateway_amount: 8000, bank_amount: 18000 });
    expect(i.detail).toMatch(/₦80\.00.*₦180\.00/);
  });

  test('posted twice -> DUPLICATE_POSTING', async () => {
    const a = await charge(6000);
    await gap();
    bank.setMode({ settlement: { duplicate: true } });
    const r = await run();
    expect(r.counts).toEqual({ ...NONE, DUPLICATE_POSTING: 1 });
    expect((await item(a.reference)).detail).toMatch(/2 times/);
  });

  test('an entry we never sent -> MISSING_FROM_SWITCH', async () => {
    await charge(2000);
    await gap();
    bank.setMode({ settlement: { extra: true } });
    const r = await run();
    expect(r.counts).toEqual({ ...NONE, MATCHED: 1, MISSING_FROM_SWITCH: 1 });
    const full = await recon.getRun(Number(r.id));
    const ghost = full.items.find((i) => i.class === 'MISSING_FROM_SWITCH');
    expect(ghost).toMatchObject({ payment_id: null, internal_amount: null, bank_amount: 123400 });
    expect(ghost.reference).toMatch(/^TF-GHOST-/);
  });
});

describe('harder cases', () => {
  test('the bank settled a payment we still hold as UNKNOWN -> MISSING_FROM_SWITCH, saying so', async () => {
    bank.setMode({ mode: 'timeout' }); // the bank processes it but never answers
    const p = await charge(9000);
    expect(p.status).toBe('UNKNOWN');
    gateway.resetBreakers();
    bank.setMode({});
    await gap();
    const r = await run();
    expect(r.counts).toEqual({ ...NONE, MISSING_FROM_SWITCH: 1 });
    expect(await item(p.reference)).toMatchObject({ class: 'MISSING_FROM_SWITCH', internal_amount: null, bank_amount: 9000, payment_id: p.id });
    expect((await item(p.reference)).detail).toMatch(/UNKNOWN/);
  });

  test('the same statement twice is skipped, not double counted', async () => {
    const a = await charge(1200);
    await gap();
    const first = await run();
    expect(first.status).toBe('COMPLETED');
    const again = await run({ fileText: bank.state.settlement.latest });
    expect(again.status).toBe('SKIPPED');
    expect(again.halt_reason).toMatch(new RegExp(`already reconciled in run ${first.id}`));
    expect(await item(a.reference)).toMatchObject({ class: 'MATCHED', last_run_id: first.id });
  });

  test('a later statement re-posting a settled item -> DUPLICATE_POSTING', async () => {
    const a = await charge(4400);
    await gap();
    await run();
    const { text } = buildStatement({
      bank: 'A',
      seq: 2,
      openingKobo: 4400,
      cutoff: new Date(),
      items: [{ direction: 'C', amount_kobo: 4400, reference: a.reference, bank_reference: 'AREPOST1', kind: 'CARD CHARGE' }],
    });
    const r = await run({ fileText: text });
    expect(r.counts).toEqual({ ...NONE, DUPLICATE_POSTING: 1 });
    expect((await item(a.reference)).detail).toMatch(/Already settled in statement STMT-A-000001/);
  });

  test('if the bank cannot be reached the run is FAILED, with the reason', async () => {
    gateway.forceOpen('A');
    const r = await run();
    expect(r.status).toBe('FAILED');
    expect(r.halt_reason).toMatch(/circuit_open/);
  });

  test('the nightly schedule runs each bank once at the configured hour, and not again that day', async () => {
    const config = require('../src/config');
    const at = (hour) => new Date(Date.UTC(2026, 10, 11, hour, 5));
    expect(await recon.runScheduled(at((config.reconHourUtc + 1) % 24))).toEqual([]);
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const first = await recon.runScheduled(at(config.reconHourUtc));
    error.mockRestore();
    expect(first.map((r) => [r.bank, r.trigger]).sort()).toEqual([['A', 'SCHEDULED'], ['B', 'SCHEDULED']]);
    expect(await recon.runScheduled(at(config.reconHourUtc))).toEqual([]);
  });
});

describe('resolving breaks, the API and the four reports', () => {
  const get = (path, as = admin) => request(app).get(`/api/v1/admin/recon${path}`).set('Authorization', `Bearer ${as.token}`);
  const post = (path, body, as = admin) => request(app).post(`/api/v1/admin/recon${path}`).set('Authorization', `Bearer ${as.token}`).send(body);

  let runId;
  let matched;
  let missing;
  beforeEach(async () => {
    matched = await charge(5000);
    missing = await charge(2500);
    await gap();
    bank.setMode({ settlement: { missing: missing.reference, extra: true } });
    const res = await post('/run', { bank: 'A', since });
    expect(res.status).toBe(201);
    runId = Number(res.body.id);
  });

  test('POST /run returns the run with its items; GET /runs and /runs/:id read it back; admin only', async () => {
    const one = await get(`/runs/${runId}`);
    expect(one.body).toMatchObject({ status: 'COMPLETED', trigger: 'MANUAL', counts: { ...NONE, MATCHED: 1, MISSING_FROM_BANK: 1, MISSING_FROM_SWITCH: 1 } });
    expect(one.body.items.map((i) => i.class).sort()).toEqual(['MATCHED', 'MISSING_FROM_BANK', 'MISSING_FROM_SWITCH']);
    expect(one.body.raw_file).toBeUndefined();
    const list = await get('/runs');
    expect(Number(list.body.runs[0].id)).toBe(runId);
    expect((await get('/runs', user)).status).toBe(403);
    expect((await get('/runs/999999999')).status).toBe(404);
    expect((await post('/run', { bank: 'Z' })).status).toBe(400);
  });

  test('a break is resolved once, by a person, with a note; matched items need none', async () => {
    const brk = await item(missing.reference);
    expect((await post(`/items/${brk.id}/resolve`, { note: '' })).status).toBe(400);
    const res = await post(`/items/${brk.id}/resolve`, { note: 'Bank confirmed by phone; will appear in tomorrow\'s file' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ class: 'MISSING_FROM_BANK', resolved_by: admin.userId });
    expect(res.body.resolved_at).not.toBeNull();
    expect((await post(`/items/${brk.id}/resolve`, { note: 'again please' })).body.error.code).toBe('ALREADY_RESOLVED');
    const ok = await item(matched.reference);
    expect((await post(`/items/${ok.id}/resolve`, { note: 'nothing to do' })).body.error.code).toBe('NOT_A_BREAK');

    const trail = await auditOf(runId);
    expect(trail[trail.length - 1]).toMatchObject({ action: 'ITEM_RESOLVED', detail: { reference: missing.reference, class: 'MISSING_FROM_BANK' } });
    // A resolved break is not picked up again by the next run.
    const open = await get('/items');
    expect(open.body.items.map((i) => i.reference)).not.toContain(missing.reference);
  });

  test('the audit trail cannot be edited or deleted', async () => {
    await expect(pool.query('UPDATE recon_audit SET action = $1 WHERE run_id = $2', ['X', runId])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM recon_audit WHERE run_id = $1', [runId])).rejects.toThrow(/append-only/);
  });

  test('report 1, summary: balances, totals and items per class', async () => {
    const { body } = await get(`/reports/summary?run=${runId}`);
    expect(body.statement).toMatchObject({ opening_kobo: 0, closing_kobo: 5000 + 123400, entries: 2, credits_kobo: 128400, debits_kobo: 0 });
    expect(body.totals).toEqual({ items: 3, matched: 1, pending_settlement: 0, breaks: 2 });
    expect(body.rows).toHaveLength(6);
    expect(body.rows.find((r) => r.class === 'MISSING_FROM_BANK')).toMatchObject({ is_break: true, items: 1, value_kobo: 2500 });
    expect((await get('/reports/summary')).status).toBe(400);
  });

  test('report 2, exceptions: every unresolved break with the difference', async () => {
    const { body } = await get(`/reports/exceptions?run=${runId}`);
    expect(body.total).toBe(2);
    expect(body.rows.map((r) => r.class).sort()).toEqual(['MISSING_FROM_BANK', 'MISSING_FROM_SWITCH']);
    expect(body.rows.every((r) => r.age_days === 0)).toBe(true);
    const csv = await get(`/reports/exceptions?run=${runId}&format=csv`);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text.split('\n')[0]).toMatch(/^id,bank,reference,class,detail,/);
    expect(csv.text.trim().split('\n')).toHaveLength(3);
  });

  test('report 3, outstanding: open items grouped by class and age', async () => {
    const { body } = await get('/reports/outstanding');
    expect(body.rows).toHaveLength(5 * 4);
    const fresh = body.rows.find((r) => r.class === 'MISSING_FROM_BANK' && r.age === '0-1 days');
    expect(fresh.items).toBeGreaterThanOrEqual(1);
    expect(body.rows.reduce((n, r) => n + r.items, 0)).toBe(body.total);
  });

  test('report 4, audit: every step of the run, in order, with who did it', async () => {
    const brk = await item(missing.reference);
    await post(`/items/${brk.id}/resolve`, { note: 'written off after review' });
    const { body } = await get(`/reports/audit?run=${runId}`);
    expect(body.rows.map((r) => r.action)).toEqual([
      'RUN_STARTED', 'FILE_INGESTED', 'ITEM_CLASSIFIED', 'ITEM_CLASSIFIED', 'ITEM_CLASSIFIED', 'RUN_COMPLETED', 'ITEM_RESOLVED',
    ]);
    expect(body.rows[0].actor).toBe(admin.email);
    expect(body.rows[1].actor).toBe('system');
    expect(body.rows[6]).toMatchObject({ actor: admin.email, detail: { note: 'written off after review' } });
    expect((await get('/reports/nonsense')).status).toBe(404);
  });
});
