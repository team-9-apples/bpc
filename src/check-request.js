// SCRUM-16: start a partner check by VAT number (optional FN).

// One regex per EU country, keyed by the 2-letter prefix.
const VAT_FORMATS = {
  AT: /^ATU\d{8}$/,   // ATU + 8 digits
  DE: /^DE\d{9}$/,    // DE + 9 digits
  // more countries later
};


// Takes whatever the user typed and returns either: { ok: true, vat: 'ATU12345678' }   (cleaned up) or, { ok: false, error: 'INVALID_VAT' }
export function validateVat(input) {
  // if input is not a string, return the error
  if (typeof input !== 'string') {
    return { ok: false, error: 'INVALID_VAT' };
  }

  // remove spaces and dots, make it uppercase
  const cleaned = input.replace(/[\s.]/g, '').toUpperCase();

  // the first two letters are the country
  const country = cleaned.slice(0, 2);

  // look up the regex for that country
  const re = VAT_FORMATS[country];

  // unknown country -> error
  if (!re) {
    return { ok: false, error: 'INVALID_VAT' };
  }

  // wrong format for that country -> error
  if (!re.test(cleaned)) {
    return { ok: false, error: 'INVALID_VAT' };
  }

  return { ok: true, vat: cleaned };   // passed everything: success
}

// The FN is optional. Returns { ok: true, fn: '123456a' }, { ok: true, fn: null } when nothing was entered, or { ok: false, error: 'INVALID_FN' }.
export function validateFn(input) {
  // nothing entered -> fine, no FN
  if (input === undefined || input === null || input === '') {
    return { ok: true, fn: null };
  }

  // not text -> error
  if (typeof input !== 'string') {
    return { ok: false, error: 'INVALID_FN' };
  }

  // remove spaces, make lowercase (the check letter is lowercase)
  const cleaned = input.replace(/\s/g, '').toLowerCase();

  // 1 to 6 digits, then one letter
  if (!/^\d{1,6}[a-z]$/.test(cleaned)) {
    return { ok: false, error: 'INVALID_FN' };
  }

  return { ok: true, fn: cleaned };
}

// Only these roles may start a check (SRS section 2.4 permission table).
// Review Users may not; the Super Admin is outside every organisation.
const ROLES_THAT_MAY_START = ['REQUEST_USER', 'ADMIN'];

const auditSql = 'INSERT INTO audit_log (created_at, user_id, action, details) VALUES (?, ?, ?, ?)';

/**
 * Starts a check request for the given user.
 * user: { id, organisation_id, role } of the logged-in user.
 * input: { vat, fn } exactly as typed.
 *
 * Returns { ok: true, requestId } or { ok: false, error } with error
 * FORBIDDEN, INVALID_VAT or INVALID_FN. No source is queried here.
 */
export async function startCheck({ db, now = new Date() }, user, input) {
  const at = now.toISOString();

  // 1. Who is asking? Review Users (and the Super Admin) get FORBIDDEN.
  if (!ROLES_THAT_MAY_START.includes(user.role)) {
    return { ok: false, error: 'FORBIDDEN' };
  }

  // 2. Validate the input before anything else happens.
  const vat = validateVat(input?.vat);
  const fn = validateFn(input?.fn);
  const error = !vat.ok ? vat.error : !fn.ok ? fn.error : null;

  if (error) {
    // FR-REQ-10: a rejected input queries no source but is logged.
    // Only the error code is stored, not what was typed.
    await db
      .prepare(auditSql)
      .bind(at, user.id, 'REQUEST_REJECTED', JSON.stringify({ error }))
      .run();
    return { ok: false, error };
  }

  // 3. Store the request. RETURNING id gives back the new row's ID.
  const row = await db
    .prepare(
      `INSERT INTO requests (organisation_id, user_id, input_vat, input_fn, status, started_at)
       VALUES (?, ?, ?, ?, 'RUNNING', ?)
       RETURNING id`,
    )
    .bind(user.organisation_id, user.id, vat.vat, fn.fn, at)
    .first();

  // 4. Log that a request was started (FR-LOG-03).
  await db
    .prepare(auditSql)
    .bind(at, user.id, 'REQUEST_STARTED', JSON.stringify({ requestId: row.id }))
    .run();

  return { ok: true, requestId: row.id };
}