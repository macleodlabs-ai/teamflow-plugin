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
// What the mod shows (MACLEOD-953):
//   - one line above the prompt: this session's ticket and its gate, the
//     last check, its plan's progress, the agents' marks and the Your turn
//     count, shrunk to the width;
//   - a pane (`/teamflow-turn`) with five tabs: Your turn with each
//     question and its options, Plans and tracks, Agents, This ticket and
//     Lately (the receipt line).
// Every number comes from `modFromBundle` in progress-core.mjs, which is
// the app's own code, so the terminal and the page cannot disagree.
//
// What it answers (MACLEOD-954, the owner, 2026-10-02: "We should allow
// [the computer's login to answer], so that the mod etc can work", and
// "Actually allow permissions too. We shouldn't have to switch context."):
// a question with options, an approval, a check and a tool permission,
// for this computer's own person only. A press runs `teamflow needs
// answer` (needs.mjs) as an argument list; the service checks that the
// card or session is this person's, never answers the session the
// command runs in, and History says "from Claude Code on <machine>".
// Free-text answers stay links into the app. It never closes, cancels or
// reopens: those are links too. The session's own questions are answered
// where Claude Code asks them, so the pane leaves them out.
//
// What it reads stays here: the tracks are grouped on this machine
// (tracks.mjs) and nothing new is reported. Nothing received is ever
// passed to a shell: the mod runs one fixed command, this one.
import path from 'node:path';
import * as core from './core.mjs';
import { fetchState, serviceUrl } from './core.mjs';
import { modFromBundle, statusLineFromBundle } from './progress-core.mjs';
import { request as needsRequest } from './needs.mjs';
import { readTracks, reportable } from './tracks.mjs';
import { bandText } from '../hooks/teamflow-mod.mjs';

export const MOD_USAGE = 'Usage: teamflow mod on|off|status';
/** How long one board read serves every session on this machine. The mod asks every 30 s. */
export const KEEP_MS = 45_000;
export const ROWS_MAX = 20;
const SESSION = /^[A-Za-z0-9_-]{1,80}$/;
const STATE_WORDS = { active: 'working', quiet: 'quiet', ended: 'done' };
const CACHE_VERSION = 3;
const DAY_MS = 24 * 60 * 60_000;

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
    ? 'on (the default). Claude Code shows your ticket, your plan, the agents and what needs you above the prompt. Type /teamflow-turn to see more. `teamflow mod off` turns it off.'
    : 'off. `teamflow mod on` shows your ticket, your plan and Your turn inside Claude Code.';
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

/** The status line's words with this session's track before them: the line an older mod draws. */
export function bandLine(track, base) {
  if (!track) return base || '';
  const mine = `TF ${track.name}, ${track.state}`;
  return base ? base.replace(/^TF /, `${mine} · `) : mine;
}

/** What this session's own state file says: its bound key and when it last reported. */
export function sessionFacts(sessionId) {
  if (!sessionId) return {};
  const state = core.readJson(core.sessionPath(sessionId), undefined) || {};
  const key = typeof state.binding?.key === 'string' ? state.binding.key : undefined;
  const reportedAt = Number(state.lastPublishedAt) || 0;
  return { ...(key ? { key } : {}), reportedAt };
}

/** One cache per ticket, so two sessions on two tickets each keep their own. */
const cachePath = (key) => path.join(core.dataDir(), key ? `mod-${core.digest(key)}.json` : 'mod.json');

/**
 * The board's part, kept 45 s so many sessions read the board once. A
 * report this session sent after the kept read makes it read again: the
 * line shows the session's own move at once.
 */
async function boardPart(config, ctx, now, { key, session, reportedAt = 0, fresh = false }) {
  const file = cachePath(key);
  if (ctx.cache !== false && !fresh) {
    const kept = core.readJson(file, undefined);
    if (kept?.v === CACHE_VERSION && now - Number(kept.at) < KEEP_MS && !(reportedAt > Number(kept.at))) return kept;
  }
  const read = ctx.read || fetchState;
  const result = await read('bundle', { ...config, serviceTimeoutMs: Math.max(Number(config.serviceTimeoutMs) || 0, 30000) });
  if (!result?.ok || !result.document) return undefined;
  const asked = await (ctx.needs || (() => needsRequest('GET', '', undefined, config)))();
  const extra = { needs: asked?.ok && Array.isArray(asked.body?.forYou) ? asked.body.forYou : [] };
  const waiting = await (ctx.asks || (() => readAsks(config)))();
  const app = `${core.serviceUrl(config)}/app/`;
  const card = (k) => `${app}#delivery?issue=${encodeURIComponent(k)}`;
  const model = modFromBundle(result.document, now, { ...extra, key, ...(session ? { session } : {}), since: now - DAY_MS });
  const part = {
    v: CACHE_VERSION,
    at: now,
    base: statusLineFromBundle(result.document, now, extra),
    turn: {
      count: model.count,
      headline: model.headline,
      rows: model.rows.slice(0, ROWS_MAX).map((row) => ({
        word: row.word,
        key: row.key,
        sentence: row.sentence,
        ...(row.question ? { question: row.question } : {}),
        link: row.key ? card(row.key) : app,
      })),
    },
    asks: askRows(waiting),
    plans: model.plans.slice(0, ROWS_MAX),
    agents: model.agents,
    ...(model.ticket ? { ticket: model.ticket } : {}),
    receipt: model.receipt,
    app,
  };
  if (ctx.cache !== false) { try { core.writeJson(file, part); } catch { /* no data directory: no cache */ } }
  return part;
}

