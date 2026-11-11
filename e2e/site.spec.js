// PHASE 10 CHECK: every screen in the site table works end to end, in a real
// browser, against the real API, worker and both mock banks.
const { test, expect } = require('@playwright/test');
const { randomUUID } = require('crypto');

const PASSWORD = 'correct-horse-battery';
const ADMIN = 'admin@e2e.example.com';
const MERCHANT = 'merchant@e2e.example.com';
const FRIEND = 'friend@e2e.example.com';
const US = { line1: '1 Market St', city: 'San Francisco', country: 'US' };

test.describe.configure({ mode: 'serial' });

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

async function fillCheckout(page, { amount, billing = US, number = '4111 1111 1111 1111' }) {
  await page.getByRole('link', { name: 'Top up' }).first().click();
  await page.getByLabel('Amount in naira').fill(amount);
  await page.getByLabel('Street address').fill(billing.line1);
  await page.getByLabel('City').fill(billing.city);
  await page.getByLabel('Country code').fill(billing.country);
  if (await page.getByLabel('Card number').isVisible()) {
    await page.getByLabel('Card number').fill(number);
    await page.getByLabel('Month').fill('12');
    await page.getByLabel('Year').fill('2030');
    await page.getByLabel('CVV').fill('123');
  }
  await page.getByRole('button', { name: 'Pay', exact: true }).click();
}

// Talks to the API directly, for setting a scene the test isn't about.
async function apiAs(request, email) {
  const login = await request.post('/api/v1/auth/login', { data: { email, password: PASSWORD } });
  const { token } = await login.json();
  const headers = () => ({ Authorization: `Bearer ${token}`, 'Idempotency-Key': randomUUID() });
  return {
    post: (path, data, extra = {}) => request.post(`/api/v1${path}`, { data, headers: { ...headers(), ...extra } }),
    get: (path) => request.get(`/api/v1${path}`, { headers: headers() }),
  };
}
const setBank = async (request, settings) => (await apiAs(request, ADMIN)).post('/admin/simulator/mode', { bank: 'A', ...settings });

const customer = { email: `ngozi-${randomUUID().slice(0, 8)}@company.example.com`, name: 'Ngozi Customer' };
let topUpReference;

