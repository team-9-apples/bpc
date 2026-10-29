#!/usr/bin/env node
// Sprint 1 proof of concept (DI-07, SCRUM-25): fetches the live BMF feed into a
// temporary in-memory database (SCRUM-18), then runs one check through all adapters.
//
//   npm run poc -- ATU12345678          # real VIES
//   npm run poc -- AT100 --test         # VIES test service: 100 = valid, 200 = invalid

import { refreshBmfFeed } from '../src/bmf-feed.js';
import { createAdapters, runChecks } from '../src/adapters/index.js';
import { d1, migratedDatabase } from '../test/d1.js';

const VIES_TEST_URL = 'https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-test-service';

const args = process.argv.slice(2);
const testMode = args.includes('--test');
const vat = args.find((arg) => !arg.startsWith('--')) ?? (testMode ? 'AT100' : null);
if (!vat) {
  console.error('Usage: npm run poc -- <VAT number> [--test]');
  process.exit(1);
}

const env = { DB: d1(migratedDatabase()), ...(testMode ? { VIES_URL: VIES_TEST_URL } : {}) };

console.log('\nBMF fake company list (live feed)\n');
const feed = await refreshBmfFeed(env);
if (feed.status === 'OK') {
  console.log(`  Published  ${feed.feedPublishedAt ?? 'unknown'}`);
  console.log(`  Entries    ${feed.entries}`);
} else {
  console.log(`  Could not read the feed: ${feed.error}`);
}

console.log(`\nCheck for ${vat}${testMode ? ' (VIES test service)' : ''}\n`);
const results = await runChecks(createAdapters(env), { vat, fn: null });
for (const row of results) {
  const { reason, name, address } = row.details ?? {};
  const info = reason ?? [name, address?.replace(/\s*\n\s*/g, ', ')].filter(Boolean).join(' · ');
  console.log(`  ${row.source.padEnd(10)} ${row.state.padEnd(11)} ${info ?? ''}`);
}
console.log('');
