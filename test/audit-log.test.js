// SCRUM-22 (QS-OBS-01, QS-OBS-02) and SCRUM-80 (QS-REL-02):
// - a demo session leaves every required event in the audit log, each with a
//   UTC timestamp and the user, token or SYSTEM that triggered it;
// - the audit log cannot be changed or emptied;
// - a completed request cannot be changed, only deleted as a whole.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SOURCES } from '../src/adapters/index.js';
import { SYSTEM, audit, auditStatement } from '../src/audit.js';
import { refreshBmfFeed } from '../src/bmf-feed.js';
import { runAndSaveChecks, startCheck } from '../src/check-request.js';
import { linkExternalUser, registerOrganisation } from '../src/registration.js';
import { createUser } from '../src/users.js';
import { d1, migratedDatabase } from './d1.js';

const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Every source answers VALID at once.
const mockSources = () => SOURCES.map((source) => ({ source, check: async () => ({ state: 'VALID', details: null }) }));

const log = (sqlite) => sqlite.prepare('SELECT * FROM audit_log ORDER BY id').all();

// One organisation with an admin and a Request User, and one finished request.
async function withCompletedRequest() {
  const sqlite = migratedDatabase();
  const db = d1(sqlite);
  sqlite.exec(`
    INSERT INTO organisations (id, name, fn) VALUES (1, 'Muster Bau GmbH', '111111a');
    INSERT INTO users (id, organisation_id, email, first_name, last_name, role, status) VALUES
      (10, 1, 'req@example.at', 'Rita', 'Request', 'REQUEST_USER', 'ACTIVE');
  `);
  const user = { id: 10, organisationId: 1, role: 'REQUEST_USER' };
  const { requestId } = await startCheck({ db }, user, { vat: 'ATU12345678' });
  await runAndSaveChecks({ db, adapters: mockSources() }, requestId);
  return { sqlite, db, requestId };
}

test('a demo session logs every request, source call, feed fetch and user creation in UTC', async () => {
  const sqlite = migratedDatabase();
  const db = d1(sqlite);

  // An organisation registers and its admin signs in for the first time.
  const { organisationId, userId: adminId } = await registerOrganisation(
    { db },
    { organisationName: 'Muster Bau GmbH', organisationNumber: 'FN 123456a', firstName: 'Anna', lastName: 'Admin', email: 'anna@example.at' },
  );
  await linkExternalUser({ db }, { email: 'anna@example.at', externalUserId: 'user_anna' });
  const admin = { id: adminId, organisationId, role: 'ADMIN' };

  // The admin creates a Request User.
  const identity = { invite: async () => {} };
  const created = await createUser({ db, identity }, admin, { firstName: 'Rita', lastName: 'Request', email: 'rita@example.at', role: 'REQUEST_USER' }, 'https://bpc.example/signup');
  assert.equal(created.ok, true);

  // An Austrian check (all five sources), a German one (only VIES), and a rejected input.
  for (const vat of ['ATU12345678', 'DE123456789']) {
    const { requestId } = await startCheck({ db }, admin, { vat });
    await runAndSaveChecks({ db, adapters: mockSources() }, requestId);
  }
  await startCheck({ db }, admin, { vat: 'nonsense' });

  // The scheduled feed fetch, here failing.
  await refreshBmfFeed({ DB: db, BMF_FEED_URL: 'https://bmf.example/feed' }, { fetch: async () => new Response('', { status: 500 }) });

  const entries = log(sqlite);
  const count = (action) => entries.filter((entry) => entry.action === action).length;
  assert.equal(count('ORGANISATION_REGISTERED'), 1);
  assert.equal(count('ACCOUNT_ACTIVATED'), 1);
  assert.equal(count('USER_CREATED'), 1);
  assert.equal(count('REQUEST_STARTED'), 2);
  assert.equal(count('REQUEST_REJECTED'), 1);
  assert.equal(count('REQUEST_COMPLETED'), 2);
  // 5 calls for the Austrian partner, 1 (VIES) for the German one.
  assert.equal(count('SOURCE_CALL'), 6);
  assert.equal(count('BMF_FEED_FETCH'), 1);

  for (const entry of entries) {
    // QS-OBS-01: every entry has a UTC timestamp.
    assert.match(entry.created_at, UTC, `${entry.action} timestamp`);
    // QS-OBS-02: every entry names a user, a token or the system.
    const actor = JSON.parse(entry.details ?? '{}').actor;
    assert.ok(entry.user_id != null || entry.api_token_id != null || actor === SYSTEM, `${entry.action} has no actor`);
  }
});

