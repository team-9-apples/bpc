// SI-07 (SCRUM-9): every external source is reached through its own adapter,
// all with the same interface, so one source can be replaced (for example by
// a mock) without touching the other checks.
//
// An adapter is { source, async check({ vat, fn }) } and resolves to
// { state, details }, where state is one of STATES and details is plain JSON.

import { createBmfAdapter } from './bmf.js';
import { createFirmenbuchAdapter } from './firmenbuch.js';
import { createGisaAdapter } from './gisa.js';
import { createHfuAdapter } from './hfu.js';
import { createViesAdapter, splitVat } from './vies.js';

// Same values as the CHECK constraints on check_results.
export const SOURCES = ['VIES', 'BMF', 'HFU', 'FIRMENBUCH', 'GISA'];
export const STATES = ['VALID', 'INVALID', 'NOT_FOUND', 'UNAVAILABLE', 'NOT_APPLICABLE'];

// One adapter per source. QS-PRF-01 allows 15 s for a whole request, so a
// single source gets less than that.
const DEFAULT_TIMEOUT_MS = 10_000;

const FACTORIES = {
  VIES: createViesAdapter,
  BMF: createBmfAdapter,
  HFU: createHfuAdapter,
  FIRMENBUCH: createFirmenbuchAdapter,
  GISA: createGisaAdapter,
};

// Builds the adapter for every source. `overrides` replaces single sources,
// e.g. { VIES: mockAdapter }, and leaves the others as they are. `options`
// (e.g. { fetch }) is passed to every adapter.
export function createAdapters(env, overrides = {}, options = {}) {
  return SOURCES.map((source) => overrides[source] ?? FACTORIES[source](env, options));
}

function unavailable(reason) {
  return { state: 'UNAVAILABLE', details: { reason } };
}

async function runOne(adapter, query, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(unavailable(`No answer within ${timeoutMs} ms`)), timeoutMs);
  });
  try {
    const result = await Promise.race([adapter.check(query), timeout]);
    if (!STATES.includes(result?.state)) return unavailable(`Invalid state from adapter: ${result?.state}`);
    return { state: result.state, details: result.details ?? null };
  } catch (error) {
    // One failing source must not fail the whole check.
    return unavailable(error.message);
  } finally {
    clearTimeout(timer);
  }
}

// Calls every adapter in parallel and returns one row per source, in the
// shape of check_results. For a partner outside Austria only VIES is called;
// the Austrian sources are NOT_APPLICABLE (FR-CHK-04, CR-10).
export async function runChecks(adapters, query, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const isAustrian = splitVat(query.vat)?.countryCode === 'AT';
  return Promise.all(
    adapters.map(async (adapter) => {
      if (!isAustrian && adapter.source !== 'VIES') {
        return {
          source: adapter.source,
          state: 'NOT_APPLICABLE',
          details: { note: 'Austrian register only' },
          queriedAt: new Date().toISOString(),
        };
      }
      return {
        source: adapter.source,
        ...(await runOne(adapter, query, timeoutMs)),
        queriedAt: new Date().toISOString(),
      };
    }),
  );
}
