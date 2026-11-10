// POST /webhooks/bank: a bank tells us what happened to a payment.
//
// 1. Verify the HMAC-SHA256 signature over the RAW request bytes. Re-encoding
//    parsed JSON can change spacing or key order and break the signature, so
//    this route reads the body as bytes, before any JSON parser touches it.
// 2. Compare signatures in constant time, so response timing can't reveal how
//    many leading characters of a forged signature were right.
// 3. Dedupe on (bank, event_id). A duplicate still gets 200, otherwise the
//    bank would keep retrying something we already have.
// 4. Store the event and return 200 straight away. The work happens in
//    processor.js, so a slow database never makes the bank time out.
const express = require('express');
const crypto = require('crypto');
const { pool } = require('../db/pool');
const { AppError } = require('../errors');
const config = require('../config');
const processor = require('./processor');

const router = express.Router();

function secretFor(bank) {
  if (!/^[A-Z]$/.test(bank)) return null;
  return process.env[`WEBHOOK_SECRET_${bank}`] || null;
}

function signatureValid(raw, header, secret) {
  const match = /^sha256=([0-9a-f]{64})$/.exec(String(header || ''));
  if (!match || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest();
  const given = Buffer.from(match[1], 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

async function logRejected(source, raw, payload, reason) {
  await pool.query(
    `INSERT INTO webhook_events (event_id, source, event_type, signature_valid, status, raw_body, last_error)
     VALUES ($1, $2, $3, false, 'REJECTED', $4, $5)`,
    [payload?.event_id ? String(payload.event_id).slice(0, 200) : null, source.slice(0, 20) || '?',
      payload?.type ? String(payload.type).slice(0, 100) : null, raw.toString('utf8').slice(0, 4000), reason]
  );
  console.warn(`webhook rejected from bank "${source}": ${reason}`);
}

router.post('/bank', express.raw({ type: '*/*', limit: '256kb' }), async (req, res) => {
  const source = String(req.get('x-bank-name') || '').toUpperCase();
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  let payload = null;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    /* handled below */
  }

  if (!signatureValid(raw, req.get('x-bank-signature'), secretFor(source))) {
    await logRejected(source, raw, payload, 'invalid signature');
    throw new AppError(401, 'INVALID_SIGNATURE', 'Webhook signature is not valid');
  }
  if (!payload || typeof payload.event_id !== 'string' || !payload.event_id || typeof payload.type !== 'string') {
    await logRejected(source, raw, payload, 'malformed payload');
    throw new AppError(400, 'BAD_WEBHOOK', 'Webhook payload is missing event_id or type');
  }

  // xmax = 0 means the row was freshly inserted; otherwise the conflict branch
  // ran and this is a duplicate delivery.
  const { rows } = await pool.query(
    `INSERT INTO webhook_events (event_id, source, event_type, signature_valid, status, payload)
     VALUES ($1, $2, $3, true, 'RECEIVED', $4)
     ON CONFLICT (source, event_id) WHERE signature_valid
     DO UPDATE SET received_count = webhook_events.received_count + 1, last_received_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [payload.event_id, source, payload.type, payload]
  );
  const { id, inserted } = rows[0];

  res.json({ received: true, duplicate: !inserted });

  if (inserted && config.webhookInlineProcessing) {
    setImmediate(() => processor.processOne(id).catch((err) => console.error(`webhook ${id}: ${err.message}`)));
  }
});

module.exports = { router, signatureValid };
