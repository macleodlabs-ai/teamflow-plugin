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

import {
  credentialDestination, credentialRefusal, defaultServiceUrl, globalConfigPath,
  isLoopbackOrigin, originOf, readJson, safeExec, serviceUrl, serviceUrlSource,
  trustedOrigins, unreachableReason, writeJson,
} from './core.mjs';
import { refusalOf } from './refusal.mjs';
import { BY_ID } from './tools.mjs';

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
// Discovery runs once per sign-in and decides whether a sign-in is
// possible at all, so it gets longer than a report does.
const CAPABILITIES_TIMEOUT_MS = 10000;
const CAPABILITIES_ATTEMPTS = 2;
// A session whose credential is one machine's device credential
// rather than a refresh token. Nothing about it is refreshed, and
// `status`, `logout` and the reporters all branch on this.
const DEVICE_KIND = 'device';
const DEVICE_INTERVAL_MS = 5000;
// What the service adds to the interval when it says slow_down. The
// grant's own number, and the point of it is that a client which
// ignores the answer gets itself cut off.
const SLOW_DOWN_MS = 5000;

export function sessionPath() {
  return path.join(os.homedir(), '.config', 'teamflow', 'session.json');
}

// Two kinds of session, and both are a credential this machine can
// report with: a refresh token from the browser sign-in, or a device
// credential from the code flow. A file with neither is not a session.
export function readSession() {
  const session = readJson(sessionPath());
  return (session?.refreshToken || session?.deviceToken) ? session : undefined;
}

export function isDeviceSession(session = readSession()) {
  return session?.kind === DEVICE_KIND && Boolean(session.deviceToken);
}

/**
 * The origin that issued this session, and so the only one it may be
 * sent to (MACLEOD-616).
 *
 * Written at sign-in from `serviceUrl(config)`. Sessions signed in
 * before this release recorded nothing, and they are not signed out for
 * it: an unrecorded origin is read as the hosted service, which is where
 * every real one was issued. The field is additive — an older plugin
 * sharing this data directory reads the file, ignores the key it has
 * never heard of and keeps working.
 *
 * Absent means hosted. It must NOT mean "unbound, adopt whatever origin
 * this session first reaches", however tempting that is as a way to
 * spare the handful of people who signed in against a preview: that is
 * trust on first use where the attacker picks the first use. A hostile
 * `.claude/settings.json` setting `TEAMFLOW_SERVICE_URL` in the first
 * session after the upgrade would bind the victim's session to the
 * attacker's origin permanently, which is a worse bug than the one this
 * whole change exists to fix. Somebody genuinely elsewhere runs
 * `teamflow login` again, which records where they are.
 */
export function sessionOrigin(session = readSession()) {
  return session?.serviceOrigin || originOf(defaultServiceUrl());
}

/** What to stamp on a session being written now. */
function originToRecord(config) {
  return originOf(serviceUrl(config)) || originOf(defaultServiceUrl());
}

/**
 * Signing in somewhere is saying that somewhere is yours (MACLEOD-616
 * follow-up, F2).
 *
 * The session itself records its origin and needs nothing more. This is
 * for the credential that cannot: an API key used against the same
 * self-hosted service, which has no record of where it came from and is
 * otherwise refused anywhere but the hosted host. Deliberately a write
 * to the user's own file — the one place a repository cannot reach —
 * and never a write from the environment's say-so alone.
 */
function rememberTrustedOrigin(config, typed = undefined) {
  const origin = originToRecord(config);
  if (!origin || origin === originOf(defaultServiceUrl())) return false;
  // Provenance, not the fact of a sign-in. Signing in against an address
  // an environment variable chose is not the user naming that address;
  // it is the user doing what the error message told them to, and the
  // first version of this function turned that into a permanent entry in
  // their own global file (MACLEOD-616 follow-up, B1). Only `--service`
  // typed this run, or `serviceUrl` already in the file, counts.
  const source = serviceUrlSource(config, typed);
  if (source !== 'typed' && source !== 'global') return false;
  if (trustedOrigins().includes(origin)) return false;
  const file = globalConfigPath();
  const existing = readJson(file, {}) || {};
  const listed = Array.isArray(existing.trustedOrigins) ? existing.trustedOrigins : [];
  writeJson(file, { ...existing, trustedOrigins: [...listed, origin] });
  return true;
}

/**
 * A sign-in at an address nobody deliberately chose does not happen
 * (MACLEOD-616 follow-up, B1).
 *
 * Checked before `/v1/capabilities` is fetched, before a browser is
 * opened, before anything at all goes to the origin — because the
 * sign-in *is* the leak, not merely its consequence. What a hostile
 * origin gets out of one is the authorize URL it can dress up as
 * anything, the authorization code with its PKCE exchange, and the
 * `id_token` that `seatCall` posts to it. Refusing afterwards would be
 * refusing after the interesting part.
 *
 * Loopback is exempt, so `npm run dev`, the preview and the e2e suite
 * sign in against a local stack exactly as before. The one flow this
 * costs is a self-hoster who configures purely by environment variable,
 * and their ask is `--service <url>` once, or one line in their own
 * config file.
 */
