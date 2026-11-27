// SCRUM-40 (FR-USR-05): a user only sees data of their own organisation.
// Two organisations, each with requests, users and tokens, read through the
// Worker with a Clerk session (the web app) and with an API token (a program).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashToken } from '../src/api-token.js';
import worker from '../src/index.js';
import { d1, migratedDatabase } from './d1.js';

const assets = { fetch: async () => new Response('web app') };

// Organisation 1 has users 10-12, tokens 100-101 and requests 1000-1001.
// Organisation 2 has users 20-21, token 200 and request 2000.
// The Super Admin (user 1) belongs to no organisation.
async function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO organisations (id, name, fn) VALUES
      (1, 'Muster Bau GmbH', 'FN 111111a'),
      (2, 'Andere Handel AG', 'FN 222222b');
    INSERT INTO users (id, organisation_id, email, first_name, last_name, role, status, external_user_id) VALUES
      (1,  NULL, 'operator@example.at', 'Olga',  'Operator', 'SUPER_ADMIN',  'ACTIVE', 'clerk_super'),
      (10, 1,    'admin@a.example',     'Anna',  'Admin',    'ADMIN',        'ACTIVE', 'clerk_admin_a'),
      (11, 1,    'req@a.example',       'Rita',  'Request',  'REQUEST_USER', 'ACTIVE', 'clerk_request_a'),
      (12, 1,    'review@a.example',    'Rudi',  'Review',   'REVIEW_USER',  'ACTIVE', 'clerk_review_a'),
      (20, 2,    'admin@b.example',     'Berta', 'Admin',    'ADMIN',        'ACTIVE', 'clerk_admin_b'),
      (21, 2,    'req@b.example',       'Bruno', 'Request',  'REQUEST_USER', 'ACTIVE', 'clerk_request_b');
    INSERT INTO requests (id, organisation_id, user_id, input_vat, status, started_at) VALUES
      (1000, 1, 11, 'ATU11111111', 'RUNNING', '2026-11-02T09:00:00.000Z'),
      (1001, 1, 10, 'ATU11111112', 'RUNNING', '2026-11-03T09:00:00.000Z'),
      (2000, 2, 21, 'ATU22222222', 'RUNNING', '2026-11-02T10:00:00.000Z');
    INSERT INTO check_results (request_id, source, state, queried_at) VALUES
      (1000, 'VIES', 'VALID',   '2026-11-02T09:00:01.000Z'),
      (2000, 'VIES', 'INVALID', '2026-11-02T10:00:01.000Z');
  `);
  const addToken = sqlite.prepare('INSERT INTO api_tokens (id, user_id, name, secret_hash) VALUES (?, ?, ?, ?)');
  addToken.run(100, 10, 'Admin A', await hashToken('bpc_admin_a'));
  addToken.run(101, 11, 'ERP A', await hashToken('bpc_request_a'));
  addToken.run(200, 20, 'Admin B', await hashToken('bpc_admin_b'));
  return { sqlite, db: d1(sqlite) };
}

// as: { session: 'clerk_...' } for the web app, { token: 'bpc_...' } for a program.
async function get(db, path, as = {}) {
  const identity = {
    authenticate: async () => (as.session ? { externalUserId: as.session } : null),
    verifiedEmail: async () => null,
  };
  const headers = as.token ? { Authorization: `Bearer ${as.token}` } : {};
  const response = await worker.fetch(new Request(`https://bpc.hsynrsd.dev${path}`, { headers }), {
    DB: db,
    ASSETS: assets,
    IDENTITY: identity,
  });
  return { status: response.status, body: await response.json() };
}

const ids = (items) => items.map((item) => item.id);

// The admin of each organisation, once through the web app and once through the API.
const ADMIN_A = [{ session: 'clerk_admin_a' }, { token: 'bpc_admin_a' }];
const ADMIN_B = [{ session: 'clerk_admin_b' }, { token: 'bpc_admin_b' }];

test('lists show only the requests, users and tokens of the own organisation', async () => {
  const { db } = await setup();

  for (const as of ADMIN_A) {
    assert.deepEqual(ids((await get(db, '/api/requests', as)).body.requests), [1001, 1000]); // newest first
    assert.deepEqual(ids((await get(db, '/api/users', as)).body.users), [10, 11, 12]);
    assert.deepEqual(ids((await get(db, '/api/tokens', as)).body.tokens), [100, 101]);
  }
  for (const as of ADMIN_B) {
    assert.deepEqual(ids((await get(db, '/api/requests', as)).body.requests), [2000]);
    assert.deepEqual(ids((await get(db, '/api/users', as)).body.users), [20, 21]);
    assert.deepEqual(ids((await get(db, '/api/tokens', as)).body.tokens), [200]);
  }
});