/**
 * The questions this person's agents wait on (`GET /v1/members/asks`): the
 * service gives a machine only its own person's. Never throws.
 */
async function readAsks(config) {
  const cred = await core.credential(config);
  if (!cred) return [];
  try {
    const response = await fetch(`${serviceUrl(config)}/v1/members/asks`, {
      headers: { [cred.header]: cred.value },
      redirect: 'error',
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 5000)),
    });
    if (!response.ok) return [];
    const body = await response.json();
    return Array.isArray(body?.asks) ? body.asks : [];
  } catch { return []; }
}

/** The fields of a waiting question the pane draws: words, never a tool's input. */
export function askRows(asks = []) {
  return (Array.isArray(asks) ? asks : []).slice(0, ROWS_MAX).map((a) => ({
    session: String(a.session || ''),
    askId: String(a.askId || ''),
    kind: String(a.asks || ''),
    text: String(a.text || ''),
    options: Array.isArray(a.options) ? a.options.map(String) : [],
    questions: Number(a.questions) || 1,
    ...(a.tool ? { tool: String(a.tool) } : {}),
    ...(a.key ? { key: String(a.key) } : {}),
    agent: String(a.agent || 'main'),
  }));
}

/**
 * What the mod draws, as JSON. Off: `{on: false}` and nothing is read.
 * `ctx.read`, `ctx.needs`, `ctx.held`, `ctx.now`, `ctx.cache` and `ctx.facts` are for tests.
 */
export async function snapshot({ sessionId, config = {}, fresh = false } = {}, ctx = {}) {
  if (!(ctx.on ?? modSwitch().on)) return { on: false };
  const now = ctx.now ?? Date.now();
  const id = typeof sessionId === 'string' && SESSION.test(sessionId) ? sessionId : undefined;
  const { track, tracks } = tracksFor(ctx.held || readTracks(config), id);
  const facts = ctx.facts ?? sessionFacts(id);
  let board;
  try {
    board = await boardPart(config, ctx, now, { key: facts.key, session: id ? core.digest(id) : undefined, reportedAt: facts.reportedAt, fresh });
  } catch { board = undefined; }
  const snap = {
    on: true,
    track,
    tracks,
    turn: board?.turn,
    /* This session's own questions are answered where Claude Code asks them. */
    asks: (board?.asks || []).filter((a) => !id || a.session !== core.digest(id)),
    plans: board?.plans || [],
    agents: board?.agents,
    ...(board?.ticket ? { ticket: board.ticket } : {}),
    receipt: board?.receipt,
    app: board?.app || `${core.serviceUrl(config)}/app/`,
    offline: !board,
  };
  /* `line` is for a mod from before MACLEOD-953, which draws it as it is: fitted to 120 columns. */
  return { ...snap, line: board ? bandText(snap, 120) : bandLine(track, undefined) };
}

/** `teamflow mod on|off|status|snapshot [--session <id>]`. Returns the exit code. */
export async function modMain(args = [], { config = {}, print = console.log, ctx = {} } = {}) {
  const [verb = 'status'] = args;
  if (verb === 'snapshot') {
    const at = args.indexOf('--session');
    try {
      print(JSON.stringify(await snapshot({ sessionId: at >= 0 ? args[at + 1] : undefined, config, fresh: args.includes('--fresh') }, ctx)));
    } catch {
      print(JSON.stringify({ on: false }));
    }
    return 0;
  }
  if (verb === 'on' || verb === 'off') {
    const held = setMod(verb);
    print(held.on
      ? 'TeamFlow will show your ticket, your plan and Your turn inside Claude Code. Start a new session or type /reload-plugins.'
      : 'TeamFlow will not draw inside Claude Code. Start a new session or type /reload-plugins.');
  } else if (verb !== 'status') {
    print(MOD_USAGE);
    return 1;
  }
  print(`Mod: ${modLine()}`);
  return 0;
}
