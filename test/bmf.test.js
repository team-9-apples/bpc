// SCRUM-19 / SI-02: the BMF adapter looks the partner up in the last good copy
// of the fake company list, by VAT number, then by FN (OI-03).
//
// The entries below are invented names and numbers.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBmfAdapter, normaliseFn, normaliseVat } from '../src/adapters/bmf.js';
import { d1, migratedDatabase } from './d1.js';

function setup() {
  const sqlite = migratedDatabase();
  return { sqlite, adapter: createBmfAdapter({ DB: d1(sqlite) }) };
}

// One successful fetch with two listed companies.
function withList(sqlite) {
  sqlite.exec(`
    INSERT INTO bmf_feed_fetches (id, fetched_at, status, feed_published_at, entry_count)
    VALUES (1, '2026-10-29T04:17:00.000Z', 'OK', '2026-10-28', 2);
    INSERT INTO bmf_feed_entries (fetch_id, name, vat, fn, published_on) VALUES
      (1, 'Schein Bau GmbH', 'ATU99999999', '999999z', '2026-10-20'),
      (1, 'Ohne UID KG', NULL, '888888y', '2026-10-21');
  `);
}

const list = { fetchedAt: '2026-10-29T04:17:00.000Z', publishedAt: '2026-10-28' };

test('inputs are tidied to the stored formats', () => {
  assert.equal(normaliseVat('atu 9999-9999'), 'ATU99999999');
  assert.equal(normaliseFn('FN 999999 Z'), '999999z');
  assert.equal(normaliseVat(null), null);
  assert.equal(normaliseFn(''), null);
});

test('without a saved copy of the list the check is UNAVAILABLE', async () => {
  const { adapter } = setup();
  assert.deepEqual(await adapter.check({ vat: 'ATU99999999', fn: null }), {
    state: 'UNAVAILABLE',
    details: { reason: 'No copy of the BMF list yet' },
  });
});

test('only failed fetches also count as no copy', async () => {
  const { sqlite, adapter } = setup();
  sqlite.exec(`INSERT INTO bmf_feed_fetches (fetched_at, status, error) VALUES ('2026-10-29T04:17:00Z', 'FAILED', 'HTTP 503')`);
  assert.equal((await adapter.check({ vat: 'ATU99999999' })).state, 'UNAVAILABLE');
});

test('a partner listed by VAT number is INVALID with the listed entry', async () => {
  const { sqlite, adapter } = setup();
  withList(sqlite);
  assert.deepEqual(await adapter.check({ vat: 'ATU99999999', fn: null }), {
    state: 'INVALID',
    details: { name: 'Schein Bau GmbH', vat: 'ATU99999999', fn: '999999z', publishedOn: '2026-10-20', list },
  });
});

test('a partner listed only by FN is found through the FN', async () => {
  const { sqlite, adapter } = setup();
  withList(sqlite);
  const result = await adapter.check({ vat: 'ATU12345678', fn: 'FN 888888 y' });
  assert.equal(result.state, 'INVALID');
  assert.equal(result.details.name, 'Ohne UID KG');
});

test('a partner that is not listed is VALID, with the age of the list', async () => {
  const { sqlite, adapter } = setup();
  withList(sqlite);
  assert.deepEqual(await adapter.check({ vat: 'ATU12345678', fn: '123456a' }), { state: 'VALID', details: { list } });
});

test('spaces and lower case in the VAT number still match', async () => {
  const { sqlite, adapter } = setup();
  withList(sqlite);
  assert.equal((await adapter.check({ vat: 'atu 9999 9999' })).state, 'INVALID');
});

test('the newest successful copy is used', async () => {
  const { sqlite, adapter } = setup();
  withList(sqlite);
  sqlite.exec(`
    INSERT INTO bmf_feed_fetches (id, fetched_at, status, feed_published_at, entry_count)
    VALUES (2, '2026-10-30T04:17:00.000Z', 'OK', '2026-10-30', 0);
  `);
  const result = await adapter.check({ vat: 'ATU12345678' });
  assert.deepEqual(result.details.list, { fetchedAt: '2026-10-30T04:17:00.000Z', publishedAt: '2026-10-30' });
});
