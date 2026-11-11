// Screen 3: checkout (top up the wallet from a card).
//
//   1. Card      the card details go ONLY to the vault (POST /cards), which
//                hands back a token. Nothing else in the app sees the number,
//                and the CVV is never stored. (Hosted-fields style: in a real
//                product this box would be an iframe served by the vault.)
//   2. Pay       POST /payments with the token and an Idempotency-Key. The
//                key is made once per payment attempt and reused on every
//                press, so a double-tapped Pay charges once.
//   3. Challenge medium-risk payments stop here for a one-time code
//                (POST /payments/:id/challenge), 3DS style.
//   4. Result    success, a decline with its reason, or "confirming" while
//                the backend finds out what the bank really did.
import { useRef, useState } from 'react';
import { api, nairaToKobo, newKey } from '../api.js';
import { Field, Note, Page, useAction, useLoad } from '../ui.jsx';
import PaymentStatus, { usePaymentPolling } from './PaymentStatus.jsx';

const EMPTY_CARD = { number: '', exp_month: '', exp_year: '', cvv: '' };

export default function Checkout() {
  const cards = useLoad(() => api.get('/cards'));
  const [cardToken, setCardToken] = useState('');
  const [card, setCard] = useState(EMPTY_CARD);
  const [amount, setAmount] = useState('');
  const [billing, setBilling] = useState({ line1: '', city: '', country: 'NG' });
  const [payment, setPayment] = useState(null);
  const [otp, setOtp] = useState('');
  const [otpError, setOtpError] = useState(null);
  const pay = useAction();
  const verify = useAction();
  // One key per payment attempt, one per challenge attempt.
  const payKey = useRef(newKey());
  const challengeKey = useRef(newKey());

  usePaymentPolling(payment, setPayment);

  const saved = cards.data?.cards || [];
  const useNew = cardToken === '' || cardToken === 'new';

  const startOver = () => {
    payKey.current = newKey();
    challengeKey.current = newKey();
    setPayment(null);
    setOtp('');
    setOtpError(null);
    setAmount('');
    cards.reload();
  };

  const submit = (e) => {
    e.preventDefault();
    pay.run(async () => {
      const kobo = nairaToKobo(amount);
      if (!kobo) throw new Error('Enter an amount in naira, such as 1500 or 1500.50');
      let token = cardToken;
      if (useNew) {
        const created = await api.post('/cards', {
          number: card.number,
          cvv: card.cvv,
          exp_month: Number(card.exp_month),
          exp_year: Number(card.exp_year.length === 2 ? `20${card.exp_year}` : card.exp_year),
        });
        token = created.token;
        setCardToken(token);
        setCard(EMPTY_CARD); // the number leaves the page as soon as the vault has it
      }
      const body = { card_token: token, amount_kobo: kobo };
      if (billing.line1.trim()) body.billing_address = { line1: billing.line1, city: billing.city, country: billing.country.toUpperCase() };
      setPayment(await api.post('/payments', body, payKey.current));
    });
  };

  const submitOtp = (e) => {
    e.preventDefault();
    setOtpError(null);
    verify.run(async () => {
      try {
        setPayment(await api.post(`/payments/${payment.id}/challenge`, { otp }, challengeKey.current));
      } catch (err) {
        if (err.code !== 'INVALID_OTP') throw err;
        // A wrong code is a finished attempt: the next try needs its own key.
        challengeKey.current = newKey();
        setOtpError(err.message);
        setOtp('');
        setPayment((p) => ({ ...p, challenge: { ...p.challenge, attempts_left: err.attempts_left } }));
      }
    });
  };

  if (payment?.challenge) {
    return (
      <Page title="Verify it's you" subtitle="Your bank asks for a one-time code on this payment.">
        <form className="card stack" onSubmit={submitOtp} style={{ maxWidth: 460 }}>
          <div className="balance" style={{ fontSize: '2.2rem' }}>{payment.amount_display}</div>
          <p className="dim">You will not be charged until the code is accepted.</p>
          {payment.challenge.test_otp && (
            <Note tone="warn">
              Demo mode: a real bank would text this code to your phone. Your code is{' '}
              <strong className="mono" data-testid="demo-otp">{payment.challenge.test_otp}</strong>
            </Note>
          )}
          <Field label="6-digit code">
            <input
              className="mono"
              inputMode="numeric"
              maxLength={6}
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
              autoFocus
              required
            />
          </Field>
          <Note tone="bad">{otpError || verify.error?.message}</Note>
          <div className="row spread">
            <button className="primary" disabled={verify.busy || otp.length !== 6}>
              {verify.busy ? 'Checking…' : 'Verify and pay'}
            </button>
            <span className="dim small">{payment.challenge.attempts_left} tries left</span>
          </div>
        </form>
      </Page>
    );
  }

  if (payment) {
    return (
      <Page title="Top up">
        <div style={{ maxWidth: 520 }}>
          <PaymentStatus payment={payment} onAgain={startOver} againLabel="Top up again" />
        </div>
      </Page>
    );
  }

  return (
    <Page title="Top up" subtitle="Add money to your wallet from a card.">
      <form className="grid cols-2" onSubmit={submit}>
        <div className="card stack">
          <h2>Amount</h2>
          <Field label="Amount in naira">
            <input className="mono" inputMode="decimal" placeholder="5000.00" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </Field>
          <h2 style={{ marginTop: 24 }}>Billing address</h2>
          <Field label="Street address">
            <input value={billing.line1} onChange={(e) => setBilling({ ...billing, line1: e.target.value })} autoComplete="address-line1" />
          </Field>
          <div className="grid cols-2">
            <Field label="City">
              <input value={billing.city} onChange={(e) => setBilling({ ...billing, city: e.target.value })} autoComplete="address-level2" />
            </Field>
            <Field label="Country code">
              <input className="mono" maxLength={2} value={billing.country} onChange={(e) => setBilling({ ...billing, country: e.target.value })} />
            </Field>
          </div>
        </div>

        <div className="card stack">
          <h2>Card</h2>
          {saved.length > 0 && (
            <Field label="Pay with">
              <select value={useNew ? 'new' : cardToken} onChange={(e) => setCardToken(e.target.value)}>
                <option value="new">A new card</option>
                {saved.map((c) => (
                  <option key={c.token} value={c.token}>
                    {c.brand.toUpperCase()} ending {c.last4} (expires {String(c.exp_month).padStart(2, '0')}/{c.exp_year})
                  </option>
                ))}
              </select>
            </Field>
          )}
          {useNew && (
            <div className="vault">
              <div className="tag">Secure card vault</div>
              <Field label="Card number">
                <input className="mono" inputMode="numeric" autoComplete="cc-number" placeholder="4111 1111 1111 1111" value={card.number} onChange={(e) => setCard({ ...card, number: e.target.value })} required />
              </Field>
              <div className="grid cols-3" style={{ marginTop: 12 }}>
                <Field label="Month">
                  <input className="mono" inputMode="numeric" maxLength={2} placeholder="12" autoComplete="cc-exp-month" value={card.exp_month} onChange={(e) => setCard({ ...card, exp_month: e.target.value })} required />
                </Field>
                <Field label="Year">
                  <input className="mono" inputMode="numeric" maxLength={4} placeholder="2030" autoComplete="cc-exp-year" value={card.exp_year} onChange={(e) => setCard({ ...card, exp_year: e.target.value })} required />
                </Field>
                <Field label="CVV">
                  <input className="mono" type="password" inputMode="numeric" maxLength={4} placeholder="123" autoComplete="cc-csc" value={card.cvv} onChange={(e) => setCard({ ...card, cvv: e.target.value })} required />
                </Field>
              </div>
              <p className="dim small" style={{ margin: '12px 0 0' }}>
                The number is stored encrypted and replaced by a token. The CVV is never stored.
              </p>
            </div>
          )}
          <Note tone="bad">{pay.error?.message}</Note>
          <button className="primary" disabled={pay.busy} style={{ width: '100%' }}>
            {pay.busy ? 'Paying…' : 'Pay'}
          </button>
        </div>
      </form>
    </Page>
  );
}
