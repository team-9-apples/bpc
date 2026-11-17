// SCRUM-32 / UI-05: which pages of the web app each role may open (SRS 2.4).
// The Worker checks this on every /app/ request (src/index.js), so a page is
// refused by direct URL too, not just left out of the menu. /api/me sends the
// caller's list, so the menu in the browser shows exactly these pages.

const ADMIN = 'ADMIN';
const REQUEST_USER = 'REQUEST_USER';
const REVIEW_USER = 'REVIEW_USER';

// inMenu: false for pages that are reached from another page (request details
// from the request list), not from the menu.
export const PAGES = [
  { name: 'start-check', path: '/app/start-check.html', roles: [ADMIN, REQUEST_USER] },
  { name: 'requests', path: '/app/requests.html', roles: [ADMIN, REVIEW_USER] },
  { name: 'request', path: '/app/request.html', roles: [ADMIN, REVIEW_USER], inMenu: false },
  { name: 'users', path: '/app/users.html', roles: [ADMIN] },
  { name: 'tokens', path: '/app/tokens.html', roles: [ADMIN] },
];

// '/app/users.html', '/app/users' and '/app/users/' all name 'users';
// '/app', '/app/' and '/app/index.html' name '' (the start page).
export function pageName(pathname) {
  return pathname
    .replace(/^\/app\/?/, '')
    .replace(/\/$/, '')
    .replace(/\.html$/, '')
    .replace(/^index$/, '');
}

// true or false; null when the path is not a page we know. Unknown pages are
// never served, so a new page cannot be opened before it has a rule here.
export function mayOpen(role, pathname) {
  const name = pageName(pathname);
  if (name === '') return true; // the start page is for every signed-in user
  const page = PAGES.find((p) => p.name === name);
  if (!page) return null;
  return page.roles.includes(role);
}

// The menu entries for a role.
export function pagesFor(role) {
  return PAGES.filter((p) => p.inMenu !== false && p.roles.includes(role)).map(({ name, path }) => ({ name, path }));
}
