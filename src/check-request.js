// SCRUM-16: start a partner check by VAT number (optional FN).
// SCRUM-20: run the checks of a request and store their results (FR-DOC-01)
// SCRUM-96: store one overall status per request (CR-01)
// SCRUM-22: log every request and every source call (QS-OBS-01, QS-OBS-02)

import { runChecks } from './adapters/index.js';
import { audit, auditStatement } from './audit.js';
import { splitVat } from './adapters/vies.js';
import { overallStatus } from './overall-status.js';

// Stricter formats for some countries, on top of splitVat.
const VAT_FORMATS = {
  AT: /^ATU\d{8}$/, // ATU + 8 digits
  DE: /^DE\d{9}$/, // DE + 9 digits
};

// Returns { ok: true, vat: 'ATU12345678' } (cleaned up) or { ok: false, error: 'INVALID_VAT' }.
// Any EU VAT number is accepted (splitVat in the VIES adapter knows every EU prefix).
export function validateVat(input) {
  if (typeof input !== 'string') {
    return { ok: false, error: 'INVALID_VAT' };
  }

  // null if it is not an EU prefix followed by a plausible number
  const parts = splitVat(input);
  if (!parts) {
    return { ok: false, error: 'INVALID_VAT' };
  }

  const vat = `${parts.countryCode}${parts.vatNumber}`;
  const format = VAT_FORMATS[parts.countryCode];
  if (format && !format.test(vat)) {
    return { ok: false, error: 'INVALID_VAT' };
  }

  return { ok: true, vat };
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

/**
 * Starts a check request for the given user.
 * user: the signed-in user from currentUser() in auth.js ({ id, organisationId, role, ... }).
 * input: { vat, fn } exactly as typed.
 * apiTokenId: the API token the request came with (SCRUM-58), or null when it
 * was started in the web app. It is stored with the request and in the audit log.
 *
 * Returns { ok: true, requestId } or { ok: false, error } with error
 * FORBIDDEN, INVALID_VAT or INVALID_FN. No source is queried here.
 */
export async function startCheck({ db, now = new Date(), apiTokenId = null }, user, input) {
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
    await audit(db, { at, userId: user.id, apiTokenId, action: 'REQUEST_REJECTED', details: { error } });
    return { ok: false, error };
  }

  // 3. Store the request. RETURNING id gives back the new row's ID.
  const row = await db
    .prepare(
      `INSERT INTO requests (organisation_id, user_id, api_token_id, input_vat, input_fn, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'RUNNING', ?)
       RETURNING id`,
    )
    .bind(user.organisationId, user.id, apiTokenId, vat.vat, fn.fn, at)
    .first();

  // 4. Log that a request was started (FR-LOG-03).
  await audit(db, { at, userId: user.id, apiTokenId, action: 'REQUEST_STARTED', details: { requestId: row.id } });

  return { ok: true, requestId: row.id };
}

const insertResultSql =
  'INSERT INTO check_results (request_id, source, state, details, queried_at) VALUES (?, ?, ?, ?, ?)';

/**
 * SCRUM-20 (FR-DOC-01): runs every check of a stored request and saves the results.
 * adapters: the list from createAdapters() in adapters/index.js (tests pass mocks).
 * now: a FUNCTION that returns the current time, e.g. () => new Date().
 * Unlike startCheck it is a function, because completed_at must be read
 * after the checks have finished, not when the function starts.
 * Stores one check_results row per source with its state and the UTC time the
  * source was queried, then marks the request COMPLETED and stores its overall
 * status in requests.summary (SCRUM-96). All rows are written in one batch,
 * so a request never ends up with only some of its results.
 * SCRUM-22: the same batch logs one SOURCE_CALL per source that was asked and
 * one REQUEST_COMPLETED, in the name of whoever started the request.
 * */
export async function runAndSaveChecks({ db, adapters, now = () => new Date() }, requestId) {
  // 1. Read back what was asked: the partner identifiers stored by startCheck,
  // and who asked, so the log names the same user and token (QS-OBS-02).
  const request = await db
    .prepare('SELECT input_vat, input_fn, user_id, api_token_id FROM requests WHERE id = ?')
    .bind(requestId)
    .first();
  if (!request) {
    throw new Error(`Request ${requestId} not found`);
  }
  // 2. Ask every source. runChecks never throws: a source that fails is UNAVAILABLE.
  const results = await runChecks(adapters, { vat: request.input_vat, fn: request.input_fn });

  // 3. Save one row per check, and mark the request as completed.
  const rows = results.map((result) => {
    const details = result.details == null ? null : JSON.stringify(result.details);
    return db.prepare(insertResultSql).bind(requestId, result.source, result.state, details, result.queriedAt);
  });
  // SCRUM-96: one overall status from all check states, e.g. 'INCOMPLETE'.                          
  const summary = overallStatus(results.map((result) => result.state));
  const completedAt = now().toISOString();
  const complete = db
    .prepare("UPDATE requests SET status = 'COMPLETED', completed_at = ?, summary = ? WHERE id = ?")
    .bind(completedAt, summary, requestId);

  // 4. Log it (QS-OBS-01). NOT_APPLICABLE sources were never called, so they
  // get no SOURCE_CALL entry. Only the state is logged, not the source's answer.
  const who = { userId: request.user_id, apiTokenId: request.api_token_id };
  const calls = results
    .filter((result) => result.state !== 'NOT_APPLICABLE')
    .map((result) =>
      auditStatement(db, {
        ...who,
        at: result.queriedAt,
        action: 'SOURCE_CALL',
        details: { requestId, source: result.source, state: result.state },
      }),
    );
  const completedEntry = auditStatement(db, {
    ...who,
    at: completedAt,
    action: 'REQUEST_COMPLETED',
    details: { requestId, summary },
  });

  await db.batch([...rows, complete, ...calls, completedEntry]);
  return results;
}

/**
 * SCRUM-20 (FR-DOC-01): reads back a request with all its check results.
 * Only returns it if it belongs to organisationId (FR-USR-05), otherwise null.
 */
export async function getRequestRecord({ db }, organisationId, requestId) {
  // 1. The request itself, only if it belongs to this organisation.
  const request = await db
    .prepare(
      `SELECT id, organisation_id, user_id, api_token_id, input_vat, input_fn, status, summary, started_at, completed_at
       FROM requests
       WHERE id = ? AND organisation_id = ?`,
    )
    .bind(requestId, organisationId)
    .first();
  if (!request) {
    return null;
  }

  // 2. Its checks, in the order they were saved.
  const { results } = await db
    .prepare('SELECT source, state, details, queried_at FROM check_results WHERE request_id = ? ORDER BY id')
    .bind(requestId)
    .all();

  // 3. Database names (snake_case) -> JavaScript names (camelCase); details back from JSON text.
  return {
    id: request.id,
    organisationId: request.organisation_id,
    userId: request.user_id,
    apiTokenId: request.api_token_id,
    vat: request.input_vat,
    fn: request.input_fn,
    status: request.status,
    overallStatus: request.summary,
    startedAt: request.started_at,
    completedAt: request.completed_at,
    checks: results.map((row) => ({
      source: row.source,
      state: row.state,
      details: row.details == null ? null : JSON.parse(row.details),
      queriedAt: row.queried_at,
    })),
  };
}