const { pool } = require('../src/db/pool');
const { app, request, uniqueEmail } = require('./helpers');

afterAll(() => pool.end());

describe('auth and accounts', () => {
  const password = 'correct-horse-battery';

  test('register creates a user with a KYC status and an empty NGN wallet', async () => {
    const email = uniqueEmail();
    const res = await request(app).post('/api/v1/auth/register').send({ email, password, full_name: 'Ada Obi' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email, full_name: 'Ada Obi', kyc_status: 'UNVERIFIED', role: 'customer' });
    expect(res.body.user.password_hash).toBeUndefined();
    expect(res.body.account).toMatchObject({ currency: 'NGN', balance_kobo: 0 });
  });

  test('register rejects a duplicate email with 409', async () => {
    const email = uniqueEmail();
    await request(app).post('/api/v1/auth/register').send({ email, password, full_name: 'One' });
    const res = await request(app).post('/api/v1/auth/register').send({ email, password, full_name: 'Two' });
    expect(res.status).toBe(409);
  });

  test('register rejects a weak password and a bad email', async () => {
    let res = await request(app).post('/api/v1/auth/register').send({ email: uniqueEmail(), password: 'short', full_name: 'X Y' });
    expect(res.status).toBe(400);
    res = await request(app).post('/api/v1/auth/register').send({ email: 'not-an-email', password, full_name: 'X Y' });
    expect(res.status).toBe(400);
  });

  test('register cannot be used to make yourself an admin', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password, full_name: 'Sneaky', role: 'admin' });
    expect(res.body.user.role).toBe('customer');
  });

  test('login returns a JWT that unlocks /accounts/me; a wrong password gets 401', async () => {
    const email = uniqueEmail();
    await request(app).post('/api/v1/auth/register').send({ email, password, full_name: 'Tunde' });

    const bad = await request(app).post('/api/v1/auth/login').send({ email, password: 'wrong-password-1' });
    expect(bad.status).toBe(401);

    const good = await request(app).post('/api/v1/auth/login').send({ email, password });
    expect(good.status).toBe(200);
    expect(typeof good.body.token).toBe('string');

    const me = await request(app).get('/api/v1/accounts/me').set('Authorization', `Bearer ${good.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.account.balance_kobo).toBe(0);
    expect(me.body.account.balance_display).toBe('₦0.00');
    expect(me.body.recent).toEqual([]);
  });

  test('/accounts/me without a token is 401', async () => {
    const res = await request(app).get('/api/v1/accounts/me');
    expect(res.status).toBe(401);
  });
});
