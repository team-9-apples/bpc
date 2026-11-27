// SCRUM-40 / FR-USR-05: a user only sees data of their own organisation.
//
// Every function here takes the caller's organisationId and puts it in the
// WHERE clause, so a row of another organisation is never read. For a single
// row that means: an ID of another organisation gives null, exactly like an ID
// that does not exist, and the route answers 404 for both. Nobody can find out
// which IDs exist elsewhere.
//
// Routes that read requests, users or tokens must go through these functions
// (and getRequestRecord in check-request.js) instead of querying by ID alone.

/** A positive whole number from a URL part like "42", or null. */
export function parseId(text) {
  return /^[1-9]\d{0,14}$/.test(text) ? Number(text) : null;
}

const REQUEST_COLUMNS = 'id, user_id, api_token_id, input_vat, input_fn, status, summary, started_at, completed_at';

/** All requests of the organisation, newest first. */
export async function listRequests({ db }, organisationId) {
  const { results } = await db
    .prepare(`SELECT ${REQUEST_COLUMNS} FROM requests WHERE organisation_id = ? ORDER BY started_at DESC, id DESC`)
    .bind(organisationId)
    .all();
  return results.map((row) => ({
    id: row.id,
    userId: row.user_id,
    apiTokenId: row.api_token_id,
    vat: row.input_vat,
    fn: row.input_fn,
    status: row.status,
    overallStatus: row.summary,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));
}

const USER_COLUMNS = 'id, email, first_name, last_name, role, status, created_at';

const publicUser = (row) => ({
  id: row.id,
  email: row.email,
  firstName: row.first_name,
  lastName: row.last_name,
  role: row.role,
  status: row.status,
  createdAt: row.created_at,
});

/** All users of the organisation. The Super Admin belongs to none and is never listed. */
export async function listUsers({ db }, organisationId) {
  const { results } = await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE organisation_id = ? ORDER BY id`)
    .bind(organisationId)
    .all();
  return results.map(publicUser);
}

/** One user, or null if there is none with this ID in the organisation. */
export async function getUser({ db }, organisationId, userId) {
  const row = await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ? AND organisation_id = ?`)
    .bind(userId, organisationId)
    .first();
  return row ? publicUser(row) : null;
}

// A token belongs to a user, and through that user to an organisation.
// secret_hash is never selected: it must not leave the database (QS-SEC-03).
const TOKEN_SELECT = `SELECT t.id, t.user_id, t.name, t.prefix, t.status, t.expires_at, t.created_at, t.last_used_at
  FROM api_tokens t JOIN users u ON u.id = t.user_id`;

export const publicToken = (row) => ({
  id: row.id,
  userId: row.user_id,
  name: row.name,
  prefix: row.prefix, // SCRUM-69: only this start of the token is ever shown again
  status: row.status,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
});

/** All API tokens of the organisation's users. */
export async function listTokens({ db }, organisationId) {
  const { results } = await db.prepare(`${TOKEN_SELECT} WHERE u.organisation_id = ? ORDER BY t.id`).bind(organisationId).all();
  return results.map(publicToken);
}

/** One API token, or null if there is none with this ID in the organisation. */
export async function getToken({ db }, organisationId, tokenId) {
  const row = await db.prepare(`${TOKEN_SELECT} WHERE t.id = ? AND u.organisation_id = ?`).bind(tokenId, organisationId).first();
  return row ? publicToken(row) : null;
}
