// TeamFlow's own MCP server in Claude Code's /mcp list (MACLEOD-637).
//
// The plugin's `.mcp.json` declares `teamflow` as an HTTP server at the
// service's `/mcp`, with a `headersHelper` that runs `mcp-headers.mjs`.
// Claude Code runs the helper on every connect and reconnect (10 s
// limit) and sends whatever JSON object of headers it prints. So /mcp
// gives Reconnect, enable/disable and the tool list for free, and the
// only thing this file decides is which header, if any, to print.
//
// The header is the short-lived access token this machine already
// reports with, minted by the same `accessToken()` call: the device
// authorization's one-hour `dat_`, or, on a machine that still holds a
// browser sign-in, that sign-in's one-hour access token (MACLEOD-757).
// The service's /mcp door accepts exactly what a report is accepted
// with. Never a refresh token, never a `dk_` from before 0.3.24 and
// never an API key (MACLEOD-630).
//
// With nothing to send the header is `{}`, and Claude Code falls
// through to its own OAuth sign-in, which the service serves itself
// (the kit's mcp_oauth.py: dynamic registration, PKCE, rotating refresh
// tokens) -- so /mcp shows Authenticate, as it does for Linear.
//
// Where it goes is decided as for every other credential (MACLEOD-616):
// the URL the plugin itself declares, and only when that URL's origin is
// the one this machine's authorization was issued by and the one the
// refresh would be sent to. A repository's `.teamflow.json` cannot name
// a service at all, and an environment that points elsewhere gets a
// refusal, not a token.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.mjs';
import { credentialDestination, machineId, originOf, serviceUrl } from './core.mjs';

export const MCP_SERVER = 'teamflow';
const DEVICE_ACCESS_PREFIX = 'dat_';
// Under Claude Code's 10 s headersHelper limit with room to spare. Only
// a refresh goes to the network, and only when the cached token is near
// expiry.
const HELPER_TIMEOUT_MS = 7000;
const PROBE_TIMEOUT_MS = 5000;
const LOGIN = 'run /teamflow:login to authorize this machine';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The URL the plugin's own `.mcp.json` declares for `teamflow`. */
export function declaredMcpUrl(root = pluginRoot) {
  try {
    const file = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8'));
    return file?.mcpServers?.[MCP_SERVER]?.url;
  } catch {
    return undefined;
  }
}

function sameUrl(value) {
  try {
    const parsed = new URL(String(value));
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
  } catch {
    return undefined;
  }
}

/**
 * The headers Claude Code should connect with: `{ headers, reason }`.
 * `headers` is `{}` whenever no token may be sent, and `reason` then says
 * why in words a person can act on. Never throws.
 */
export async function mcpHeaders(config = {}, { url = declaredMcpUrl(), announced, mint = true } = {}) {
  const refuse = (reason) => ({ headers: {}, ok: false, reason });
  const target = originOf(url);
  if (!target) return refuse('the plugin declares no TeamFlow MCP url; reinstall the plugin');
  // Claude Code names the server it is about to dial. If that is not the
  // url the plugin declares, somebody else's configuration is running
  // this helper, and the token is not theirs to have.
  if (announced && sameUrl(announced) !== sameUrl(url)) {
    return refuse(`this helper sends TeamFlow's token only to ${url}, not to ${announced}`);
  }
  const session = auth.readSession();
  if (!session) return refuse(`this machine is not authorized; choose Authenticate for teamflow in /mcp, or ${LOGIN}`);
  const device = auth.isDeviceSession(session);
  const bound = auth.sessionOrigin(session);
  const destination = credentialDestination({ serviceUrl: target }, bound);
  if (!destination.ok) return refuse(destination.reason);
  if (target !== bound) {
    return refuse(`this machine holds an authorization issued by ${bound}, and the MCP server is at `
      + `${target}; TeamFlow did not send the token there`);
  }
  // The refresh goes to `serviceUrl(config)`. That must be the same
  // origin, or a token minted by one service would be handed to another.
  const service = originOf(serviceUrl(config));
  if (service !== target) {
    return refuse(`TeamFlow is configured for ${service}, and the MCP server is at ${target}; `
      + 'the token was not sent there');
  }
  // `status` asks whether a header could be printed without minting one.
  if (!mint) return { headers: {}, ok: true, device };
  const token = await auth.accessToken({ ...config, serviceTimeoutMs: HELPER_TIMEOUT_MS });
  if (!token.ok) return refuse(token.reason || 'could not read this machine\'s authorization');
  if (!device) {
    // A browser sign-in: its access token, refreshed by `accessToken()`
    // as a report's is. The machine id rule is the device's, so no
    // X-Machine-Id rides with a person's token.
    return { headers: { Authorization: `Bearer ${token.token}` }, ok: true, device };
  }
  if (!String(token.token || '').startsWith(DEVICE_ACCESS_PREFIX)) {
    // A `dk_` that has not migrated yet. The MCP door refuses keys, and
    // the next report migrates it.
    return refuse('this machine still holds a device key from before plugin 0.3.24; it switches to '
      + `short-lived tokens on its next report, or ${LOGIN}`);
  }
  // The same random machine id a report carries, so the service's
  // one-machine rule on a device credential (MACLEOD-620) holds over MCP
  // as it does over REST. An identifier, not content.
  const machine = machineId();
  return {
    headers: { Authorization: `Bearer ${token.token}`, ...(machine ? { 'X-Machine-Id': machine } : {}) },
    ok: true,
    device,
  };
}

