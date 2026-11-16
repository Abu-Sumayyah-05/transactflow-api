// The walkthrough video: one slow pass through all twelve screens in a real
// browser, with a caption explaining each step. Run it with `npm run video`.
//
// It is also a test: every step waits for the right result on screen, so if
// the app misbehaves the recording stops with an error instead of showing
// something false.
const { test, expect } = require('@playwright/test');
const { randomUUID } = require('crypto');

const PASSWORD = 'correct-horse-battery';
const ADMIN = 'admin@e2e.example.com';
const MERCHANT = 'merchant@e2e.example.com';
const FRIEND = 'friend@e2e.example.com';
const US = { line1: '1 Market St', city: 'San Francisco', country: 'US' };
const GB = { line1: '10 Downing St', city: 'London', country: 'GB' };

// ---- the caption bar -------------------------------------------------------
// Lives in a closed shadow root so its words never get mixed up with the
// app's own text when the script looks for something on the page.
async function say(page, text, ms = 3500) {
  await page.evaluate((t) => {
    let host = document.getElementById('tour-caption');
    if (!host) {
      host = document.createElement('div');
      host.id = 'tour-caption';
      host.style.cssText = 'position:fixed;left:0;right:0;bottom:16px;z-index:99999;pointer-events:none;display:flex;justify-content:center';
      const root = host.attachShadow({ mode: 'closed' });
      const box = document.createElement('div');
      box.style.cssText =
        'max-width:960px;margin:0 24px;background:rgba(12,10,20,.94);color:#fff;font:600 19px/1.45 system-ui,sans-serif;' +
        'padding:13px 22px;border-radius:14px;border:2px solid #f5b942;box-shadow:0 10px 36px rgba(0,0,0,.6);text-align:center';
      root.appendChild(box);
      host.box = box;
      document.body.appendChild(host);
    }
    host.box.textContent = t;
  }, text);
  await page.waitForTimeout(ms);
}

// ---- helpers ---------------------------------------------------------------
async function signIn(page, email) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

async function signUp(page, email, name) {
  await page.goto('/login');
  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign up' }).click();
  await expect(page).toHaveURL(/\/wallet$/);
}

const signOut = (page) => page.getByRole('button', { name: 'Sign out' }).click();

// Fills the checkout form and stops just before Pay.
async function fillCheckout(page, { amount, billing = US }) {
  await page.getByRole('link', { name: 'Wallet', exact: true }).click(); // leave any earlier result screen
  await page.getByRole('link', { name: 'Top up' }).first().click();
  await expect(page.getByRole('button', { name: 'Pay', exact: true })).toBeVisible();
  await page.getByLabel('Amount in naira').fill(amount);
  await page.getByLabel('Street address').fill(billing.line1);
  await page.getByLabel('City').fill(billing.city);
  await page.getByLabel('Country code').fill(billing.country);
  if (await page.getByLabel('Card number').isVisible()) {
    await page.getByLabel('Card number').fill('4111 1111 1111 1111');
    await page.getByLabel('Month').fill('12');
    await page.getByLabel('Year').fill('2030');
    await page.getByLabel('CVV').fill('123');
  }
}
const pay = (page) => page.getByRole('button', { name: 'Pay', exact: true }).click();

// Talks to the API directly, for setting a scene off screen.
async function apiAs(request, email) {
  const login = await request.post('/api/v1/auth/login', { data: { email, password: PASSWORD } });
  const { token } = await login.json();
  const headers = () => ({ Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() });
  return {
    post: (path, data) => request.post(`/api/v1${path}`, { data, headers: headers() }),
    get: (path) => request.get(`/api/v1${path}`, { headers: headers() }),
  };
}
const setBank = async (request, settings) => (await apiAs(request, ADMIN)).post('/admin/simulator/mode', { bank: 'A', ...settings });

