// Admin screen 2: the fraud queue. Every flagged payment with its score and
// the rules that fired, so the analyst can see WHY before deciding.
//
//   payment still waiting for its code   Approve = charge it now, Block = cancel it
//   payment already stopped              Approve = false positive (the customer
//                                        may retry), Block = confirm the stop
import { useRef, useState } from 'react';
import { api, newKey, when } from '../api.js';
import { Badge, Note, Page, useAction, useLoad } from '../ui.jsx';

function Flag({ item, onDone }) {
  const act = useAction();
  // One key per flag: a double-clicked Approve charges once.
  const key = useRef(newKey());
  const waiting = item.payment.status === 'PENDING';
  const decide = (decision) =>
    act.run(async () => {
      await api.post(`/admin/fraud/${item.id}/decision`, { decision }, key.current);
      onDone();
    });

  return (
    <div className="card stack" data-testid="fraud-flag">
      <div className="row spread">
        <div>
          <div className="row">
            <span className="amount" style={{ fontSize: '1.3rem' }}>{item.payment.amount_display}</span>
            <Badge>{item.outcome}</Badge>
            <Badge>{item.payment.status}</Badge>
          </div>
          <div className="dim small">
            {item.customer_email} · {when(item.flagged_at)} · <span className="mono">{item.payment.reference}</span>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="dim small">Score</div>
          <div className="amount" style={{ fontSize: '1.8rem', color: item.score >= 80 ? 'var(--rose)' : 'var(--amber)' }}>{item.score}</div>
        </div>
      </div>
      <table>
        <tbody>
          {item.rules_fired.map((r) => (
            <tr key={r.rule}>
              <td className="mono" style={{ width: 70, color: r.points > 0 ? 'var(--rose)' : 'var(--lime)' }}>
                {r.points > 0 ? `+${r.points}` : r.points}
              </td>
              <td>{r.rule.replace(/_/g, ' ')}</td>
              <td className="dim">{r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Note tone="bad">{act.error?.message}</Note>
      <div className="row spread">
        <span className="dim small">
          {waiting ? 'Waiting for the customer\'s verification code.' : 'Already stopped; nothing was charged.'}
        </span>
        <div className="row">
          <button className="good" disabled={act.busy} onClick={() => decide('APPROVE')}>
            {waiting ? 'Approve and charge' : 'Approve (false positive)'}
          </button>
          <button className="primary" disabled={act.busy} onClick={() => decide('BLOCK')}>
            {waiting ? 'Block' : 'Confirm block'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function FraudQueue() {
  const [status, setStatus] = useState('OPEN');
  const { data, error, reload } = useLoad(() => api.get(`/admin/fraud?status=${status}`), [status], 5000);
  const items = data?.items || [];

  return (
    <Page
      title="Fraud queue"
      subtitle="Flagged payments, with the score and the rules that fired."
      actions={
        <div className="tabs" style={{ margin: 0 }}>
          {['OPEN', 'APPROVED', 'BLOCKED', 'ALL'].map((s) => (
            <button key={s} className={`sm ${status === s ? 'on' : ''}`} onClick={() => setStatus(s)}>
              {s[0] + s.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
      }
    >
      <Note tone="bad">{error?.message}</Note>
      {items.length === 0 && data && <div className="card empty">Nothing here.</div>}
      <div className="stack">
        {items.map((item) =>
          item.review_status === 'OPEN' ? (
            <Flag key={item.id} item={item} onDone={reload} />
          ) : (
            <div className="card row spread" key={item.id}>
              <div>
                <span className="amount">{item.payment.amount_display}</span> <span className="dim small">{item.customer_email}</span>
                <div className="dim small">
                  Score {item.score} · {item.rules_fired.map((r) => r.rule.replace(/_/g, ' ')).join(', ')}
                </div>
              </div>
              <div className="row">
                <Badge>{item.review_status}</Badge>
                <Badge>{item.payment.status}</Badge>
              </div>
            </div>
          )
        )}
      </div>
    </Page>
  );
}
