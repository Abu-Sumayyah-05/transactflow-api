// Shows where a payment or bank transfer stands, and keeps asking the
// backend while it isn't final. Used by Checkout and Transfer.
//
// A payment in UNKNOWN means the bank went quiet. We never guess: the screen
// says "confirming" and polls GET /payments/:id, which makes the backend ask
// the bank (TSQ) each time.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Badge, Note } from '../ui.jsx';

const FINAL = new Set(['COMPLETED', 'FAILED']);

export function usePaymentPolling(payment, setPayment) {
  const waiting = payment && !FINAL.has(payment.status) && !payment.challenge;
  const id = payment?.id;
  useEffect(() => {
    if (!waiting || !id) return undefined;
    const t = setInterval(async () => {
      try {
        setPayment(await api.get(`/payments/${id}`));
      } catch {
        /* keep trying; the next tick may succeed */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [waiting, id, setPayment]);
}

export default function PaymentStatus({ payment, onAgain, againLabel = 'Make another' }) {
  const [dots, setDots] = useState('');
  const final = FINAL.has(payment.status);
  useEffect(() => {
    if (final) return undefined;
    const t = setInterval(() => setDots((d) => (d.length >= 3 ? '' : `${d}.`)), 500);
    return () => clearInterval(t);
  }, [final]);

  const tone = payment.status === 'COMPLETED' ? 'good' : payment.status === 'FAILED' ? 'bad' : 'warn';
  return (
    <div className="card stack" data-testid="payment-status">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>
          {payment.status === 'COMPLETED' ? 'Done' : payment.status === 'FAILED' ? 'Not completed' : `Confirming${dots}`}
        </h2>
        <Badge>{payment.status}</Badge>
      </div>
      <div className="balance" style={{ fontSize: '2.2rem' }}>{payment.amount_display}</div>
      <Note tone={tone} data-testid="payment-message">{payment.message}</Note>
      <div className="dim small mono">
        Reference {payment.reference}
        {payment.bank ? ` · Bank ${payment.bank}` : ''}
      </div>
      {final && (
        <div className="row">
          <button className="primary" onClick={onAgain}>{againLabel}</button>
          <Link className="btn" to="/wallet">Back to wallet</Link>
        </div>
      )}
    </div>
  );
}
