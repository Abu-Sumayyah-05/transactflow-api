// Screen 5: history. Every card payment and bank transfer with its state.
// Selecting one shows the receipt: the message, the reference, and the full
// trail of state changes (INITIALIZED -> PENDING -> ... ) from the backend's
// append-only event log.
import { useState } from 'react';
import { api, when } from '../api.js';
import { Badge, Note, Page, useLoad } from '../ui.jsx';

const WHAT = { CARD_TOPUP: 'Card top-up', BANK_TRANSFER: 'Bank transfer' };

function Receipt({ id, onClose }) {
  const { data: p, error } = useLoad(() => api.get(`/payments/${id}`), [id]);
  if (error) return <Note tone="bad">{error.message}</Note>;
  if (!p) return null;
  return (
    <div className="card stack" data-testid="receipt">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>Receipt</h2>
        <button className="sm ghost" onClick={onClose}>Close</button>
      </div>
      <div className="row spread">
        <div className="balance" style={{ fontSize: '2rem' }}>{p.amount_display}</div>
        <Badge>{p.status}</Badge>
      </div>
      <Note tone={p.status === 'COMPLETED' ? 'good' : p.status === 'FAILED' ? 'bad' : 'warn'}>{p.message}</Note>
      <table>
        <tbody>
          <tr><td className="dim">Type</td><td>{WHAT[p.type]}</td></tr>
          <tr><td className="dim">Reference</td><td className="mono">{p.reference}</td></tr>
          {p.account_name && <tr><td className="dim">Sent to</td><td>{p.account_name} <span className="mono dim">({p.account_number})</span></td></tr>}
          {p.bank && <tr><td className="dim">Bank</td><td>Mock Bank {p.bank}</td></tr>}
          {p.response_code && <tr><td className="dim">Bank response code</td><td className="mono">{p.response_code}</td></tr>}
          <tr><td className="dim">Started</td><td>{when(p.created_at)}</td></tr>
        </tbody>
      </table>
      <h3>What happened</h3>
      <ul className="timeline">
        {p.events.map((e, i) => (
          <li key={i}>
            <Badge>{e.to_status}</Badge> <span className="dim small">{when(e.at)}</span>
            {e.reason && <div className="dim small">{e.reason}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function History() {
  const { data, error, loading } = useLoad(() => api.get('/payments'), [], 5000);
  const [open, setOpen] = useState(null);
  if (loading) return null;
  const payments = data?.payments || [];

  return (
    <Page title="History" subtitle="Every payment and transfer, with its state and receipt.">
      <Note tone="bad">{error?.message}</Note>
      <div className={open ? 'grid cols-2' : 'grid'}>
        <div className="card flush">
          {payments.length === 0 ? (
            <div className="empty">No payments yet.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>What</th>
                  <th>State</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p) => (
                  <tr key={p.id} className="click" onClick={() => setOpen(p.id)}>
                    <td className="dim">{when(p.created_at)}</td>
                    <td>
                      {WHAT[p.type]}
                      <div className="dim small">
                        {p.card ? `${p.card.brand.toUpperCase()} ending ${p.card.last4}` : p.account_name}
                      </div>
                    </td>
                    <td><Badge>{p.status}</Badge></td>
                    <td className="num amount">{p.amount_display}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {open && <Receipt id={open} onClose={() => setOpen(null)} />}
      </div>
    </Page>
  );
}
