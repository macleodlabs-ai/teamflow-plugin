// Ephemeral credentials for TeamFlow reporters.
//
// A developer signs in once with `/teamflow:login`: authorization code
// with PKCE against the Cognito hosted UI, a loopback redirect, and a
// refresh token written to ~/.config/teamflow/session.json at 0600.
// Access tokens live for an hour, are held in memory only, and are
// refreshed a few minutes before they expire. CI signs in per job
// instead, exchanging the GitHub Actions OIDC token for an access
// token, so a workflow needs no stored secret at all.
//
// Nothing here ever writes an access token to disk. A refresh token is
// revocable and scoped to one machine; an access token on disk is a
// bearer secret with an hour of life and no way to take it back.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { defaultServiceUrl, readJson, safeExec, serviceUrl, writeJson } from './core.mjs';

// Fixed and small on purpose: every one of these has to be registered
// as a callback URL on the Cognito app client, so the range cannot
// grow without a deploy.
const REDIRECT_PORTS = [52480, 52481, 52482, 52483, 52484, 52485, 52486, 52487, 52488, 52489];
const DEFAULT_SCOPES = 'openid email profile';
// Refresh early. A token that expires between the check and the
// request is a report lost to a 401 that nothing retries.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 180000;
const SESSION_VERSION = 1;

export function sessionPath() {
  return path.join(os.homedir(), '.config', 'teamflow', 'session.json');
}

export function readSession() {
  const session = readJson(sessionPath());
  return session?.refreshToken ? session : undefined;
}

export function hasSession() {
  return Boolean(readSession());
}

function saveSession(session) {
  // writeJson already writes 0600 through a temp file.
  writeJson(sessionPath(), { ...session, updatedAt: new Date().toISOString() });
}

export function clearSession() {
  forgetCachedToken();
  try {
    fs.unlinkSync(sessionPath());
    return true;
  } catch {
    return false;
  }
}

// --- in-memory access token ----------------------------------------
//
// Keyed by the refresh token it came from, so rotating the refresh
// token (Cognito does) cannot leave a stale access token behind.

let cached;

export function forgetCachedToken() {
  cached = undefined;
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

// --- PKCE ----------------------------------------------------------

function b64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// Display only. The token came from our own token endpoint over TLS,
// and nothing is authorised on the strength of these claims -- the
// service verifies the signature on every request. Decoding it to
// print an email address is not a trust decision.
export function claimsOf(idToken) {
  try {
    const [, payload] = String(idToken).split('.');
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
  } catch {
    return {};
  }
}

// --- discovery -----------------------------------------------------

async function capabilitiesAuth(config) {
  try {
    const response = await fetch(`${serviceUrl(config)}/v1/capabilities`, {
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 5000)),
    });
    if (!response.ok) return undefined;
    const body = await response.json();
    return body?.auth;
  } catch {
    return undefined;
  }
}

// OAuth wants one space-separated string, and the service publishes
// its sign-in scopes as a list. The paid-API scope is named separately
// in `api_scope` because it is not part of signing in: the plugin asks
// for it too, because the same token has to identify the developer and
// then call /v1/report. Duplicates are dropped so an override that
// already names the API scope does not ask for it twice.
export function scopeString(...values) {
  const seen = [];
  for (const value of values.flat()) {
    for (const scope of String(value ?? '').split(/\s+/)) {
      if (scope && !seen.includes(scope)) seen.push(scope);
    }
  }
  return seen.join(' ');
}

// The service is the authority on where its hosted UI lives. Config
// and env override it so a developer can point at a preview stack, and
// cover the window before the kit publishes the block at all.
export async function discoverAuth(config = {}) {
  const published = (config.authIssuer && config.authClientId) ? undefined : await capabilitiesAuth(config);
  const issuer = String(config.authIssuer || published?.issuer || '').replace(/\/+$/, '');
  const clientId = config.authClientId || published?.client_id;
  if (!issuer || !clientId) {
    return {
      ok: false,
      reason: 'the service published no auth configuration; set authIssuer and authClientId '
        + '(TEAMFLOW_AUTH_ISSUER, TEAMFLOW_AUTH_CLIENT_ID) to sign in against a specific stack',
    };
  }
  return {
    ok: true,
    issuer,
    clientId,
    authorizeUrl: published?.authorize_url || `${issuer}/oauth2/authorize`,
    tokenUrl: published?.token_url || `${issuer}/oauth2/token`,
    scopes: scopeString(
      config.authScopes || published?.scopes || DEFAULT_SCOPES,
      config.authApiScope || published?.api_scope || '',
    ),
  };
}

