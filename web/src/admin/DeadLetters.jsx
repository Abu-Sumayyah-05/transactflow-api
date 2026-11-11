// Admin screen 5: the dead-letter queue. Events that failed every retry and
// now wait for a person. Replay runs the event again from the start.
import { api, when } from '../api.js';
import { Badge, Note, Page, useAction, useLoad } from '../ui.jsx';

function Dead({ event, onDone }) {
  const act = useAction();
  const replay = () =>
    act.run(async () => {
      await api.post(`/admin/dlq/${event.id}/replay`);
      onDone();
    });
  return (
    <div className="card stack" data-testid="dead-letter">
      <div className="row spread">
        <div>
          <strong>{event.event_type}</strong> <span className="dim">from Bank {event.source}</span>
          <div className="dim small mono">{event.event_id}</div>
        </div>
        <div className="row">
          <span className="dim small">{event.attempts} tries · {when(event.received_at)}</span>
          <button className="primary" disabled={act.busy} onClick={replay}>{act.busy ? 'Replaying…' : 'Replay'}</button>
        </div>
      </div>
      <Note tone="bad">{act.error?.message || event.last_error}</Note>
      <pre className="mono small dim" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
        {JSON.stringify(event.payload?.data ?? event.payload, null, 2)}
      </pre>
    </div>
  );
}

export default function DeadLetters() {
  const { data, error, reload } = useLoad(() => api.get('/admin/dlq'), [], 5000);
  const events = data?.events || [];
  return (
    <Page title="Dead-letter queue" subtitle="Bank events that failed repeatedly. Fix the cause, then replay.">
      <Note tone="bad">{error?.message}</Note>
      {events.length === 0 && data ? (
        <div className="card empty">
          Empty. <Badge tone="good">all events processed</Badge>
        </div>
      ) : (
        <div className="stack">
          {events.map((e) => (
            <Dead key={e.id} event={e} onDone={reload} />
          ))}
        </div>
      )}
    </Page>
  );
}
