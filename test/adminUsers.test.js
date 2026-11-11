// Admins make a customer a merchant (payouts are merchant-only) and back.
const { pool } = require('../src/db/pool');
const { app, request, registerAndLogin, makeAdmin } = require('./helpers');

let admin;
beforeAll(async () => {
  admin = await makeAdmin(await registerAndLogin('Ops'));
});
afterAll(() => pool.end());

const setRole = (userId, role, as = admin) =>
  request(app).post(`/api/v1/admin/users/${userId}/role`).set('Authorization', `Bearer ${as.token}`).send({ role });

const login = (u) => request(app).post('/api/v1/auth/login').send({ email: u.email, password: u.password });

test('an admin promotes a customer to merchant; the next login carries the new role', async () => {
  const user = await registerAndLogin('Shop Owner');
  const res = await setRole(user.userId, 'merchant');
  expect(res.status).toBe(200);
  expect(res.body).toMatchObject({ id: user.userId, role: 'merchant' });
  expect((await login(user)).body.user.role).toBe('merchant');

  expect((await setRole(user.userId, 'customer')).body.role).toBe('customer');
});

test('the API can never create an admin', async () => {
  const user = await registerAndLogin();
  const res = await setRole(user.userId, 'admin');
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('INVALID_ROLE');
});

test('an admin cannot be demoted through this endpoint', async () => {
  const other = await makeAdmin(await registerAndLogin('Other Admin'));
  const res = await setRole(other.userId, 'customer');
  expect(res.status).toBe(409);
});

test('unknown users are 404; customers cannot use it', async () => {
  expect((await setRole('00000000-0000-0000-0000-000000000000', 'merchant')).status).toBe(404);
  expect((await setRole('not-a-uuid', 'merchant')).status).toBe(404);
  const customer = await registerAndLogin();
  expect((await setRole(customer.userId, 'merchant', customer)).status).toBe(403);
});
