// Screen 2: the wallet. Balance and recent activity come straight from the
// database on every load (GET /accounts/me): balances are never cached.
import { Link } from 'react-router-dom';
import { api, naira, when } from '../api.js';
import { Badge, Note, Page, useLoad } from '../ui.jsx';

const KYC_TONE = { VERIFIED: 'good', PENDING: 'warn', UNVERIFIED: 'warn', REJECTED: 'bad' };

export default function Wallet() {
  const { data, error, loading } = useLoad(() => api.get('/accounts/me'), [], 5000);
  if (loading) return null;
  if (!data) return <Note tone="bad">{error?.message}</Note>;
  const { account, recent } = data;

  return (
    <Page
      title="Wallet"
      subtitle={`Hello, ${account.full_name.split(' ')[0]}`}
      actions={
        <>
          <Link className="btn primary" to="/checkout">Top up</Link>
          <Link className="btn" to="/transfer">Send money</Link>
        </>
      }
    >
      <div className="card hero">
        <div className="row spread">
          <span className="eyebrow">Available balance</span>
          <span>
            <span className="dim small">KYC </span>
            <Badge tone={KYC_TONE[account.kyc_status]}>{account.kyc_status}</Badge>
          </span>
        </div>
        <div className="balance" data-testid="balance">{naira(account.balance_kobo)}</div>
      </div>

      <h2>Recent activity</h2>
      <div className="card flush">
        {recent.length === 0 ? (
          <div className="empty">Nothing yet. Top up your wallet to get started.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th className="num">Amount</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((r, i) => (
                <tr key={`${r.transaction_id}-${i}`}>
                  <td className="dim">{when(r.created_at)}</td>
                  <td>{r.memo || 'Ledger entry'}</td>
                  {/* A wallet is money we owe the customer: a CREDIT raises it. */}
                  <td className="num amount" style={{ color: r.direction === 'CREDIT' ? 'var(--lime)' : 'var(--bone)' }}>
                    {r.direction === 'CREDIT' ? '+' : '−'}
                    {naira(r.amount_kobo)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Page>
  );
}
