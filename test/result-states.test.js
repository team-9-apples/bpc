// SCRUM-42 (FR-CHK-04): every check of a request has exactly one state.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STATES, runChecks } from '../src/adapters/index.js';
import { migratedDatabase } from './d1.js';

// A database with one organisation, one user and one request (ID 1).
function setup() {
  const sqlite = migratedDatabase();
  sqlite.exec(`
    INSERT INTO organisations (id, name, fn) VALUES (1, 'Muster Bau GmbH', '111111a');
    INSERT INTO users (id, organisation_id, email, first_name, last_name, role, status)
      VALUES (10, 1, 'req@example.at', 'Rita', 'Request', 'REQUEST_USER', 'ACTIVE');
    INSERT INTO requests (id, organisation_id, user_id, input_vat) VALUES (1, 1, 10, 'ATU12345678');
  `);
  const insert = sqlite.prepare(
    "INSERT INTO check_results (request_id, source, state, queried_at) VALUES (1, ?, ?, '2026-11-06T12:00:00.000Z')",
  );
  return { sqlite, insert };
}

test('there are exactly the five result states', () => {
  assert.deepEqual(STATES, ['VALID', 'INVALID', 'NOT_FOUND', 'UNAVAILABLE', 'NOT_APPLICABLE']);
});

test('runChecks passes every state on unchanged', async () => {
  const adapters = STATES.map((state) => ({ source: state, check: async () => ({ state, details: null }) }));
  const results = await runChecks(adapters, { vat: 'ATU12345678', fn: null });
  assert.deepEqual(results.map((row) => row.state), STATES);
});

test('the database stores every state', () => {
  for (const state of STATES) {
    const { sqlite, insert } = setup();
    insert.run('VIES', state);
    assert.equal(sqlite.prepare('SELECT state FROM check_results').get().state, state);
  }
});

test('the database refuses an unknown state', () => {
  const { insert } = setup();
  assert.throws(() => insert.run('VIES', 'MAYBE'), /CHECK constraint failed/);
});

test('the database refuses a check without a state', () => {
  const { insert } = setup();
  assert.throws(() => insert.run('VIES', null), /NOT NULL constraint failed/);
});

test('one source of a request cannot have two states', () => {
  const { insert } = setup();
  insert.run('VIES', 'VALID');
  assert.throws(() => insert.run('VIES', 'INVALID'), /UNIQUE constraint failed/);
});
