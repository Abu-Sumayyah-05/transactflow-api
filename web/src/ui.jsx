// Small shared pieces used by every screen.
import { useCallback, useEffect, useRef, useState } from 'react';

const TONE = {
  COMPLETED: 'good', PAID: 'good', MATCHED: 'good', APPROVED: 'good', VERIFIED: 'good', PROCESSED: 'good', DONE: 'good', CLOSED: 'good', APPROVE: 'good',
  PENDING: 'warn', UNKNOWN: 'warn', AUTHORIZED: 'warn', PROCESSING: 'warn', QUEUED: 'warn', RUNNING: 'warn', PENDING_SETTLEMENT: 'warn',
  CHALLENGE: 'warn', RETRY: 'warn', RECEIVED: 'warn', HALF_OPEN: 'warn', UNVERIFIED: 'warn', INITIALIZED: 'warn', OPEN_FLAG: 'warn',
  FAILED: 'bad', REJECTED: 'bad', DEAD: 'bad', HALTED: 'bad', BLOCK: 'bad', BLOCKED: 'bad', OPEN: 'bad',
  MISSING_FROM_SWITCH: 'bad', MISSING_FROM_BANK: 'bad', AMOUNT_MISMATCH: 'bad', DUPLICATE_POSTING: 'bad',
  SKIPPED: 'plain',
};

export function Badge({ children, tone }) {
  const text = String(children ?? '');
  return <span className={`badge ${tone || TONE[text] || 'info'}`}>{text.replace(/_/g, ' ')}</span>;
}

export function Note({ tone = '', children, ...rest }) {
  if (!children) return null;
  return (
    <div className={`note ${tone}`} role={tone === 'bad' ? 'alert' : 'status'} {...rest}>
      {children}
    </div>
  );
}

export function Page({ title, subtitle, actions, children }) {
  return (
    <>
      <div className="head">
        <div>
          <h1>{title}</h1>
          {subtitle && <p className="dim">{subtitle}</p>}
        </div>
        {actions && <div className="row">{actions}</div>}
      </div>
      {children}
    </>
  );
}

export function Stat({ label, value, hint, tone }) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className="value" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </div>
      {hint && <div className="dim small">{hint}</div>}
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <div className="field">
      <label>
        {label}
        <div style={{ marginTop: 5 }}>{children}</div>
      </label>
    </div>
  );
}

// Loads data when the screen opens, and again every `every` ms if given
// (how "live" screens stay live). Returns { data, error, loading, reload }.
export function useLoad(fn, deps = [], every = 0) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const saved = useRef(fn);
  saved.current = fn;
  const reload = useCallback(async () => {
    try {
      const data = await saved.current();
      setState({ data, error: null, loading: false });
      return data;
    } catch (error) {
      setState((s) => ({ ...s, error, loading: false }));
      return null;
    }
  }, []);
  useEffect(() => {
    let alive = true;
    reload();
    if (!every) return undefined;
    const t = setInterval(() => alive && reload(), every);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, every]);
  return { ...state, reload };
}

// Runs an action from a button: tracks "busy" (so the button disables) and
// the error (so the screen can show it).
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = useCallback(async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(err);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clearError: () => setError(null) };
}
