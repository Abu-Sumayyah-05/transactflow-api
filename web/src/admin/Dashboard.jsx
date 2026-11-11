// Admin screen 1: the live dashboard. Refreshes every 3 seconds from
// GET /admin/metrics, which reads the payments table directly (no cache).
import { useState } from 'react';
import { api, naira, percent } from '../api.js';
import { Badge, Note, Page, Stat, useLoad } from '../ui.jsx';

const ms = (v) => (v === null || v === undefined ? '—' : `${v} ms`);
const BREAKER_TONE = { CLOSED: 'good', HALF_OPEN: 'warn', OPEN: 'bad' };

export default function Dashboard() {
  const [windowMin, setWindowMin] = useState(60);
  const { data: m, error } = useLoad(() => api.get(`/admin/metrics?window=${windowMin}`), [windowMin], 3000);
  if (!m) return <Note tone="bad">{error?.message}</Note>;
  const cp = m.critical_path;

  return (
    <Page
      title="Live dashboard"
      subtitle="Refreshes every 3 seconds."
      actions={
        <select value={windowMin} onChange={(e) => setWindowMin(Number(e.target.value))} aria-label="Time window" style={{ width: 'auto' }}>
          <option value={15}>Last 15 minutes</option>
          <option value={60}>Last hour</option>
          <option value={1440}>Last 24 hours</option>
          <option value={10080}>Last 7 days</option>
        </select>
      }
    >
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat
          label="Success rate"
          value={percent(m.success_rate)}
          hint={`${m.payments.completed} completed · ${m.payments.failed} failed`}
          tone={m.success_rate === null ? undefined : m.success_rate >= 0.9 ? 'lime' : 'amber'}
        />
        <Stat label="p99 latency" value={ms(m.latency_ms.p99)} hint={`p50 ${ms(m.latency_ms.p50)} · ${m.latency_ms.samples} requests`} />
        <Stat label="Volume" value={m.volume.completed_display} hint={`${m.volume.completed_count} completed payments`} />
        <Stat
          label="Unresolved"
          value={m.payments.unresolved}
          hint="Pending or unknown, being confirmed"
          tone={m.payments.unresolved ? 'amber' : undefined}
        />
      </div>

      <h2>Gateway health</h2>
      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        {m.by_bank.map((b) => (
          <div className="card stack" key={b.bank} data-testid={`bank-${b.bank}`}>
            <div className="row spread">
              <h3 style={{ margin: 0 }}>Mock Bank {b.bank}</h3>
              <span>
                <span className="dim small">Circuit breaker </span>
                <Badge tone={BREAKER_TONE[b.breaker]}>{b.breaker}</Badge>
              </span>
            </div>
            <div className="grid cols-3">
              <div className="stat">
                <div className="label">Authorization rate</div>
                <div className="value">{percent(b.card.authorization_rate)}</div>
                <div className="dim small">{b.card.approved} approved · {b.card.declined} declined</div>
              </div>
              <div className="stat">
                <div className="label">Transfers</div>
                <div className="value">{percent(b.transfers.success_rate)}</div>
                <div className="dim small">{b.transfers.completed} sent · {b.transfers.failed} failed</div>
              </div>
              <div className="stat">
                <div className="label">Bank p99</div>
                <div className="value">{ms(b.latency_ms.p99)}</div>
                <div className="dim small">{b.card.unknown + b.transfers.unknown} unanswered</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid cols-3">
        <div className="card stat">
          <div className="label">Critical path (our side) p99</div>
          <div className="value" style={{ color: cp.within_target === false ? 'var(--amber)' : 'var(--lime)' }}>{ms(cp.p99_ms)}</div>
          <div className="dim small">Target under {cp.target_ms} ms, excluding the bank's own time</div>
        </div>
        <div className="card stat">
          <div className="label">Fraud decisions</div>
          <div className="value">{m.fraud.approved + m.fraud.challenged + m.fraud.blocked}</div>
          <div className="dim small">
            {m.fraud.approved} approved · {m.fraud.challenged} challenged · {m.fraud.blocked} blocked
          </div>
        </div>
        <div className="card stat">
          <div className="label">Outbox backlog</div>
          <div className="value" style={{ color: m.outbox.unpublished > 100 ? 'var(--amber)' : undefined }}>{m.outbox.unpublished}</div>
          <div className="dim small">
            {m.outbox.unpublished ? `Oldest waiting ${Math.round(m.outbox.oldest_unpublished_seconds)} s (is the worker running?)` : 'Every event published'}
          </div>
        </div>
      </div>
      <p className="dim small" style={{ marginTop: 16 }}>
        Completed value in window: {naira(m.volume.completed_kobo)}
      </p>
    </Page>
  );
}
