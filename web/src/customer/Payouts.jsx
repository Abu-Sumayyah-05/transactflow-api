// Screen 6: payouts (merchants). Upload a CSV, watch the batch progress, read
// the per-row result. The backend reserves the money for all valid rows up
// front, pays in sub-batches of 100, and each row has its own idempotency
// key, so a crash and rerun pays nobody twice.
import { useRef, useState } from 'react';
import { api, naira, newKey, when } from '../api.js';
import { Badge, Note, Page, useAction, useLoad } from '../ui.jsx';
import { useSession } from '../session.js';

const SAMPLE = `bank,account_number,account_name,amount,reference
A,0123456789,Ngozi Eze,1500.00,INV-0001
A,0000000001,Ibrahim Musa,2500.00,INV-0002
B,0987654321,Funke Adeyemi,750.50,INV-0003`;

const REASONS = {
  INVALID_BANK: 'Unknown bank',
  INVALID_ACCOUNT_NUMBER: 'Account number must be 10 digits',
  INVALID_ACCOUNT_NAME: 'Account name missing',
  INVALID_AMOUNT: 'Amount is not valid',
  AMOUNT_TOO_SMALL: 'Amount too small',
  AMOUNT_TOO_LARGE: 'Amount over the per-payout limit',
  INVALID_REFERENCE: 'Reference is not valid',
  DUPLICATE_REFERENCE: 'Reference already used',
  DUPLICATE_PAYMENT: 'Same account and amount as an earlier row',
  MALFORMED_ROW: 'Row has the wrong number of columns',
  NAME_MISMATCH: 'Name does not match the bank\'s record',
  ACCOUNT_NOT_FOUND: 'The bank has no such account',
};

function Batch({ id }) {
  // Poll while the batch is still being paid.
  const [done, setDone] = useState(false);
  const { data: b, error } = useLoad(
    async () => {
      const r = await api.get(`/payouts/batches/${id}`);
      setDone(r.status === 'DONE');
      return r;
    },
    [id],
    done ? 0 : 1500
  );
  if (error) return <Note tone="bad">{error.message}</Note>;
  if (!b) return null;
  const c = b.counts;
  return (
    <div className="stack" data-testid="batch">
      <div className="card stack">
        <div className="row spread">
          <h2 style={{ margin: 0 }}>Batch progress</h2>
          <Badge>{b.status}</Badge>
        </div>
        <div className="bar" role="progressbar" aria-valuenow={b.progress_percent} aria-valuemin={0} aria-valuemax={100}>
          <div style={{ width: `${b.progress_percent}%` }} />
        </div>
        <div className="row spread">
          <span className="mono" data-testid="batch-progress">{b.progress_percent}%</span>
          <span className="dim small">
            {c.paid} paid · {c.failed} failed · {c.rejected} rejected · {c.processing} in progress · {c.queued} queued
          </span>
        </div>
        <div className="row">
          {b.sub_batches.map((s) => (
            <span key={s.number} className="small">
              Sub-batch {s.number} ({s.size}) <Badge>{s.status}</Badge>
            </span>
          ))}
        </div>
        <div className="row spread">
          <span className="dim small">
            Reserved {naira(b.reserved_kobo)} · Paid out <span className="amount">{b.paid_display}</span>
          </span>
          <button className="sm" onClick={() => api.download(`/payouts/batches/${id}?format=csv`, `payout-report-${id}.csv`)}>
            Download report (CSV)
          </button>
        </div>
      </div>
      <div className="card flush">
        <table>
          <thead>
            <tr>
              <th>Row</th>
              <th>Reference</th>
              <th>Recipient</th>
              <th className="num">Amount</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {b.items.map((i) => (
              <tr key={i.row}>
                <td className="mono dim">{i.row}</td>
                <td className="mono">{i.reference || '—'}</td>
                <td>
                  {i.account_name || '—'}
                  <div className="dim small mono">{i.bank && `${i.bank} · ${i.account_number}`}</div>
                </td>
                <td className="num amount">{naira(i.amount_kobo)}</td>
                <td>
                  <Badge>{i.status}</Badge>
                  {i.reason && <div className="dim small">{REASONS[i.reason] || i.reason}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function Payouts() {
  const { me } = useSession();
  const [csv, setCsv] = useState('');
  const [open, setOpen] = useState(null);
  const upload = useAction();
  const key = useRef(newKey());
  const list = useLoad(() => (me.role === 'merchant' ? api.get('/payouts/batches') : { batches: [] }), [me.role]);

  if (me.role !== 'merchant') {
    return (
      <Page title="Payouts">
        <Note tone="warn">Payouts are for merchant accounts. Ask an administrator to make your account a merchant, then sign in again.</Note>
      </Page>
    );
  }

  const readFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setCsv(String(reader.result));
      key.current = newKey(); // a different file is a different upload
    };
    reader.readAsText(file);
  };

  const submit = (e) => {
    e.preventDefault();
    upload.run(async () => {
      const batch = await api.postCsv('/payouts/batches', csv, key.current);
      key.current = newKey();
      setCsv('');
      setOpen(batch.id);
      list.reload();
    });
  };

  return (
    <Page title="Payouts" subtitle="Pay many people at once from a CSV file.">
      <div className="grid cols-2">
        <form className="card stack" onSubmit={submit}>
          <h2>Upload a batch</h2>
          <input type="file" accept=".csv,text/csv" onChange={readFile} aria-label="CSV file" />
          <textarea
            aria-label="CSV contents"
            placeholder={SAMPLE}
            value={csv}
            onChange={(e) => {
              setCsv(e.target.value);
              key.current = newKey();
            }}
          />
          <p className="dim small">
            Columns: bank, account_number, account_name, amount (naira), reference.{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); setCsv(SAMPLE); key.current = newKey(); }}>Use the sample</a>
          </p>
          <Note tone="bad">{upload.error?.message}</Note>
          <button className="primary" disabled={upload.busy || !csv.trim()}>{upload.busy ? 'Checking rows…' : 'Upload and pay'}</button>
        </form>

        <div className="card flush">
          {(list.data?.batches || []).length === 0 ? (
            <div className="empty">No batches yet.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Uploaded</th>
                  <th>Rows</th>
                  <th>Status</th>
                  <th className="num">Paid</th>
                </tr>
              </thead>
              <tbody>
                {list.data.batches.map((b) => (
                  <tr key={b.id} className="click" onClick={() => setOpen(b.id)}>
                    <td className="dim">{when(b.created_at)}</td>
                    <td className="mono">{b.valid_rows}/{b.total_rows}</td>
                    <td><Badge>{b.status}</Badge></td>
                    <td className="num amount">{b.paid_display}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {open && (
        <div style={{ marginTop: 16 }}>
          <Batch key={open} id={open} />
        </div>
      )}
    </Page>
  );
}
