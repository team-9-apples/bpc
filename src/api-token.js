// SCRUM-58 / FR-API-03: every API call by a program is authenticated by an API
// token that belongs to exactly one user. The program sends it as
//   Authorization: Bearer bpc_...
// The api_tokens table (migration 0001) stores only the SHA-256 hash of the
// token (QS-SEC-03), so we hash what was sent and look the hash up.

import { publicToken } from './tenant.js';

const USER_COLUMNS = 'u.id, u.organisation_id, u.email, u.first_name, u.last_name, u.role';

/** The token from the Authorization header, or null if there is none. */
export function bearerToken(request) {
  const header = request.headers.get('Authorization');
  if (!header) return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match ? match[1] : '';
}

/** SHA-256 of the token as lowercase hex. Works in Workers and in Node. */
export async function hashToken(token) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The user behind the API token of this request.
 * Returns { user, apiTokenId } or { error } with:
 *   MISSING_TOKEN - no Authorization header
 *   INVALID_TOKEN - unknown, revoked or expired token, or its user is not active
 * The same INVALID_TOKEN is used for every bad token, so a caller cannot tell
 * which tokens exist.
 */
export async function tokenUser({ db, now = new Date() }, request) {
  const token = bearerToken(request);
  if (token === null) return { error: 'MISSING_TOKEN' };
  if (!token) return { error: 'INVALID_TOKEN' };

  const at = now.toISOString();
  const row = await db
    .prepare(
      `SELECT t.id AS token_id, ${USER_COLUMNS}
       FROM api_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.secret_hash = ?
         AND t.status = 'ACTIVE'
         AND (t.expires_at IS NULL OR t.expires_at > ?)
         AND u.status = 'ACTIVE'`,
    )
    .bind(await hashToken(token), at)
    .first();
  if (!row) return { error: 'INVALID_TOKEN' };

  await db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').bind(at, row.token_id).run();

  return {
    apiTokenId: row.token_id,
    user: {
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      role: row.role,
      organisationId: row.organisation_id,
    },
  };
}

// SCRUM-69 / FR-API-07: creating a token. The full token is returned only in
// the answer to the create call and never again: the database keeps its hash
// (for tokenUser above) and a short prefix (for the token list), and nothing
// is written to the audit log or console that would let anyone rebuild it.
//
// The Organisation Admin creates tokens for Request Users of their own
// organisation (SCRUM-59 / FR-API-04); one user may hold several tokens.

const TOKEN_BYTES = 32; // 256 random bits
const PREFIX_LENGTH = 12; // "bpc_" + 8 characters
const MAX_TOKEN_NAME_LENGTH = 100;

/** A new random token like "bpc_3fA9kQ2x...", base64url, 47 characters. */
export function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(TOKEN_BYTES));
  const base64 = btoa(String.fromCharCode(...bytes));
  return `bpc_${base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** The part of a token that may be shown again after creation. */
export const tokenPrefix = (token) => token.slice(0, PREFIX_LENGTH);

/**
 * Creates an API token for a Request User of the admin's organisation.
 * input: { userId, name }.
 * Returns { ok: true, token, secret } where secret is the full token, shown
 * this one time, or { ok: false, error, fields? } with error FORBIDDEN or
 * INVALID_INPUT. A user of another organisation is INVALID_INPUT, the same as
 * a user that does not exist (FR-USR-05).
 */
export async function createApiToken({ db, apiTokenId = null, now = new Date() }, admin, input = {}) {
  if (admin?.role !== 'ADMIN' || admin.organisationId == null) return { ok: false, error: 'FORBIDDEN' };

  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const userId = Number.isSafeInteger(input.userId) && input.userId > 0 ? input.userId : null;
  const fields = {};
  if (!name) fields.name = 'REQUIRED';
  else if (name.length > MAX_TOKEN_NAME_LENGTH) fields.name = 'TOO_LONG';

  // The organisation always comes from the admin, never from the input.
  const owner =
    userId === null
      ? null
      : await db
          .prepare('SELECT id, role, status FROM users WHERE id = ? AND organisation_id = ?')
          .bind(userId, admin.organisationId)
          .first();
  if (input.userId == null) fields.userId = 'REQUIRED';
  else if (!owner || owner.role !== 'REQUEST_USER' || owner.status === 'DEACTIVATED') fields.userId = 'INVALID';
  if (Object.keys(fields).length) return { ok: false, error: 'INVALID_INPUT', fields };

  const secret = generateToken();
  const at = now.toISOString();
  const row = await db
    .prepare(
      `INSERT INTO api_tokens (user_id, name, secret_hash, prefix, created_at)
       VALUES (?, ?, ?, ?, ?)
       RETURNING id, user_id, name, prefix, status, expires_at, created_at, last_used_at`,
    )
    .bind(owner.id, name, await hashToken(secret), tokenPrefix(secret), at)
    .first();

  await db
    .prepare(
      `INSERT INTO audit_log (created_at, user_id, api_token_id, action, details)
       VALUES (?, ?, ?, 'TOKEN_CREATED', json_object('created_token_id', ?, 'token_user_id', ?))`,
    )
    .bind(at, admin.id, apiTokenId, row.id, owner.id)
    .run();

  return { ok: true, token: publicToken(row), secret };
}
