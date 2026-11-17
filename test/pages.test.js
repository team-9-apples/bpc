import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mayOpen, pageName, pagesFor } from '../src/pages.js';

const names = (role) => pagesFor(role).map((p) => p.name);
const ALL = ['/app/start-check.html', '/app/requests.html', '/app/request.html', '/app/users.html', '/app/tokens.html'];

test('page names ignore .html, index and a trailing slash', () => {
  for (const path of ['/app', '/app/', '/app/index.html', '/app/index']) assert.equal(pageName(path), '');
  for (const path of ['/app/users', '/app/users/', '/app/users.html']) assert.equal(pageName(path), 'users');
});

test('every signed-in role may open the start page', () => {
  for (const role of ['SUPER_ADMIN', 'ADMIN', 'REQUEST_USER', 'REVIEW_USER']) {
    assert.equal(mayOpen(role, '/app/'), true);
  }
});

test('Request Users only get start a check', () => {
  assert.deepEqual(names('REQUEST_USER'), ['start-check']);
  assert.equal(mayOpen('REQUEST_USER', '/app/start-check.html'), true);
  for (const path of ['/app/requests.html', '/app/request.html', '/app/users.html', '/app/tokens.html']) {
    assert.equal(mayOpen('REQUEST_USER', path), false, path);
  }
});

test('Review Users only get the request list and details', () => {
  assert.deepEqual(names('REVIEW_USER'), ['requests']);
  assert.equal(mayOpen('REVIEW_USER', '/app/requests.html'), true);
  assert.equal(mayOpen('REVIEW_USER', '/app/request.html'), true);
  for (const path of ['/app/start-check.html', '/app/users.html', '/app/tokens.html']) {
    assert.equal(mayOpen('REVIEW_USER', path), false, path);
  }
});

test('Organisation Admins get all five pages', () => {
  assert.deepEqual(names('ADMIN'), ['start-check', 'requests', 'users', 'tokens']);
  for (const path of ALL) assert.equal(mayOpen('ADMIN', path), true, path);
});

test('the Super Admin gets no organisation pages', () => {
  assert.deepEqual(names('SUPER_ADMIN'), []);
  for (const path of ALL) assert.equal(mayOpen('SUPER_ADMIN', path), false, path);
});

test('the clean URL of a page is refused the same way', () => {
  assert.equal(mayOpen('REQUEST_USER', '/app/users'), false);
  assert.equal(mayOpen('REQUEST_USER', '/app/users/'), false);
});

test('unknown pages are not served to anyone', () => {
  for (const path of ['/app/secret.html', '/app/users.html/x', '/app/Users.html']) {
    assert.equal(mayOpen('ADMIN', path), null, path);
  }
});