function deliberateService(config, typed) {
  const origin = originToRecord(config);
  if (isLoopbackOrigin(origin)) return { ok: true };
  const source = serviceUrlSource(config, typed);
  if (source !== 'environment') return { ok: true };
  return {
    ok: false,
    refused: true,
    reason: `TEAMFLOW_SERVICE_URL in this environment names ${origin}, so TeamFlow did not sign in `
      + 'there — a sign-in hands that address an authorization code and your identity token, and an '
      + 'environment variable is not a deliberate choice of who to sign in to. A repository can set '
      + 'one: a `.claude/settings.json` "env" block, an `.envrc` or an editor workspace setting all '
      // The command is printed with a placeholder, never with the
      // declined origin filled in (MACLEOD-616 final audit): this message
      // is read by somebody whose sign-in has just failed, and a line
      // they can paste is a line they will paste.
      + `reach this process. If ${origin} is genuinely your service, say so deliberately by typing `
      + "its address yourself — `teamflow login --service <your service's address>` — or put "
      + `\`serviceUrl\` in ${globalConfigPath()}.`,
  };
}

/**
 * The origins this machine's *own* identity provider may live on
 * (MACLEOD-616 follow-up, F1).
 *
 * `session.tokenUrl` is where the refresh token goes, and it was learned
 * at sign-in from the service's `/v1/capabilities`. Before this change a
 * repository could choose that service, so somebody who ran
 * `teamflow login` inside a hostile checkout has an attacker's token
 * endpoint written into their session file — and the guards elsewhere
 * all pass, because the session reads as hosted and the attacker's URL
 * is https. The upgrade would keep handing them a refresh token for as
 * long as the session lived.
 *
 * So the token endpoint is checked against where the session says it was
 * issued. The hosted service's provider is NOT on the hosted origin —
 * Cognito's custom domain is `auth.codercat.io` by design — so it is
 * named here rather than derived, and a session that recorded its own
 * origin may also use a provider on that origin or on a trusted one.
 */
const HOSTED_TOKEN_ORIGIN = 'https://auth.codercat.io';

