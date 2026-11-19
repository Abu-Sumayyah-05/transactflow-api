// Admin screen 3: reconciliation. Run it against a bank's settlement file,
// see how many items matched, are pending settlement, or are breaks, and
// resolve each break with a note. A halted run shows why the file was refused.
import { useState } from 'react';
import { api, naira, when } from '../api.js';
import { Badge, Note, Page, Stat, useAction, useLoad } from '../ui.jsx';

const BREAKS = ['MISSING_FROM_SWITCH', 'MISSING_FROM_BANK', 'AMOUNT_MISMATCH', 'DUPLICATE_POSTING'];
const REPORTS = [
  ['summary', 'Summary'],
  ['exceptions', 'Exceptions'],
  ['outstanding', 'Outstanding by age'],
  ['audit', 'Audit trail'],
];

function Item({ item, onDone }) {
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);
  const act = useAction();
  const isBreak = BREAKS.includes(item.class);
  const resolve = (e) => {
    e.preventDefault();
    act.run(async () => {
      await api.post(`/admin/recon/items/${item.id}/resolve`, { note });
      onDone();
    });
  };
  return (
    <tr>
      <td className="mono small">{item.reference}</td>
      <td>
        <Badge>{item.class}</Badge>
        {item.detail && <div className="dim small">{item.detail}</div>}
      </td>
      <td className="num amount">{naira(item.internal_amount)}</td>
      <td className="num amount">{naira(item.gateway_amount)}</td>
      <td className="num amount">{naira(item.bank_amount)}</td>
      <td>
        {item.resolved_at ? (
          <span className="small">
            <Badge tone="good">resolved</Badge>
            <div className="dim small">{item.resolution_note}</div>
          </span>
        ) : !isBreak ? (
          <span className="dim small">{item.class === 'MATCHED' ? '' : 'Waiting for the next file'}</span>
        ) : open ? (
          <form className="stack" onSubmit={resolve}>
            <input aria-label="Resolution note" placeholder="How was it resolved?" value={note} onChange={(e) => setNote(e.target.value)} required minLength={5} />
            <Note tone="bad">{act.error?.message}</Note>
            <div className="row">
              <button className="sm primary" disabled={act.busy}>Save</button>
              <button type="button" className="sm ghost" onClick={() => setOpen(false)}>Cancel</button>
            </div>
          </form>
        ) : (
          <button className="sm" onClick={() => setOpen(true)}>Resolve</button>
        )}
      </td>
    </tr>
  );
}

function Run({ id }) {
  const { data: run, error, reload } = useLoad(() => api.get(`/admin/recon/runs/${id}`), [id]);
  if (error) return <Note tone="bad">{error.message}</Note>;
  if (!run) return null;
  const c = run.counts || {};
  const breaks = BREAKS.reduce((n, k) => n + (c[k] || 0), 0);

  return (
    <div className="stack" data-testid="recon-run">
      <div className="row spread">
        <h2 style={{ margin: 0 }}>
          Run {run.id} · Bank {run.bank} <Badge>{run.status}</Badge>
        </h2>
        <div className="row">
          {REPORTS.map(([name, label]) => (
            <button key={name} className="sm" onClick={() => api.download(`/admin/recon/reports/${name}?run=${run.id}&format=csv`, `recon-${name}-run-${run.id}.csv`)}>
              {label} (CSV)
            </button>
          ))}
        </div>
      </div>

      {run.halt_reason && (
        <Note tone={run.status === 'HALTED' || run.status === 'FAILED' ? 'bad' : 'warn'} data-testid="halt-reason">
          {run.halt_reason}
        </Note>
      )}

      {run.status === 'COMPLETED' && (
        <div className="grid cols-4">
          <Stat label="Matched" value={c.MATCHED} tone="ok" />
          <Stat label="Pending settlement" value={c.PENDING_SETTLEMENT} tone={c.PENDING_SETTLEMENT ? 'warn' : undefined} hint="Timing, not a break" />
          <Stat label="Breaks" value={breaks} tone={breaks ? 'bad' : undefined} hint={BREAKS.filter((k) => c[k]).map((k) => `${c[k]} ${k.toLowerCase().replace(/_/g, ' ')}`).join(' · ')} />
          <Stat label="Statement" value={naira(run.closing_kobo)} hint={`${run.statement_ref} · opened ${naira(run.opening_kobo)} · ${run.entries_count} entries`} />
        </div>
      )}

      {run.flagged_lines.length > 0 && (
        <div className="card">
          <h3>Flagged lines ({run.flagged_lines.length})</h3>
          {run.flagged_lines.map((f) => (
            <div key={f.line} className="small">
              <span className="mono dim">line {f.line}</span> {f.reason}: <span className="mono">{f.text}</span>
            </div>
          ))}
        </div>
      )}

      {run.items.length > 0 && (
        <div className="card flush">
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Class</th>
                <th className="num">Our ledger</th>
                <th className="num">Bank said</th>
                <th className="num">Bank file</th>
                <th>Resolution</th>
              </tr>
            </thead>
            <tbody>
              {run.items.map((i) => (
                <Item key={i.id} item={i} onDone={reload} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function Recon() {
  const runs = useLoad(() => api.get('/admin/recon/runs'));
  const [open, setOpen] = useState(null);
  const start = useAction();

  const run = (bank) =>
    start.run(async () => {
      const r = await api.post('/admin/recon/run', { bank });
      setOpen(r.id);
      runs.reload();
    });

  return (
    <Page
      title="Reconciliation"
      subtitle="Our ledger against each bank's settlement file. Runs nightly; run it now with the buttons."
      actions={
        <>
          <button className="primary" disabled={start.busy} onClick={() => run('A')}>Run Bank A</button>
          <button className="primary" disabled={start.busy} onClick={() => run('B')}>Run Bank B</button>
        </>
      }
    >
      <Note tone="bad">{start.error?.message || runs.error?.message}</Note>
      {open && (
        <div style={{ marginBottom: 24 }}>
          <Run key={open} id={open} />
        </div>
      )}
      <h2>Runs</h2>
      <div className="card flush">
        {(runs.data?.runs || []).length === 0 ? (
          <div className="empty">No runs yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Started</th>
                <th>Bank</th>
                <th>Status</th>
                <th className="num">Matched</th>
                <th className="num">Pending</th>
                <th className="num">Breaks</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.runs.map((r) => {
                const c = r.counts;
                return (
                  <tr key={r.id} className="click" onClick={() => setOpen(r.id)}>
                    <td className="mono">{r.id}</td>
                    <td className="dim">{when(r.started_at)}</td>
                    <td>{r.bank} <span className="dim small">{r.trigger.toLowerCase()}</span></td>
                    <td><Badge>{r.status}</Badge></td>
                    <td className="num mono">{c ? c.MATCHED : '—'}</td>
                    <td className="num mono">{c ? c.PENDING_SETTLEMENT : '—'}</td>
                    <td className="num mono">{c ? BREAKS.reduce((n, k) => n + c[k], 0) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Page>
  );
}
