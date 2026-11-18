// SCRUM-43 (FR-CHK-05) and SCRUM-79 (QS-REL-01): when one source is offline,
// the request still completes, only that check is UNAVAILABLE and the other
// four keep their normal result. One test file covers both tickets.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SOURCES, runChecks } from '../src/adapters/index.js';
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
  return { db, user };
}

// The normal answer of each source when it is online.
const NORMAL = {
  VIES: { state: 'VALID', details: { name: 'Muster Bau GmbH' } },
  BMF: { state: 'VALID', details: null },
  HFU: { state: 'NOT_FOUND', details: { reason: 'not on the HFU list' } },
  FIRMENBUCH: { state: 'VALID', details: null },
  GISA: { state: 'INVALID', details: { reason: 'licence expired' } },
};

// Five mocked sources: `offlineSource` fails like a source that is down, the others answer normally.
function sourcesWithOneOffline(offlineSource) {
  return SOURCES.map((source) => ({
    source,
    check: async () => {
      if (source === offlineSource) throw new Error('Connection refused');
      return NORMAL[source];
    },
  }));
}

// Run the test once for every source, so each one is the offline one once.
for (const offlineSource of SOURCES) {
  test(`with ${offlineSource} offline the request completes and only ${offlineSource} is UNAVAILABLE`, async () => {
    const { db, user } = setup();
    const { requestId } = await startCheck({ db }, user, { vat: 'ATU12345678' });

    await runAndSaveChecks({ db, adapters: sourcesWithOneOffline(offlineSource) }, requestId);
    const record = await getRequestRecord({ db }, 1, requestId);

    // Acceptance criterion 1: the request completes.
    assert.equal(record.status, 'COMPLETED');
    assert.ok(record.completedAt);
    assert.notEqual(record.overallStatus, null);

    // Acceptance criterion 2: only the offline source is UNAVAILABLE,
    // the other four have their normal result states.
    assert.equal(record.checks.length, 5);
    for (const check of record.checks) {
      if (check.source === offlineSource) {
        assert.equal(check.state, 'UNAVAILABLE');
        assert.deepEqual(check.details, { reason: 'Connection refused' });
      } else {
        assert.equal(check.state, NORMAL[check.source].state, `${check.source} should keep its normal state`);
        assert.deepEqual(check.details, NORMAL[check.source].details);
      }
    }
  });
}

// A source that never answers counts as offline too (10 s timeout, SCRUM-45).
test('a source that never answers is UNAVAILABLE, the other four answer normally', async () => {
  const adapters = SOURCES.map((source) => ({
    source,
    check: source === 'VIES' ? () => new Promise(() => {}) : async () => NORMAL[source],
  }));

  const results = await runChecks(adapters, { vat: 'ATU12345678', fn: null }, { timeoutMs: 20 });

  for (const result of results) {
    if (result.source === 'VIES') {
      assert.equal(result.state, 'UNAVAILABLE');
    } else {
      assert.equal(result.state, NORMAL[result.source].state);
    }
  }
});