export function tokenOriginAllowed(session = readSession()) {
  const token = originOf(session?.tokenUrl);
  if (!token) return false;
  if (token === HOSTED_TOKEN_ORIGIN) return true;
  if (isLoopbackOrigin(token)) return true;
  // Only a session that recorded where it was issued may name a provider
  // of its own: an unrecorded one reads as hosted, and the hosted
  // provider is the line above.
  if (!session?.serviceOrigin) return false;
  return token === session.serviceOrigin
    || token === originOf(session.issuer)
    || trustedOrigins().includes(token);
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

// Two answers that used to look the same and are not: the service said
// it publishes no auth block, or the service never answered at all.
// Told the first when the second happened, a developer goes looking for
// configuration that was never the problem -- which is exactly what the
// bug report said the plugin did.
//
// Ten seconds and one retry, because a cold Lambda behind CloudFront
// spends most of the first window starting up. The retry is a second
// window rather than a pause: by the time it goes out the function is
// warm. Only a timeout, a transport error or a 5xx is retried; a 404 is
// a service that has no such route and will not grow one on a retry.
async function capabilities(config) {
  const url = `${serviceUrl(config)}/v1/capabilities`;
  const timeoutMs = Number(config.serviceTimeoutMs || CAPABILITIES_TIMEOUT_MS);
  let detail;
  for (let attempt = 0; attempt < CAPABILITIES_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      if (response.status >= 500) {
        detail = `the service answered ${response.status}`;
        continue;
      }
      if (!response.ok) return { reached: true };
      const body = await response.json();
      return { reached: true, auth: body?.auth };
    } catch (error) {
      detail = error?.name === 'TimeoutError'
        ? `no answer in ${timeoutMs}ms`
        : (error instanceof Error ? error.message : String(error));
    }
  }
  return { reached: false, detail };
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
  const overridden = Boolean(config.authIssuer && config.authClientId);
  const probe = overridden ? { reached: true } : await capabilities(config);
  if (!probe.reached) {
    return {
      ok: false,
      unreachable: true,
      reason: `could not reach ${serviceUrl(config)} to ask how to sign in`
        + `${probe.detail ? ` (${probe.detail})` : ''}; check the network and try again`,
    };
  }
  const published = probe.auth;
  const issuer = String(config.authIssuer || published?.issuer || '').replace(/\/+$/, '');
  const clientId = config.authClientId || published?.client_id;
  if (!issuer || !clientId) {
    return {
      ok: false,
      // Carried even here: the device flow needs neither an issuer
      // nor a client id, so a service that publishes only that block
      // can still sign somebody in.
      device: Boolean(published?.device?.enabled),
      deviceVerificationUrl: published?.device?.verification_url,
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
    // Whether asking for a device code is an option here. Published
    // by the service, so a CLI on a machine with no browser knows
    // before it asks rather than reading a 404 as an outage.
    device: Boolean(published?.device?.enabled),
    deviceVerificationUrl: published?.device?.verification_url,
  };
}

// --- the token endpoint --------------------------------------------

async function tokenRequest(tokenUrl, params, config) {
  // The authorization code and the refresh token both go out here, and
  // the address came from the service's own `/v1/capabilities` answer —
  // a URL from a response, which is exactly the shape part 4 of
  // MACLEOD-616 is about. It gets the transport rule the rest do: https,
  // or this machine.
  const origin = originOf(tokenUrl);
  if (!origin || (!origin.startsWith('https:') && !isLoopbackOrigin(origin))) {
    return { ok: false, reason: `refusing to send a credential to the token endpoint at ${tokenUrl || 'no address'}: https is required for anything but localhost` };
  }
  let response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 10000)),
    });
  } catch (error) {
    return { ok: false, reason: unreachableReason(error, { serviceUrl: tokenUrl }) };
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

// Whether shelling out to a browser can possibly work here. macOS and
// Windows always have one in front of somebody; an X or Wayland display
// says the same about a Linux desktop. A Linux box with neither -- a
// server, a container, an SSH session -- has nowhere to open a window,
// and running `xdg-open` there buys a five-second wait and no browser.
export function browserPossible({ env = process.env, platform = process.platform } = {}) {
  if (platform === 'darwin' || platform === 'win32') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

// Sign-in progress goes to stderr: stdout carries the result the caller
// parses, and a URL printed into it would land in the middle of that.
function printLine(line) {
  process.stderr.write(`${line}\n`);
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
  // `teamflow login --no-browser`, a box with no display, and whether
  // anybody is watching a terminal. None of them stop a sign-in: they
  // decide whether the URL is opened here or handed to the person.
  noBrowser = false, canOpenBrowser = browserPossible(), tty = Boolean(process.stdout.isTTY),
  notify = printLine,
  // `--service <url>`, as typed this run. The one thing that makes a
  // non-hosted address a deliberate choice rather than a variable.
  service = undefined,
} = {}) {
  // Before discovery: nothing, not even a capabilities probe, goes to an
  // address only the environment named (MACLEOD-616 follow-up, B1).
  const deliberate = deliberateService(config, service);
  if (!deliberate.ok) return deliberate;
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

    // Nothing is opened when there is nowhere to open it. Otherwise the
    // opener is asked, and its answer is believed: `open` and `xdg-open`
    // exit non-zero when there is no browser to hand the URL to.
    const opened = (noBrowser || !canOpenBrowser) ? false : await openUrl(authorizeUrl);
    // The URL goes out now, while the listener is up, rather than after
    // the timeout when the port has closed and the URL leads nowhere.
    // A run with no terminal gets it too: Claude Code drives this over a
    // pipe, and the person only ever sees what was printed.
    const printedUrl = !opened || !tty;
    if (printedUrl) {
      notify(`TeamFlow sign-in: open this URL in any browser on this machine within`
        + ` ${Math.max(1, Math.round(timeoutMs / 1000))} seconds. This terminal keeps waiting.`);
      notify(authorizeUrl);
    }
    // The timer is cleared, not just lost to the race: an uncancelled
    // three-minute timeout keeps the process alive long after the
    // developer has signed in.
    let timer;
    const callback = await Promise.race([
      server.arrived,
      new Promise((resolve) => { timer = setTimeout(() => resolve({ error: 'timeout' }), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));

    if (callback.error === 'timeout') {
      return { ok: false, reason: 'sign-in timed out; nobody opened the URL', authorizeUrl, opened, printedUrl };
    }
    if (callback.error) return { ok: false, reason: callback.error, authorizeUrl, opened, printedUrl };
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
      // The service that issued this session, and the only one it will
      // be sent to afterwards (MACLEOD-616).
      serviceOrigin: originToRecord(config),
      refreshToken: exchanged.body.refresh_token,
      email,
      // Which organisation this session is bound to, so `teamflow org` and
      // `teamflow status` can say so without a round trip.
      account: bound.account,
      accountName: bound.name,
      createdAt: new Date().toISOString(),
    });
    rememberToken(exchanged.body, exchanged.body.refresh_token, email);
    // Signing in *deliberately* here is saying this service is yours,
    // which is what lets an API key against it be used later. Signing in
    // because a variable pointed here is not (MACLEOD-616, B1).
    rememberTrustedOrigin(config, service);
    return {
      ok: true, email, issuer: auth.issuer, account: bound.account, accountName: bound.name,
      bound: bound.bound, opened, printedUrl,
    };
  } finally {
    await server.close();
  }
}

// --- device sign-in --------------------------------------------------
//
// The loopback redirect above goes to 127.0.0.1, which is this
// machine and nobody else's. When the browser is somewhere else --
// an SSH session, a container, an agent running on a box in a rack --
// no URL printed on this terminal can help, because the address it
// comes back to is not reachable from where the browser is.
//
// So: the machine asks the service for a code, the person carries the
// short half of it to any browser anywhere, signs in the way they
// always do and approves. What comes back is a device credential --
// revocable, bound to their seat, and nothing anybody had to type
// into a terminal.

function deviceLabel() {
  // What this computer will be called on the members page. A hostname
  // is the one name a person recognises without being told it.
  return String(os.hostname() || 'unnamed machine').slice(0, 64);
}

// --- which tool is asking (MACLEOD-604, MACLEOD-605) -----------------
//
// The consent page's question is "did I start this?", and a hostname
// alone does not answer it: the same laptop runs several tools and
// `teamflow login` is the same command in every one of them. So the
// request says which, and the page reads the display name out of
// `tools.mjs` rather than out of a second list.
//
// TWO DIFFERENT QUESTIONS, AND THE ORDER BETWEEN THEM IS THE POINT.
// The session that wrote this carried, at the same moment,
// `CLAUDE_CODE_ENTRYPOINT=cli` and a `GIT_ASKPASS` inside
// `/Applications/Cursor.app`. Both facts were true and they were not
// the same fact: Claude Code was driving the plugin, and Cursor was
// the editor whose terminal it was running in. A sweep for editor
// markers would have put "Cursor" on the one screen where a person
// grants a credential to a machine, for work Claude Code was doing.
// That is not a cosmetic slip; a consent screen that names the wrong
// asker is a phishing primitive. So the two questions are asked by two
// functions with two names, and `detectTool` puts them in order.
//
// THE BAR FOR ADDING A MARKER: it must be able to mean only the tool
// it names. A marker that names a family while the id names a member
// of it is refused, however convenient — `TERM_PROGRAM=vscode` is set
// by every VS Code fork and says nothing about GitHub Copilot, and
// `TERMINAL_EMULATOR=JetBrains-JediTerm` is set by every JetBrains IDE
// and says nothing about Junie. Answering `copilot` or `jetbrains`
// from those would assert an agent nobody saw. They decline instead.
//
// A marker is safe to add, even for a tool nobody here has run, when
// it is ANCHORED — when the thing being matched is one only that tool
// puts there, so the check can fail by being absent but not by being
// wrong, and absence falls through to the honest fallback. The word in
// a path is not an anchor and the first version of this learnt it the
// expensive way; see `forkInAskpassPath`. A bundle identifier, a
// `TERM_PROGRAM` a vendor sets to its own name, and a path ending in a
// specific extension's own dist directory are anchors.
//
// Where each marker below was confirmed is recorded beside it.

/**
 * Editors whose installation directory is named after themselves and
 * whose record in `tools.mjs` is the editor rather than an agent
 * inside it — so the directory name and the tool id are the same word.
 *
 * Deliberately not `copilot`: its record is "VS Code with GitHub
 * Copilot", and a `Visual Studio Code` install path proves the editor
 * and not the extension.
 */
const FORK_EDITORS = ['cursor', 'windsurf'];

/**
 * Bundle identifiers that name an editor, for macOS, where
 * `__CFBundleIdentifier` is inherited by everything the app launches.
 *
 * Only Cursor is here because only Cursor could be read off a machine:
 * it ships through ToDesktop, so its identifier names ToDesktop rather
 * than Cursor and could not have been guessed. Confirmed twice on
 * 2026-09-20 — present in a live session's environment, and read back
 * from `/Applications/Cursor.app/Contents/Info.plist`.
 */
const HOST_BUNDLE_IDS = {
  'com.todesktop.230313mzl4w4u92': 'cursor',
};

/**
 * The path VS Code's git extension ships its askpass helpers at, which
 * is the anchor this whole check hangs on.
 *
 * Confirmed by listing the directory in two editors installed on one
 * machine on 2026-09-20 — `/Applications/Cursor.app` and
 * `/Applications/Visual Studio Code.app` both ship `askpass.sh`,
 * `askpass-empty.sh` and `askpass-main.js` under
 * `Contents/Resources/app/extensions/git/dist/` — so the shape is
 * first-hand for two editors rather than inferred from one.
 */
// No `.bat` arm: the extension has no platform branch. Its shipped
// `git/dist/main.js` names `askpass.sh`, `askpass-empty.sh` and
// `askpass-main.js` and nothing else, and neither editor installed
// here ships a `.bat` at all — so matching one would be guarding a
// case that does not exist, which is how a fictional test gets
// written (MACLEOD-605 audit).
const ASKPASS_TAIL = /[/\\]resources[/\\]app[/\\]extensions[/\\]git[/\\]dist[/\\]askpass[\w-]*\.(sh|js)$/i;

/**
 * Which VS Code fork an askpass path belongs to, or nothing.
 *
 * VS Code's git extension exports a path inside its own installation,
 * and every fork inherits that extension unchanged — which is why the
 * path names the fork when `TERM_PROGRAM` cannot, being `vscode` in
 * all of them.
 *
 * ANCHORED ON THE EXTENSION'S OWN FILE, NEVER ON THE WORD. The first
 * version of this scanned every segment for `cursor` or `windsurf`,
 * and a review found what that costs: `GIT_ASKPASS` set to
 * `/Users/cursor/bin/my-askpass.sh` — a person whose home directory is
 * named `cursor`, using a custom askpass with no editor involved at
 * all — was told "Cursor is asking" on the screen where they grant a
 * credential. `/home/dev/windsurf/scripts/askpass.sh` and
 * `/usr/local/bin/cursor-askpass` did the same. So the tail above has
 * to match first, and only then is the installation directory read:
 * the last segment before `resources/app`, stepping over macOS's
 * `Contents`, which leaves the bundle's own name last in every layout.
 *
 * This is the version that can only be right or silent, and the anchor
 * is why. An unanchored word can be anybody's directory; a path ending
 * in this extension's own dist directory belongs to a VS Code fork or
 * to nothing. The trade is a false negative where the fix is a false
 * positive: a layout that puts the extension somewhere else declines.
 * Verified here are the two macOS bundles above; assumed from VS
 * Code's standard packaging are Linux (`/usr/share/<name>/resources/
 * app/…`) and Windows (`…\<name>\resources\app\…`). Known to decline:
 * a remote or WSL session, where `GIT_ASKPASS` points into
 * `~/.vscode-server/bin/<commit>/extensions/…` with no `resources/app`
 * in it. That decline is correct, but not for the reason it first
 * looks: WSL and a devcontainer are the same seat as the terminal, so
 * "the editor is elsewhere" is false for two of the three. The honest
 * reason is narrower — a server install carries no install directory
 * to read a name out of, so there is nothing to answer with.
 *
 * Windsurf is a fork of the same editor and so inherits the same
 * extension; that it installs as `Windsurf` has not been watched here,
 * which costs nothing, because a fork this does not recognise simply
 * declines.
 */
function forkInAskpassPath(given) {
  if (!given) return '';
  const askpass = String(given);
  const tail = ASKPASS_TAIL.exec(askpass);
  if (!tail) return '';
  const segments = askpass.slice(0, tail.index).split(/[/\\]/).filter(Boolean);
  let last = segments.pop();
  if (last && last.toLowerCase() === 'contents') last = segments.pop();
  const name = String(last || '').toLowerCase().replace(/\.app$/, '');
  return FORK_EDITORS.includes(name) ? name : '';
}

/**
 * 1. What a person said, which outranks anything inferred.
 *
 * Validated against the table all the same. The consent page renders
 * nothing for an id it does not know and the service refuses to echo
 * an arbitrary client string, so an unrecognised value is dropped here
 * rather than passed on — ignored, never echoed. Dropped and not
 * fatal: detection carries on below, because a typo in a variable is
 * no reason to stop naming the tool that is demonstrably running.
 */
function toolNamedByHand(env) {
  const named = env.TEAMFLOW_TOOL;
  return named && BY_ID[named] ? named : '';
}

/**
 * 2. The tool actually driving the plugin.
 *
 * Every tool other than these is told to the plugin rather than
 * guessed at by it: `teamflow hook --for <tool>` names it on the hook
 * path (`hook-cli.mjs`). That is not available here — `teamflow login`
 * is a person at a terminal, in a process no hook started — and it is
 * deliberately not remembered from a previous hook run; see the note
 * under `detectTool`.
 */
function drivingTool(env) {
  // Claude Code. Confirmed in a live session in this repository on
  // 2026-09-20: `CLAUDECODE=1` and `CLAUDE_CODE_ENTRYPOINT=cli` were
  // both present. Either alone answers, so a future entrypoint that
  // sets only one still names itself.
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_ENTRYPOINT) return 'claude-code';
  // Gemini CLI. Confirmed against the vendor's own shell-tool
  // reference, which sets it for precisely this purpose: "When
  // run_shell_command executes a command, it sets the GEMINI_CLI=1
  // environment variable in the subprocess's environment. This allows
  // scripts or tools to detect if they are being run from within the
  // Gemini CLI." Read 2026-09-20 at
  // google-gemini.github.io/gemini-cli/docs/tools/shell.html.
  //
  // The documented value, not merely a set variable. Bare truthiness
  // made `GEMINI_CLI=0` answer "Gemini CLI" while `CLAUDECODE=0` above
  // answered nothing — two conventions in adjacent lines, and the one
  // that reads a disabling value as an enabling one is the wrong one
  // to keep on a page that names who is asking for a credential.
  if (env.GEMINI_CLI === '1') return 'gemini';
  return '';
}

