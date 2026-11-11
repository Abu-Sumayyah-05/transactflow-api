// Screen 1: sign up and log in. One form, two modes.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, setToken } from '../api.js';
import { Field, Note, useAction } from '../ui.jsx';

export default function Login({ onSignedIn }) {
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ full_name: '', email: '', password: '' });
  const { busy, error, run, clearError } = useAction();
  const navigate = useNavigate();
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      if (mode === 'register') await api.post('/auth/register', form);
      const { token } = await api.post('/auth/login', { email: form.email, password: form.password });
      setToken(token);
      await onSignedIn();
      navigate('/');
    });
  };

  return (
    <div className="auth">
      <form className="card stack" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}>
          Transact<span>Flow</span>
        </div>
        <h1>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
        {mode === 'register' && (
          <Field label="Full name">
            <input value={form.full_name} onChange={set('full_name')} autoComplete="name" required />
          </Field>
        )}
        <Field label="Email">
          <input type="email" value={form.email} onChange={set('email')} autoComplete="email" required />
        </Field>
        <Field label={mode === 'register' ? 'Password (at least 10 characters)' : 'Password'}>
          <input
            type="password"
            value={form.password}
            onChange={set('password')}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            required
          />
        </Field>
        <Note tone="bad">{error?.message}</Note>
        <button className="primary" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'One moment…' : mode === 'login' ? 'Log in' : 'Sign up'}
        </button>
        <p className="dim small" style={{ margin: 0 }}>
          {mode === 'login' ? 'New here? ' : 'Already have an account? '}
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              clearError();
              setMode(mode === 'login' ? 'register' : 'login');
            }}
          >
            {mode === 'login' ? 'Create an account' : 'Log in'}
          </a>
        </p>
      </form>
    </div>
  );
}
