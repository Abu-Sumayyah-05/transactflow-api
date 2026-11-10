// Gateway adapter: the ONE place that talks to banks. Every bank answer is
// translated into one of four outcomes the rest of the app understands:
//
//   SUCCESS    the bank confirmed it
//   DECLINED   the bank confirmed it refused (with response_code)
//   NOT_FOUND  (queries only) the bank has no record, so it never happened
//   UNKNOWN    anything else: timeout, network error, 5xx, garbage.
//              We do NOT know whether money moved, so we must not guess.
//
// Phase 5 adds retries with backoff and the circuit breaker here.
const config = require('../config');

function bankUrl(bank) {
  const url = process.env[`BANK_${bank}_URL`];
  if (!url) throw new Error(`BANK_${bank}_URL is not configured`);
  return url;
}

async function call(bank, method, path, body) {
  let res;
  try {
    res = await fetch(`${bankUrl(bank)}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(config.gatewayTimeoutMs),
    });
  } catch (err) {
    const reason = err.name === 'TimeoutError' ? 'timeout' : 'network_error';
    return { httpStatus: null, reason };
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body: treated as unknown below */
  }
  return { httpStatus: res.status, json };
}

function unknown(r) {
  return { outcome: 'UNKNOWN', reason: r.reason || `http_${r.httpStatus}` };
}

async function charge(bank, { reference, amountKobo, card }) {
  const r = await call(bank, 'POST', '/charges', {
    reference,
    amount_kobo: amountKobo,
    pan: card.pan,
    exp_month: card.expMonth,
    exp_year: card.expYear,
  });
  return interpretCharge(r);
}

function interpretCharge(r) {
  if (r.httpStatus === 200 && r.json?.status === 'APPROVED') {
    return { outcome: 'SUCCESS', responseCode: r.json.response_code, bankReference: r.json.bank_reference };
  }
  if (r.httpStatus === 200 && r.json?.status === 'DECLINED') {
    return { outcome: 'DECLINED', responseCode: r.json.response_code, bankReference: r.json.bank_reference };
  }
  return unknown(r);
}

async function queryCharge(bank, reference) {
  const r = await call(bank, 'GET', `/charges/${encodeURIComponent(reference)}`);
  if (r.httpStatus === 404 && r.json?.status === 'NOT_FOUND') return { outcome: 'NOT_FOUND' };
  return interpretCharge(r);
}

async function nameEnquiry(bank, accountNumber) {
  const r = await call(bank, 'GET', `/accounts/${encodeURIComponent(accountNumber)}`);
  if (r.httpStatus === 200 && r.json?.account_name) return { outcome: 'SUCCESS', accountName: r.json.account_name };
  if (r.httpStatus === 404) return { outcome: 'NOT_FOUND' };
  return unknown(r);
}

function interpretTransfer(r) {
  if (r.httpStatus === 200 && r.json?.status === 'SUCCESSFUL') {
    return { outcome: 'SUCCESS', responseCode: r.json.response_code, bankReference: r.json.bank_reference };
  }
  if (r.httpStatus === 200 && r.json?.status === 'FAILED') {
    return { outcome: 'DECLINED', responseCode: r.json.response_code, bankReference: r.json.bank_reference };
  }
  return unknown(r);
}

async function transfer(bank, { reference, accountNumber, amountKobo }) {
  const r = await call(bank, 'POST', '/transfers', { reference, account_number: accountNumber, amount_kobo: amountKobo });
  return interpretTransfer(r);
}

async function queryTransfer(bank, reference) {
  const r = await call(bank, 'GET', `/transfers/${encodeURIComponent(reference)}`);
  if (r.httpStatus === 404 && r.json?.status === 'NOT_FOUND') return { outcome: 'NOT_FOUND' };
  return interpretTransfer(r);
}

module.exports = { charge, queryCharge, nameEnquiry, transfer, queryTransfer };
