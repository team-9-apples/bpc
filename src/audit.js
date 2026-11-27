// SCRUM-22 (QS-OBS-01, QS-OBS-02): one place that writes the audit log.
//
// Every entry has a UTC timestamp (ISO 8601, e.g. 2026-11-27T09:26:05.000Z)
// and names who triggered it: a user, an API token, or the system itself
// (the daily BMF feed fetch runs on a schedule, so no person triggered it).
// The table is append-only: migration 0008 refuses UPDATE and DELETE.

// For entries nobody triggered, e.g. the scheduled BMF feed fetch.
export const SYSTEM = 'SYSTEM';

const INSERT_SQL = 'INSERT INTO audit_log (created_at, user_id, api_token_id, action, details) VALUES (?, ?, ?, ?, ?)';

/**
 * Builds the INSERT for one audit entry without running it, so it can go into
 * the same db.batch() as the change it describes (both saved, or neither).
 *
 * entry: { at, action, userId?, apiTokenId?, actor?, details? }
 *   at: a Date or an ISO string; it is always stored in UTC.
 *   userId / apiTokenId: who triggered it. At least one is required unless
 *   actor is SYSTEM (QS-OBS-02).
 *   details: plain JSON, never secrets or what a user typed in.
 */
export function auditStatement(db, { at, action, userId = null, apiTokenId = null, actor = null, details = {} }) {
  if (!action) throw new Error('Audit entry needs an action');
  if (userId == null && apiTokenId == null && actor !== SYSTEM) {
    throw new Error(`Audit entry ${action} must name a user, a token or SYSTEM (QS-OBS-02)`);
  }
  const createdAt = (at instanceof Date ? at : new Date(at ?? Date.now())).toISOString();
  const stored = actor === SYSTEM ? { actor: SYSTEM, ...details } : details;
  return db.prepare(INSERT_SQL).bind(createdAt, userId, apiTokenId, action, JSON.stringify(stored));
}

/** Writes one audit entry on its own. */
export async function audit(db, entry) {
  await auditStatement(db, entry).run();
}