test('source calls and the completion are logged in the name of whoever started the request', async () => {
  const { sqlite, requestId } = await withCompletedRequest();
  const calls = log(sqlite).filter((entry) => entry.action === 'SOURCE_CALL');

  assert.deepEqual(calls.map((entry) => JSON.parse(entry.details).source).sort(), [...SOURCES].sort());
  for (const entry of calls) {
    assert.equal(entry.user_id, 10);
    assert.deepEqual(JSON.parse(entry.details), { requestId, source: JSON.parse(entry.details).source, state: 'VALID' });
  }
  const completed = log(sqlite).find((entry) => entry.action === 'REQUEST_COMPLETED');
  assert.equal(completed.user_id, 10);
  assert.equal(JSON.parse(completed.details).requestId, requestId);
});

test('the feed fetch is logged with SYSTEM as the actor', async () => {
  const sqlite = migratedDatabase();
  await refreshBmfFeed({ DB: d1(sqlite) }, { fetch: async () => new Response('') });
  const [entry] = log(sqlite);
  assert.equal(entry.action, 'BMF_FEED_FETCH');
  assert.equal(JSON.parse(entry.details).actor, SYSTEM);
});

test('an audit entry without a user, token or SYSTEM is refused', () => {
  const db = d1(migratedDatabase());
  assert.throws(() => auditStatement(db, { at: new Date(), action: 'SOMETHING' }), /QS-OBS-02/);
});

test('audit entries are always stored in UTC', async () => {
  const sqlite = migratedDatabase();
  const db = d1(sqlite);
  sqlite.exec(`
    INSERT INTO organisations (id, name, fn) VALUES (1, 'Muster Bau GmbH', '111111a');
    INSERT INTO users (id, organisation_id, email, first_name, last_name, role, status) VALUES
      (10, 1, 'req@example.at', 'Rita', 'Request', 'REQUEST_USER', 'ACTIVE');
  `);
  await audit(db, { at: '2026-11-27T10:26:05+01:00', userId: 10, action: 'TEST' });
  assert.equal(log(sqlite)[0].created_at, '2026-11-27T09:26:05.000Z');
});

test('the audit log cannot be changed or emptied', async () => {
  const { sqlite } = await withCompletedRequest();
  const before = log(sqlite);

  assert.throws(() => sqlite.exec("UPDATE audit_log SET action = 'X'"), /append-only/);
  assert.throws(() => sqlite.exec('DELETE FROM audit_log'), /append-only/);
  assert.deepEqual(log(sqlite), before);
});

test('a completed request and its results cannot be changed', async () => {
  const { sqlite, requestId } = await withCompletedRequest();

  assert.throws(() => sqlite.exec(`UPDATE requests SET summary = 'OK' WHERE id = ${requestId}`), /QS-REL-02/);
  assert.throws(() => sqlite.exec(`UPDATE requests SET status = 'RUNNING' WHERE id = ${requestId}`), /QS-REL-02/);
  assert.throws(() => sqlite.exec(`UPDATE check_results SET state = 'INVALID' WHERE request_id = ${requestId}`), /QS-REL-02/);
  assert.throws(() => sqlite.exec(`DELETE FROM check_results WHERE request_id = ${requestId} AND source = 'GISA'`), /QS-REL-02/);
  assert.throws(
    () => sqlite.exec(`INSERT INTO check_results (request_id, source, state, queried_at) VALUES (${requestId}, 'GISA', 'VALID', '2026-11-27T00:00:00.000Z')`),
    /QS-REL-02/,
  );
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM check_results WHERE request_id = ?').get(requestId).n, 5);
});

test('running the checks of a completed request again is refused', async () => {
  const { db, requestId } = await withCompletedRequest();
  await assert.rejects(runAndSaveChecks({ db, adapters: mockSources() }, requestId), /QS-REL-02/);
});

test('a completed request can still be deleted as a whole, with its results', async () => {
  const { sqlite, requestId } = await withCompletedRequest();

  sqlite.exec(`DELETE FROM requests WHERE id = ${requestId}`);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM check_results').get().n, 0);
});
