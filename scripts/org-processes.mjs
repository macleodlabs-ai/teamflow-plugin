// The organisation's saved processes, read from the service (MACLEOD-968).
//
// The owner: "Allow for saving sdlc's. And respecting them." The service
// keeps them in the organisation's settings and answers
// `GET /v1/members/processes`; a plan names one, else the organisation's
// default applies. Read the way check-presets.mjs reads the pipeline: the
// same credential, a short timeout, and never an error. The answer is
// cached in the plugin's own data folder, per organisation, and asked for
// again at most hourly, or whenever a run is created or applied.
//
// A process is data: a name and two choices from closed sets. Nothing in
// the answer is ever run or written anywhere as a command; process.mjs
// cleans every entry before anything here keeps it.

import fs from 'node:fs';
import path from 'node:path';
import { credential, dataDir, reportScope, serviceUrl } from './core.mjs';
import { cleanProcess } from './process.mjs';

export const REFRESH_MS = 60 * 60 * 1000;
const FILE = 'processes.json';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/** Only what the plugin reads: the default's id and the cleaned processes. */
export function keepServed(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.processes)) return undefined;
  const processes = body.processes.map((raw) => cleanProcess(raw).process).filter(Boolean)
    .map(({ id, name, tdd, audit }) => ({ id, name, tdd, audit }));
  const out = { processes };
  if (typeof body.default === 'string') out.default = body.default.slice(0, 32);
  if (Number.isInteger(body.version)) out.version = body.version;
  return out;
}

/** `GET /v1/members/processes`, cleaned. Undefined when it cannot be asked or answered. */
export async function fetchProcesses(config = {}, timeoutMs) {
  try {
    const cred = await credential(config);
    if (!cred) return undefined;
    const response = await fetch(`${serviceUrl(config)}/v1/members/processes`, {
      headers: { [cred.header]: cred.value },
      redirect: 'error',
      signal: AbortSignal.timeout(Number(timeoutMs || config.serviceTimeoutMs || 5000)),
    });
    if (!response.ok) return undefined;
    return keepServed(await response.json());
  } catch {
    return undefined;
  }
}

/**
 * The organisation's processes as last read: fresh from the service when
 * the cache is over an hour old or `force` asks, else the cache. When the
 * service cannot answer, the cache of any age; with none, undefined, which
 * process.mjs reads as the built-in ones with Standard the default.
 * Never throws.
 */
export async function orgProcesses({
  config = {}, dir, now = Date.now(), force = false, load = fetchProcesses,
} = {}) {
  let file;
  let cache = {};
  let scope;
  try {
    file = path.join(dir || dataDir(), FILE);
    cache = readJson(file) || {};
    scope = reportScope(config);
  } catch {
    return undefined;
  }
  const held = cache[scope];
  const fresh = held && Number.isFinite(held.at) && now - held.at < REFRESH_MS;
  if (fresh && !force) return held.served;
  let served;
  try { served = keepServed(await load(config, 3000)); } catch { served = undefined; }
  if (!served) return held?.served;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...cache, [scope]: { at: now, served } }));
  } catch { /* read again next time */ }
  return served;
}
