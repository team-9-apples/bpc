// SCRUM-32 / UI-05: shared by the pages under /app/ – language, the header with
// the menu, logout, and simple tables for the lists and details.
// The Worker decides which pages a role may open (src/pages.js) and refuses the
// others; the menu only shows the list /api/me sends and protects nothing itself.
// Needs /clerk.js to be loaded first (for logout).
(function () {
  const TEXTS = {
    en: {
      appName: 'BizPartnerCheck',
      who: (u, role) => `Logged in as ${u.firstName} ${u.lastName} (${role}).`,
      notRegistered: 'This account does not belong to a registered organisation yet.',
      logout: 'Log out',
      forbidden: 'Your role is not allowed to open that page.',
      noPages: 'There are no pages for your role.',
      loading: 'Loading…',
      empty: 'Nothing here yet.',
      notFound: 'Not found.',
      error: 'Something went wrong.',
      details: 'Details',
      back: 'Back to the list',
      pages: {
        'start-check': 'Start a check',
        requests: 'Requests',
        request: 'Request details',
        users: 'Users',
        tokens: 'API tokens',
      },
      roles: { SUPER_ADMIN: 'Super Admin', ADMIN: 'Organisation Admin', REQUEST_USER: 'Request User', REVIEW_USER: 'Review User' },
    },
    de: {
      appName: 'BizPartnerCheck',
      who: (u, role) => `Angemeldet als ${u.firstName} ${u.lastName} (${role}).`,
      notRegistered: 'Dieses Konto gehört noch zu keiner registrierten Organisation.',
      logout: 'Abmelden',
      forbidden: 'Ihre Rolle darf diese Seite nicht öffnen.',
      noPages: 'Für Ihre Rolle gibt es keine Seiten.',
      loading: 'Wird geladen…',
      empty: 'Noch keine Einträge.',
      notFound: 'Nicht gefunden.',
      error: 'Etwas ist schiefgelaufen.',
      details: 'Details',
      back: 'Zurück zur Liste',
      pages: {
        'start-check': 'Prüfung starten',
        requests: 'Anfragen',
        request: 'Anfragedetails',
        users: 'Benutzer',
        tokens: 'API-Tokens',
      },
      roles: { SUPER_ADMIN: 'Super-Admin', ADMIN: 'Organisations-Admin', REQUEST_USER: 'Anfrage-Benutzer', REVIEW_USER: 'Prüf-Benutzer' },
    },
  };

  const lang = navigator.language.toLowerCase().startsWith('de') ? 'de' : 'en';
  const t = TEXTS[lang];
  document.documentElement.lang = lang;
  const clerkReady = typeof loadClerk === 'function' ? loadClerk() : null;

  // Builds elements with textContent only, never innerHTML, so data from the
  // server (e.g. a VAT number someone typed) cannot inject HTML.
  function el(tag, props = {}, children = []) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
  }

  function text(value) {
    if (value == null) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  // Fills <header id="app-header"> and returns { user, pages } from /api/me.
  async function start() {
    const response = await fetch('/api/me');
    if (response.status === 401) {
      location.replace('/login');
      return new Promise(() => {}); // the page is going away
    }
    const body = await response.json().catch(() => ({}));
    const user = body.user ?? null;
    const pages = body.pages ?? [];
    renderHeader(user, pages);
    return { user, pages };
  }

  function renderHeader(user, pages) {
    const header = document.getElementById('app-header');
    if (!header) return;
    const nav = el('nav', {}, [el('a', { href: '/app/', textContent: t.appName })]);
    for (const page of pages) nav.append(' | ', el('a', { href: page.path, textContent: t.pages[page.name] ?? page.name }));
    const who = el('p', { textContent: user ? t.who(user, t.roles[user.role] ?? user.role) : t.notRegistered });
    const logout = el('button', { type: 'button', textContent: t.logout });
    logout.addEventListener('click', async () => {
      const clerk = await clerkReady;
      await clerk.signOut({ redirectUrl: '/login' });
    });
    header.replaceChildren(nav, who, logout);
  }

  // A table with one column per field of the first row; linkFor(row) adds a details link.
  function table(rows, linkFor) {
    if (!rows.length) return el('p', { textContent: t.empty });
    const columns = Object.keys(rows[0]);
    const head = el('tr', {}, columns.map((c) => el('th', { textContent: c })));
    if (linkFor) head.append(el('th'));
    const body = rows.map((row) => {
      const tr = el('tr', {}, columns.map((c) => el('td', { textContent: text(row[c]) })));
      if (linkFor) tr.append(el('td', {}, [el('a', { href: linkFor(row), textContent: t.details })]));
      return tr;
    });
    return el('table', {}, [el('thead', {}, [head]), el('tbody', {}, body)]);
  }

  // One item as name/value pairs; a list of objects inside it (e.g. the check
  // results of a request) becomes its own table.
  function details(item) {
    const list = el('dl');
    for (const [key, value] of Object.entries(item)) {
      const isRows = Array.isArray(value) && value.length > 0 && typeof value[0] === 'object';
      list.append(el('dt', { textContent: key }), el('dd', {}, [isRows ? table(value) : text(value)]));
    }
    return list;
  }

  async function load(url) {
    try {
      const response = await fetch(url);
      const body = await response.json().catch(() => ({}));
      return { ok: response.ok, status: response.status, body };
    } catch {
      return { ok: false, status: 0, body: {} };
    }
  }

  // GET url -> { [key]: [...] } shown as a table in container.
  async function showList(container, url, key, linkFor) {
    container.replaceChildren(t.loading);
    const { ok, body } = await load(url);
    container.replaceChildren(ok ? table(body[key] ?? [], linkFor) : el('p', { textContent: t.error }));
  }

  // GET url -> { [key]: {...} } shown as details in container.
  async function showItem(container, url, key) {
    container.replaceChildren(t.loading);
    const { ok, status, body } = await load(url);
    if (ok && body[key]) container.replaceChildren(details(body[key]));
    else container.replaceChildren(el('p', { textContent: status === 404 ? t.notFound : t.error }));
  }

  window.appShell = { lang, t, el, start, table, details, showList, showItem };
})();