// Addressed with serviceUrl(config) like every other request the plugin
// makes (credential-route.test.mjs). `mcpHeaders` has already required
// the declared url to be on that origin, so only its path is taken.
async function rpc(config, url, headers, body) {
  const route = new URL(url).pathname;
  const response = await fetch(`${serviceUrl(config)}${route}`, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const text = await response.text();
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    // Streamable HTTP may answer as an event stream: the JSON is the
    // last `data:` line.
    const data = text.split('\n').filter((line) => line.startsWith('data:')).at(-1);
    try { message = data ? JSON.parse(data.slice(5)) : undefined; } catch { message = undefined; }
  }
  return { status: response.status, ok: response.ok, message, session: response.headers.get('mcp-session-id') };
}

/**
 * What `teamflow doctor` says about the MCP connection: authorized,
 * reachable, and how many tools it offers. Uses exactly the header the
 * helper would print, so a green line here is a connection /mcp can make.
 */
export async function mcpStatus(config = {}, { url = declaredMcpUrl() } = {}) {
  const base = { server: MCP_SERVER, url: url || 'not declared' };
  const headers = await mcpHeaders(config, { url });
  if (!headers.ok) return { ...base, ok: false, authorized: false, reason: headers.reason };
  try {
    const init = await rpc(config, url,headers.headers, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'teamflow-doctor', version: '1' } },
    });
    if (init.status === 401 || init.status === 403) {
      return {
        ...base, ok: false, authorized: false, reachable: true,
        reason: `the MCP server answered ${init.status} to this machine's token; ${LOGIN} again, `
          + 'or check on the Organisation page that nobody revoked the device',
      };
    }
    if (!init.ok || !init.message?.result) {
      return { ...base, ok: false, authorized: true, reachable: true, reason: `the MCP server answered ${init.status}` };
    }
    const follow = { ...headers.headers, ...(init.session ? { 'Mcp-Session-Id': init.session } : {}) };
    const listed = await rpc(config, url,follow, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = listed.message?.result?.tools;
    if (!Array.isArray(tools)) {
      return { ...base, ok: false, authorized: true, reachable: true, reason: `tools/list answered ${listed.status}` };
    }
    return { ...base, ok: true, authorized: true, reachable: true, tools: tools.length };
  } catch (error) {
    return { ...base, ok: false, authorized: true, reachable: false, reason: `could not reach ${url}: ${error.message}` };
  }
}

/** What `teamflow status` says, from local state only: no token is minted. */
export async function mcpReadinessLine(config = {}, { url = declaredMcpUrl() } = {}) {
  const ready = await mcpHeaders(config, { url, mint: false });
  const by = ready.device ? 'this machine\'s device authorization' : 'this machine\'s browser sign-in';
  return ready.ok
    ? `${MCP_SERVER} authorized by ${by}; /mcp to reconnect or disable it, /teamflow:doctor to test it`
    : `${MCP_SERVER} not connected: ${ready.reason}`;
}

/** The one line doctor prints. */
export function mcpStatusLine(status) {
  if (status.ok) return `${status.server} connected at ${status.url}, ${status.tools} tools; manage it in /mcp`;
  return `${status.server} not connected: ${status.reason}`;
}
