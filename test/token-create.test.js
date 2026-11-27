// SCRUM-69 / FR-API-07: a new token is shown in full only once, when it is
// created; afterwards only its name and a short prefix. Also the creation rules
// it depends on (SCRUM-59 / FR-API-04): only the Organisation Admin, only for
// Request Users of their own organisation, several tokens per user.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { generateToken, hashToken, tokenPrefix } from '../src/api-token.js';
import worker from '../src/index.js';
import { d1, migratedDatabase } from './d1.js';

let sqlite;
let env;

// Clerk is replaced by a header naming the signed-in user.
const identity = {
  async authenticate(request) {
    const externalUserId = request.headers.get('X-Test-Clerk-User');
    return externalUserId ? { externalUserId } : null;
  },
  verifiedEmail: async () => null,
};

// Bau (admin Ana, Request User Rita, Review User Rudi, deactivated Gina) and Holz (admin Otto, Request User Hans).
beforeEach(() => {
  sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO organisations (id, name, fn) VALUES (1, 'Bau GmbH', 'FN 123456a'), (2, 'Holz AG', 'FN 654321b');
    INSERT INTO users (id, organisation_id, email, first_name, last_name, role, status, external_user_id) VALUES
      (1, 1, 'ana@bau.example',  'Ana',  'Berger', 'ADMIN',        'ACTIVE',      'user_ana'),
      (2, 1, 'rita@bau.example', 'Rita', 'Rot',    'REQUEST_USER', 'ACTIVE',      'user_rita'),
      (3, 1, 'rudi@bau.example', 'Rudi', 'Roth',   'REVIEW_USER',  'ACTIVE',      'user_rudi'),
      (4, 1, 'gina@bau.example', 'Gina', 'Gone',   'REQUEST_USER', 'DEACTIVATED', NULL),
      (5, 2, 'otto@holz.example','Otto', 'Holzer', 'ADMIN',        'ACTIVE',      'user_otto'),
      (6, 2, 'hans@holz.example','Hans', 'Huber',  'REQUEST_USER', 'ACTIVE',      'user_hans');
  `);
  env = { DB: d1(sqlite), ASSETS: { fetch: async () => new Response('') }, IDENTITY: identity };
});

const send = (method, path, clerkUser, body, headers = {}) =>
  worker.fetch(
    new Request(`https://bpc.test${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(clerkUser ? { 'X-Test-Clerk-User': clerkUser } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );

const create = (clerkUser, body) => send('POST', '/api/tokens', clerkUser, body);
const tokenCount = () => sqlite.prepare('SELECT COUNT(*) AS n FROM api_tokens').get().n;

test('generateToken gives a new random bpc_ token each time', () => {
  const a = generateToken();
  const b = generateToken();
  assert.match(a, /^bpc_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(tokenPrefix(a), a.slice(0, 12));
});

test('the admin creates a token and gets the full token once, in the answer', async () => {
  const response = await create('user_ana', { userId: 2, name: 'ERP' });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const { token, secret } = await response.json();
  assert.match(secret, /^bpc_/);
  assert.equal(token.prefix, secret.slice(0, 12));
  assert.equal(token.userId, 2);
  assert.equal(token.name, 'ERP');
  assert.equal(token.status, 'ACTIVE');
  assert.equal(token.expiresAt, null);
  assert.equal('secret' in token, false);
});

test('the full token is not stored: the database has only its hash and the prefix', async () => {
  const { token, secret } = await (await create('user_ana', { userId: 2, name: 'ERP' })).json();
  const row = sqlite.prepare('SELECT * FROM api_tokens WHERE id = ?').get(token.id);
  assert.equal(row.secret_hash, await hashToken(secret));
  assert.equal(row.prefix, secret.slice(0, 12));
  const everything = JSON.stringify([
    sqlite.prepare('SELECT * FROM api_tokens').all(),
    sqlite.prepare('SELECT * FROM audit_log').all(),
  ]);
  assert.equal(everything.includes(secret), false);
});

test('afterwards the list and the detail show name and prefix, never the token or its hash', async () => {
  const { token, secret } = await (await create('user_ana', { userId: 2, name: 'ERP' })).json();
  const hash = await hashToken(secret);
  for (const path of ['/api/tokens', `/api/tokens/${token.id}`]) {
    const response = await send('GET', path, 'user_ana');
    assert.equal(response.status, 200, path);
    const text = await response.text();
    assert.equal(text.includes(secret), false, path);
    assert.equal(text.includes(hash), false, path);
    assert.equal(text.includes(token.prefix), true, path);
    assert.equal(text.includes('"name":"ERP"'), true, path);
  }
});

test('the new token works for API calls as its user', async () => {
  const { secret } = await (await create('user_ana', { userId: 2, name: 'ERP' })).json();
  const response = await send('GET', '/api/me', null, undefined, { Authorization: `Bearer ${secret}` });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).user.id, 2);
});

test('one user can hold several tokens, each with its own token', async () => {
  const first = await (await create('user_ana', { userId: 2, name: 'ERP' })).json();
  const second = await (await create('user_ana', { userId: 2, name: 'Procurement' })).json();
  assert.notEqual(first.secret, second.secret);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = 2').get().n, 2);
});

test('creating a token is written to the audit log without the token', async () => {
  const { token } = await (await create('user_ana', { userId: 2, name: 'ERP' })).json();
  const log = sqlite.prepare("SELECT user_id, details FROM audit_log WHERE action = 'TOKEN_CREATED'").get();
  assert.equal(log.user_id, 1);
  assert.deepEqual(JSON.parse(log.details), { created_token_id: token.id, token_user_id: 2 });
});

test('Request Users and Review Users cannot create tokens (403)', async () => {
  for (const clerkUser of ['user_rita', 'user_rudi']) {
    const response = await create(clerkUser, { userId: 2, name: 'ERP' });
    assert.equal(response.status, 403, clerkUser);
  }
  assert.equal(tokenCount(), 0);
});

test('a token of a Request User cannot create tokens either (403)', async () => {
  const { secret } = await (await create('user_ana', { userId: 2, name: 'ERP' })).json();
  const response = await send('POST', '/api/tokens', null, { userId: 2, name: 'More' }, { Authorization: `Bearer ${secret}` });
  assert.equal(response.status, 403);
  assert.equal(tokenCount(), 1);
});

test('without a session or token the answer is 401', async () => {
  assert.equal((await create(null, { userId: 2, name: 'ERP' })).status, 401);
});

for (const [why, body, fields] of [
  ['no name', { userId: 2 }, { name: 'REQUIRED' }],
  ['a blank name', { userId: 2, name: '   ' }, { name: 'REQUIRED' }],
  ['a too long name', { userId: 2, name: 'x'.repeat(101) }, { name: 'TOO_LONG' }],
  ['no user', { name: 'ERP' }, { userId: 'REQUIRED' }],
  ['a user ID that is not a number', { userId: '2', name: 'ERP' }, { userId: 'INVALID' }],
  ['a user that does not exist', { userId: 999, name: 'ERP' }, { userId: 'INVALID' }],
  ['a user of another organisation', { userId: 6, name: 'ERP' }, { userId: 'INVALID' }],
  ['a Review User', { userId: 3, name: 'ERP' }, { userId: 'INVALID' }],
  ['the admin', { userId: 1, name: 'ERP' }, { userId: 'INVALID' }],
  ['a deactivated user', { userId: 4, name: 'ERP' }, { userId: 'INVALID' }],
]) {
  test(`${why} gives 400 INVALID_INPUT`, async () => {
    const response = await create('user_ana', body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'INVALID_INPUT', fields });
    assert.equal(tokenCount(), 0);
  });
}
