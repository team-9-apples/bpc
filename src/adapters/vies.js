// SI-01 / SCRUM-66: VIES (EU VAT check) adapter for every EU member state (FR-CHK-03).
// VIES reports errors in the body with HTTP 200, so the body decides the result.

// DI-04 / SCRUM-88: the endpoint comes from the VIES_URL variable, not from the
// code (see .dev.vars.example). Without it the check reports UNAVAILABLE.

const TIMEOUT_MS = 10_000;

// VIES prefixes: Greece is EL, XI is Northern Ireland.
export const VIES_COUNTRIES = [
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'EL', 'ES', 'FI', 'FR', 'HR', 'HU',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'XI',
];

// "ATU 123 456-78" -> { countryCode: 'AT', vatNumber: 'U12345678' }; null if not an EU prefix.
export function splitVat(vat) {
  const compact = String(vat ?? '').toUpperCase().replace(/[\s.\-]/g, '');
  const match = /^([A-Z]{2})([0-9A-Z+*]{2,12})$/.exec(compact);
  if (!match) return null;
  const countryCode = match[1] === 'GR' ? 'EL' : match[1];
  return VIES_COUNTRIES.includes(countryCode) ? { countryCode, vatNumber: match[2] } : null;
}

// VIES fills unknown fields with "---".
function text(value) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed && trimmed !== '---' ? trimmed : null;
}

// fetch can be replaced in tests.
export function createViesAdapter(env, { fetch = globalThis.fetch } = {}) {
  return {
    source: 'VIES',
    async check({ vat }) {
      const parts = splitVat(vat);
      if (!parts) {
        return { state: 'INVALID', details: { reason: 'Not an EU VAT number', vat: vat ?? null } };
      }

      // runChecks turns a thrown error into UNAVAILABLE.
      if (!env.VIES_URL) throw new Error('VIES_URL is not configured');
      const response = await fetch(env.VIES_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(parts),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`VIES answered HTTP ${response.status}`);
      const body = await response.json();

      if (body.actionSucceed === false) {
        const error = body.errorWrappers?.[0]?.error ?? 'UNKNOWN_ERROR';
        // INVALID_INPUT: VIES rejected the number. Any other code: VIES could not check it.
        if (error === 'INVALID_INPUT') {
          return { state: 'INVALID', details: { reason: 'VIES rejected the VAT number format', error } };
        }
        return { state: 'UNAVAILABLE', details: { reason: `VIES could not check the number (${error})`, error } };
      }
      if (typeof body.valid !== 'boolean') throw new Error('VIES answer has no "valid" field');

      const details = {
        vat: `${body.countryCode ?? parts.countryCode}${body.vatNumber ?? parts.vatNumber}`,
        requestDate: body.requestDate ?? null,
      };
      if (!body.valid) return { state: 'INVALID', details };
      return { state: 'VALID', details: { ...details, name: text(body.name), address: text(body.address) } };
    },
  };
}
