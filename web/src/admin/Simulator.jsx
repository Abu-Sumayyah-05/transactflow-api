// Admin screen 6: simulator controls. A real bank sandbox can't be told to
// fail on demand; ours can. Each switch makes a mock bank misbehave in one
// specific way so the backend's handling can be shown live.
//
// The browser never talks to a bank: it asks our API (admin only), which
// forwards the setting to the bank.
import { useState } from 'react';
import { api } from '../api.js';
import { Badge, Field, Note, Page, useAction, useLoad } from '../ui.jsx';

const MODES = [
  ['normal', 'Normal', 'Answers straight away.'],
  ['timeout', 'Timeout', 'Processes the payment but never replies. Payment goes UNKNOWN, then TSQ finds the truth.'],
  ['slow', 'Slow', 'Replies after 5 to 10 seconds.'],
  ['error503', 'Error 503', 'Fails a share of calls. Retries, then the circuit breaker opens.'],
];
const OUTCOMES = [
  ['APPROVED', 'Approve'],
  ['DECLINED', 'Decline with one code'],
  ['DECLINE_CYCLE', 'Decline, each code in turn'],
];
const WEBHOOKS = [
  ['normal', 'One signed webhook'],
  ['duplicate', 'Send it 3 times'],
  ['bad_signature', 'Wrong signature'],
  ['off', 'No webhooks'],
];
const FAULTS = [
  ['badLine', 'A corrupted line'],
  ['missing', 'Leave one item out'],
  ['wrongClosing', 'Wrong closing balance'],
  ['wrongAmount', 'One wrong amount'],
  ['duplicate', 'Post one item twice'],
  ['extra', 'An item we never sent'],
];

