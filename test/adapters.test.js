// SCRUM-9: all five sources go through one adapter interface, one adapter can
// be replaced by a mock without changing the others, and a failing source
// only affects its own result.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SOURCES, createAdapters, runChecks } from '../src/adapters/index.js';
import { d1, migratedDatabase } from './d1.js';

const query = { vat: 'ATU12345678', fn: null };
const mock = (source, check) => ({ source, check });
// Keeps the VIES adapter offline.
const offline = {
  fetch: async () => {
    throw new Error('offline in tests');
  },
};

test('there is exactly one adapter per source, all with the same interface', () => {
  const adapters = createAdapters({});
  assert.deepEqual(adapters.map((adapter) => adapter.source), SOURCES);
  for (const adapter of adapters) assert.equal(typeof adapter.check, 'function');
});

test('every source is called through the interface and returns a check_results row', async () => {
  const results = await runChecks(createAdapters({ DB: d1(migratedDatabase()) }, {}, offline), query);
  assert.deepEqual(results.map((row) => row.source), SOURCES);
  // VIES (SCRUM-66) and BMF (SCRUM-19) are implemented; here VIES is offline and
  // the empty database has no copy of the BMF list yet.
  const reasons = { VIES: /offline in tests/, BMF: /No copy of the BMF list yet/ };
  for (const row of results) {
    assert.equal(row.state, 'UNAVAILABLE');
    assert.match(row.details.reason, reasons[row.source] ?? /Not implemented yet \(SCRUM-\d+\)/);
    assert.ok(!Number.isNaN(Date.parse(row.queriedAt)));
  }
});

test('replacing one adapter with a mock leaves the others unchanged', async () => {
  const calls = [];
  const vies = mock('VIES', async (q) => {
    calls.push(q);
    return { state: 'VALID', details: { name: 'Example GmbH' } };
  });
  const original = await runChecks(createAdapters({}, {}, offline), query);
  const mocked = await runChecks(createAdapters({}, { VIES: vies }, offline), query);

  assert.deepEqual(calls, [query]);
  const { queriedAt, ...viesRow } = mocked[0];
  assert.deepEqual(viesRow, { source: 'VIES', state: 'VALID', details: { name: 'Example GmbH' } });
  const withoutTime = (rows) => rows.slice(1).map(({ queriedAt, ...row }) => row);
  assert.deepEqual(withoutTime(mocked), withoutTime(original));
});

test('a source that throws is UNAVAILABLE, the others still answer', async () => {
  const results = await runChecks(
    createAdapters({}, {
      BMF: mock('BMF', async () => {
        throw new Error('feed down');
      }),
      HFU: mock('HFU', async () => ({ state: 'NOT_FOUND', details: null })),
    }, offline),
    query,
  );
  const bySource = Object.fromEntries(results.map((row) => [row.source, row]));
  assert.deepEqual(bySource.BMF.details, { reason: 'feed down' });
  assert.equal(bySource.BMF.state, 'UNAVAILABLE');
  assert.equal(bySource.HFU.state, 'NOT_FOUND');
});

test('a source that answers too late or with an unknown state is UNAVAILABLE', async () => {
  const results = await runChecks(
    [
      mock('VIES', () => new Promise(() => {})),
      mock('GISA', async () => ({ state: 'MAYBE' })),
    ],
    query,
    { timeoutMs: 20 },
  );
  assert.deepEqual(
    results.map(({ source, state, details }) => ({ source, state, details })),
    [
      { source: 'VIES', state: 'UNAVAILABLE', details: { reason: 'No answer within 20 ms' } },
      { source: 'GISA', state: 'UNAVAILABLE', details: { reason: 'Invalid state from adapter: MAYBE' } },
    ],
  );
});
