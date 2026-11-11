// One place for every call to the backend.
//
// - The JWT from login is kept in localStorage and sent as a Bearer token.
// - Errors from the API ({ error: { code, message } }) become thrown ApiError
//   objects, so a screen can show error.message as is: the backend already
//   words them for customers.
// - A 401 means the session ended: the token is dropped and the app goes
//   back to the sign-in screen.

const TOKEN_KEY = 'tf_token';
const DEVICE_KEY = 'tf_device';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY));

// A stable id for this browser. The fraud rules use it for "new device".
export function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = `web-${crypto.randomUUID()}`;
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

// A fresh Idempotency-Key. A screen makes ONE per thing the user is trying to
// do (one payment, one transfer) and reuses it if the button is pressed
// again or the request is retried, so the backend does the thing once.
export const newKey = () => crypto.randomUUID();

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => (onUnauthorized = fn);

async function request(method, path, { body, key, csv, raw } = {}) {
  const headers = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (key) headers['Idempotency-Key'] = key;
  let payload;
  if (csv !== undefined) {
    headers['Content-Type'] = 'text/csv';
    payload = csv;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (path === '/payments' && method === 'POST') headers['X-Device-Id'] = deviceId();

  let res;
  try {
    res = await fetch(`/api/v1${path}`, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Could not reach TransactFlow. Check your connection and try again.');
  }
  if (raw && res.ok) return res;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && token) {
      setToken(null);
      onUnauthorized();
    }
    const err = data?.error || {};
    throw new ApiError(res.status, err.code || 'ERROR', err.message || `Something went wrong (${res.status})`, err);
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body, key) => request('POST', path, { body, key }),
  postCsv: (path, csv, key) => request('POST', path, { csv, key }),
  // Downloads a file from an endpoint that needs the token (a plain <a>
  // link can't send it).
  async download(path, filename) {
    const res = await request('GET', path, { raw: true });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
};

// "1,500.50" -> 150050, working on the digits as text so no float is ever
// involved (the same rule as the backend). Returns null if it isn't an amount.
export function nairaToKobo(input) {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(input).replace(/,/g, '').trim());
  if (!m) return null;
  const kobo = Number(m[1] + (m[2] || '').padEnd(2, '0'));
  return Number.isSafeInteger(kobo) && kobo > 0 ? kobo : null;
}

// 150050 -> "₦1,500.50". Integer maths only.
export function naira(kobo) {
  if (kobo === null || kobo === undefined) return '—';
  const abs = Math.abs(kobo);
  return `${kobo < 0 ? '-' : ''}₦${Math.trunc(abs / 100).toLocaleString('en-NG')}.${String(abs % 100).padStart(2, '0')}`;
}

export const when = (iso) =>
  iso ? new Date(iso).toLocaleString('en-NG', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

export const percent = (rate) => (rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(1)}%`);
