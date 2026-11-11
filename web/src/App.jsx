// The frame around every screen: who is signed in, the side menu, and which
// screen each address shows.
//
// Hiding a menu item is a convenience, not security: the backend checks the
// role on every admin and payout request, whatever the browser shows.
import { useCallback, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, getToken, setToken, setUnauthorizedHandler } from './api.js';
import { Badge } from './ui.jsx';
import { Session } from './session.js';
import Login from './customer/Login.jsx';
import Wallet from './customer/Wallet.jsx';
import Checkout from './customer/Checkout.jsx';
import Transfer from './customer/Transfer.jsx';
import History from './customer/History.jsx';
import Payouts from './customer/Payouts.jsx';
import Dashboard from './admin/Dashboard.jsx';
import FraudQueue from './admin/FraudQueue.jsx';
import Recon from './admin/Recon.jsx';
import WebhookLog from './admin/WebhookLog.jsx';
import DeadLetters from './admin/DeadLetters.jsx';
import Simulator from './admin/Simulator.jsx';

const link = ({ isActive }) => `nav${isActive ? ' active' : ''}`;

function Shell({ me, signOut, children }) {
  return (
    <div className="shell">
      <nav className="side" aria-label="Main">
        <div className="brand">
          Transact<span>Flow</span>
        </div>
        <NavLink className={link} to="/wallet">Wallet</NavLink>
        <NavLink className={link} to="/checkout">Top up</NavLink>
        <NavLink className={link} to="/transfer">Transfer</NavLink>
        <NavLink className={link} to="/history">History</NavLink>
        {me.role === 'merchant' && <NavLink className={link} to="/payouts">Payouts</NavLink>}
        {me.role === 'admin' && (
          <>
            <div className="section">Admin console</div>
            <NavLink className={link} to="/admin/dashboard">Live dashboard</NavLink>
            <NavLink className={link} to="/admin/fraud">Fraud queue</NavLink>
            <NavLink className={link} to="/admin/recon">Reconciliation</NavLink>
            <NavLink className={link} to="/admin/webhooks">Webhook log</NavLink>
            <NavLink className={link} to="/admin/dlq">Dead-letter queue</NavLink>
            <NavLink className={link} to="/admin/simulator">Simulator controls</NavLink>
          </>
        )}
        <div className="who">
          <div>{me.full_name}</div>
          <div className="dim small">{me.email}</div>
          <div className="row" style={{ marginTop: 8 }}>
            <Badge tone="info">{me.role}</Badge>
            <button className="sm ghost" onClick={signOut}>Sign out</button>
          </div>
        </div>
      </nav>
      <main className="main">{children}</main>
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState(null);
  const [ready, setReady] = useState(false);
  const navigate = useNavigate();

  const loadMe = useCallback(async () => {
    if (!getToken()) {
      setMe(null);
      setReady(true);
      return;
    }
    try {
      const { account } = await api.get('/accounts/me');
      setMe(account);
    } catch {
      setMe(null);
    }
    setReady(true);
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setMe(null);
    navigate('/login');
  }, [navigate]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setMe(null);
      navigate('/login');
    });
    loadMe();
  }, [loadMe, navigate]);

  if (!ready) return null;

  if (!me) {
    return (
      <Routes>
        <Route path="/login" element={<Login onSignedIn={loadMe} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  const adminOnly = (el) => (me.role === 'admin' ? el : <Navigate to="/wallet" replace />);
  return (
    <Session.Provider value={{ me, reloadMe: loadMe }}>
      <Shell me={me} signOut={signOut}>
        <Routes>
          <Route path="/wallet" element={<Wallet />} />
          <Route path="/checkout" element={<Checkout />} />
          <Route path="/transfer" element={<Transfer />} />
          <Route path="/history" element={<History />} />
          <Route path="/payouts" element={<Payouts />} />
          <Route path="/admin/dashboard" element={adminOnly(<Dashboard />)} />
          <Route path="/admin/fraud" element={adminOnly(<FraudQueue />)} />
          <Route path="/admin/recon" element={adminOnly(<Recon />)} />
          <Route path="/admin/webhooks" element={adminOnly(<WebhookLog />)} />
          <Route path="/admin/dlq" element={adminOnly(<DeadLetters />)} />
          <Route path="/admin/simulator" element={adminOnly(<Simulator />)} />
          <Route path="*" element={<Navigate to={me.role === 'admin' ? '/admin/dashboard' : '/wallet'} replace />} />
        </Routes>
      </Shell>
    </Session.Provider>
  );
}