// ---- customer app ------------------------------------------------------------
test.describe('customer app', () => {
  test('1. sign up and login: account creation, JWT login, KYC badge', async ({ page }) => {
    await signUp(page, customer.email, customer.name);
    await expect(page.getByRole('heading', { name: 'Wallet' })).toBeVisible();
    await expect(page.getByText('UNVERIFIED')).toBeVisible(); // the KYC badge
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);

    // Wrong password: a clear message, no hint about which part was wrong.
    await page.getByLabel('Email').fill(customer.email);
    await page.getByLabel('Password').fill('not-my-password');
    await page.getByRole('button', { name: 'Log in' }).click();
    await expect(page.getByRole('alert')).toHaveText('Email or password is incorrect');

    await signIn(page, customer.email);
    await expect(page.getByText(customer.email)).toBeVisible();
  });

  test('2 + 3. wallet and checkout: card form, success message, balance in naira', async ({ page }) => {
    await signIn(page, customer.email);
    await expect(page.getByTestId('balance')).toHaveText('₦0.00');
    await expect(page.getByText('Nothing yet')).toBeVisible();

    await fillCheckout(page, { amount: '5000' });
    await expect(page.getByTestId('payment-message')).toHaveText('Wallet topped up with ₦5,000.00');
    await expect(page.getByTestId('payment-status').getByText('COMPLETED')).toBeVisible();
    topUpReference = (await page.getByText(/^Reference TF-/).innerText()).match(/TF-[A-Z0-9-]+/)[0];

    await page.getByRole('link', { name: 'Back to wallet' }).click();
    await expect(page.getByTestId('balance')).toHaveText('₦5,000.00');
    await expect(page.getByRole('cell', { name: '+₦5,000.00' })).toBeVisible();
  });

  test('3. checkout: a decline shows the reason, never a bare "declined"', async ({ page, request }) => {
    await setBank(request, { outcome: 'DECLINED', declineCode: '51' });
    await signIn(page, customer.email);
    await fillCheckout(page, { amount: '700' });
    await expect(page.getByTestId('payment-message')).toContainText('insufficient funds');
    await expect(page.getByTestId('payment-status').getByText('FAILED')).toBeVisible();
    await setBank(request, {});
  });

  test('3. checkout: a medium-risk payment stops for the 3DS-style challenge', async ({ browser }) => {
    // A new browser (new device), a free email address and a billing country
    // that differs from the card's: 15 + 10 + 20 = 45, the challenge band.
    const context = await browser.newContext();
    const page = await context.newPage();
    await signUp(page, `risky-${randomUUID().slice(0, 8)}@gmail.com`, 'Risky Buyer');
    await fillCheckout(page, { amount: '1200', billing: { line1: '10 Downing St', city: 'London', country: 'GB' } });

    await expect(page.getByRole('heading', { name: "Verify it's you" })).toBeVisible();
    const code = await page.getByTestId('demo-otp').innerText();

    await page.getByLabel('6-digit code').fill(code === '000000' ? '111111' : '000000');
    await page.getByRole('button', { name: 'Verify and pay' }).click();
    await expect(page.getByRole('alert')).toContainText('2 tries left');

    await page.getByLabel('6-digit code').fill(code);
    await page.getByRole('button', { name: 'Verify and pay' }).click();
    await expect(page.getByTestId('payment-message')).toHaveText('Wallet topped up with ₦1,200.00');
    await context.close();
  });

  test('3. checkout: a bank timeout ends in the correct final status, not a guess', async ({ page, request }) => {
    await setBank(request, { mode: 'timeout' }); // the bank takes the money but never answers
    await signIn(page, customer.email);
    await fillCheckout(page, { amount: '300' });
    await expect(page.getByRole('heading', { name: /Confirming/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('payment-message')).toContainText('confirming this payment');
    await setBank(request, {});
    // The screen keeps asking; the backend asks the bank (TSQ) and learns it was approved.
    await expect(page.getByTestId('payment-message')).toHaveText('Wallet topped up with ₦300.00', { timeout: 40_000 });
  });

  test('4. transfer: name enquiry shows the account name, confirm, live status', async ({ page }) => {
    await signIn(page, customer.email);
    await page.getByRole('link', { name: 'Transfer' }).click();

    // To another wallet.
    await page.getByLabel("Recipient's email").fill(FRIEND);
    await page.getByLabel('Amount in naira').fill('1000');
    await page.getByRole('button', { name: 'Check recipient' }).click();
    await expect(page.getByTestId('recipient-name')).toHaveText('Funmi Friend');
    await page.getByRole('button', { name: 'Confirm and send' }).click();
    await expect(page.getByTestId('payment-message')).toContainText('Sent to Funmi Friend');
    await page.getByRole('button', { name: 'Send another' }).click();

    // To a bank account: the bank is asked for the name first.
    await page.getByRole('button', { name: 'To a bank account' }).click();
    await page.getByLabel('Account number (10 digits)').fill('0123456789');
    await page.getByLabel('Amount in naira').fill('250.50');
    await page.getByRole('button', { name: 'Check recipient' }).click();
    await expect(page.getByTestId('recipient-name')).toHaveText('Ngozi Eze');
    await page.getByRole('button', { name: 'Confirm and send' }).click();
    await expect(page.getByTestId('payment-message')).toHaveText('Sent ₦250.50 to Ngozi Eze');

    // An account that doesn't exist is caught before any money moves.
    await page.getByRole('button', { name: 'Send another' }).click();
    await page.getByRole('button', { name: 'To a bank account' }).click();
    await page.getByLabel('Account number (10 digits)').fill('9999999999');
    await page.getByLabel('Amount in naira').fill('10');
    await page.getByRole('button', { name: 'Check recipient' }).click();
    await expect(page.getByRole('alert')).toContainText('no account with that number');

    await page.getByRole('link', { name: 'Wallet' }).click();
    // 5,000 + 300 top-ups, minus 1,000 and 250.50 sent.
    await expect(page.getByTestId('balance')).toHaveText('₦4,049.50');
  });

  test('5. history: every transaction with its state, and a receipt', async ({ page }) => {
    await signIn(page, customer.email);
    await page.getByRole('link', { name: 'History' }).click();
    const rows = page.locator('tbody tr.click');
    await expect(rows).toHaveCount(4); // 5,000 top-up, declined 700, 300 top-up, bank transfer
    await expect(rows.filter({ hasText: 'FAILED' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'COMPLETED' })).toHaveCount(3);

    await rows.filter({ hasText: '₦5,000.00' }).click();
    const receipt = page.getByTestId('receipt');
    await expect(receipt.getByText(topUpReference)).toBeVisible();
    for (const state of ['INITIALIZED', 'PENDING', 'AUTHORIZED', 'COMPLETED']) {
      await expect(receipt.locator('.timeline').getByText(state, { exact: true })).toBeVisible();
    }
    await rows.filter({ hasText: 'FAILED' }).click();
    await expect(receipt).toContainText('insufficient funds');
  });

  test('6. payouts: upload a CSV, batch progress bar, per-item result report', async ({ page }) => {
    // A customer sees why they can't; the menu doesn't even offer it.
    await signIn(page, customer.email);
    await expect(page.getByRole('link', { name: 'Payouts' })).toHaveCount(0);
    await page.goto('/payouts');
    await expect(page.getByText('Payouts are for merchant accounts')).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();

    await signIn(page, MERCHANT);
    await page.getByRole('link', { name: 'Payouts' }).click();
    await page.getByLabel('CSV contents').fill(
      [
        'bank,account_number,account_name,amount,reference',
        'A,0123456789,Ngozi Eze,1500.00,INV-0001',
        'B,0987654321,Funke Adeyemi,750.50,INV-0002',
        'A,0000000001,Wrong Person,300.00,INV-0003', // name enquiry will refuse this
        'A,12345,Short Number,100.00,INV-0004', // bad account number
      ].join('\n')
    );
    await page.getByRole('button', { name: 'Upload and pay' }).click();

    const batch = page.getByTestId('batch');
    await expect(batch.getByTestId('batch-progress')).toHaveText('100%', { timeout: 30_000 });
    await expect(batch.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100');
    await expect(batch.getByText('2 paid')).toBeVisible();
    await expect(batch.locator('tbody tr').filter({ hasText: 'INV-0001' })).toContainText('PAID');
    await expect(batch.locator('tbody tr').filter({ hasText: 'INV-0003' })).toContainText("Name does not match the bank's record");
    await expect(batch.locator('tbody tr').filter({ hasText: 'INV-0004' })).toContainText('Account number must be 10 digits');

    const download = page.waitForEvent('download');
    await batch.getByRole('button', { name: 'Download report (CSV)' }).click();
    expect((await download).suggestedFilename()).toMatch(/^payout-report-.*\.csv$/);
  });
});

// ---- admin console --------------------------------------------------------------
test.describe('admin console', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, ADMIN);
  });

  test('customers cannot open the admin console', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await signIn(page, FRIEND);
    await expect(page.getByText('Admin console')).toHaveCount(0);
    await page.goto('/admin/dashboard');
    await expect(page).toHaveURL(/\/wallet$/);
    await context.close();
  });

  test('1. live dashboard: success rate, p99 latency, volume, gateway health, breaker state', async ({ page }) => {
    await page.getByRole('link', { name: 'Live dashboard' }).click();
    await expect(page.getByText('Success rate')).toBeVisible();
    await expect(page.getByText('p99 latency')).toBeVisible();
    await expect(page.getByText('Volume')).toBeVisible();
    const bankA = page.getByTestId('bank-A');
    await expect(bankA.getByText('CLOSED')).toBeVisible();
    await expect(bankA.getByText('Authorization rate')).toBeVisible();
    await expect(bankA.getByText(/\d+ approved · 1 declined/)).toBeVisible();
    await expect(page.getByText('Every event published')).toBeVisible(); // the worker is relaying the outbox
  });

  test('2. fraud queue: score and rules that fired, approve or block', async ({ page, request }) => {
    // Two medium-risk payments are waiting for their codes.
    const waiting = [];
    for (const amount of [8800, 9900]) {
      const email = `flagged-${randomUUID().slice(0, 8)}@gmail.com`;
      await request.post('/api/v1/auth/register', { data: { email, password: PASSWORD, full_name: 'Flagged Buyer' } });
      const buyer = await apiAs(request, email);
      const card = await (await buyer.post('/cards', { number: '4111111111111111', exp_month: 12, exp_year: 2030, cvv: '123' })).json();
      const p = await (
        await buyer.post('/payments', { card_token: card.token, amount_kobo: amount, billing_address: { line1: '10 Downing St', city: 'London', country: 'GB' } })
      ).json();
      expect(p.status).toBe('PENDING');
      waiting.push(p.reference);
    }

    await page.getByRole('link', { name: 'Fraud queue' }).click();
    const first = page.getByTestId('fraud-flag').filter({ hasText: waiting[0] });
    await expect(first.getByText('45', { exact: true })).toBeVisible();
    for (const rule of ['billing mismatch', 'free email', 'new device']) await expect(first.getByText(rule)).toBeVisible();
    await first.getByRole('button', { name: 'Approve and charge' }).click();
    await expect(first).toHaveCount(0);

    const second = page.getByTestId('fraud-flag').filter({ hasText: waiting[1] });
    await second.getByRole('button', { name: 'Block', exact: true }).click();
    await expect(second).toHaveCount(0);

    await page.getByRole('button', { name: 'All', exact: true }).click();
    await expect(page.locator('.card').filter({ hasText: '₦88.00' })).toContainText('COMPLETED');
    await expect(page.locator('.card').filter({ hasText: '₦99.00' })).toContainText('FAILED');
  });

  test('6. simulator controls + 4. webhook log: duplicate and bad-signature webhooks', async ({ page, request }) => {
    await page.getByRole('link', { name: 'Simulator controls' }).click();
    const simA = page.getByTestId('sim-A');
    await simA.getByLabel('Webhooks').selectOption('duplicate');
    await simA.getByRole('button', { name: 'Apply to Bank A' }).click();
    await expect(simA.getByText('applied')).toBeVisible();

    const buyer = await apiAs(request, customer.email);
    const cards = await (await buyer.get('/cards')).json();
    const dup = await (await buyer.post('/payments', { card_token: cards.cards[0].token, amount_kobo: 4100, billing_address: US })).json();

    await simA.getByLabel('Webhooks').selectOption('bad_signature');
    await simA.getByRole('button', { name: 'Apply to Bank A' }).click();
    await expect(simA.getByText('applied')).toBeVisible();
    await buyer.post('/payments', { card_token: cards.cards[0].token, amount_kobo: 4200, billing_address: US });

    await simA.getByRole('button', { name: 'Back to normal' }).click();
    await expect(simA.getByText('normal · APPROVED')).toBeVisible();

    await page.getByRole('link', { name: 'Webhook log' }).click();
    await expect(page.getByText('received 3 times').first()).toBeVisible();
    await expect(page.getByText('invalid', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('REJECTED').first()).toBeVisible();
    await expect(page.getByText('valid', { exact: true }).first()).toBeVisible();
    // The duplicate was applied once: the payment completed and the wallet got one credit.
    const after = await (await buyer.get(`/payments/${dup.id}`)).json();
    expect(after.status).toBe('COMPLETED');
  });

  test('6. simulator controls: a 503 outage opens the breaker and traffic moves to Bank B', async ({ page, request }) => {
    await page.getByRole('link', { name: 'Simulator controls' }).click();
    const simA = page.getByTestId('sim-A');
    await simA.getByRole('button', { name: 'Error 503' }).click();
    await simA.getByRole('button', { name: 'Apply to Bank A' }).click();
    await expect(simA.getByText('applied')).toBeVisible();

    const buyer = await apiAs(request, customer.email);
    const cards = await (await buyer.get('/cards')).json();
    const pay = async () => (await buyer.post('/payments', { card_token: cards.cards[0].token, amount_kobo: 1000, billing_address: US })).json();
    await pay();
    await pay();
    const third = await pay();
    expect(third).toMatchObject({ bank: 'B', status: 'COMPLETED' });

    await page.getByRole('link', { name: 'Live dashboard' }).click();
    await expect(page.getByTestId('bank-A').getByText('OPEN', { exact: true })).toBeVisible();
    await expect(page.getByTestId('bank-B').getByText('CLOSED')).toBeVisible();

    await setBank(request, {});
  });

  test('3. reconciliation: matched, pending and break counts; a broken file halts the run', async ({ page, request }) => {
    await page.getByRole('link', { name: 'Reconciliation' }).click();

    // A file with one item left out: a classified break to resolve.
    await setBank(request, { settlement: { missing: topUpReference } });
    await page.waitForTimeout(1500); // let the cut-off pass clearly after the payments
    await page.getByRole('button', { name: 'Run Bank A' }).click();
    const run = page.getByTestId('recon-run');
    await expect(run.getByText('COMPLETED').first()).toBeVisible({ timeout: 30_000 });
    await expect(run.locator('.stat').filter({ hasText: 'Matched' }).locator('.value')).not.toHaveText('0');
    const brk = run.locator('tbody tr').filter({ hasText: topUpReference });
    await expect(brk).toContainText('MISSING FROM BANK');
    await brk.getByRole('button', { name: 'Resolve' }).click();
    await brk.getByLabel('Resolution note').fill('Bank confirmed by phone, will post tomorrow');
    await brk.getByRole('button', { name: 'Save' }).click();
    await expect(brk).toContainText('resolved');

    const download = page.waitForEvent('download');
    await run.getByRole('button', { name: 'Exceptions (CSV)' }).click();
    expect((await download).suggestedFilename()).toMatch(/^recon-exceptions-run-\d+\.csv$/);

    // A wrong closing balance: the run halts and says why.
    const buyer = await apiAs(request, customer.email);
    const cards = await (await buyer.get('/cards')).json();
    await buyer.post('/payments', { card_token: cards.cards[0].token, amount_kobo: 2500, billing_address: US });
    await setBank(request, { settlement: { wrongClosing: true } });
    await page.getByRole('button', { name: 'Run Bank A' }).click();
    await expect(page.getByTestId('halt-reason')).toContainText('closing balance in the file', { timeout: 30_000 });
    await expect(page.getByTestId('recon-run').getByText('HALTED').first()).toBeVisible();
    await setBank(request, {});

    await expect(page.locator('tbody tr.click').filter({ hasText: 'HALTED' })).toHaveCount(1);
  });

  test('5. dead-letter queue: a failed event is listed, with a replay button', async ({ page, request }) => {
    await page.getByRole('link', { name: 'Dead-letter queue' }).click();
    await expect(page.getByText('all events processed')).toBeVisible();

    // The bank disputes more than was ever charged: an event that can never succeed.
    const admin = await apiAs(request, ADMIN);
    const raised = await admin.post('/admin/simulator/dispute', { reference: topUpReference, amount_kobo: 99_999_900 });
    expect(raised.status()).toBe(202);

    const dead = page.getByTestId('dead-letter');
    await expect(dead).toHaveCount(1);
    await expect(dead).toContainText('charge.disputed');
    await expect(dead.getByRole('alert')).toContainText('dispute amount');
    await dead.getByRole('button', { name: 'Replay' }).click();
    // Replayed and failed again for the same reason: it stays, with the reason.
    await expect(dead.getByRole('button', { name: 'Replay' })).toBeEnabled();
    await expect(dead.getByRole('alert')).toContainText('dispute amount');
  });
});
