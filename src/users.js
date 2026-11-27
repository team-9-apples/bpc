// SCRUM-35 / FR-USR-01: an Organisation Admin creates Request Users and Review
// Users in their own organisation. Nobody else may create users (SRS 2.4).
//
// The new user is stored as PENDING and invited through the identity provider
// (Clerk, SCRUM-104): the invitation e-mail lets the person set a password
// there. On their first sign-in with that verified address, currentUser()
// links the account and makes it ACTIVE (linkExternalUser in registration.js),
// and from then on they have the rights of their role.

import { audit } from './audit.js';

const EMAIL = /^[^\s@']+@[^\s@']+\.[^\s@']+$/; // same rule as registration.js
const MAX_NAME_LENGTH = 200;
const MAX_EMAIL_LENGTH = 254;

// An admin can only create these two roles; ADMIN and SUPER_ADMIN are never offered.
export const CREATABLE_ROLES = ['REQUEST_USER', 'REVIEW_USER'];

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * Checks the form. Returns { ok: true, value } with cleaned-up values, or
 * { ok: false, fields } with an error code per wrong field.
 */
export function validateNewUser(input = {}) {
  const value = {
    firstName: text(input.firstName),
    lastName: text(input.lastName),
    email: text(input.email),
    role: text(input.role),
  };
  const fields = {};
  for (const name of ['firstName', 'lastName']) {
    if (!value[name]) fields[name] = 'REQUIRED';
    else if (value[name].length > MAX_NAME_LENGTH) fields[name] = 'TOO_LONG';
  }
  if (!value.email) fields.email = 'REQUIRED';
  else if (!EMAIL.test(value.email) || value.email.length > MAX_EMAIL_LENGTH) fields.email = 'INVALID';
  if (!value.role) fields.role = 'REQUIRED';
  else if (!CREATABLE_ROLES.includes(value.role)) fields.role = 'INVALID';

  return Object.keys(fields).length === 0 ? { ok: true, value } : { ok: false, fields };
}

const publicUser = (row) => ({
  id: row.id,
  email: row.email,
  firstName: row.first_name,
  lastName: row.last_name,
  role: row.role,
  status: row.status,
  createdAt: row.created_at,
});

/**
 * Creates a user in the admin's organisation and sends the invitation.
 * admin: the caller (from the Clerk session or an API token).
 * redirectUrl: where the invitation link takes the person to set a password.
 * Returns { ok: true, user } or { ok: false, error, fields? } with error
 * FORBIDDEN, INVALID_INPUT, EMAIL_IN_USE or INVITE_FAILED.
 */
export async function createUser({ db, identity, apiTokenId = null, now = new Date() }, admin, input, redirectUrl) {
  // The organisation always comes from the admin, never from the input.
  if (admin?.role !== 'ADMIN' || admin.organisationId == null) return { ok: false, error: 'FORBIDDEN' };

  const checked = validateNewUser(input ?? {});
  if (!checked.ok) return { ok: false, error: 'INVALID_INPUT', fields: checked.fields };
  const { firstName, lastName, email, role } = checked.value;

  // E-mail addresses are unique across all organisations (users.email).
  if (await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) {
    return { ok: false, error: 'EMAIL_IN_USE' };
  }

  const at = now.toISOString();
  let row;
  try {
    row = await db
      .prepare(
        `INSERT INTO users (organisation_id, email, first_name, last_name, role, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'PENDING', ?)
         RETURNING id, email, first_name, last_name, role, status, created_at`,
      )
      .bind(admin.organisationId, email, firstName, lastName, role, at)
      .first();
  } catch (error) {
    // Two admins adding the same address at the same moment.
    if (/UNIQUE constraint failed: users\.email/.test(error.message)) return { ok: false, error: 'EMAIL_IN_USE' };
    throw error;
  }

  try {
    await identity.invite(email, redirectUrl);
  } catch (error) {
    // No invitation, no account: remove the user again so the admin can simply retry.
    await db.prepare('DELETE FROM users WHERE id = ?').bind(row.id).run();
    console.error(`Invitation for new user ${row.id} failed: ${error.message}`);
    return { ok: false, error: 'INVITE_FAILED' };
  }

  await audit(db, {
    at,
    userId: admin.id,
    apiTokenId,
    action: 'USER_CREATED',
    details: { created_user_id: row.id, role },
  });

  return { ok: true, user: publicUser(row) };
}