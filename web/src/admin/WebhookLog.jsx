// Admin screen 4: the webhook log. Every event a bank sent us: was the
// signature valid, was it new or a duplicate, and how many tries it took.
import { api, when } from '../api.js';
import { Badge, Note, Page, useLoad } from '../ui.jsx';

export default function WebhookLog() {
  const { data, error } = useLoad(() => api.get('/admin/webhooks'), [], 4000);
  const events = data?.events || [];
  return (
    <Page title="Webhook log" subtitle="Each event received from a bank. Refreshes every 4 seconds.">
      <Note tone="bad">{error?.message}</Note>
      <div className="card flush">
        {events.length === 0 ? (
          <div className="empty">No webhooks received yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Received</th>
                <th>Bank</th>
                <th>Event</th>
                <th>Signature</th>
                <th>Duplicate?</th>
                <th>Status</th>
                <th className="num">Tries</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="dim">{when(e.received_at)}</td>
                  <td>{e.source}</td>
                  <td>
                    {e.event_type || '—'}
                    <div className="dim small mono">{e.event_id || 'no event id'}</div>
                    {e.last_error && <div className="small" style={{ color: 'var(--bad)' }}>{e.last_error}</div>}
                  </td>
                  <td>{e.signature_valid ? <Badge tone="good">valid</Badge> : <Badge tone="bad">invalid</Badge>}</td>
                  <td>
                    {e.received_count > 1 ? <Badge tone="warn">{`received ${e.received_count} times`}</Badge> : <span className="dim">new</span>}
                  </td>
                  <td><Badge>{e.status}</Badge></td>
                  <td className="num mono">{e.attempts}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Page>
  );
}
