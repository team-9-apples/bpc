// Pure helpers for the setup script, kept separate so they can be tested
// without wrangler. SCRUM-93.

import { SYSTEM, audit } from '../src/audit.js';

const EMAIL = /^[^\s@']+@[^\s@']+\.[^\s@']+$/;

export function validateEmail(email) {
  if (!email || !EMAIL.test(email)) {
    throw new Error(`SUPER_ADMIN_EMAIL is missing or not a valid e-mail address: ${email ?? '(unset)'}`);
  }
}

/**
 * Reads KEY=VALUE lines from the text of a .dev.vars file. Blank lines and
 * # comments are skipped; quotes around a value are removed.
 */
export function parseDevVars(text) {
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith('#')) continue;
    vars[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  return vars;
}

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;

export const SELECT_SUPER_ADMIN_SQL = "SELECT email FROM users WHERE role = 'SUPER_ADMIN'";

const INSERT_SUPER_ADMIN_SQL = `INSERT INTO users (organisation_id, email, first_name, last_name, role, status)
SELECT NULL, ?, 'Super', 'Admin', 'SUPER_ADMIN', 'ACTIVE'
WHERE NOT EXISTS (SELECT 1 FROM users WHERE role = 'SUPER_ADMIN')
RETURNING id`;

/**
 * Creates the Super Admin only if none exists yet, so running setup twice is
 * safe. The unique index users_one_super_admin enforces the same rule in the
 * database. There is no password: the Super Admin signs up at the identity
 * provider (Clerk) with this e-mail address, and the first sign-in links the
 * two (SCRUM-104).
 *
 * SCRUM-22 (QS-OBS-01): the creation is logged as USER_CREATED. Nobody is
 * signed in when setup runs, so the actor is SYSTEM (QS-OBS-02).
 *
 * db: anything with the D1 prepare/bind/first/run API, e.g. wranglerDb() below.
 * Returns the new user's id, or null if a Super Admin already existed.
 */
export async function createSuperAdmin(db, { email, now = new Date() }) {
  const row = await db.prepare(INSERT_SUPER_ADMIN_SQL).bind(email).first();
  if (!row) return null;
  await audit(db, {
    at: now,
    actor: SYSTEM,
    action: 'USER_CREATED',
    details: { created_user_id: row.id, role: 'SUPER_ADMIN', via: 'setup' },
  });
  return row.id;
}

// SQL literal for one bound value. wrangler d1 execute --command takes no
// parameters, so the values are written into the SQL, quoted safely.
function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return quote(value);
}

/** Replaces each ? in sql with the matching value as a safe SQL literal. */
export function inlineParams(sql, values) {
  const parts = sql.split('?');
  if (parts.length - 1 !== values.length) {
    throw new Error(`SQL has ${parts.length - 1} placeholders but ${values.length} values were given`);
  }
  return parts.reduce((text, part, index) => text + literal(values[index - 1]) + part);
}

/**
 * A minimal D1-like db on top of a query(sql) function that runs one SQL
 * command through wrangler and returns its result rows. Enough for
 * createSuperAdmin() and audit().
 */
export function wranglerDb(query) {
  const statement = (sql, values = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => query(inlineParams(sql, values))[0] ?? null,
    run: async () => {
      query(inlineParams(sql, values));
    },
  });
  return { prepare: (sql) => statement(sql) };
}
