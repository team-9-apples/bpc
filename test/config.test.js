// SCRUM-88 / DI-04: source URLs, keys and passwords are configuration, kept
// outside the code. They come from environment variables: .dev.vars locally
// (see .dev.vars.example), Wrangler secrets on Cloudflare.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

// Every file that ends up in the Worker or is run by npm scripts.
function codeFiles(dir) {
  return readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? codeFiles(`${dir}${entry.name}/`) : entry.name.endsWith('.js') ? [`${dir}${entry.name}`] : [],
  );
}

const files = [...codeFiles('src/'), ...codeFiles('scripts/'), 'wrangler.toml'];

const FORBIDDEN = [
  [/https?:\/\//, 'a URL'],
  [/\b[ps]k_(test|live)_[A-Za-z0-9]{8,}/, 'a Clerk key'],
  [/password\s*[:=]\s*['"][^'"]+['"]/i, 'a password'],
];

test('no source URLs, keys or passwords in the code or wrangler.toml', () => {
  assert.ok(files.length > 10, 'the scan found the source files');
  const found = [];
  for (const file of files) {
    const text = readFileSync(new URL(file, root), 'utf8');
    for (const [pattern, what] of FORBIDDEN) {
      if (pattern.test(text)) found.push(`${file}: ${what}`);
    }
  }
  assert.deepEqual(found, []);
});

test('.dev.vars.example names every setting, and .dev.vars stays out of Git', () => {
  const example = readFileSync(new URL('.dev.vars.example', root), 'utf8');
  for (const name of ['CLERK_PUBLISHABLE_KEY', 'CLERK_SECRET_KEY', 'VIES_URL', 'BMF_FEED_URL']) {
    assert.match(example, new RegExp(`^${name}=`, 'm'), `${name} is missing in .dev.vars.example`);
  }
  assert.doesNotMatch(example, /[ps]k_(test|live)_[A-Za-z0-9]{8,}/, 'no real Clerk key in the example');
  const gitignore = readFileSync(new URL('.gitignore', root), 'utf8');
  assert.match(gitignore, /^\.dev\.vars$/m);
});
