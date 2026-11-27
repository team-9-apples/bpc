// Cloudflare Worker entry point (DI-02, SCRUM-87). The web app is served as
// static assets from public/; requests to /api/* run this code first, so the
// web app and the API share one domain.

import { bearerToken, createApiToken, revokeApiToken, tokenUser } from './api-token.js';
import { clerkIdentity, currentUser } from './auth.js';
import { refreshBmfFeed } from './bmf-feed.js';
import { createAdapters } from './adapters/index.js';
import { getRequestRecord, runAndSaveChecks, startCheck } from './check-request.js';
import { languageOf } from './language.js';
import { mayOpen, pagesFor } from './pages.js';
import { registerOrganisation } from './registration.js';
import { getToken, getUser, listRequests, listTokens, listUsers, parseId } from './tenant.js';
import { createUser } from './users.js';

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function health(env) {
  try {
    await env.DB.prepare('SELECT 1').first();
    return json({ status: 'ok', database: 'ok', time: new Date().toISOString() });
  } catch {
    return json({ status: 'error', database: 'unreachable', time: new Date().toISOString() }, 503);
  }
}

// SCRUM-12
async function register(request, env) {
  const result = await registerOrganisation({ db: env.DB }, await readJson(request), languageOf(request));
  if (result.ok) return json({ organisationId: result.organisationId }, 201);
  if (result.error === 'INVALID_INPUT') return json({ error: result.error, fields: result.fields }, 400);
  return json({ error: result.error }, 409);
}

// SCRUM-104: the Clerk key the browser needs. It is public by design.
function config(env) {
  return json({ clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY ?? null });
}

// Tests pass env.IDENTITY instead of talking to Clerk.
const identityOf = (env) => env.IDENTITY ?? clerkIdentity(env);

// Who is calling the API? A program sends an API token (SCRUM-58, FR-API-03);
// the web app sends the Clerk session cookie instead. A request with an
// Authorization header is always judged by its token, never by a cookie.
// Returns { user, apiTokenId } or { status, error } for the error response.
async function apiCaller(request, env) {
  if (bearerToken(request) !== null) {
    const result = await tokenUser({ db: env.DB }, request);
    return result.user ? result : { status: 401, error: result.error };
  }
  const result = await currentUser({ db: env.DB, identity: identityOf(env) }, request);
  if (result.user) return { user: result.user, apiTokenId: null };
  // 401: not signed in. 403: signed in at Clerk, but not a BizPartnerCheck user.
  const error = result.error ?? 'NOT_SIGNED_IN';
  return { status: error === 'NOT_REGISTERED' ? 403 : 401, error };
}

function unauthorized({ status, error }) {
  const response = json({ error }, status);
  if (status === 401) response.headers.set('WWW-Authenticate', 'Bearer');
  return response;
}

async function me(request, env) {
  const caller = await apiCaller(request, env);
  // SCRUM-32: pages = the menu entries this user's role may open (src/pages.js).
  return caller.user ? json({ user: caller.user, pages: pagesFor(caller.user.role) }) : unauthorized(caller);
}

