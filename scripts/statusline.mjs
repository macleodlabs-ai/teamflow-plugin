// `teamflow statusline` (MACLEOD-932, P1-6): one line for Claude Code's status
// line, tmux or herdr: "TF 2 need you · 7 working".
//
// The number is the dashboard's own: the bundle goes through the page's rules
// (`statusLineFromBundle` in progress-core.mjs, built from src/lib), with what
// agents asked this person added the way the page adds it. So the status line,
// the browser tab "(2) TeamFlow" and Your turn print one number.
//
// A status line runs often, so the line is kept for a minute in the plugin's
// data directory. It never throws and never prints an error: a board it cannot
// read prints nothing, and the status line stays as it was.
import path from 'node:path';
import * as core from './core.mjs';
import { fetchState } from './core.mjs';
import { statusLineFromBundle } from './progress-core.mjs';
import { request as needsRequest } from './needs.mjs';

export const STATUSLINE_USAGE = 'teamflow statusline   one line for a status bar: what needs you and how many agents work';
export const KEEP_MS = 60_000;

const cachePath = () => path.join(core.dataDir(), 'statusline.json');

/** The line from a bundle and what agents asked this person. Pure: the test pins it to the page. */
export function lineFrom(bundle, needs, now) {
  return statusLineFromBundle(bundle, now, { needs: Array.isArray(needs) ? needs : [] });
}

/**
 * Prints the line and returns 0. `ctx.read`, `ctx.needs`, `ctx.now` and
 * `ctx.cache` are for tests; `ctx.cache: false` skips the kept line.
 */
export async function main(_args = [], ctx = {}) {
  const { config = {} } = ctx;
  const print = ctx.print || ((value) => process.stdout.write(value));
  const now = ctx.now ?? Date.now();
  const useCache = ctx.cache !== false;
  if (useCache) {
    const kept = core.readJson(cachePath(), undefined);
    if (kept && typeof kept.line === 'string' && now - Number(kept.at) < KEEP_MS) { print(`${kept.line}\n`); return 0; }
  }
  try {
    const read = ctx.read || fetchState;
    const result = await read('bundle', { ...config, serviceTimeoutMs: Math.max(Number(config.serviceTimeoutMs) || 0, 30000) });
    if (!result.ok || !result.document) return 0;
    const asked = await (ctx.needs || (() => needsRequest('GET', '', undefined, config)))();
    const line = lineFrom(result.document, asked?.ok ? asked.body?.forYou : [], now);
    if (useCache) { try { core.writeJson(cachePath(), { at: now, line }); } catch { /* no data directory: no cache */ } }
    print(`${line}\n`);
  } catch { /* never in the way of the status line */ }
  return 0;
}

export default main;
