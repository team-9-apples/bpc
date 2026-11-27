// SCRUM-60 / FR-API-05: a token stays valid until it is revoked or its user is
// deactivated. Tokens get no expiry date, and none can be set when creating one.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { createApiToken, tokenUser } from '../src/api-token.js';
import { d1, migratedDatabase } from './d1.js';

let sqlite;
let db;
const admin = { id: 1, role: 'ADMIN', organisationId: 1 };

beforeEach(() => {
  sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO organisations (id, name, fn) VALUES (1, 'Bau GmbH', 'FN 123456a');
    INSERT INTO users (id, organisation_id, email, first_name, last_name, role, status) VALUES
      (1, 1, 'ana@bau.example',  'Ana',  'Berger', 'ADMIN',        'ACTIVE'),
      (2, 1, 'rita@bau.example', 'Rita', 'Rot',    'REQUEST_USER', 'ACTIVE');
  `);
  db = d1(sqlite);
});

const created = new Date('2026-11-27T10:00:00.000Z');
const tenYearsLater = new Date('2036-11-27T10:00:00.000Z');
const call = (secret) => new Request('https://bpc.test/api/me', { headers: { Authorization: `Bearer ${secret}` } });

test('a new token has no expiry date, even if the input asks for one', async () => {
  const { token } = await createApiToken({ db, now: created }, admin, {
    userId: 2,
    name: 'ERP',
    expiresAt: '2026-12-01T00:00:00.000Z',
  });
  assert.equal(token.expiresAt, null);
  assert.equal(sqlite.prepare('SELECT expires_at FROM api_tokens WHERE id = ?').get(token.id).expires_at, null);
});

test('a token still works ten years after it was created', async () => {
  const { secret } = await createApiToken({ db, now: created }, admin, { userId: 2, name: 'ERP' });
  const result = await tokenUser({ db, now: tenYearsLater }, call(secret));
  assert.equal(result.user?.id, 2);
});

test('a token stops working once it is revoked', async () => {
  const { token, secret } = await createApiToken({ db, now: created }, admin, { userId: 2, name: 'ERP' });
  sqlite.prepare("UPDATE api_tokens SET status = 'REVOKED' WHERE id = ?").run(token.id);
  assert.deepEqual(await tokenUser({ db, now: created }, call(secret)), { error: 'INVALID_TOKEN' });
});

test('a token stops working once its user is deactivated', async () => {
  const { secret } = await createApiToken({ db, now: created }, admin, { userId: 2, name: 'ERP' });
  sqlite.exec("UPDATE users SET status = 'DEACTIVATED' WHERE id = 2");
  assert.deepEqual(await tokenUser({ db, now: created }, call(secret)), { error: 'INVALID_TOKEN' });
});