// --- the token endpoint --------------------------------------------

async function tokenRequest(tokenUrl, params, config) {
  let response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 10000)),
    });
  } catch (error) {
    return { ok: false, reason: `token endpoint unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  // `token_type` is deliberately not compared. The kit answers
  // "bearer" and the OAuth spec says the value is case-insensitive, so
  // a check here buys nothing and breaks on capitalisation.
  if (!response.ok || !body?.access_token) {
    return {
      ok: false,
      status: response.status,
      // OAuth error codes are safe to show; they name the failure
      // without quoting the credential that caused it.
      reason: body?.error_description || body?.error || `token endpoint returned ${response.status}`,
    };
  }
  return { ok: true, body };
}

// --- loopback redirect ---------------------------------------------

function page(title, message) {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>`
    + '<body style="font:16px system-ui;margin:4rem auto;max-width:32rem;color:#3B155F">'
    + `<h1 style="font-size:1.25rem">${title}</h1><p>${message}</p></body>`;
}

async function loopback() {
  let resolveCode;
  const arrived = new Promise((resolve) => { resolveCode = resolve; });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get('error');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(error
      ? page('TeamFlow sign-in failed', `The identity provider said: ${error}. Close this tab and try /teamflow:login again.`)
      : page('TeamFlow is signed in', 'You can close this tab and go back to Claude Code.'));
    resolveCode({ code: url.searchParams.get('code'), state: url.searchParams.get('state'), error });
  });

  for (const port of REDIRECT_PORTS) {
    try {
      await new Promise((resolve, reject) => {
        const fail = (error) => reject(error);
        server.once('error', fail);
        server.listen(port, '127.0.0.1', () => { server.removeListener('error', fail); resolve(); });
      });
      return {
        port,
        redirectUri: `http://127.0.0.1:${port}/callback`,
        arrived,
        close: () => new Promise((resolve) => server.close(resolve)),
      };
    } catch {
      // Port in use. Try the next one the app client knows about.
    }
  }
  throw new Error(`no free loopback port in ${REDIRECT_PORTS[0]}-${REDIRECT_PORTS.at(-1)}; close whatever is using them and retry`);
}

function openInBrowser(url) {
  const opener = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  return safeExec(opener[0], opener[1], { timeout: 5000 }).ok;
}

// --- login ----------------------------------------------------------