/**
 * 3. The editor whose terminal this is, which is a weaker claim than
 * the one above and is only reached when nothing above answered.
 */
function hostEditor(env) {
  const byBundle = HOST_BUNDLE_IDS[env.__CFBundleIdentifier];
  if (byBundle) return byBundle;
  // Zed, which names itself here rather than inheriting `vscode`.
  // zed-industries/zed#4571 asked for it and was closed by #14213, and
  // #21951 is a report of it going MISSING when Zed is launched from a
  // dock or launcher — which only makes sense if it is normally set.
  // Secondary evidence rather than a session watched here; the failure
  // it can produce is silence.
  if (env.TERM_PROGRAM === 'zed') return 'zed';
  // `…_MAIN` and not `…_NODE`, which the first version read by
  // mistake: in this session's own environment `VSCODE_GIT_ASKPASS_NODE`
  // is `/Applications/Cursor.app/Contents/Frameworks/Cursor Helper
  // (Plugin).app/…`, the Electron helper binary, which is nowhere near
  // the extension and can never satisfy the anchor. `…_MAIN` is the
  // one that points at `dist/askpass-main.js`. The extension exports
  // all three together, so nothing is lost by dropping `…_NODE`.
  return forkInAskpassPath(env.VSCODE_GIT_ASKPASS_MAIN)
    || forkInAskpassPath(env.GIT_ASKPASS);
}

