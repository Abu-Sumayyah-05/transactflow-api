// Screen 4: transfer. Two steps on purpose:
//   1. name enquiry: the backend looks the recipient up and we SHOW the
//      account name, so a typo doesn't send money to a stranger
//   2. confirm: POST /transfers with one Idempotency-Key for this transfer
// A bank transfer can take a moment (or come back UNKNOWN), so the status
// keeps updating until it is final.
import { useRef, useState } from 'react';
import { api, naira, nairaToKobo, newKey } from '../api.js';
import { Field, Note, Page, useAction } from '../ui.jsx';
import PaymentStatus, { usePaymentPolling } from './PaymentStatus.jsx';

export default function Transfer() {
  const [kind, setKind] = useState('wallet');
  const [form, setForm] = useState({ email: '', bank: 'A', account_number: '', amount: '' });
  const [recipient, setRecipient] = useState(null); // set once the name is confirmed
  const [result, setResult] = useState(null);
  const lookup = useAction();
  const send = useAction();
  const key = useRef(newKey());
  const set = (k) => (e) => {
    setForm({ ...form, [k]: e.target.value });
    setRecipient(null); // any change means the name must be checked again
  };

  usePaymentPolling(result?.id ? result : null, setResult);

  const reset = () => {
    key.current = newKey();
    setRecipient(null);
    setResult(null);
    setForm({ ...form, amount: '' });
  };

  const check = (e) => {
    e.preventDefault();
    lookup.run(async () => {
      const kobo = nairaToKobo(form.amount);
      if (!kobo) throw new Error('Enter an amount in naira, such as 1500 or 1500.50');
      const query =
        kind === 'wallet'
          ? `email=${encodeURIComponent(form.email)}`
          : `bank=${form.bank}&account_number=${encodeURIComponent(form.account_number)}`;
      const found = await api.get(`/transfers/name-enquiry?${query}`);
      setRecipient({ name: found.account_name, kobo });
    });
  };

  const confirm = () =>
    send.run(async () => {
      const body =
        kind === 'wallet'
          ? { recipient_email: form.email, amount_kobo: recipient.kobo }
          : { bank: form.bank, account_number: form.account_number, amount_kobo: recipient.kobo };
      setResult(await api.post('/transfers', body, key.current));
    });

  if (result) {
    // A bank transfer is a payment with live status; a wallet transfer is
    // instant and final.
    return (
      <Page title="Transfer">
        <div style={{ maxWidth: 520 }}>
          {result.id ? (
            <PaymentStatus payment={result} onAgain={reset} againLabel="Send another" />
          ) : (
            <div className="card stack" data-testid="payment-status">
              <h2>Sent</h2>
              <div className="balance" style={{ fontSize: '2.2rem' }}>{naira(result.amount_kobo)}</div>
              <Note tone="good" data-testid="payment-message">Sent to {result.recipient_name}. It is in their wallet now.</Note>
              <div>
                <button className="primary" onClick={reset}>Send another</button>
              </div>
            </div>
          )}
        </div>
      </Page>
    );
  }

  return (
    <Page title="Transfer" subtitle="Send money to another TransactFlow wallet or to a bank account.">
      <div className="card" style={{ maxWidth: 520 }}>
        <div className="tabs" role="tablist">
          <button type="button" className={kind === 'wallet' ? 'on' : ''} onClick={() => { setKind('wallet'); setRecipient(null); }}>
            To a wallet
          </button>
          <button type="button" className={kind === 'bank' ? 'on' : ''} onClick={() => { setKind('bank'); setRecipient(null); }}>
            To a bank account
          </button>
        </div>
        <form className="stack" onSubmit={check}>
          {kind === 'wallet' ? (
            <Field label="Recipient's email">
              <input type="email" value={form.email} onChange={set('email')} required />
            </Field>
          ) : (
            <div className="grid cols-2">
              <Field label="Bank">
                <select value={form.bank} onChange={set('bank')}>
                  <option value="A">Mock Bank A</option>
                  <option value="B">Mock Bank B</option>
                </select>
              </Field>
              <Field label="Account number (10 digits)">
                <input className="mono" inputMode="numeric" maxLength={10} value={form.account_number} onChange={set('account_number')} required />
              </Field>
            </div>
          )}
          <Field label="Amount in naira">
            <input className="mono" inputMode="decimal" placeholder="2500.00" value={form.amount} onChange={set('amount')} required />
          </Field>
          <Note tone="bad">{lookup.error?.message || send.error?.message}</Note>

          {!recipient ? (
            <button className="primary" disabled={lookup.busy}>{lookup.busy ? 'Checking…' : 'Check recipient'}</button>
          ) : (
            <div className="note stack" data-testid="name-enquiry">
              <div>
                <div className="dim small">You are sending</div>
                <div className="amount" style={{ fontSize: '1.4rem' }}>{naira(recipient.kobo)}</div>
              </div>
              <div>
                <div className="dim small">To</div>
                <div style={{ fontSize: '1.2rem', fontWeight: 600 }} data-testid="recipient-name">{recipient.name}</div>
              </div>
              <div className="row">
                <button type="button" className="primary" disabled={send.busy} onClick={confirm}>
                  {send.busy ? 'Sending…' : 'Confirm and send'}
                </button>
                <button type="button" className="ghost" onClick={() => setRecipient(null)}>Change</button>
              </div>
            </div>
          )}
        </form>
      </div>
    </Page>
  );
}