export async function login(config = {}, {
  openUrl = openInBrowser, timeoutMs = LOGIN_TIMEOUT_MS, account, chooseAccount,
} = {}) {
  const auth = await discoverAuth(config);
  if (!auth.ok) return auth;

  const { verifier, challenge } = pkcePair();
  const state = b64url(crypto.randomBytes(16));
  const server = await loopback();
  try {
    const authorizeUrl = `${auth.authorizeUrl}?${new URLSearchParams({
      response_type: 'code',
      client_id: auth.clientId,
      redirect_uri: server.redirectUri,
      scope: auth.scopes,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })}`;

    const opened = await openUrl(authorizeUrl);
    // The timer is cleared, not just lost to the race: an uncancelled
    // three-minute timeout keeps the process alive long after the
    // developer has signed in.
    let timer;
    const callback = await Promise.race([
      server.arrived,
      new Promise((resolve) => { timer = setTimeout(() => resolve({ error: 'timeout' }), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));

    if (callback.error === 'timeout') {
      return { ok: false, reason: 'sign-in timed out', authorizeUrl, opened };
    }
    if (callback.error) return { ok: false, reason: callback.error, authorizeUrl, opened };
    // A mismatched state means the code came from a request this
    // process did not start. Redeeming it would be redeeming somebody
    // else's authorization.
    if (callback.state !== state) return { ok: false, reason: 'state mismatch; the redirect did not come from this sign-in' };
    if (!callback.code) return { ok: false, reason: 'the identity provider returned no authorization code' };

    const exchanged = await tokenRequest(auth.tokenUrl, {
      grant_type: 'authorization_code',
      client_id: auth.clientId,
      code: callback.code,
      redirect_uri: server.redirectUri,
      code_verifier: verifier,
    }, config);
    if (!exchanged.ok) return exchanged;
    if (!exchanged.body.refresh_token) {
      return { ok: false, reason: 'the identity provider issued no refresh token; the app client must allow them' };
    }

    // Bind before anything is written. A session whose access token
    // authenticates as nobody is worse than no session: reporting
    // would look configured and silently 401 on every report.
    let bound = await bindIdentity(config, exchanged.body.id_token, account);
    // Seats on several organisations is a question. The tokens are already
    // in hand, so it is asked here and answered with a second bind rather
    // than by starting the whole sign-in again.
    if (bound.ambiguous && chooseAccount) {
      const chosen = await chooseAccount(bound.accounts);
      if (chosen) bound = await bindIdentity(config, exchanged.body.id_token, chosen);
    }
    if (bound.ambiguous) {
      return {
        ok: false,
        ambiguous: true,
        accounts: bound.accounts,
        reason: 'that address holds a seat on more than one organisation',
      };
    }
    if (!bound.ok) {
      return { ok: false, reason: `signed in, but the service would not bind this identity to a seat: ${bound.reason}` };
    }

    const email = bound.member || claimsOf(exchanged.body.id_token).email;
    saveSession({
      version: SESSION_VERSION,
      issuer: auth.issuer,
      clientId: auth.clientId,
      tokenUrl: auth.tokenUrl,
      refreshToken: exchanged.body.refresh_token,
      email,
      // Which organisation this session is bound to, so `teamflow org` and
      // `teamflow status` can say so without a round trip.
      account: bound.account,
      accountName: bound.name,
      createdAt: new Date().toISOString(),
    });
    rememberToken(exchanged.body, exchanged.body.refresh_token, email);
    return { ok: true, email, issuer: auth.issuer, account: bound.account, accountName: bound.name, bound: bound.bound };
  } finally {
    await server.close();
  }
}

// A member who has just signed in holds a token from the pool and
// nothing else: the service cannot yet tell which seat is theirs. The
// ID token is the one artifact that proves a given subject owns a
// given verified email, so it is what claims the seat. Until that
// happens the access token authenticates as nobody.
//
// Idempotent, and skipped entirely by a service that does not run the
// orgs module, which answers 404 and needs no binding at all.
export async function bindIdentity(config, idToken, account) {
  const bound = await seatCall(config, '/v1/members/identity', idToken, account);
  // Identity will not move a person quietly, because moving them moves who
  // is billed for their calls. Somebody already in one organisation who
  // named another is switching, so the same intent goes to the route that
  // says so out loud.
  if (bound.boundElsewhere && account) return switchOrg(config, idToken, account);
  return bound;
}

// The other half of the same exchange: an already-bound address moving to
// another organisation it holds a seat on. Same evidence, same answers --
// only the route differs, so the caller reads one result shape either way.
export async function switchOrg(config, idToken, account) {
  if (!account) return { ok: false, reason: 'name the organisation to switch to' };
  return seatCall(config, '/v1/members/switch', idToken, account);
}

async function seatCall(config, route, idToken, account) {
  if (!idToken) return { ok: false, reason: 'the identity provider returned no ID token' };
  let response;
  try {
    response = await fetch(`${serviceUrl(config)}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `account` only when one has been chosen: a service that predates the
      // chooser sees exactly the request it saw before.
      body: JSON.stringify({ id_token: idToken, ...(account ? { account } : {}) }),
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 10000)),
    });
  } catch (error) {
    return { ok: false, reason: `service unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  // Not a failure: the address has seats on several live organisations and
  // the service is asking which one. The caller answers with an account.
  if (response.status === 409 && body?.error === 'ambiguous_seat') {
    return { ok: false, ambiguous: true, accounts: body.accounts || [] };
  }
  if (response.status === 409 && body?.error === 'already_bound_elsewhere') {
    return {
      ok: false,
      boundElsewhere: true,
      account: body.account,
      accounts: body.accounts || [],
      reason: `that address is already bound to ${body.account || 'another organisation'}; switch instead of binding again`,
    };
  }
  // A service that does not run the orgs module has no such route and says
  // nothing about why. One that does run it names the reason -- `no_seat` on
  // an organisation the address is not a member of -- and that is a refusal,
  // not an absent feature.
  if ((response.status === 404 || response.status === 405)
    && !body?.error && !body?.message && !body?.detail) {
    return { ok: true, bound: false, reason: 'this service does not bind members to seats' };
  }
  if (!response.ok) {
    return { ok: false, status: response.status, reason: body?.message || body?.detail || body?.error || `identity binding returned ${response.status}` };
  }
  return { ok: true, bound: true, account: body?.account, name: body?.name, member: body?.member };
}

// Record which organisation the stored session is bound to, after a switch.
// Nothing here is a credential: the refresh token is untouched, so the
// session keeps working whether or not this write lands.
export function rememberOrg(account, name) {
  const session = readSession();
  if (!session) return false;
  saveSession({ ...session, account, accountName: name });
  return true;
}

// The binding in force and what else this address could be bound to. The ID
// token, not the access token: the list belongs to the verified address
// rather than to the scope.
export async function listOrgs(config, idToken) {
  if (!idToken) return { ok: false, reason: 'not signed in; run /teamflow:login' };
  let response;
  try {
    response = await fetch(`${serviceUrl(config)}/v1/members/me`, {
      headers: { Authorization: `Bearer ${idToken}` },
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 10000)),
    });
  } catch (error) {
    return { ok: false, reason: `service unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  if (!response.ok) {
    return { ok: false, status: response.status, reason: body?.message || body?.detail || body?.error || `the service answered ${response.status}` };
  }
  return {
    ok: true,
    account: body?.account,
    name: body?.name,
    role: body?.role,
    plan: body?.plan,
    accounts: body?.accounts || [],
  };
}

// --- naming an organisation on a terminal ----------------------------
//
// Shared by `teamflow login` and `teamflow org` so the numbering a person
// reads is the numbering they can answer with, whichever command printed it.

export function organisationLines(accounts, current) {
  return accounts.map((org, index) => {
    const detail = [org.role, org.plan].filter(Boolean).join(', ');
    const mark = current && org.id === current ? ' (current)' : '';
    return `  ${index + 1}. ${org.name || org.id} [${org.id}]${detail ? ` \u2014 ${detail}` : ''}${mark}`;
  }).join('\n');
}

// A number as printed, or the account id itself. Anything else is nothing:
// guessing at a half-typed name would bind the wrong organisation.
export function pickAccount(accounts, answer) {
  const value = String(answer ?? '').trim();
  if (!value) return undefined;
  if (/^\d+$/.test(value)) return accounts[Number(value) - 1]?.id;
  return accounts.find((org) => org.id === value)?.id;
}

// Asks, once, on a terminal. Streams are arguments so a test can drive it
// without a pty, and so a non-TTY caller simply never calls it.
export async function promptForAccount(accounts, { input = process.stdin, output = process.stdout } = {}) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input, output });
  try {
    output.write(`Your address holds a seat on ${accounts.length} organisations:\n${organisationLines(accounts)}\n`);
    const answer = await rl.question('Which one? Enter a number or an org id: ');
    return pickAccount(accounts, answer);
  } finally {
    rl.close();
  }
}

function rememberToken(body, refreshToken, email) {
  cached = {
    token: body.access_token,
    // The ID token rides along with the access token: same cache, same
    // expiry, same refresh, and the same never-on-disk rule. The admin
    // routes want it because only the ID token carries the verified
    // email claim that `admin.superadmins` is matched against; an
    // access token names a subject and a scope and nothing else.
    idToken: body.id_token,
    // Only what the provider told us. Guessing an hour for a token
    // that lives fifteen minutes means every fourth report is a 401.
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    refresh: fingerprint(refreshToken),
    email,
  };
  return cached.token;
}

// --- access tokens --------------------------------------------------

export async function accessToken(config = {}) {
  const session = readSession();
  if (!session) return { ok: false, reason: 'not signed in; run /teamflow:login' };
  const refresh = fingerprint(session.refreshToken);
  if (cached && cached.refresh === refresh && cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
    return { ok: true, token: cached.token, idToken: cached.idToken, expiresAt: cached.expiresAt, email: session.email, refreshed: false };
  }
  const refreshed = await tokenRequest(session.tokenUrl, {
    grant_type: 'refresh_token',
    client_id: session.clientId,
    refresh_token: session.refreshToken,
  }, config);
  if (!refreshed.ok) {
    return { ok: false, reason: `could not refresh the session: ${refreshed.reason}`, status: refreshed.status };
  }
  // Cognito rotates refresh tokens on some client settings and not on
  // others. Persist a new one when it arrives; keep the old one when
  // it does not.
  const nextRefresh = refreshed.body.refresh_token || session.refreshToken;
  if (refreshed.body.refresh_token) saveSession({ ...session, refreshToken: nextRefresh });
  const email = claimsOf(refreshed.body.id_token).email || session.email;
  if (email !== session.email) saveSession({ ...session, refreshToken: nextRefresh, email });
  rememberToken(refreshed.body, nextRefresh, email);
  return { ok: true, token: cached.token, idToken: cached.idToken, expiresAt: cached.expiresAt, email, refreshed: true };
}

// The credential the admin routes take. Same session, same refresh, one
// hour of life -- the only difference is which of the two tokens the
// provider issued is sent. Everything else in the plugin keeps using
// the access token, because everything else is authorised by scope.
//
// Cognito only returns an ID token on the openid scope. A session that
// was granted without it refreshes fine and still cannot call an admin
// route, so say that rather than sending a header the service will
// answer 403 to.
export async function adminIdToken(config = {}) {
  const token = await accessToken(config);
  if (!token.ok) return token;
  if (!token.idToken) {
    return {
      ok: false,
      reason: 'this session has no ID token; sign in again with `teamflow login` so the openid scope is granted',
    };
  }
  return { ok: true, token: token.idToken, email: token.email, expiresAt: token.expiresAt };
}

// --- GitHub Actions OIDC --------------------------------------------
//
// A workflow with `permissions: id-token: write` can ask Actions for a
// short-lived JWT that names the repository, the workflow and the ref.
// The service trades it for an access token. No secret is stored in
// the repository, and a fork cannot obtain one.

export function inGithubActions() {
  return Boolean(process.env.ACTIONS_ID_TOKEN_REQUEST_URL && process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
}

// What a GitHub OIDC token must be addressed to. The service checks
// it, because an unchecked audience accepts a token minted for
// somebody else's service, which any workflow anywhere can get. It is
// the hosted origin by default rather than `serviceUrl`: pointing a
// reporter at a preview stack must not change what its CI tokens are
// addressed to. `orgs.oidc_audience` on the service side moves it, and
// GET /v1/repos reports the value in force.
export function oidcAudience(config = {}) {
  return config.oidcAudience || process.env.TEAMFLOW_OIDC_AUDIENCE || defaultServiceUrl();
}

async function githubIdToken(config) {
  const audience = oidcAudience(config);
  const url = `${process.env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(audience)}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 10000)),
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok || !body?.value) {
    return { ok: false, reason: `GitHub refused an OIDC token (${response.status})` };
  }
  return { ok: true, token: body.value };
}

export async function githubOidcAccessToken(config = {}) {
  if (!inGithubActions()) return { ok: false, attempted: false, reason: 'not running in GitHub Actions' };
  try {
    const id = await githubIdToken(config);
    if (!id.ok) return { ...id, attempted: true };
    const response = await fetch(`${serviceUrl(config)}/v1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: id.token }),
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 10000)),
    });
    let body;
    try { body = await response.json(); } catch { body = undefined; }
    if (!response.ok || !body?.access_token) {
      // `repository_not_registered` is the one an owner can fix, and
      // the service's own message names the route that fixes it.
      return { ok: false, attempted: true, status: response.status, reason: body?.message || body?.detail || body?.error || `the service refused the OIDC token (${response.status})` };
    }
    return {
      ok: true, attempted: true, token: body.access_token,
      expiresIn: Number(body.expires_in) || undefined,
      account: body.account, repository: body.repository,
    };
  } catch (error) {
    return { ok: false, attempted: true, reason: `OIDC exchange failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// --- repository registration ---------------------------------------
//
// A workflow can only trade its OIDC token once an owner has said the
// repository belongs to the account. Without that, any repository's CI
// could mint tokens against any account that shares the audience.

export async function registerRepo(config, repo, credentialHeader) {
  return repoCall(config, 'POST', '/v1/repos', credentialHeader, { repo });
}

export async function listRepos(config, credentialHeader) {
  return repoCall(config, 'GET', '/v1/repos', credentialHeader);
}

async function repoCall(config, method, route, credentialHeader, payload) {
  if (!credentialHeader) return { ok: false, reason: 'not signed in; run /teamflow:login' };
  let response;
  try {
    response = await fetch(`${serviceUrl(config)}${route}`, {
      method,
      headers: {
        [credentialHeader.header]: credentialHeader.value,
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 10000)),
    });
  } catch (error) {
    return { ok: false, reason: `service unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  if (!response.ok) {
    return { ok: false, status: response.status, reason: body?.message || body?.detail || body?.error || `the service answered ${response.status}` };
  }
  return { ok: true, ...body };
}