/**
 * Which tool this is running in, as an id `tools.mjs` knows, or ''.
 *
 * The precedence, in one line, weakest last. An unset answer is not a
 * failure: the page falls back to naming the plugin alone, which is
 * true whatever asked.
 *
 * NOT REMEMBERED ACROSS SESSIONS, and that was a judgement rather than
 * an omission (MACLEOD-605). `--for <tool>` is a fact the plugin is
 * handed, so writing it into the data directory would let a later
 * `login` in the same repository name Cline or Codex CLI, which no
 * environment marker can. It is not worth it. Such a note is only ever
 * consulted when the environment says nothing — which is exactly the
 * bare-terminal CLI case where two of these tools are
 * indistinguishable from each other, so a repository used from Codex
 * CLI and then from Gemini CLI would be named wrongly by the note in
 * the one situation the note exists for. A host-editor change
 * (`cursor` then `windsurf`) could be caught by comparing the
 * environment then against the environment now, but that same guard
 * cannot see two CLIs apart, and MACLEOD-583's rule keeps what is
 * written to the data directory readable by older versions, so a wrong
 * note is durable. Meanwhile the person typing `teamflow login` has
 * `TEAMFLOW_TOOL` above, which is a statement rather than a guess. A
 * remembered guess that is wrong occasionally is worse here than the
 * fallback, which is never wrong.
 */