// no-store keeps the browser from showing a page again after logout.
async function servePage(env, request, status) {
  const page = await env.ASSETS.fetch(request);
  const response = new Response(page.body, { status: status ?? page.status, headers: page.headers });
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

// Pages under /app/ are only for signed-in users; everyone else is sent to the
// sign-in page. SCRUM-32 / UI-05: each page is also only served to the roles
// allowed to use it, so typing its URL does not get around the menu.
async function appPage(request, env) {
  const result = await currentUser({ db: env.DB, identity: identityOf(env) }, request);
  if (result.handshake) return new Response(null, { status: 307, headers: result.handshake });
  if (result.error === 'NOT_SIGNED_IN') return Response.redirect(new URL('/login', request.url), 302);
  // Signed in to Clerk but not a user here: show the start page, which says so and
  // offers logout. Redirecting to /login would loop, because /login sends anyone
  // with a Clerk session back to /app/.
  if (!result.user) return servePage(env, new Request(new URL('/app/', request.url), request), 403);

  const allowed = mayOpen(result.user.role, new URL(request.url).pathname);
  if (allowed === null) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  // Not for this role: back to the start page, which says so and shows the pages it may use.
  if (!allowed) return Response.redirect(new URL('/app/?forbidden', request.url), 302);
  return servePage(env, request);
}

// SCRUM-16: POST /api/requests { vat, fn } -> 202 { requestId }
async function startCheckRoute(request, env, ctx) {
  // Same check as /api/me: API token or Clerk session.
  const caller = await apiCaller(request, env);
  if (!caller.user) return unauthorized(caller);

  const body = (await readJson(request)) ?? {};
  const { vat, fn } = body;
  const result = await startCheck({ db: env.DB, apiTokenId: caller.apiTokenId }, caller.user, { vat, fn });

  if (!result.ok) return json({ error: result.error }, result.error === 'FORBIDDEN' ? 403 : 400);
  // for scrum-56; run the checks after answering, so the caller gets the ID at once.
  const run = runAndSaveChecks({ db: env.DB, adapters: createAdapters(env) }, result.requestId).catch((error) =>
    console.error(`Checks for request ${result.requestId} failed: ${error.message}`),
  );
  // the tests call the worker without ctx, so they wait for the checks instead.
  if (ctx?.waitUntil) ctx.waitUntil(run);
  else await run;
  return json({ requestId: result.requestId }, 202);
}

// SCRUM-35 / FR-USR-01: POST /api/users { firstName, lastName, email, role } -> 201 { user }
// Only an Organisation Admin may do this; the new user is invited through Clerk.
const CREATE_USER_STATUS = { FORBIDDEN: 403, INVALID_INPUT: 400, EMAIL_IN_USE: 409, INVITE_FAILED: 502 };

async function createUserRoute(request, env) {
  const caller = await apiCaller(request, env);
  if (!caller.user) return unauthorized(caller);

  // The invitation link brings the person to our sign-up page to set a password.
  const redirectUrl = new URL('/signup', request.url).href;
  const deps = { db: env.DB, identity: identityOf(env), apiTokenId: caller.apiTokenId };
  const result = await createUser(deps, caller.user, await readJson(request), redirectUrl);

  if (result.ok) return json({ user: result.user }, 201);
  const body = result.fields ? { error: result.error, fields: result.fields } : { error: result.error };
  return json(body, CREATE_USER_STATUS[result.error]);
}

// SCRUM-69 / FR-API-07: POST /api/tokens { userId, name } -> 201 { token, secret }
// secret is the full token. This answer is the only place it ever appears;
// afterwards GET /api/tokens shows only the name and prefix.
async function createTokenRoute(request, env) {
  const caller = await apiCaller(request, env);
  if (!caller.user) return unauthorized(caller);

  const result = await createApiToken({ db: env.DB, apiTokenId: caller.apiTokenId }, caller.user, await readJson(request));
  if (result.ok) return json({ token: result.token, secret: result.secret }, 201);
  if (result.error === 'FORBIDDEN') return json({ error: result.error }, 403);
  return json({ error: result.error, fields: result.fields }, 400);
}

// SCRUM-61 / FR-API-06: POST /api/tokens/<id>/revoke -> 200 { token }
async function revokeTokenRoute(request, env, idText) {
  const caller = await apiCaller(request, env);
  if (!caller.user) return unauthorized(caller);

  const deps = { db: env.DB, apiTokenId: caller.apiTokenId };
  const result = await revokeApiToken(deps, caller.user, parseId(idText));
  if (result.ok) return json({ token: result.token });
  return json({ error: result.error }, result.error === 'FORBIDDEN' ? 403 : 404);
}

// SCRUM-40 / FR-USR-05: reading requests, users and tokens. Each kind has a
// list (GET /api/<kind>) and a single item (GET /api/<kind>/<id>); both only
// ever look inside the caller's own organisation (src/tenant.js).
// roles: who may read this kind at all (SRS section 2.4).
const ANY_ORG_ROLE = ['ADMIN', 'REQUEST_USER', 'REVIEW_USER'];
const READABLE = {
  requests: { roles: ANY_ORG_ROLE, list: listRequests, get: getRequestRecord, one: 'request' },
  users: { roles: ['ADMIN'], list: listUsers, get: getUser, one: 'user' },
  tokens: { roles: ['ADMIN'], list: listTokens, get: getToken, one: 'token' },
};

async function readRoute(request, env, kind, idText) {
  const caller = await apiCaller(request, env);
  if (!caller.user) return unauthorized(caller);

  // The Super Admin is outside every organisation, so there is nothing to show.
  const { organisationId, role } = caller.user;
  const { roles, list, get, one } = READABLE[kind];
  if (organisationId == null || !roles.includes(role)) return json({ error: 'FORBIDDEN' }, 403);

  const deps = { db: env.DB };
  if (idText === undefined) return json({ [kind]: await list(deps, organisationId) });

  // 404 for an ID of another organisation, the same as for an ID that does not exist.
  const id = parseId(idText);
  const item = id === null ? null : await get(deps, organisationId, id);
  return item ? json({ [one]: item }) : json({ error: 'NOT_FOUND' }, 404);
}

const REVOKE_PATH = /^\/api\/tokens\/([^/]+)\/revoke$/;
const READ_PATH = /^\/api\/(requests|users|tokens)(?:\/([^/]+))?$/;

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    const read = request.method === 'GET' ? READ_PATH.exec(pathname) : null;
    if (read) return readRoute(request, env, read[1], read[2]);
    if (pathname === '/api/health') return health(env);
    if (request.method === 'POST' && pathname === '/api/organisations') return register(request, env);
    if (request.method === 'GET' && pathname === '/api/config') return config(env);
    if (request.method === 'GET' && pathname === '/api/me') return me(request, env);
    if (request.method === 'POST' && pathname === '/api/requests') return startCheckRoute(request, env, ctx);
    if (request.method === 'POST' && pathname === '/api/users') return createUserRoute(request, env);
    if (request.method === 'POST' && pathname === '/api/tokens') return createTokenRoute(request, env);
    const revoke = request.method === 'POST' ? REVOKE_PATH.exec(pathname) : null;
    if (revoke) return revokeTokenRoute(request, env, revoke[1]);
    if (pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    if (pathname === '/app' || pathname.startsWith('/app/')) return appPage(request, env);
    return env.ASSETS.fetch(request);
  },

  // SCRUM-18 / FR-DOC-06: run once a day by the cron trigger in wrangler.toml.
  // It only refreshes the BMF copy and never starts a partner check (FR-CHK-09).
  async scheduled(controller, env) {
    const result = await refreshBmfFeed(env);
    const log = result.status === 'OK' ? console.log : console.error;
    log(`BMF feed fetch ${result.status}: ${JSON.stringify(result)}`);
  },
};