test('TransactFlow walkthrough', async ({ page, request }) => {
  const customer = { email: `ngozi-${randomUUID().slice(0, 8)}@company.example.com`, name: 'Ngozi Customer' };
  const message = page.getByTestId('payment-message');
  const balance = page.getByTestId('balance');

  // ======================= CUSTOMER APP =====================================
  await page.goto('/login');
  await say(page, 'TransactFlow: a payment platform. First the customer app, then the admin console. Everything here runs against the real backend and two simulated banks.', 5500);

  // ---- 1. Sign up and login
  await say(page, 'Screen 1 · Sign up and login. A new customer creates an account.');
  await signUp(page, customer.email, customer.name);
  await expect(page.getByText('UNVERIFIED')).toBeVisible();
  await say(page, 'Signed in with a JWT. The badge shows the KYC status, and the wallet starts at ₦0.00.', 4500);

  // ---- 2 + 3. Wallet and checkout, with a double-tapped Pay
  await say(page, 'Screen 3 · Checkout. Top up ₦5,000 from a card. The card number goes only to the vault, which returns a token.');
  await fillCheckout(page, { amount: '5000' });
  await say(page, 'Watch: the Pay button is about to be double-tapped.');
  await page.getByRole('button', { name: 'Pay', exact: true }).dblclick();
  await expect(message).toHaveText('Wallet topped up with ₦5,000.00');
  const topUpReference = (await page.getByText(/^Reference TF-/).innerText()).match(/TF-[A-Z0-9-]+/)[0];
  await say(page, 'COMPLETED. Both taps carried the same idempotency key, so the card was charged once.', 4500);
  await page.getByRole('link', { name: 'Back to wallet' }).click();
  await expect(balance).toHaveText('₦5,000.00');
  await say(page, 'Screen 2 · Wallet. One credit of ₦5,000.00, not two. The balance is read from the database, never a cache.', 4500);

  // ---- 3. A decline with its reason
  await setBank(request, { outcome: 'DECLINED', declineCode: '51' });
  await say(page, 'Next, the bank is set to decline with issuer code 51.');
  await fillCheckout(page, { amount: '700' });
  await pay(page);
  await expect(message).toContainText('insufficient funds');
  await say(page, 'FAILED, with the reason: insufficient funds. The customer never sees a bare "declined".', 4500);
  await setBank(request, {});

  // ---- 3. A bank timeout
  await setBank(request, { mode: 'timeout', webhook: 'off' });
  await say(page, 'Now the bank takes the money but never answers, and sends no webhook.');
  await fillCheckout(page, { amount: '300' });
  await pay(page);
  await expect(page.getByRole('heading', { name: /Confirming/ })).toBeVisible();
  await say(page, 'The payment is UNKNOWN, not FAILED. The backend does not guess: it asks the bank what really happened (a transaction status query).', 4500);
  await setBank(request, {});
  await expect(message).toHaveText('Wallet topped up with ₦300.00', { timeout: 60_000 });
  await say(page, 'The bank confirmed it had approved the payment, so it completes with the correct final status.', 4500);

  // ---- 4. Transfer
  await page.getByRole('link', { name: 'Transfer' }).click();
  await say(page, 'Screen 4 · Transfer. First to another wallet. A name enquiry shows who will receive the money before anything moves.');
  await page.getByLabel("Recipient's email").fill(FRIEND);
  await page.getByLabel('Amount in naira').fill('1000');
  await page.getByRole('button', { name: 'Check recipient' }).click();
  await expect(page.getByTestId('recipient-name')).toHaveText('Funmi Friend');
  await say(page, 'The recipient is Funmi Friend. Confirm and send.', 2500);
  await page.getByRole('button', { name: 'Confirm and send' }).click();
  await expect(message).toContainText('Sent to Funmi Friend');
  await say(page, 'Sent. Both wallet rows were locked, and the ledger got a balanced debit and credit.', 4000);
  await page.getByRole('button', { name: 'Send another' }).click();

  await page.getByRole('button', { name: 'To a bank account' }).click();
  await page.getByLabel('Account number (10 digits)').fill('0123456789');
  await page.getByLabel('Amount in naira').fill('250.50');
  await page.getByRole('button', { name: 'Check recipient' }).click();
  await expect(page.getByTestId('recipient-name')).toHaveText('Ngozi Eze');
  await say(page, 'To a bank account: the bank itself is asked for the account name.', 3000);
  await page.getByRole('button', { name: 'Confirm and send' }).click();
  await expect(message).toHaveText('Sent ₦250.50 to Ngozi Eze');
  await say(page, 'Sent ₦250.50. Money is stored as whole kobo, so the 50 kobo is exact.', 3500);

  await page.getByRole('button', { name: 'Send another' }).click();
  await page.getByRole('button', { name: 'To a bank account' }).click();
  await page.getByLabel('Account number (10 digits)').fill('9999999999');
  await page.getByLabel('Amount in naira').fill('10');
  await page.getByRole('button', { name: 'Check recipient' }).click();
  await expect(page.getByRole('alert')).toContainText('no account with that number');
  await say(page, 'An account that does not exist is caught before any money moves.', 3500);

  await page.getByRole('link', { name: 'Wallet', exact: true }).click();
  await expect(balance).toHaveText('₦4,049.50');
  await say(page, 'Wallet: 5,000 + 300 in, 1,000 and 250.50 out = ₦4,049.50.', 4000);

  // ---- 5. History
  await page.getByRole('link', { name: 'History' }).click();
  const rows = page.locator('tbody tr.click');
  await expect(rows.filter({ hasText: 'FAILED' })).toHaveCount(1);
  await say(page, 'Screen 5 · History. Every transaction with its state.');
  await rows.filter({ hasText: '₦5,000.00' }).click();
  const receipt = page.getByTestId('receipt');
  await expect(receipt.getByText(topUpReference)).toBeVisible();
  await say(page, 'The receipt shows each step of the state machine: INITIALIZED, PENDING, AUTHORIZED, COMPLETED.', 4500);
  await rows.filter({ hasText: 'FAILED' }).click();
  await expect(receipt).toContainText('insufficient funds');
  await say(page, 'The declined payment keeps its reason.', 3000);
  await signOut(page);

  // ---- 3. The 3DS-style challenge, as a riskier customer
  await say(page, 'A riskier customer: a free email address, a new device, and a billing country that differs from the card.', 4000);
  await signUp(page, `risky-${randomUUID().slice(0, 8)}@gmail.com`, 'Risky Buyer');
  await fillCheckout(page, { amount: '1200', billing: GB });
  await pay(page);
  await expect(page.getByRole('heading', { name: "Verify it's you" })).toBeVisible();
  const code = await page.getByTestId('demo-otp').innerText();
  await say(page, 'Fraud score 45 (20 + 10 + 15): the challenge band. The payment stops for a one-time code, 3DS style.', 4500);
  await page.getByLabel('6-digit code').fill(code === '000000' ? '111111' : '000000');
  await page.getByRole('button', { name: 'Verify and pay' }).click();
  await expect(page.getByRole('alert')).toContainText('2 tries left');
  await say(page, 'A wrong code is refused and uses up a try. Nothing has been charged.', 3500);
  await page.getByLabel('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Verify and pay' }).click();
  await expect(message).toHaveText('Wallet topped up with ₦1,200.00');
  await say(page, 'The right code: the payment goes to the bank and completes.', 3500);
  await page.getByRole('link', { name: 'Back to wallet' }).click();
  await signOut(page);

  // ---- 6. Payouts, as a merchant
  await signIn(page, MERCHANT);
  await page.getByRole('link', { name: 'Payouts' }).click();
  await say(page, 'Screen 6 · Payouts. A merchant pays many people from one CSV. Two of these four rows are wrong on purpose.', 4500);
  await page.getByLabel('CSV contents').fill(
    [
      'bank,account_number,account_name,amount,reference',
      'A,0123456789,Ngozi Eze,1500.00,INV-0001',
      'B,0987654321,Funke Adeyemi,750.50,INV-0002',
      'A,0000000001,Wrong Person,300.00,INV-0003',
      'A,12345,Short Number,100.00,INV-0004',
    ].join('\n')
  );
  await page.waitForTimeout(2000);
  await page.getByRole('button', { name: 'Upload and pay' }).click();
  const batch = page.getByTestId('batch');
  await expect(batch.getByTestId('batch-progress')).toHaveText('100%', { timeout: 60_000 });
  await expect(batch.getByText('2 paid')).toBeVisible();
  await batch.locator('tbody tr').filter({ hasText: 'INV-0004' }).scrollIntoViewIfNeeded();
  await say(page, 'The itemised report: two paid, one refused by name enquiry, one rejected for a bad account number. Each row has its own idempotency key, so a rerun pays nobody twice.', 6500);
  await signOut(page);

  // ======================= ADMIN CONSOLE ====================================
  // Off screen: two medium-risk payments are left waiting for their codes.
  const waiting = [];
  for (const amount of [8800, 9900]) {
    const email = `flagged-${randomUUID().slice(0, 8)}@gmail.com`;
    await request.post('/api/v1/auth/register', { data: { email, password: PASSWORD, full_name: 'Flagged Buyer' } });
    const buyer = await apiAs(request, email);
    const card = await (await buyer.post('/cards', { number: '4111111111111111', exp_month: 12, exp_year: 2030, cvv: '123' })).json();
    const p = await (await buyer.post('/payments', { card_token: card.token, amount_kobo: amount, billing_address: GB })).json();
    waiting.push(p.reference);
  }

  await signIn(page, ADMIN);
  await say(page, 'Now the admin console, where the operations team watches and steps in.', 3500);

  // ---- 2. Fraud queue
  await page.getByRole('link', { name: 'Fraud queue' }).click();
  const first = page.getByTestId('fraud-flag').filter({ hasText: waiting[0] });
  await expect(first.getByText('45', { exact: true })).toBeVisible();
  await say(page, 'Admin 2 · Fraud queue. Each flagged payment shows its score and the rules that fired.', 4500);
  await first.getByRole('button', { name: 'Approve and charge' }).click();
  await expect(first).toHaveCount(0);
  await say(page, 'Approved: that payment is charged.', 2500);
  const second = page.getByTestId('fraud-flag').filter({ hasText: waiting[1] });
  await second.getByRole('button', { name: 'Block', exact: true }).click();
  await expect(second).toHaveCount(0);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(page.locator('.card').filter({ hasText: '₦99.00' })).toContainText('FAILED');
  await say(page, 'Blocked: that one fails. Every decision keeps its reason.', 3500);

  // ---- 6 + 4. Simulator controls and the webhook log
  await page.getByRole('link', { name: 'Simulator controls' }).click();
  const simA = page.getByTestId('sim-A');
  await expect(simA).toBeVisible();
  await say(page, 'Admin 6 · Simulator controls. A real bank cannot be told to fail on demand; these two mock banks can.', 4500);
  await simA.getByLabel('Webhooks').selectOption('duplicate');
  await simA.getByRole('button', { name: 'Apply to Bank A' }).click();
  await expect(simA.getByText('applied')).toBeVisible();
  const buyer = await apiAs(request, customer.email);
  const { cards } = await (await buyer.get('/cards')).json();
  const charge = async (kobo) => (await buyer.post('/payments', { card_token: cards[0].token, amount_kobo: kobo, billing_address: US })).json();
  const dup = await charge(4100);
  await say(page, 'Bank A now sends every webhook three times. A customer has just paid.', 3500);
  await simA.getByLabel('Webhooks').selectOption('bad_signature');
  await simA.getByRole('button', { name: 'Apply to Bank A' }).click();
  await expect(simA.getByText('applied')).toBeVisible();
  await charge(4200);
  await say(page, 'Now it signs its webhooks with the wrong key, and another payment goes through.', 3500);
  await simA.getByRole('button', { name: 'Back to normal' }).click();
  await expect(simA.getByText('normal · APPROVED')).toBeVisible();

  await page.getByRole('link', { name: 'Webhook log' }).click();
  await expect(page.getByText('received 3 times').first()).toBeVisible();
  await expect(page.getByText('REJECTED').first()).toBeVisible();
  expect((await (await buyer.get(`/payments/${dup.id}`)).json()).status).toBe('COMPLETED');
  await say(page, 'Admin 4 · Webhook log. The event received 3 times was applied once. The one with a bad signature was rejected with 401 and logged.', 6000);

  // ---- 3. Reconciliation
  await page.getByRole('link', { name: 'Reconciliation' }).click();
  await setBank(request, { settlement: { missing: topUpReference } });
  await say(page, "Admin 3 · Reconciliation. Bank A's settlement file will leave out the ₦5,000 top-up.", 4000);
  await page.getByRole('button', { name: 'Run Bank A' }).click();
  const run = page.getByTestId('recon-run');
  await expect(run.getByText('COMPLETED').first()).toBeVisible();
  const brk = run.locator('tbody tr').filter({ hasText: topUpReference });
  await expect(brk).toContainText('MISSING FROM BANK');
  await brk.scrollIntoViewIfNeeded();
  await say(page, 'The run matched the rest and classified the break: MISSING FROM BANK, not a vague "mismatch".', 5000);
  await brk.getByRole('button', { name: 'Resolve' }).click();
  await brk.getByLabel('Resolution note').fill('Bank confirmed by phone, will post tomorrow');
  await brk.getByRole('button', { name: 'Save' }).click();
  await expect(brk).toContainText('resolved');
  await say(page, 'Resolved with a note, which goes into the audit trail. Four reports can be downloaded.', 4000);

  await charge(2500);
  await setBank(request, { settlement: { wrongClosing: true } });
  await page.getByRole('button', { name: 'Run Bank A' }).scrollIntoViewIfNeeded();
  await say(page, "Next file: the bank's closing balance does not add up.", 3000);
  await page.getByRole('button', { name: 'Run Bank A' }).click();
  await expect(page.getByTestId('halt-reason')).toContainText('closing balance in the file');
  await page.getByTestId('halt-reason').scrollIntoViewIfNeeded();
  await say(page, 'HALTED. A file that does not add up is not trusted, so nothing in it is matched.', 5000);
  await setBank(request, {});

  // ---- 5. Dead-letter queue
  await page.getByRole('link', { name: 'Dead-letter queue' }).click();
  await expect(page.getByText('all events processed')).toBeVisible();
  await say(page, 'Admin 5 · Dead-letter queue. Empty for now. The bank is about to dispute more money than was ever charged.', 4500);
  await (await apiAs(request, ADMIN)).post('/admin/simulator/dispute', { reference: topUpReference, amount_kobo: 99_999_900 });
  const dead = page.getByTestId('dead-letter');
  await expect(dead).toHaveCount(1);
  await expect(dead.getByRole('alert')).toContainText('dispute amount');
  await say(page, 'That event can never succeed, so it is parked here with its reason instead of being retried forever.', 4500);
  await dead.getByRole('button', { name: 'Replay' }).click();
  await expect(dead.getByRole('button', { name: 'Replay' })).toBeEnabled();
  await expect(dead.getByRole('alert')).toContainText('dispute amount');
  await say(page, 'Replay tries it again. It fails for the same reason and stays in the queue.', 3500);

  // ---- 6 + 1. A 503 outage, the circuit breaker and the live dashboard
  await page.getByRole('link', { name: 'Simulator controls' }).click();
  await expect(simA).toBeVisible();
  await simA.getByRole('button', { name: 'Error 503' }).click();
  await simA.getByRole('button', { name: 'Apply to Bank A' }).click();
  await expect(simA.getByText('applied')).toBeVisible();
  await say(page, 'Last: an outage. Bank A now answers every call with 503. Three payments come in.', 4000);
  await charge(1000);
  await charge(1000);
  const third = await charge(1000);
  expect(third).toMatchObject({ bank: 'B', status: 'COMPLETED' });

  await page.getByRole('link', { name: 'Live dashboard' }).click();
  await expect(page.getByTestId('bank-A').getByText('OPEN', { exact: true })).toBeVisible();
  await expect(page.getByTestId('bank-B').getByText('CLOSED')).toBeVisible();
  await say(page, "Admin 1 · Live dashboard. Bank A's circuit breaker is OPEN after retries failed, and the third payment completed through Bank B.", 6000);
  await page.getByTestId('bank-A').scrollIntoViewIfNeeded();
  await say(page, 'Success rate, p99 latency, volume and authorization rate by bank, all live.', 4500);
  await setBank(request, {});
  await say(page, 'That is TransactFlow: all twelve screens, and the five hard problems of payments handled.', 5000);
});
