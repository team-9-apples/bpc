// SI-02 / SCRUM-19: BMF fake company list adapter. Looks the partner up in the
// last good copy of the BMF feed (SCRUM-18), by VAT number, then by FN (OI-03).

const LAST_GOOD_FETCH = `SELECT fetched_at, feed_published_at FROM bmf_feed_fetches
WHERE status = 'OK' ORDER BY id DESC LIMIT 1`;

const ENTRY_BY = (column) =>
  `SELECT name, vat, fn, published_on FROM bmf_feed_entries WHERE ${column} = ? LIMIT 1`;

// Same formats as bmf-feed.js stores them: "atu 1234 5678" -> "ATU12345678",
// "FN 123456 A" -> "123456a".
export const normaliseVat = (vat) => String(vat ?? '').toUpperCase().replace(/[\s.\-]/g, '') || null;
export const normaliseFn = (fn) =>
  String(fn ?? '').toLowerCase().replace(/\s/g, '').replace(/^fn/, '') || null;

export function createBmfAdapter(env) {
  return {
    source: 'BMF',
    async check({ vat, fn }) {
      const fetch = await env.DB.prepare(LAST_GOOD_FETCH).first();
      if (!fetch) return { state: 'UNAVAILABLE', details: { reason: 'No copy of the BMF list yet' } };
      const list = { fetchedAt: fetch.fetched_at, publishedAt: fetch.feed_published_at };

      const byVat = normaliseVat(vat);
      const byFn = normaliseFn(fn);
      const entry =
        (byVat && (await env.DB.prepare(ENTRY_BY('vat')).bind(byVat).first())) ||
        (byFn && (await env.DB.prepare(ENTRY_BY('fn')).bind(byFn).first())) ||
        null;

      if (!entry) return { state: 'VALID', details: { list } };
      return {
        state: 'INVALID',
        details: { name: entry.name, vat: entry.vat, fn: entry.fn, publishedOn: entry.published_on, list },
      };
    },
  };
}
