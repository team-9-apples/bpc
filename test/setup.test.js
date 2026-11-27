// SCRUM-94: the schema applies to an empty database, setup creates exactly one
// Super Admin, and a second run creates none.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SYSTEM } from '../src/audit.js';
import { SELECT_SUPER_ADMIN_SQL, createSuperAdmin, inlineParams, validateEmail, wranglerDb } from '../scripts/setup-lib.js';
import { d1, migratedDatabase } from './d1.js';

const schema = readFileSync(new URL('../migrations/0001_initial_schema.sql', import.meta.url), 'utf8');

function emptyDatabaseWithSchema() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  return db;
}

test('schema creates all tables on an empty database', () => {
  const db = emptyDatabaseWithSchema();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => row.name);
  assert.deepEqual(tables, ['api_tokens', 'audit_log', 'check_results', 'email_verifications', 'organisations', 'requests', 'users']);
});

test('setup creates exactly one Super Admin, and a second run creates none', async () => {
  const db = migratedDatabase();
  assert.equal(typeof (await createSuperAdmin(d1(db), { email: 'ops@example.com' })), 'number');
  assert.equal(await createSuperAdmin(d1(db), { email: 'other@example.com' }), null);

  const admins = db.prepare(SELECT_SUPER_ADMIN_SQL).all();
  assert.deepEqual(admins.map((row) => row.email), ['ops@example.com']);

  const admin = db.prepare("SELECT * FROM users WHERE role = 'SUPER_ADMIN'").get();
  assert.equal(admin.organisation_id, null);
  assert.equal(admin.status, 'ACTIVE');
});

test('database refuses a second Super Admin even without the setup guard', () => {
  const db = emptyDatabaseWithSchema();
  const insert = "INSERT INTO users (email, first_name, last_name, role) VALUES (?, 'Super', 'Admin', 'SUPER_ADMIN')";
  db.prepare(insert).run('a@example.com');
  assert.throws(() => db.prepare(insert).run('b@example.com'), /UNIQUE constraint failed/);
});

test('organisation users need an organisation, the Super Admin must not have one', () => {
  const db = emptyDatabaseWithSchema();
  assert.throws(
    () => db.exec("INSERT INTO users (email, first_name, last_name, role) VALUES ('x@example.com', 'X', 'Y', 'ADMIN')"),
    /CHECK constraint failed/,
  );
});

test('e-mail input is quoted safely when the SQL goes through wrangler', async () => {
  const sqlite = migratedDatabase();
  // Stands in for `wrangler d1 execute --command`: runs one finished SQL string.
  const query = (sql) => (/RETURNING/i.test(sql) ? sqlite.prepare(sql).all() : (sqlite.exec(sql), []));
  await createSuperAdmin(wranglerDb(query), { email: "o'brien@example.com" });
  assert.equal(sqlite.prepare(SELECT_SUPER_ADMIN_SQL).get().email, "o'brien@example.com");
});

test('inlineParams writes NULL, numbers and quoted strings, and checks the count', () => {
  assert.equal(inlineParams('VALUES (?, ?, ?)', [null, 7, "it's ?"]), "VALUES (NULL, 7, 'it''s ?')");
  assert.throws(() => inlineParams('VALUES (?)', []), /placeholders/);
});

// SCRUM-22 (QS-OBS-01, QS-OBS-02): creating the Super Admin is logged, with SYSTEM as the actor.
test('creating the Super Admin is logged in UTC with SYSTEM as the actor, a second run logs nothing', async () => {
  const sqlite = migratedDatabase();
  const id = await createSuperAdmin(d1(sqlite), { email: 'ops@example.com', now: new Date('2026-11-27T09:00:00Z') });
  await createSuperAdmin(d1(sqlite), { email: 'other@example.com' });

  const entries = sqlite.prepare('SELECT * FROM audit_log').all();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].action, 'USER_CREATED');
  assert.equal(entries[0].created_at, '2026-11-27T09:00:00.000Z');
  assert.equal(entries[0].user_id, null);
  assert.deepEqual(JSON.parse(entries[0].details), { actor: SYSTEM, created_user_id: id, role: 'SUPER_ADMIN', via: 'setup' });
});

test('invalid e-mail is rejected', () => {
  assert.throws(() => validateEmail(undefined), /SUPER_ADMIN_EMAIL/);
  assert.throws(() => validateEmail('not-an-email'), /SUPER_ADMIN_EMAIL/);
});