function Bank({ bank, initial, reachable, onSaved }) {
  const [m, setM] = useState({
    mode: initial?.mode || 'normal',
    outcome: initial?.outcome || 'APPROVED',
    declineCode: initial?.declineCode || '51',
    errorRate: initial?.errorRate || 1,
    webhook: initial?.webhook || 'normal',
    settlement: initial?.settlement || {},
  });
  const act = useAction();
  const [saved, setSaved] = useState(false);
  const change = (patch) => {
    setM({ ...m, ...patch });
    setSaved(false);
  };
  const apply = (next = m) =>
    act.run(async () => {
      await api.post('/admin/simulator/mode', {
        bank,
        mode: next.mode,
        outcome: next.outcome,
        declineCode: next.declineCode,
        errorRate: next.mode === 'error503' ? Number(next.errorRate) : 0,
        webhook: next.webhook,
        webhookCopies: 3,
        settlement: next.settlement,
      });
      setSaved(true);
      onSaved();
    });
  const reset = () => {
    const clean = { mode: 'normal', outcome: 'APPROVED', declineCode: '51', errorRate: 1, webhook: 'normal', settlement: {} };
    setM(clean);
    apply(clean);
  };

  if (!reachable) {
    return (
      <div className="card stack">
        <h2>Mock Bank {bank}</h2>
        <Note tone="warn">Not running. Start it with <span className="mono">npm run bank:{bank.toLowerCase()}</span>.</Note>
      </div>
    );
  }

  return (
    <div className="card stack" data-testid={`sim-${bank}`}>
      <div className="row spread">
        <h2 style={{ margin: 0 }}>Mock Bank {bank}</h2>
        <Badge tone={initial?.mode === 'normal' && initial?.outcome === 'APPROVED' ? 'good' : 'warn'}>
          {`${initial?.mode} · ${initial?.outcome}`}
        </Badge>
      </div>

      <div>
        <label>How it responds</label>
        <div className="row">
          {MODES.map(([value, label]) => (
            <button key={value} type="button" className={`sm ${m.mode === value ? 'on' : ''}`} onClick={() => change({ mode: value })}>
              {label}
            </button>
          ))}
        </div>
        <p className="dim small" style={{ margin: '6px 0 0' }}>{MODES.find(([v]) => v === m.mode)[2]}</p>
        {m.mode === 'error503' && (
          <Field label={`Share of calls that fail: ${Math.round(m.errorRate * 100)}%`}>
            <input type="range" min="0.1" max="1" step="0.1" value={m.errorRate} onChange={(e) => change({ errorRate: e.target.value })} />
          </Field>
        )}
      </div>

      <div className="grid cols-2">
        <Field label="What it answers">
          <select value={m.outcome} onChange={(e) => change({ outcome: e.target.value })}>
            {OUTCOMES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        {m.outcome === 'DECLINED' ? (
          <Field label="Decline code">
            <select value={m.declineCode} onChange={(e) => change({ declineCode: e.target.value })}>
              <option value="51">51 insufficient funds</option>
              <option value="57">57 international use disabled</option>
              <option value="61">61 limit exceeded</option>
              <option value="59">59 suspected fraud</option>
              <option value="54">54 card expired</option>
              <option value="82">82 invalid CVV</option>
            </select>
          </Field>
        ) : (
          <Field label="Webhooks">
            <select value={m.webhook} onChange={(e) => change({ webhook: e.target.value })}>
              {WEBHOOKS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        )}
      </div>
      {m.outcome === 'DECLINED' && (
        <Field label="Webhooks">
          <select value={m.webhook} onChange={(e) => change({ webhook: e.target.value })}>
            {WEBHOOKS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
      )}

      <div>
        <label>Next settlement file (for reconciliation)</label>
        <div className="grid cols-2">
          {FAULTS.map(([k, l]) => (
            <label key={k} className="row" style={{ color: 'var(--ink)', margin: 0 }}>
              <input
                type="checkbox"
                checked={Boolean(m.settlement[k])}
                onChange={(e) => {
                  const s = { ...m.settlement };
                  if (e.target.checked) s[k] = true;
                  else delete s[k];
                  change({ settlement: s });
                }}
              />
              {l}
            </label>
          ))}
        </div>
      </div>

      <Note tone="bad">{act.error?.message}</Note>
      <div className="row">
        <button className="primary" disabled={act.busy} onClick={() => apply()}>Apply to Bank {bank}</button>
        <button className="ghost" disabled={act.busy} onClick={reset}>Back to normal</button>
        {saved && <Badge tone="good">applied</Badge>}
      </div>
    </div>
  );
}

function Chargeback() {
  const [reference, setReference] = useState('');
  const [done, setDone] = useState(null);
  const act = useAction();
  const submit = (e) => {
    e.preventDefault();
    setDone(null);
    act.run(async () => {
      await api.post('/admin/simulator/dispute', { reference: reference.trim() });
      setDone(reference.trim());
    });
  };
  return (
    <form className="card stack" onSubmit={submit}>
      <h2>Raise a chargeback</h2>
      <p className="dim small">
        The bank disputes a completed card top-up. It arrives as a signed webhook, and the money moves from the customer's wallet into escrow.
      </p>
      <Field label="Payment reference">
        <input className="mono" placeholder="TF-…" value={reference} onChange={(e) => setReference(e.target.value)} required />
      </Field>
      <Note tone="bad">{act.error?.message}</Note>
      {done && <Note tone="good">Chargeback raised for {done}. Check the webhook log.</Note>}
      <div>
        <button className="primary" disabled={act.busy}>Raise chargeback</button>
      </div>
    </form>
  );
}

export default function Simulator() {
  const { data, error, reload } = useLoad(() => api.get('/admin/simulator'));
  return (
    <Page title="Simulator controls" subtitle="Make the mock banks misbehave, then watch the system cope.">
      <Note tone="bad">{error?.message}</Note>
      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        {(data?.banks || []).map((b) => (
          <Bank key={b.bank} bank={b.bank} initial={b.mode} reachable={b.reachable} onSaved={reload} />
        ))}
      </div>
      <div style={{ maxWidth: 560 }}>
        <Chargeback />
      </div>
    </Page>
  );
}
