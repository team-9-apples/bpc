// SCRUM-20 (FR-DOC-01): every request is stored with all proof fields.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getRequestRecord, runAndSaveChecks, startCheck } from '../src/check-request.js';
import { d1, migratedDatabase } from './d1.js';

// One organisation with one Request User.
function setup() {
  const sqlite = migratedDatabase();
  const db = d1(sqlite);
  sqlite.exec(`
    INSERT INTO organisations (id, name, fn) VALUES (1, 'Muster Bau GmbH', '111111a');
    INSERT INTO users (id, organisation_id, email, first_name, last_name, role, status) VALUES
      (10, 1, 'req@example.at', 'Rita', 'Request', 'REQUEST_USER', 'ACTIVE');
  `);
  const user = { id: 10, organisationId: 1, role: 'REQUEST_USER' };
  return { db, sqlite, user };
}

const now = new Date('2026-11-02T09:00:00Z');

// A fake source: answers with `answer`, or fails like a source that is down.
const fakeSource = (source, answer) => ({
  source,
  check: async () => {
    if (answer === 'DOWN') throw new Error('Connection refused');
    return answer;
  },
});

// One fake source per real source, with every kind of answer.
const fakeSources = [
  fakeSource('VIES', { state: 'VALID', details: { name: 'Muster Bau GmbH' } }),
  fakeSource('BMF', { state: 'NOT_FOUND' }),
  fakeSource('HFU', 'DOWN'),
  fakeSource('FIRMENBUCH', { state: 'INVALID', details: { reason: 'deleted' } }),
  fakeSource('GISA', { state: 'VALID', details: null }),
];

// 2026-11-02T09:00:03.123Z, always with milliseconds and Z (= UTC).
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

test('a completed request is stored with every proof field', async () => {
  const { db, user } = setup();
  const { requestId } = await startCheck({ db, now }, user, { vat: 'ATU12345678', fn: '123456a' });
  await runAndSaveChecks({ db, adapters: fakeSources, now: () => new Date('2026-11-02T09:00:05Z') }, requestId);

  const record = await getRequestRecord({ db }, 1, requestId);

  // The request: ID, organisation, requesting user, partner identifiers, timestamps in UTC.
  const { checks, ...request } = record;
  assert.deepEqual(request, {
    id: requestId,
    organisationId: 1,
    userId: 10,
    apiTokenId: null, // started in the web app, not with a token
    vat: 'ATU12345678',
    fn: '123456a',
    status: 'COMPLETED',
    startedAt: '2026-11-02T09:00:00.000Z',
    completedAt: '2026-11-02T09:00:05.000Z',
  });

  // Every check: its result state and the UTC time the source was queried.
  assert.deepEqual(
    checks.map(({ source, state, details }) => ({ source, state, details })),
    [
      { source: 'VIES', state: 'VALID', details: { name: 'Muster Bau GmbH' } },
      { source: 'BMF', state: 'NOT_FOUND', details: null },
      { source: 'HFU', state: 'UNAVAILABLE', details: { reason: 'Connection refused' } },
      { source: 'FIRMENBUCH', state: 'INVALID', details: { reason: 'deleted' } },
      { source: 'GISA', state: 'VALID', details: null },
    ],
  );
  for (const check of checks) {
    assert.match(check.queriedAt, UTC, `${check.source} has no UTC query time`);
  }
});

test('a request started with an API token stores the token and its user', async () => {
  const { db, sqlite, user } = setup();
  sqlite.exec("INSERT INTO api_tokens (id, user_id, name, secret_hash) VALUES (5, 10, 'ERP', 'hash')");

  const { requestId } = await startCheck({ db, now, apiTokenId: 5 }, user, { vat: 'ATU12345678' });

  const record = await getRequestRecord({ db }, 1, requestId);
  assert.equal(record.userId, 10); // the token's user
  assert.equal(record.apiTokenId, 5);
  const log = sqlite.prepare("SELECT api_token_id FROM audit_log WHERE action = 'REQUEST_STARTED'").get();
  assert.equal(log.api_token_id, 5);
});

test('if one result cannot be saved, nothing is saved and the request stays RUNNING', async () => {
  const { db, sqlite, user } = setup();
  const { requestId } = await startCheck({ db, now }, user, { vat: 'ATU12345678' });

  // Two results for VIES: the database allows only one per source, so the second fails.
  const twiceVies = [fakeSource('VIES', { state: 'VALID' }), fakeSource('VIES', { state: 'VALID' })];
  await assert.rejects(runAndSaveChecks({ db, adapters: twiceVies }, requestId));

  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM check_results').get().n, 0);
  const row = sqlite.prepare('SELECT status, completed_at FROM requests WHERE id = ?').get(requestId);
  assert.deepEqual({ ...row }, { status: 'RUNNING', completed_at: null });
});

test('a request of another organisation cannot be read', async () => {
  const { db, sqlite, user } = setup();
  sqlite.exec("INSERT INTO organisations (id, name, fn) VALUES (2, 'Other GmbH', '222222b')");
  const { requestId } = await startCheck({ db, now }, user, { vat: 'ATU12345678' });

  assert.equal(await getRequestRecord({ db }, 2, requestId), null); // organisation 2 asks for organisation 1's request
  assert.equal(await getRequestRecord({ db }, 1, 999), null); // no such request
});

test('running the checks of an unknown request fails', async () => {
  const { db } = setup();
  await assert.rejects(runAndSaveChecks({ db, adapters: fakeSources }, 999), /Request 999 not found/);
});