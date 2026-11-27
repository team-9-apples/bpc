// SCRUM-78 / QS-SEC-05: a revoked token is refused within one minute. The
// Worker keeps no cache of tokens: tokenUser() reads the token's status from
// the database on every call, so the refusal is immediate, also when the token
// was revoked through another Worker instance or directly in the database.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { hashToken } from '../src/api-token.js';
import worker from '../src/index.js';
import { d1, migratedDatabase } from './d1.js';

const TOKEN = 'bpc_scrum78_token';
let sqlite;
let env;

beforeEach(async () => {
  sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO organisations (id, name, fn) VALUES (1, 'Bau GmbH', 'FN 123456a');
    INSERT INTO users (id, organisation_id, email, first_name, last_name, role, status, external_user_id) VALUES
      (1, 1, 'ana@bau.example',  'Ana',  'Berger', 'ADMIN',        'ACTIVE', 'user_ana'),
      (2, 1, 'rita@bau.example', 'Rita', 'Rot',    'REQUEST_USER', 'ACTIVE', NULL);
  `);
  sqlite
    .prepare("INSERT INTO api_tokens (id, user_id, name, secret_hash, prefix) VALUES (1, 2, 'ERP', ?, 'bpc_scrum78_')")
    .run(await hashToken(TOKEN));
  const identity = {
    authenticate: async (request) => (request.headers.get('X-Test-Clerk-User') ? { externalUserId: 'user_ana' } : null),
    verifiedEmail: async () => null,
  };
  env = { DB: d1(sqlite), ASSETS: { fetch: async () => new Response('') }, IDENTITY: identity };
});

const callWithToken = () =>
  worker.fetch(new Request('https://bpc.test/api/me', { headers: { Authorization: `Bearer ${TOKEN}` } }), env);

test('the call right after revoking in the web app gets 401, with no waiting', async () => {
  assert.equal((await callWithToken()).status, 200);
  const revoked = await worker.fetch(
    new Request('https://bpc.test/api/tokens/1/revoke', { method: 'POST', headers: { 'X-Test-Clerk-User': 'user_ana' } }),
    env,
  );
  assert.equal(revoked.status, 200);
  const next = await callWithToken();
  assert.equal(next.status, 401);
  assert.deepEqual(await next.json(), { error: 'INVALID_TOKEN' });
});

test('nothing is cached: a token revoked outside this Worker is refused on the next call', async () => {
  // Many calls first, so a cache would have had every chance to keep the token.
  for (let i = 0; i < 5; i += 1) assert.equal((await callWithToken()).status, 200);
  sqlite.exec("UPDATE api_tokens SET status = 'REVOKED' WHERE id = 1");
  assert.equal((await callWithToken()).status, 401);
});

test('the token of a deactivated user is refused on the next call too', async () => {
  assert.equal((await callWithToken()).status, 200);
  sqlite.exec("UPDATE users SET status = 'DEACTIVATED' WHERE id = 2");
  assert.equal((await callWithToken()).status, 401);
});
