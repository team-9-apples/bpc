#!/usr/bin/env node
// Setup script (DI-01 / FR-ORG-03, SCRUM-11): applies the database schema and
// creates the one Super Admin account. Safe to run more than once.
//
//   npm run setup              # local D1, SUPER_ADMIN_EMAIL from .dev.vars or the shell
//   npm run setup -- --remote  # Cloudflare D1

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SELECT_SUPER_ADMIN_SQL, createSuperAdmin, parseDevVars, validateEmail, wranglerDb } from './setup-lib.js';

const DATABASE = process.env.D1_DATABASE ?? 'bpc';
const target = process.argv.includes('--remote') ? '--remote' : '--local';

// Runs the project's own wrangler with node directly. Calling 'npx' fails on
// Windows, where it is npx.cmd and cannot be started without a shell.
const WRANGLER = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));

function wrangler(...args) {
  return execFileSync(process.execPath, [WRANGLER, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, CI: 'true' }, // no interactive confirmation prompts
  });
}

function query(sql) {
  const output = JSON.parse(wrangler('d1', 'execute', DATABASE, target, '--json', '--command', sql));
  return output[0].results;
}

// SUPER_ADMIN_EMAIL comes from the shell, or else from .dev.vars, which is
// not committed (see .dev.vars.example).
function superAdminEmail() {
  if (process.env.SUPER_ADMIN_EMAIL) return process.env.SUPER_ADMIN_EMAIL;
  const file = new URL('../.dev.vars', import.meta.url);
  return existsSync(file) ? parseDevVars(readFileSync(file, 'utf8')).SUPER_ADMIN_EMAIL : undefined;
}

async function main() {
  const email = superAdminEmail();
  validateEmail(email);

  console.log(`Applying schema migrations to ${DATABASE} (${target.slice(2)})...`);
  wrangler('d1', 'migrations', 'apply', DATABASE, target);

  const existing = query(SELECT_SUPER_ADMIN_SQL);
  if (existing.length > 0) {
    console.log(`Super Admin already exists (${existing[0].email}). Nothing to create.`);
    return;
  }

  // Creates the Super Admin and logs it in the audit log (SCRUM-22).
  const id = await createSuperAdmin(wranglerDb(query), { email });
  if (id === null) {
    console.log('Super Admin was created by someone else in the meantime. Nothing to create.');
    return;
  }
  console.log(`Created Super Admin ${email}.`);
  console.log('Next: create the account with this e-mail address on /signup. The first sign-in links it (SCRUM-104).');
}

main().catch((error) => {
  console.error(`Setup failed: ${error.message}`);
  process.exit(1);
});
