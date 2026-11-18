// SCRUM-35 / FR-USR-01: only an Organisation Admin creates users, and only
// Request Users and Review Users, in their own organisation. Clerk is replaced
// by a fake that records the invitations it was asked to send.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import worker from '../src/index.js';
import { registerOrganisation } from '../src/registration.js';
import { d1, migratedDatabase } from './d1.js';

let sqlite;
let env;
let verifiedEmails;
let invitations;
let inviteFails;

const fakeIdentity = {
  async authenticate(request) {
    const externalUserId = request.headers.get('X-Test-Clerk-User');
    return externalUserId ? { externalUserId } : null;
  },
  async verifiedEmail(externalUserId) {
    return verifiedEmails[externalUserId] ?? null;
  },
  async invite(email, redirectUrl) {
    if (inviteFails) throw new Error('Clerk is down');
    invitations.push({ email, redirectUrl });
  },
};

const assets = { fetch: async (request) => new Response(`page ${new URL(request.url).pathname}`) };

// Two organisations: Bau (admin Ana, Request User Rita, Review User Rudi) and
// Holz (admin Otto). Everyone is already signed in to Clerk and ACTIVE.
beforeEach(async () => {
  sqlite = migratedDatabase();
  const db = d1(sqlite);
  env = { DB: db, ASSETS: assets, IDENTITY: fakeIdentity };
  verifiedEmails = {};
  invitations = [];
  inviteFails = false;
  await registerOrganisation(
    { db },
    { organisationName: 'Bau GmbH', organisationNumber: 'FN 123456a', firstName: 'Ana', lastName: 'Berger', email: 'ana@bau.example' },
  );
  await registerOrganisation(
    { db },
    { organisationName: 'Holz AG', organisationNumber: 'FN 654321b', firstName: 'Otto', lastName: 'Holzer', email: 'otto@holz.example' },
  );
  sqlite.exec(`
    UPDATE users SET status = 'ACTIVE', external_user_id = 'user_ana' WHERE email = 'ana@bau.example';
    UPDATE users SET status = 'ACTIVE', external_user_id = 'user_otto' WHERE email = 'otto@holz.example';
    INSERT INTO users (organisation_id, email, first_name, last_name, role, status, external_user_id) VALUES
      (1, 'rita@bau.example', 'Rita', 'Rot', 'REQUEST_USER', 'ACTIVE', 'user_rita'),
      (1, 'rudi@bau.example', 'Rudi', 'Roth', 'REVIEW_USER', 'ACTIVE', 'user_rudi');
  `);
});

