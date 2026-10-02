// The TeamFlow mod (MACLEOD-941): on by default (owner, 2026-10-02),
// installed with the plugin, and TeamFlow works the same without it.
//
// Claude Code mods (Claude Code v2.1.287 and later,
// https://code.claude.com/docs/en/plugins/mods/overview) draw inside
// Claude Code: a band above the prompt and panes. The mod itself is
// `plugin/hooks/teamflow-mod.mjs`. It has no Node.js of its own, so it
// draws only what this file prints: `teamflow mod snapshot` runs here,
// reads the board and the tracks on this machine, and prints JSON.
//
// What the mod shows:
//   - one line above the prompt: this session's track and its state, and
//     the page's own "N need you" count (the status line's words);
//   - a pane (`/teamflow-turn`): your tracks and Your turn, each item
//     with a link to its card in TeamFlow.
//
// What it does not do. It never answers a question. An answer from
// TeamFlow must come from a signed-in person (session_answers.py,
// `check_person`), and this machine holds only its device credential,
// which may never answer. So the pane hands each item off to the app,
// where the person is signed in. The session's own questions are
// answered where Claude Code asks them, as always.
//
// What it reads stays here: the tracks are grouped on this machine
// (tracks.mjs) and nothing new is reported. Nothing received is ever
// passed to a shell: the mod runs one fixed command, this one.
import path from 'node:path';
import * as core from './core.mjs';
import { fetchState } from './core.mjs';
import { statusLineFromBundle, turnFromBundle } from './progress-core.mjs';
import { request as needsRequest } from './needs.mjs';
import { readTracks, reportable } from './tracks.mjs';

export const MOD_USAGE = 'Usage: teamflow mod on|off|status';
export const KEEP_MS = 60_000;
export const ROWS_MAX = 20;
const SESSION = /^[A-Za-z0-9_-]{1,80}$/;
const STATE_WORDS = { active: 'working', quiet: 'quiet', ended: 'done' };

// --- the switch: on unless this person turned it off (owner, 2026-10-02) --

export function modSwitch() {
  return { on: core.readJson(core.globalConfigPath(), {})?.mod?.on !== false };
}

export function setMod(value) {
  if (value !== 'on' && value !== 'off') throw new Error(MOD_USAGE);
  const file = core.globalConfigPath();
  const next = { ...(core.readJson(file, {}) || {}), mod: { on: value === 'on' } };
  core.writeJson(file, next);
  return modSwitch();
}

export function modLine(held = modSwitch()) {
  return held.on
    ? 'on (the default). Claude Code shows your track and what needs you above the prompt. Type /teamflow-turn to see Your turn. `teamflow mod off` turns it off.'
    : 'off. `teamflow mod on` shows your track and Your turn inside Claude Code.';
}

// --- what the mod draws ---------------------------------------------------

const trackRow = (t) => ({
  id: t.id,
  name: t.name,
  state: STATE_WORDS[t.state] || 'quiet',
  threads: (t.members || []).length,
  keys: (t.keys || []).slice(0, 5),
});

/** This person's tracks on this machine, live ones first, and the one this session is in. */
export function tracksFor(held, sessionId) {
  const all = Object.values(held?.tracks || {}).filter((t) => reportable(t) && t.state !== 'ended');
  all.sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')));
  const mine = sessionId ? all.find((t) => (t.members || []).includes(sessionId)) : undefined;
  return { track: mine ? trackRow(mine) : undefined, tracks: all.slice(0, ROWS_MAX).map(trackRow) };
}

/** The line above the prompt: the status line's words with this session's track before them. */
export function bandLine(track, base) {
  if (!track) return base || '';
  const mine = `TF ${track.name}, ${track.state}`;
  return base ? base.replace(/^TF /, `${mine} · `) : mine;
}

const cachePath = () => path.join(core.dataDir(), 'mod.json');

/** The board's part: the status line and Your turn, kept a minute so many sessions read the board once. */
async function boardPart(config, ctx, now) {
  if (ctx.cache !== false) {
    const kept = core.readJson(cachePath(), undefined);
    if (kept && now - Number(kept.at) < KEEP_MS && kept.turn) return kept;
  }
  const read = ctx.read || fetchState;
  const result = await read('bundle', { ...config, serviceTimeoutMs: Math.max(Number(config.serviceTimeoutMs) || 0, 30000) });
  if (!result?.ok || !result.document) return undefined;
  const asked = await (ctx.needs || (() => needsRequest('GET', '', undefined, config)))();
  const extra = { needs: asked?.ok && Array.isArray(asked.body?.forYou) ? asked.body.forYou : [] };
  const app = `${core.serviceUrl(config)}/app/`;
  const turn = turnFromBundle(result.document, now, extra);
  const part = {
    at: now,
    base: statusLineFromBundle(result.document, now, extra),
    turn: {
      count: turn.count,
      headline: turn.headline,
      rows: turn.rows.slice(0, ROWS_MAX).map((row) => ({
        word: row.word,
        key: row.key,
        sentence: row.sentence,
        link: row.key ? `${app}#delivery?issue=${encodeURIComponent(row.key)}` : app,
      })),
    },
    app,
  };
  if (ctx.cache !== false) { try { core.writeJson(cachePath(), part); } catch { /* no data directory: no cache */ } }
  return part;
}

/**
 * What the mod draws, as JSON. Off: `{on: false}` and nothing is read.
 * `ctx.read`, `ctx.needs`, `ctx.held`, `ctx.now` and `ctx.cache` are for tests.
 */
export async function snapshot({ sessionId, config = {} } = {}, ctx = {}) {
  if (!(ctx.on ?? modSwitch().on)) return { on: false };
  const now = ctx.now ?? Date.now();
  const id = typeof sessionId === 'string' && SESSION.test(sessionId) ? sessionId : undefined;
  const { track, tracks } = tracksFor(ctx.held || readTracks(config), id);
  let board;
  try { board = await boardPart(config, ctx, now); } catch { board = undefined; }
  return {
    on: true,
    line: bandLine(track, board?.base),
    track,
    tracks,
    turn: board?.turn,
    app: board?.app || `${core.serviceUrl(config)}/app/`,
    offline: !board,
  };
}

/** `teamflow mod on|off|status|snapshot [--session <id>]`. Returns the exit code. */
export async function modMain(args = [], { config = {}, print = console.log, ctx = {} } = {}) {
  const [verb = 'status'] = args;
  if (verb === 'snapshot') {
    const at = args.indexOf('--session');
    try {
      print(JSON.stringify(await snapshot({ sessionId: at >= 0 ? args[at + 1] : undefined, config }, ctx)));
    } catch {
      print(JSON.stringify({ on: false }));
    }
    return 0;
  }
  if (verb === 'on' || verb === 'off') {
    const held = setMod(verb);
    print(held.on
      ? 'TeamFlow will show your track and Your turn inside Claude Code. Start a new session or type /reload-plugins.'
      : 'TeamFlow will not draw inside Claude Code. Start a new session or type /reload-plugins.');
  } else if (verb !== 'status') {
    print(MOD_USAGE);
    return 1;
  }
  print(`Mod: ${modLine()}`);
  return 0;
}
