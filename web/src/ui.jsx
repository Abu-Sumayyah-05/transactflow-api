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

// Line icons, drawn in the current text colour. They are decoration only
// (aria-hidden), so a screen reader hears just the label beside them.
const ICONS = {
  wallet: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H18v3M3 7.5V17a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2H5.5A2.5 2.5 0 0 1 3 7.5ZM16.5 13.5h.01',
  plus: 'M12 5v14M5 12h14',
  send: 'M21 3 10 14M21 3l-7 18-4-7-7-4 18-7Z',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  layers: 'm12 3 9 5-9 5-9-5 9-5ZM3 13l9 5 9-5M3 17.5l9 5 9-5',
  pulse: 'M3 12h4l3-8 4 16 3-8h4',
  shield: 'M12 3 4.5 6v5.5c0 4.6 3.1 8.3 7.5 9.5 4.4-1.2 7.5-4.9 7.5-9.5V6L12 3ZM9 12l2 2 4-4',
  scale: 'M12 4v16M7 20h10M5 8h14M5 8l-3 6a3 3 0 0 0 6 0L5 8ZM19 8l-3 6a3 3 0 0 0 6 0l-3-6Z',
  inbox: 'M3 13h5l1.5 3h5L16 13h5M3 13l3-8h12l3 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5Z',
  alert: 'M12 9v4M12 17h.01M10.3 4.3 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0Z',
  sliders: 'M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4M16 4v4M8 10v4M14 16v4',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  flow: 'M4 8h11m0 0-3.5-3.5M15 8l-3.5 3.5M20 16H9m0 0 3.5-3.5M9 16l3.5 3.5',
};

export function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

// The logo: the mark plus the two-tone wordmark.
export function Brand() {
  return (
    <div className="brand">
      <div className="mark"><Icon name="flow" size={19} /></div>
      <div>Transact<span>Flow</span></div>
    </div>
  );
}

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