export function detectTool(env = process.env) {
  return toolNamedByHand(env) || drivingTool(env) || hostEditor(env) || '';
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function deviceCall(config, route, payload) {
  let response;
  try {
    response = await fetch(`${serviceUrl(config)}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 10000)),
    });
  } catch (error) {
    return { ok: false, unreachable: true, reason: unreachableReason(error, config) };
  }
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      // The grant's own slugs. The caller branches on these, so they
      // are carried through rather than flattened into prose.
      error: body?.error,
      reason: refusalOf(body, `the service answered ${response.status}`).reason,
    };
  }
  return { ok: true, body: body || {} };
}

/**
 * The verification URL, on the host this machine is actually talking to
 * (MACLEOD-572, plugin audit row 18).
 *
 * The service builds that URL from its own configured domain, which on
 * the deployed stack is the host the plugin is talking to and on a
 * preview, a laptop or a test service is not: a preview answers
 * `https://codercat.io/app/#device` for a code only it has issued, and
 * a person who opened that would be typing a real code into the live
 * dashboard, which cannot approve it. So the path, query and fragment
 * the service chose are kept exactly and only the origin is replaced,
 * and only when the two disagree — a service that answered with its own
 * host is left alone, and anything unparseable is passed through rather
 * than guessed at.
 */
export function verificationUrl(given, config = {}) {
  if (!given) return given;
  let url;
  let here;
  try {
    url = new URL(String(given));
    here = new URL(serviceUrl(config));
  } catch {
    return given;
  }
  if (url.origin === here.origin) return given;
  url.protocol = here.protocol;
  url.host = here.host;
  return url.toString();
}

const DEVICE_REFUSALS = {
  access_denied: 'the sign-in was refused in the browser',
  expired_token: 'the code expired before anybody approved it',
  invalid_grant: 'that code is no longer valid; start again',
};

export async function deviceLogin(config = {}, {
  notify = printLine, label = deviceLabel(), tool = detectTool(),
  timeoutMs = LOGIN_TIMEOUT_MS, sleep = wait, now = () => Date.now(),
  service = undefined,
} = {}) {
  // As in `login`, and before the first request: a device grant is a
  // credential this machine will hold, and an address the environment
  // chose is not a choice (MACLEOD-616 follow-up, B1).
  const deliberate = deliberateService(config, service);
  if (!deliberate.ok) return deliberate;
  const started = await deviceCall(config, '/v1/auth/device', { label, client: tool });
  if (!started.ok) {
    return { ok: false, reason: `the service would not start a device sign-in: ${started.reason}` };
  }
  const grant = started.body;
  if (!grant.device_code || !grant.user_code) {
    return { ok: false, reason: 'the service answered a device request without a code' };
  }
  const url = verificationUrl(
    grant.verification_url_complete || grant.verification_url, config);
  // What the person is doing is connecting the plugin, not signing a
  // machine in, and the two addresses are for two different people: the
  // short one is typed on a phone, the long one is tapped (RFC 8628
  // §3.3.1). Both are printed, because which is useful depends on where
  // the browser is (MACLEOD-604).
  const short = verificationUrl(grant.verification_url, config);
  notify(`To connect the TeamFlow plugin, open ${short} in a browser on any`
    + ` device and confirm the code ${grant.user_code}`);
  if (url && url !== short) notify(`Or open this link, which carries the code: ${url}`);

  let interval = Math.max(1000, (Number(grant.interval) || 0) * 1000 || DEVICE_INTERVAL_MS);
  // Whichever runs out first: the caller's patience or the code's own
  // life. Polling a code the service has already forgotten is noise.
  const deadline = now() + Math.min(timeoutMs, (Number(grant.expires_in) || 600) * 1000);
  while (now() + interval <= deadline) {
    await sleep(interval);
    const answer = await deviceCall(config, '/v1/auth/device/token', { device_code: grant.device_code });
    if (answer.ok) {
      const body = answer.body;
      if (!body.access_token) return { ok: false, reason: 'the service approved the code but issued no credential' };
      saveSession({
        version: SESSION_VERSION,
        kind: DEVICE_KIND,
        // Not a refresh token: there is nothing to exchange it for.
        // It is the credential, and revoking it is instant.
        deviceToken: body.access_token,
        deviceId: body.device_id,
        // As for a browser session: the origin that granted it
        // (MACLEOD-616).
        serviceOrigin: originToRecord(config),
        label,
        email: body.member,
        account: body.account,
        createdAt: new Date().toISOString(),
      });
      forgetCachedToken();
      rememberTrustedOrigin(config, service);
      return {
        ok: true, device: true, email: body.member, account: body.account,
        accountName: body.account_name, deviceId: body.device_id, label,
      };
    }
    if (answer.error === 'authorization_pending') continue;
    if (answer.error === 'slow_down') {
      // Believed, not ignored: a client that keeps its own pace is
      // the one the service ends up refusing outright.
      interval += SLOW_DOWN_MS;
      continue;
    }
    if (answer.unreachable) continue;       // a blip, not an answer
    return { ok: false, reason: DEVICE_REFUSALS[answer.error] || answer.reason, error: answer.error };
  }
  return {
    ok: false,
    reason: `device sign-in timed out; nobody entered ${grant.user_code}`,
    userCode: grant.user_code,
    verificationUrl: url,
  };
}

// Signing out, both ends. A device credential lives on the service
// until somebody takes it away, so a machine being handed on or
// decommissioned has to say so; a refresh-token session has nothing
// to revoke here, because removing the file is the revocation.
//
// The local file goes whatever the service answered. A machine left
// signed in because the network was down is the worse of the two
// failures, and the credential is revocable from the members page.
export async function signOut(config = {}) {
  const session = readSession();
  if (!session) return { ok: false, reason: 'not signed in' };
  let revoked = false;
  let reason;
  if (isDeviceSession(session) && session.deviceId) {
    const answer = await revokeDevice(config, session.deviceId, session.deviceToken);
    revoked = answer.ok;
    reason = answer.ok ? undefined : answer.reason;
  }
  clearSession();
  return { ok: true, revoked, reason, device: isDeviceSession(session) };
}

export async function revokeDevice(config, deviceId, token) {
  if (!deviceId || !token) return { ok: false, reason: 'no device credential to revoke' };
  // The device credential in the clear, in a header, to whatever this
  // config names. Same rule as everywhere else (MACLEOD-616): the local
  // file still goes, because `signOut` clears it whatever this answers.
  const target = credentialDestination(config, sessionOrigin());
  if (!target.ok) return { ok: false, refused: true, reason: target.reason };
  let response;
  try {
    response = await fetch(`${serviceUrl(config)}/v1/members/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 10000)),
    });
  } catch (error) {
    return { ok: false, reason: unreachableReason(error, config) };
  }
  if (!response.ok) {
    let body;
    try { body = await response.json(); } catch { body = undefined; }
    return { ok: false, status: response.status, ...refusalOf(body, `the service answered ${response.status}`) };
  }
  return { ok: true };
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
  // An ID token in a body is still a credential. No origin is bound yet
  // — this runs during sign-in, before a session exists — so it gets the
  // transport half of the rule (MACLEOD-616).
  const target = credentialDestination(config);
  if (!target.ok) return { ok: false, refused: true, reason: target.reason };
  let response;
  try {
    response = await fetch(`${serviceUrl(config)}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // `account` only when one has been chosen: a service that predates the
      // chooser sees exactly the request it saw before.
      body: JSON.stringify({ id_token: idToken, ...(account ? { account } : {}) }),
      redirect: 'error',
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 10000)),
    });
  } catch (error) {
    return { ok: false, reason: unreachableReason(error, config) };
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
    return { ok: false, status: response.status, ...refusalOf(body, `identity binding returned ${response.status}`) };
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
      redirect: 'error',
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 10000)),
    });
  } catch (error) {
    return { ok: false, reason: unreachableReason(error, config) };
  }
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  if (!response.ok) {
    return { ok: false, status: response.status, ...refusalOf(body, `the service answered ${response.status}`) };
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
  // The same rule `credential()` applies, applied again here because
  // this is the other door into a stored credential: `adminIdToken` and
  // anything else that wants a token comes through it and not through
  // `credential()` (MACLEOD-616).
  const target = credentialDestination(config, sessionOrigin(session));
  if (!target.ok) return { ok: false, refused: true, reason: target.reason };
  // A device credential is the credential. Nothing to exchange, no
  // expiry to race, and no round trip on the way to a report.
  if (isDeviceSession(session)) {
    return {
      ok: true,
      token: session.deviceToken,
      device: true,
      email: session.email,
      refreshed: false,
    };
  }
  // The refresh token is about to be sent to `session.tokenUrl`, which a
  // pre-fix sign-in inside a hostile repository could have chosen
  // (MACLEOD-616 follow-up, F1). Checked before the cache, so a session
  // already holding a valid access token cannot keep using one either.
  if (!tokenOriginAllowed(session)) {
    return {
      ok: false,
      refused: true,
      reason: 'this session names a sign-in service that is not the one it was issued by, which is '
        + 'what a repository could do before this version. It has not been used. Run `teamflow login` '
        + 'again to replace it, and revoke the old session on the members page.',
    };
  }
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
      reason: token.device
        // A device credential names a seat, not an address, and the
        // admin and organisation routes are the address's.
        ? 'this machine is signed in with a device credential, which names a seat but not a verified address; '
          + 'run `teamflow login` where a browser can be opened for the routes that need one'
        : 'this session has no ID token; sign in again with `teamflow login` so the openid scope is granted',
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
    redirect: 'error',
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
      redirect: 'error',
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 10000)),
    });
    let body;
    try { body = await response.json(); } catch { body = undefined; }
    if (!response.ok || !body?.access_token) {
      // `repository_not_registered` is the one an owner can fix, and
      // the service's own message names the route that fixes it.
      return { ok: false, attempted: true, status: response.status, ...refusalOf(body, `the service refused the OIDC token (${response.status})`) };
    }
    return {
      ok: true, attempted: true, token: body.access_token,
      expiresIn: Number(body.expires_in) || undefined,
      account: body.account, repository: body.repository,
      /*
       * The origin that just minted this token, carried in process and
       * never through config (MACLEOD-616 follow-up).
       *
       * A token is bound to its issuer by construction: sending it back
       * to the service that issued it leaks nothing, whoever named that
       * service. Without this the CI path fell to `ambientDestination`
       * and a self-hosted GitHub Actions run was refused outright —
       * fail-closed, but a regression. It cannot arrive from the
       * environment (`loadConfig` reads no variable for it) or from a
       * repository (`accessTokenOrigin` is in `UNTRUSTED_PROJECT_KEYS`).
       */
      origin: originOf(serviceUrl(config)),
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
  // The header was resolved by `credential()` against this same config,
  // so this cannot currently fire — it is here because the header is a
  // parameter, and a future caller that mints one some other way would
  // otherwise route around the rule (MACLEOD-616). `credentialRefusal`
  // rather than `credentialDestination` so it asks the same question of
  // the same credential, ambient ones included.
  const refused = credentialRefusal(config);
  if (refused) return { ok: false, refused: true, reason: refused };
  let response;
  try {
    response = await fetch(`${serviceUrl(config)}${route}`, {
      method,
      headers: {
        [credentialHeader.header]: credentialHeader.value,
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 10000)),
    });
  } catch (error) {
    return { ok: false, reason: unreachableReason(error, config) };
  }
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  if (!response.ok) {
    return { ok: false, status: response.status, ...refusalOf(body, `the service answered ${response.status}`) };
  }
  return { ok: true, ...body };
}
