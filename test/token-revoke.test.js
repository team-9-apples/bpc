// SCRUM-61 / FR-API-06: the Organisation Admin lists all tokens of the
// organisation and revokes any of them; the next call with a revoked token gets 401.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import worker from '../src/index.js';
import { d1, migratedDatabase } from './d1.js';

let sqlite;
let env;

const identity = {
  async authenticate(request) {
    const externalUserId = request.headers.get('X-Test-Clerk-User');
    return externalUserId ? { externalUserId } : null;
  },
  verifiedEmail: async () => null,
};

// Bau (admin Ana, Request Users Rita and Rolf, Review User Rudi) and Holz (admin Otto, Request User Hans).
beforeEach(() => {
  sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO organisations (id, name, fn) VALUES (1, 'Bau GmbH', 'FN 123456a'), (2, 'Holz AG', 'FN 654321b');
    INSERT INTO users (id, organisation_id, email, first_name, last_name, role, status, external_user_id) VALUES
      (1, 1, 'ana@bau.example',  'Ana',  'Berger', 'ADMIN',        'ACTIVE', 'user_ana'),
      (2, 1, 'rita@bau.example', 'Rita', 'Rot',    'REQUEST_USER', 'ACTIVE', 'user_rita'),
      (3, 1, 'rudi@bau.example', 'Rudi', 'Roth',   'REVIEW_USER',  'ACTIVE', 'user_rudi'),
      (4, 1, 'rolf@bau.example', 'Rolf', 'Rau',    'REQUEST_USER', 'ACTIVE', 'user_rolf'),
      (5, 2, 'otto@holz.example','Otto', 'Holzer', 'ADMIN',        'ACTIVE', 'user_otto'),
      (6, 2, 'hans@holz.example','Hans', 'Huber',  'REQUEST_USER', 'ACTIVE', 'user_hans');
  `);
  env = { DB: d1(sqlite), ASSETS: { fetch: async () => new Response('') }, IDENTITY: identity };
});

const send = (method, path, { clerkUser, token, body } = {}) =>
  worker.fetch(
    new Request(`https://bpc.test${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(clerkUser ? { 'X-Test-Clerk-User': clerkUser } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );

async function createToken(clerkUser, userId, name) {
  return (await send('POST', '/api/tokens', { clerkUser, body: { userId, name } })).json();
}
const revoke = (id, as) => send('POST', `/api/tokens/${id}/revoke`, as);
const statusOf = (id) => sqlite.prepare('SELECT status FROM api_tokens WHERE id = ?').get(id).status;

test('the list shows every token of the organisation with its name, user and creation date, never the full token', async () => {
  const rita = await createToken('user_ana', 2, 'ERP');
  const rolf = await createToken('user_ana', 4, 'Procurement');
  await createToken('user_otto', 6, 'Holz ERP');
  const response = await send('GET', '/api/tokens', { clerkUser: 'user_ana' });
  const text = await response.clone().text();
  const { tokens } = await response.json();
  assert.deepEqual(
    tokens.map((t) => [t.name, t.userId, Boolean(t.createdAt)]),
    [['ERP', 2, true], ['Procurement', 4, true]],
  );
  assert.equal(text.includes(rita.secret), false);
  assert.equal(text.includes(rolf.secret), false);
});

test('the admin revokes a token and the next call with it gets 401', async () => {
  const { token, secret } = await createToken('user_ana', 2, 'ERP');
  assert.equal((await send('GET', '/api/me', { token: secret })).status, 200);

  const response = await revoke(token.id, { clerkUser: 'user_ana' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).token.status, 'REVOKED');
  assert.equal(statusOf(token.id), 'REVOKED');

  const next = await send('POST', '/api/requests', { token: secret, body: { vat: 'ATU12345678' } });
  assert.equal(next.status, 401);
  assert.deepEqual(await next.json(), { error: 'INVALID_TOKEN' });
});

test('revoking one token leaves the user\'s other tokens working', async () => {
  const first = await createToken('user_ana', 2, 'ERP');
  const second = await createToken('user_ana', 2, 'Procurement');
  await revoke(first.token.id, { clerkUser: 'user_ana' });
  assert.equal((await send('GET', '/api/me', { token: second.secret })).status, 200);
});

test('the revoked token stays in the list, marked REVOKED', async () => {
  const { token } = await createToken('user_ana', 2, 'ERP');
  await revoke(token.id, { clerkUser: 'user_ana' });
  const { tokens } = await (await send('GET', '/api/tokens', { clerkUser: 'user_ana' })).json();
  assert.equal(tokens.find((t) => t.id === token.id).status, 'REVOKED');
});

test('revoking twice is fine and logs only once', async () => {
  const { token } = await createToken('user_ana', 2, 'ERP');
  assert.equal((await revoke(token.id, { clerkUser: 'user_ana' })).status, 200);
  assert.equal((await revoke(token.id, { clerkUser: 'user_ana' })).status, 200);
  const logs = sqlite.prepare("SELECT user_id, details FROM audit_log WHERE action = 'TOKEN_REVOKED'").all();
  assert.equal(logs.length, 1);
  assert.equal(logs[0].user_id, 1);
  assert.deepEqual(JSON.parse(logs[0].details), { revoked_token_id: token.id, token_user_id: 2 });
});

test('a token of another organisation gives 404 and stays active', async () => {
  const { token } = await createToken('user_otto', 6, 'Holz ERP');
  const response = await revoke(token.id, { clerkUser: 'user_ana' });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'NOT_FOUND' });
  assert.equal(statusOf(token.id), 'ACTIVE');
});

test('an unknown or malformed token ID gives 404', async () => {
  assert.equal((await revoke(999, { clerkUser: 'user_ana' })).status, 404);
  assert.equal((await revoke('abc', { clerkUser: 'user_ana' })).status, 404);
});

test('Request Users and Review Users cannot revoke tokens (403), not even their own', async () => {
  const { token, secret } = await createToken('user_ana', 2, 'ERP');
  for (const as of [{ clerkUser: 'user_rita' }, { clerkUser: 'user_rudi' }, { token: secret }]) {
    assert.equal((await revoke(token.id, as)).status, 403);
  }
  assert.equal(statusOf(token.id), 'ACTIVE');
});

test('without a session or token the answer is 401', async () => {
  const { token } = await createToken('user_ana', 2, 'ERP');
  assert.equal((await revoke(token.id, {})).status, 401);
  assert.equal(statusOf(token.id), 'ACTIVE');
});