const send = (method, path, clerkUser, body) =>
  worker.fetch(
    new Request(`https://bpc.test${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(clerkUser ? { 'X-Test-Clerk-User': clerkUser } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );

const createUser = (clerkUser, body) => send('POST', '/api/users', clerkUser, body);
const newUser = (overrides = {}) => ({ firstName: 'Nina', lastName: 'Neu', email: 'nina@bau.example', role: 'REQUEST_USER', ...overrides });
const userByEmail = (email) => sqlite.prepare('SELECT organisation_id, role, status, external_user_id FROM users WHERE email = ?').get(email);
const userCount = () => sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n;

test('the Organisation Admin creates a Request User in their own organisation', async () => {
  const response = await createUser('user_ana', newUser());
  assert.equal(response.status, 201);
  const { user } = await response.json();
  assert.equal(user.email, 'nina@bau.example');
  assert.equal(user.role, 'REQUEST_USER');
  assert.equal(user.status, 'PENDING');
  assert.deepEqual({ ...userByEmail('nina@bau.example') }, { organisation_id: 1, role: 'REQUEST_USER', status: 'PENDING', external_user_id: null });
});

test('the Organisation Admin creates a Review User too', async () => {
  const response = await createUser('user_ana', newUser({ email: 'rene@bau.example', role: 'REVIEW_USER' }));
  assert.equal(response.status, 201);
  assert.equal(userByEmail('rene@bau.example').role, 'REVIEW_USER');
});

test('the new user is invited through Clerk, with a link back to our sign-up page', async () => {
  await createUser('user_ana', newUser());
  assert.deepEqual(invitations, [{ email: 'nina@bau.example', redirectUrl: 'https://bpc.test/signup' }]);
});

test('Request Users and Review Users cannot create users (403)', async () => {
  for (const clerkUser of ['user_rita', 'user_rudi']) {
    const response = await createUser(clerkUser, newUser());
    assert.equal(response.status, 403, clerkUser);
    assert.deepEqual(await response.json(), { error: 'FORBIDDEN' }, clerkUser);
  }
  assert.equal(userByEmail('nina@bau.example'), undefined);
  assert.deepEqual(invitations, []);
});

test('the Super Admin is outside every organisation and cannot create organisation users', async () => {
  sqlite.exec(
    "INSERT INTO users (email, first_name, last_name, role, status, external_user_id) VALUES ('ops@bpc.example', 'Super', 'Admin', 'SUPER_ADMIN', 'ACTIVE', 'user_ops')",
  );
  assert.equal((await createUser('user_ops', newUser())).status, 403);
});

test('without a sign-in the answer is 401', async () => {
  assert.equal((await createUser(null, newUser())).status, 401);
  assert.deepEqual(invitations, []);
});

test('only Request User and Review User can be chosen as role', async () => {
  for (const role of ['ADMIN', 'SUPER_ADMIN', 'request_user', 'BOSS', '']) {
    const response = await createUser('user_ana', newUser({ role }));
    assert.equal(response.status, 400, role);
    const body = await response.json();
    assert.equal(body.error, 'INVALID_INPUT', role);
    assert.ok(body.fields.role, role);
  }
  assert.equal(userByEmail('nina@bau.example'), undefined);
});

test('every field is required and the e-mail address must be valid', async () => {
  const response = await createUser('user_ana', { firstName: '  ', email: 'not-an-email' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'INVALID_INPUT',
    fields: { firstName: 'REQUIRED', lastName: 'REQUIRED', email: 'INVALID', role: 'REQUIRED' },
  });
});

test('a missing or broken body gives 400, not a crash', async () => {
  assert.equal((await createUser('user_ana', null)).status, 400);
  assert.equal((await createUser('user_ana')).status, 400);
});

test('an e-mail address that already has an account is refused, in any organisation and any spelling', async () => {
  for (const email of ['rita@bau.example', 'OTTO@holz.example']) {
    const response = await createUser('user_ana', newUser({ email }));
    assert.equal(response.status, 409, email);
    assert.deepEqual(await response.json(), { error: 'EMAIL_IN_USE' }, email);
  }
  assert.deepEqual(invitations, []);
});

test('the organisation always comes from the admin, never from the request', async () => {
  await createUser('user_ana', newUser({ organisationId: 2, organisation_id: 2 }));
  assert.equal(userByEmail('nina@bau.example').organisation_id, 1);
  await createUser('user_otto', newUser({ email: 'nora@holz.example' }));
  assert.equal(userByEmail('nora@holz.example').organisation_id, 2);
});

test('if Clerk cannot send the invitation, no user is left behind and the admin can retry', async () => {
  inviteFails = true;
  const before = userCount();
  const response = await createUser('user_ana', newUser());
  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), { error: 'INVITE_FAILED' });
  assert.equal(userCount(), before);

  inviteFails = false;
  assert.equal((await createUser('user_ana', newUser())).status, 201);
});

test('creating a user is audited with the admin, the new user and a UTC timestamp', async () => {
  const { user } = await (await createUser('user_ana', newUser())).json();
  const row = sqlite.prepare("SELECT user_id, details, created_at FROM audit_log WHERE action = 'USER_CREATED'").get();
  assert.equal(row.user_id, 1);
  assert.deepEqual(JSON.parse(row.details), { created_user_id: user.id, role: 'REQUEST_USER' });
  assert.match(row.created_at, /Z$/);
});

test('after accepting the invitation, the new user signs in with the rights of their role', async () => {
  await createUser('user_ana', newUser());
  // Accepting the Clerk invitation verifies the address; the first sign-in links the account.
  verifiedEmails.user_nina = 'nina@bau.example';
  const me = await send('GET', '/api/me', 'user_nina');
  assert.equal(me.status, 200);
  const body = await me.json();
  assert.equal(body.user.role, 'REQUEST_USER');
  assert.equal(body.user.organisationId, 1);
  assert.deepEqual(body.pages.map((page) => page.name), ['start-check']);
  assert.equal(userByEmail('nina@bau.example').status, 'ACTIVE');

  // A Request User may start checks, but not open the admin's user list.
  assert.equal((await send('GET', '/app/start-check.html', 'user_nina')).status, 200);
  assert.equal((await send('GET', '/app/users.html', 'user_nina')).status, 302);
});

test('the admin sees the new user in the user list of the organisation', async () => {
  await createUser('user_ana', newUser());
  const { users } = await (await send('GET', '/api/users', 'user_ana')).json();
  assert.ok(users.some((user) => user.email === 'nina@bau.example' && user.status === 'PENDING'));
  const holz = await (await send('GET', '/api/users', 'user_otto')).json();
  assert.ok(!holz.users.some((user) => user.email === 'nina@bau.example'));
});