test('a request, user or token of the own organisation can be opened', async () => {
  const { db } = await setup();

  for (const as of ADMIN_A) {
    const request = await get(db, '/api/requests/1000', as);
    assert.equal(request.status, 200);
    assert.equal(request.body.request.vat, 'ATU11111111');
    assert.deepEqual(request.body.request.checks.map((check) => check.state), ['VALID']);

    const user = await get(db, '/api/users/11', as);
    assert.equal(user.status, 200);
    assert.equal(user.body.user.email, 'req@a.example');

    const token = await get(db, '/api/tokens/101', as);
    assert.equal(token.status, 200);
    assert.deepEqual({ name: token.body.token.name, userId: token.body.token.userId }, { name: 'ERP A', userId: 11 });
  }
});

test('opening a request, user or token of another organisation gives 404', async () => {
  const { db } = await setup();
  const notFound = { status: 404, body: { error: 'NOT_FOUND' } };

  // Organisation A asks for B's data, and B for A's.
  const foreign = [
    [ADMIN_A, ['/api/requests/2000', '/api/users/20', '/api/users/21', '/api/tokens/200']],
    [ADMIN_B, ['/api/requests/1000', '/api/users/10', '/api/users/11', '/api/tokens/100', '/api/tokens/101']],
  ];
  for (const [callers, paths] of foreign) {
    for (const as of callers) {
      for (const path of paths) assert.deepEqual(await get(db, path, as), notFound, path);
    }
  }

  // The answer is the same as for an ID that does not exist, or is no ID at all.
  for (const path of ['/api/requests/9999', '/api/users/9999', '/api/tokens/9999', '/api/users/abc', '/api/users/1']) {
    assert.deepEqual(await get(db, path, ADMIN_A[0]), notFound, path);
  }
});

test('a token never shows its secret hash', async () => {
  const { db } = await setup();
  const { body } = await get(db, '/api/tokens', ADMIN_A[0]);
  assert.deepEqual(Object.keys(body.tokens[0]).sort(), ['createdAt', 'expiresAt', 'id', 'lastUsedAt', 'name', 'prefix', 'status', 'userId']);
  assert.doesNotMatch(JSON.stringify(await get(db, '/api/tokens/100', ADMIN_A[0])), /hash/i);
});

test('every role sees the requests of its organisation, but only the admin sees users and tokens', async () => {
  const { db } = await setup();
  const forbidden = { status: 403, body: { error: 'FORBIDDEN' } };

  for (const as of [{ session: 'clerk_request_a' }, { session: 'clerk_review_a' }, { token: 'bpc_request_a' }]) {
    assert.deepEqual(ids((await get(db, '/api/requests', as)).body.requests), [1001, 1000]);
    assert.equal((await get(db, '/api/requests/1001', as)).status, 200);
    assert.equal((await get(db, '/api/requests/2000', as)).status, 404);
    for (const path of ['/api/users', '/api/users/11', '/api/users/20', '/api/tokens', '/api/tokens/101', '/api/tokens/200']) {
      assert.deepEqual(await get(db, path, as), forbidden, path);
    }
  }
});

test('the Super Admin belongs to no organisation and sees none of it', async () => {
  const { db } = await setup();
  for (const path of ['/api/requests', '/api/requests/1000', '/api/users', '/api/users/10', '/api/tokens', '/api/tokens/100']) {
    assert.deepEqual(await get(db, path, { session: 'clerk_super' }), { status: 403, body: { error: 'FORBIDDEN' } }, path);
  }
});

test('reading needs a login: no session and a bad token give 401', async () => {
  const { db } = await setup();
  for (const path of ['/api/requests', '/api/requests/1000', '/api/users', '/api/users/10', '/api/tokens', '/api/tokens/100']) {
    assert.deepEqual(await get(db, path), { status: 401, body: { error: 'NOT_SIGNED_IN' } }, path);
    assert.deepEqual(await get(db, path, { token: 'bpc_wrong' }), { status: 401, body: { error: 'INVALID_TOKEN' } }, path);
  }
});
