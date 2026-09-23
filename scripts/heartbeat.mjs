#!/usr/bin/env node
// The live heartbeat (MACLEOD-641).
//
// One small background process per Claude Code session. Every two
// minutes it tells the service the session is alive, which ticket it is
// on, and which of its agents are working on what. When the session's
// own process disappears without a SessionEnd, it says so once and
// exits. The service turns missing beats into hangs, stalls, crashes and
// orphans; this file only reports.
//
// What a beat carries is derived state and nothing else: a digest of the
// session id, issue keys, stage and status words, agent ids and names,
// and times. Never a prompt, a path, a command or any text the work
// produced. The payload is built field by field below, so nothing else
// can ride along.
//
// The hook starts it (`ensureHeartbeat`) and stops it (`stopHeartbeat`).
// Both are file operations and one `kill(pid, 0)`, cheap enough for the
// fast events. The process itself is detached, has no shell, ignores its
// stdio and is unref'd, so it never holds the tool or the hook open. It
// fails open: an error skips one beat and never ends the loop.
import fs from 'node:fs';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import * as core from './core.mjs';
import { sentence } from './words.mjs';

export const BEAT_MS = 120_000;
// How often the process looks at the session and the stop mark between
// beats. A `kill(pid, 0)` and an `existsSync`; no disk writes.
export const POLL_MS = 5_000;
// Never runs forever, whatever the session does.
export const MAX_LIFE_MS = 24 * 60 * 60 * 1000;
export const AGENTS_MAX = 50;
// A claim to start the process older than this was left by a hook that
// died mid-start.
const CLAIM_STALE_MS = 10_000;
// A hand-off mark is believed this long (the service's grace, too).
export const HANDOFF_FRESH_MS = 10 * 60 * 1000;
// Claude's usage window: the reset time when the event gives none.
export const PAUSE_DEFAULT_MS = 5 * 60 * 60 * 1000;
// A pause is never carried longer than this, whatever it said.
const PAUSE_MAX_MS = 24 * 60 * 60 * 1000;
// StopFailure `error_type` values that stop the work until a limit
// resets (Claude Code hooks reference), and the word a beat carries.
const LIMITS = { rate_limit: 'rate_limit', billing_error: 'billing' };
// How long after a reset the heartbeat looks again, if nothing happened.
export const CHECK_BACK_MS = 2 * 60 * 1000;
// One delivery round's network budget: never more than a beat's worth.
const ROUND_MS = 3_000;

const SCRIPT = fileURLToPath(import.meta.url);

// The service's vocabularies (adapters/teamflow/schema.py STAGES and
// WORK_STATUS). A value outside them is left off the beat rather than
// sent, because one bad field refuses the whole report.
const STAGES = new Set([
  'BACKLOG', 'LOCAL_DEV', 'LOCAL_TEST', 'LOCAL_AUDIT', 'LOCAL_REWORK',
  'MERGE', 'CI_BUILD', 'DEPLOY_DEV', 'DEV_TEST', 'DEV_AUDIT',
  'DEV_REWORK', 'DEV_VERIFIED', 'DONE',
]);
const STATUSES = new Set(['running', 'success', 'waiting', 'blocked', 'failed', 'idle']);
// schema.py `_is_key`: a Jira/Linear-shaped key or `repo#123`.
const KEY = /^(?:[A-Za-z][A-Za-z0-9]{0,19}-[0-9]{1,9}|[A-Za-z0-9][A-Za-z0-9._-]{0,63}#[0-9]{1,9})$/;
// schema.py `_agent_id`: at most 80 characters, no path separator, and
// `root:` followed only by a hex digest.
const ROOT_DIGEST = /^[0-9a-f]{8,64}$/;

export function keyOf(value) {
  return typeof value === 'string' && !value.includes('..') && KEY.test(value) ? value : undefined;
}

function agentIdOk(id) {
  if (typeof id !== 'string' || !id || id.length > 80 || /[/\\]/.test(id)) return false;
  return id.startsWith('root:') ? ROOT_DIGEST.test(id.slice(5)) : true;
}

function isoOf(value) {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

/** Where one session's heartbeat keeps its pid. Named by a digest, never the raw id. */
export function heartbeatPath(sessionId) {
  return path.join(core.dataDir(), 'heartbeats', `${core.digest(sessionId)}.json`);
}

/** The mark the hook leaves on SessionEnd. Its own file, so the process's writes never erase it. */
export function endMarkPath(sessionId) {
  return heartbeatPath(sessionId).replace(/\.json$/, '.end');
}

/** The mark a limit leaves: this session may be moving to another account. */
export function handoffMarkPath(sessionId) {
  return heartbeatPath(sessionId).replace(/\.json$/, '.handoff');
}

/** The pause a limit leaves while the session waits for it to reset. */
export function pausePath(sessionId) {
  return heartbeatPath(sessionId).replace(/\.json$/, '.pause');
}

/**
 * What a StopFailure says about a usage limit (MACLEOD-641), or
 * undefined. Claude Code's payload names the error in `error_type` and,
 * for a rate limit, the reset in `rate_limit_reset_time` (Unix seconds).
 * No reset time: Claude's five-hour window from now, marked estimated.
 */
export function limitOf(input = {}, now = Date.now()) {
  const reason = LIMITS[String(input.error_type || '')];
  if (!reason) return undefined;
  const reset = Number(input.rate_limit_reset_time) * 1000;
  const known = Number.isFinite(reset) && reset > now && reset - now <= PAUSE_MAX_MS;
  return { reason, until: new Date(known ? reset : now + PAUSE_DEFAULT_MS).toISOString(), estimated: !known };
}

/**
 * cc-rotate's own signal, for a hand-off whose StopFailure hook raced
 * this one: it runs with CC_ROTATE_ACTIVE=1 and touches
 * `<pidfile>.rotate` just before it stops Claude Code.
 */
export function rotating(env = process.env) {
  return env.CC_ROTATE_ACTIVE === '1' && Boolean(env.CC_ROTATE_PIDFILE)
    && fs.existsSync(`${env.CC_ROTATE_PIDFILE}.rotate`);
}

/** A hand-off mark: this session may be moving to another account. */
export function markHandoff(sessionId, now = Date.now()) {
  if (!sessionId || sessionId === 'unknown-session') return false;
  const file = handoffMarkPath(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, new Date(now).toISOString());
  return true;
}

/**
 * The hook's half of a limit. Leaves the pause (the process may wait
 * for the reset) and the hand-off mark (a tool may move the work to
 * another account). The heartbeat reads which one it was. Files only.
 */
export function markLimit(sessionId, limit, now = Date.now()) {
  if (!limit || !markHandoff(sessionId, now)) return false;
  core.writeJson(pausePath(sessionId), { ...limit, at: new Date(now).toISOString() });
  return true;
}

/** The session carried on here: it no longer waits, and with `handoff` it is not moving either. */
export function clearPause(sessionId, { handoff = false } = {}) {
  if (!sessionId) return;
  fs.rmSync(pausePath(sessionId), { force: true });
  if (handoff) fs.rmSync(handoffMarkPath(sessionId), { force: true });
}

/** Whether the session is moving to another account: a fresh mark, or cc-rotate's signal. */
export function handingOff(sessionId, { now = Date.now(), env = process.env } = {}) {
  if (rotating(env)) return true;
  let at;
  try { at = Date.parse(fs.readFileSync(handoffMarkPath(sessionId), 'utf8')); } catch { return false; }
  return now - at < HANDOFF_FRESH_MS;
}

/** The pause a beat carries, or undefined. */
export function pauseOf(sessionId, now = Date.now()) {
  const held = core.readJson(pausePath(sessionId));
  const until = isoOf(held?.until);
  const since = Date.parse(held?.at || '');
  if (!until || !Object.values(LIMITS).includes(held.reason) || !(now - since < PAUSE_MAX_MS)) return undefined;
  return { reason: held.reason, until, estimated: held.estimated !== false };
}

/**
 * A desktop notice, for a session nothing else can reach (MACLEOD-641).
 * The plugin's own fixed words and a checked key, never text from the
 * service. `execFile` with no shell: macOS `osascript`, Linux
 * `notify-send`, nothing elsewhere. Fails silently.
 */
export function notifyDesktop(key, { platform = process.platform, run = execFile } = {}) {
  const who = keyOf(key) ? `${key} is waiting` : 'Claude Code is waiting';
  const text = [who, 'The usage limit has reset', 'Type continue in Claude Code'].map(sentence).join(' ');
  const args = platform === 'darwin'
    ? ['osascript', ['-e', `display notification "${text}" with title "TeamFlow"`]]
    : platform === 'linux' ? ['notify-send', ['TeamFlow', text]] : undefined;
  if (!args) return false;
  try { run(args[0], args[1], { timeout: 2000, shell: false }, () => {}); } catch { return false; }
  return true;
}

/**
 * What the hooks do on `Stop`, from the heartbeat (MACLEOD-641): the
 * actions queued for this machine, through intake.mjs and its done-marks
 * exactly as a hook runs them, and the plan's own gate deadlines, with no
 * reads. A session sitting at its prompt fires no hooks, so without this
 * nothing left for it would arrive. One request when nothing is queued.
 */
export async function deliverRound(sessionId, { cwd = process.cwd(), intake, heal } = {}) {
  const config = core.loadConfig(cwd);
  const { intakePass } = intake ?? await import('./intake.mjs');
  const { budgetUntil, tick } = heal ?? await import('./selfheal.mjs');
  const budget = budgetUntil(ROUND_MS);
  const state = core.readJson(core.sessionPath(sessionId));
  const bound = keyOf(state?.binding?.key);
  // Another session that holds the card runs its actions; here they wait.
  const key = bound && holdsKey(sessionId, bound) ? bound : undefined;
  const got = await intakePass(config, { key, cwd, budget });
  const healed = await tick(config, { budget, reads: 0 }).catch(() => ({ lines: [] }));
  const mine = got.performed.filter((row) => key && row.key === key).map(({ key: _key, ...row }) => row);
  const heard = [...got.notices, ...healed.lines];
  if (state && (mine.length || heard.length)) {
    // Said at the session's next prompt, like a hook's round.
    const fresh = core.readJson(core.sessionPath(sessionId)) ?? state;
    if (mine.length) fresh.actions = [...(fresh.actions || []), ...mine].slice(-16);
    if (heard.length) fresh.intakePending = [...(fresh.intakePending || []), ...heard].slice(-8);
    core.saveSession(fresh);
  }
  return { performed: got.performed.length, heard: heard.length };
}

/**
 * The check-back after a usage limit resets, once per pause: if no event
 * has come since (the pause is still here), run a delivery round and put
 * a desktop notice on the screen. Returns true when it ran. Its mark is
 * in the pause file, so a restarted heartbeat does not run it twice.
 */
export async function checkBack(sessionId, { now = Date.now(), deliver = deliverRound, notify = notifyDesktop, cwd } = {}) {
  const held = core.readJson(pausePath(sessionId));
  const paused = pauseOf(sessionId, now);
  if (!paused || held.checkedAt || now < Date.parse(paused.until) + CHECK_BACK_MS) return false;
  core.writeJson(pausePath(sessionId), { ...held, checkedAt: new Date(now).toISOString() });
  try { await deliver(sessionId, { cwd }); } catch { /* the service asks again after its own wait */ }
  notify(core.readJson(core.sessionPath(sessionId))?.binding?.key);
  return true;
}

// --- several sessions on one project (MACLEOD-641) ---------------------

/** Which repository, as a digest of its name: the same on every machine, never a path. */
export function repoDigest(cwd, { info = core.gitInfo } = {}) {
  const repository = info(cwd)?.repository;
  return repository ? core.digest(repository) : undefined;
}

/** The reply's word on other sessions, checked field by field before it is kept. */
export function othersOf(result) {
  const others = (Array.isArray(result?.others) ? result.others : [])
    .filter((o) => keyOf(o?.key))
    .map((o) => ({ key: o.key, who: String(o.who || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64), since: isoOf(o.since) }))
    .slice(0, 10);
  const holds = (Array.isArray(result?.holds) ? result.holds : []).filter(keyOf).slice(0, 20);
  return { others, holds };
}

/**
 * Whether this session runs the queued actions for `key`. The service
 * says which session holds each card; before it has said, the newest
 * live session on this machine bound to the key does. So an action for
 * a card two sessions work on runs in one of them, never both.
 */
export function holdsKey(sessionId, key, { alive = isAlive } = {}) {
  if (!key) return false;
  const held = core.readJson(heartbeatPath(sessionId));
  if (Array.isArray(held?.holds)) return held.holds.includes(key);
  const dir = path.dirname(heartbeatPath(sessionId));
  let newest;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* no heartbeats yet */ }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const one = core.readJson(path.join(dir, name));
    if (one?.key !== key || one.endedReason || !alive(one.watchPid)) continue;
    if (!newest || String(one.startedAt) > String(newest.one.startedAt)) newest = { name, one };
  }
  return !newest || newest.name === path.basename(heartbeatPath(sessionId));
}

function saidPath(sessionId) {
  return heartbeatPath(sessionId).replace(/\.json$/, '.said.json');
}

/**
 * What the session is told about other sessions, at SessionStart and
 * at a prompt (MACLEOD-641), each fact once. File reads only. Never a
 * reason to stop: the person decides.
 */
export function sessionLines(sessionId, cwd, { alive = isAlive } = {}) {
  if (!sessionId || sessionId === 'unknown-session') return [];
  const said = core.readJson(saidPath(sessionId)) || {};
  const told = new Set(Array.isArray(said.told) ? said.told : []);
  const lines = [];
  const held = core.readJson(heartbeatPath(sessionId));
  for (const other of othersOf(held).others) {
    const mark = `${other.key}|${other.since || ''}`;
    if (told.has(mark)) continue;
    told.add(mark);
    const who = [other.who, other.since ? `since ${other.since.slice(11, 16)} UTC` : ''].filter(Boolean).join(', ');
    lines.push(`${other.key} is already being worked on in another session${who ? ` (${who})` : ''}. Pick another ticket or coordinate first.`);
  }
  let folder = Boolean(said.folder);
  if (!folder && cwd) {
    const dir = path.dirname(heartbeatPath(sessionId));
    const own = path.basename(heartbeatPath(sessionId));
    let names = [];
    try { names = fs.readdirSync(dir); } catch { /* no heartbeats yet */ }
    const shared = names.some((name) => {
      if (!name.endsWith('.json') || name === own || name.endsWith('.said.json')) return false;
      const one = core.readJson(path.join(dir, name));
      return one?.root === cwd && !one.endedReason && alive(one.watchPid);
    });
    if (shared) {
      folder = true;
      lines.push('Another Claude Code session is working in this folder. '
        + 'Work in a separate copy (`git worktree add`) so your changes do not collide.');
    }
  }
  if (lines.length) core.writeJson(saidPath(sessionId), { told: [...told].slice(-50), folder });
  return lines;
}

/**
 * The session a new one carries on, after a hand-off (MACLEOD-641): a
 * heartbeat under the same repository root whose last beat said
 * `handoff` less than ten minutes ago and that nobody has claimed yet.
 * Its file name is the session's digest, which is all a beat names.
 */
export function predecessorOf(sessionId, root, now = Date.now()) {
  const dir = path.dirname(heartbeatPath(sessionId));
  const own = core.digest(sessionId);
  let best;
  for (const name of fs.readdirSync(dir)) {
    const digest = name.slice(0, -5);
    if (!name.endsWith('.json') || digest === own || !ROOT_DIGEST.test(digest)) continue;
    const held = core.readJson(path.join(dir, name));
    const at = Date.parse(held?.endedAt || '');
    if (held?.endedReason !== 'handoff' || held.root !== root || held.continuedBy || !(now - at < HANDOFF_FRESH_MS)) continue;
    if (!best || at > best.at) best = { digest, at, file: path.join(dir, name), held };
  }
  if (!best) return undefined;
  core.writeJson(best.file, { ...best.held, continuedBy: own });
  return best.digest;
}

/** Whether a process exists. EPERM means it exists and belongs to somebody else. */
export function isAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'tcsh', 'csh']);

/** One row of `ps` for a pid: its parent and its command name. No shell. */
export function psLookup(pid) {
  if (process.platform === 'win32') return undefined;
  try {
    const out = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const match = out.match(/^(\d+)\s+(.+)$/);
    return match ? { ppid: Number(match[1]), comm: match[2] } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The session's own process, from the hook's parent.
 *
 * Claude Code runs this plugin's hook as `node hook.mjs` with no shell,
 * so the hook's parent is the Claude Code process. Another tool may run
 * it through `sh -c`, and that shell exits with the hook: watching it
 * would end every heartbeat within a second. So a shell is stepped over,
 * at most three times. Asked only when a heartbeat starts, never on
 * every event.
 */
export function sessionProcess(pid, { lookup = psLookup, depth = 3 } = {}) {
  let at = Number(pid);
  for (let step = 0; step < depth; step += 1) {
    const row = lookup(at);
    if (!row || !SHELLS.has(path.basename(String(row.comm)).replace(/^-/, ''))) break;
    if (!(row.ppid > 1)) break;
    at = row.ppid;
  }
  return at;
}

/**
 * Whether this session's heartbeat is running, from its record.
 *
 * A live pid alone is not enough: pids are reused, and a process that
 * has not beaten for well over two intervals is not ours any more.
 */
export function heartbeatState(sessionId, { now = Date.now(), alive = isAlive, beatMs = BEAT_MS } = {}) {
  if (!sessionId) return { running: false };
  const held = core.readJson(heartbeatPath(sessionId));
  if (!held?.pid) return { running: false };
  const last = Date.parse(held.beatAt || held.startedAt || '');
  const fresh = Number.isFinite(last) && now - last < beatMs * 2 + POLL_MS * 2;
  return { running: Boolean(fresh && alive(held.pid)), pid: held.pid, beatAt: held.beatAt, sent: held.sent };
}

/**
 * Start the session's heartbeat unless it is already running.
 *
 * Called by the hook on every event but SessionEnd. The common answer
 * is "already running": one small read and one `kill(pid, 0)`. A start
 * is claimed with an exclusive file first, so two hooks firing at once
 * start one process, not two. After a SessionEnd only a SessionStart
 * (a resumed session) starts it again.
 */
export function ensureHeartbeat(sessionId, {
  event, source, cwd = process.cwd(), watchPid = process.ppid, spawnImpl = spawn, lookup = psLookup,
  now = Date.now(), alive = isAlive, env = process.env,
} = {}) {
  if (!sessionId || sessionId === 'unknown-session') return { running: false, started: false };
  // The one switch: TEAMFLOW_HEARTBEAT=off. The test harness sets it, so
  // no test starts a real process it did not ask for.
  if (String(env.TEAMFLOW_HEARTBEAT || '').toLowerCase() === 'off') return { running: false, started: false, off: true };
  const file = heartbeatPath(sessionId);
  const prior = core.readJson(file);
  const current = heartbeatState(sessionId, { now, alive });
  // A resumed session whose old process is gone replaces the heartbeat
  // still watching that process, rather than wait for its last beat.
  const resumed = event === 'SessionStart' && prior?.watchPid && !alive(prior.watchPid);
  if (current.running && !resumed) return { running: true, started: false, pid: current.pid };
  const end = endMarkPath(sessionId);
  if (fs.existsSync(end)) {
    if (event !== 'SessionStart') return { running: false, started: false };
    fs.rmSync(end, { force: true });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const claim = `${file}.starting`;
  if (!takeClaim(claim, now)) return { running: false, started: false };
  try {
    const watch = sessionProcess(watchPid, { lookup });
    if (!alive(watch)) return { running: false, started: false };
    // A new session id after a hand-off names the one it carries on.
    const continues = prior?.continues || (event === 'SessionStart' && !prior
      && (source === 'resume' || source === 'startup') ? predecessorOf(sessionId, cwd, now) : undefined);
    const child = spawnImpl(process.execPath, [SCRIPT, sessionId, String(watch), ...(continues ? [continues] : [])],
      { cwd, detached: true, stdio: 'ignore', shell: false, env });
    child.on?.('error', () => {});
    child.unref?.();
    if (!child.pid) return { running: false, started: false };
    core.writeJson(file, {
      pid: child.pid, watchPid: watch, startedAt: new Date(now).toISOString(), root: cwd, ...(continues ? { continues } : {}),
    });
    // After the record: the old heartbeat either finds itself replaced
    // or still finds the mark and says `handoff`.
    fs.rmSync(handoffMarkPath(sessionId), { force: true });
    return { running: true, started: true, pid: child.pid, ...(continues ? { continues } : {}) };
  } finally {
    fs.rmSync(claim, { force: true });
  }
}

function takeClaim(claim, now) {
  const take = () => { fs.writeFileSync(claim, String(process.pid), { flag: 'wx' }); return true; };
  try { return take(); } catch { /* another hook holds it, or left it behind */ }
  let age;
  try { age = now - fs.statSync(claim).mtimeMs; } catch { age = Infinity; }
  if (age < CLAIM_STALE_MS) return false;
  fs.rmSync(claim, { force: true });
  try { return take(); } catch { return false; }
}

/**
 * The hook's half of a normal end. SessionEnd has 1.5 s and no network,
 * so this only leaves a mark; the process sees it within a poll, sends
 * the last beat itself and exits. No signal: a pid in a stale record may
 * belong to something else by now.
 */
export function stopHeartbeat(sessionId) {
  if (!sessionId || sessionId === 'unknown-session') return false;
  const end = endMarkPath(sessionId);
  fs.mkdirSync(path.dirname(end), { recursive: true });
  fs.writeFileSync(end, new Date().toISOString());
  return true;
}

/** The `teamflow status` line. Plain words; a person reads it. */
export function heartbeatLine(sessionId, { now = Date.now(), alive = isAlive, env = process.env } = {}) {
  if (String(env.TEAMFLOW_HEARTBEAT || '').toLowerCase() === 'off') return 'off. TEAMFLOW_HEARTBEAT=off turned it off.';
  if (!sessionId) return 'not running. No session has started here yet.';
  const state = heartbeatState(sessionId, { now, alive });
  if (!state.running) return 'not running. It starts with the next event of this session.';
  const at = Date.parse(state.beatAt || '');
  if (!Number.isFinite(at)) return 'running. The first beat is not sent yet.';
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  const ago = minutes < 1 ? 'less than a minute ago' : `${minutes} min ago`;
  return state.sent
    ? `running. The last beat went out ${ago}.`
    : `running. The service did not take the last beat, ${ago}.`;
}

export function agentRow(actor) {
  const block = core.agentBlock(actor);
  if (!agentIdOk(block.id)) return undefined;
  const row = { agentId: block.id, name: block.name };
  const key = keyOf(actor.binding?.key);
  if (key) row.key = key;
  if (STAGES.has(actor.stage)) row.stage = actor.stage;
  if (STATUSES.has(actor.status)) row.status = actor.status;
  const at = isoOf(actor.updatedAt);
  if (at) row.lastEventAt = at;
  return row;
}

/**
 * One beat, from the plugin's own records of this session: the main
 * actor's bound key, and every agent that has a start and no end, newest
 * first, at most fifty. An agent file with no start, or one already
 * ended, is not a live agent (MACLEOD-641 audit, K3 and K4). Its id and
 * the session's are the ones a report carries (`agentBlock`,
 * `sessionBlock`), so the board joins them on one value.
 */
export function buildBeat(sessionId, { at = new Date().toISOString(), alive = true, endedReason, continues, repo } = {}) {
  const actors = core.sessionActors(sessionId);
  const main = actors.find((one) => !one.agentKey);
  const beat = { sessionId: core.digest(sessionId), beatAt: at, sessionAlive: Boolean(alive) };
  if (!alive && endedReason) beat.endedReason = endedReason;
  if (ROOT_DIGEST.test(String(continues || ''))) beat.continues = continues;
  if (ROOT_DIGEST.test(String(repo || ''))) beat.repo = repo;
  const paused = alive ? pauseOf(sessionId, Date.parse(at)) : undefined;
  if (paused) beat.paused = paused;
  const bound = keyOf(main?.binding?.key);
  if (bound) beat.boundKey = bound;
  beat.agents = actors
    .filter((one) => one.agentKey && one.agent?.startedAt && !one.agent.endedAt && !one.ended && !one.absorbedInto)
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
    .map(agentRow)
    .filter(Boolean)
    .slice(0, AGENTS_MAX);
  return beat;
}

// Every how many beats the machine's inventory goes out (inventory.mjs).
const INVENTORY_EVERY = 10;

/** The inventory, loaded only when one is due. */
async function sendLedger(options) {
  const { sendInventory } = await import('./inventory.mjs');
  return sendInventory({ ...options, helpers: { agentRow, keyOf, isAlive } });
}

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The loop. Beats at once, then every `beatMs`; looks at the session and
 * the stop mark every `pollMs`. Returns why it stopped:
 * `session_end`, `process_gone`, `handoff`, `expired` or `replaced`.
 * A session stopped at a usage limit while a tool moves it to another
 * account is a `handoff`, never a crash, even when its SessionEnd ran
 * during the stop.
 */
export async function runHeartbeat({
  sessionId, watchPid, cwd = process.cwd(), beatMs = BEAT_MS, pollMs = POLL_MS,
  maxLifeMs = MAX_LIFE_MS, now = Date.now, sleep = pause, alive = isAlive,
  send = core.sendHeartbeat, self = process.pid, continues, env = process.env,
  deliver = deliverRound, notify = notifyDesktop, inventory = sendLedger,
}) {
  const file = heartbeatPath(sessionId);
  const started = now();
  let repo;
  try { repo = repoDigest(cwd); } catch { /* no repository: no field */ }
  const beat = async (sessionAlive, endedReason) => {
    const at = new Date(now()).toISOString();
    let sent = false;
    let reply = {};
    try {
      const result = await send(buildBeat(sessionId, { at, alive: sessionAlive, endedReason, continues, repo }), core.loadConfig(cwd));
      sent = Boolean(result?.ok);
      if (sent && (Array.isArray(result.others) || Array.isArray(result.holds))) reply = othersOf(result);
    } catch { /* this beat is skipped; the next one is two minutes away */ }
    try {
      const held = core.readJson(file);
      const end = endedReason ? { endedReason, endedAt: at } : {};
      const key = keyOf(core.readJson(core.sessionPath(sessionId))?.binding?.key);
      if (held?.pid === self) core.writeJson(file, { ...held, beatAt: at, sent, ...end, ...reply, ...(key ? { key } : {}) });
    } catch { /* the record is a convenience for `status` */ }
  };
  let next = started;
  let beats = 0;
  for (;;) {
    const other = heartbeatState(sessionId, { now: now(), alive, beatMs });
    if (other.running && other.pid !== self) return 'replaced';
    const ended = fs.existsSync(endMarkPath(sessionId))
      || Boolean(core.readJson(core.sessionPath(sessionId))?.ended);
    if (ended || !alive(watchPid)) {
      const why = handingOff(sessionId, { now: now(), env }) ? 'handoff' : ended ? 'session_end' : 'process_gone';
      await beat(false, why);
      return why;
    }
    if (now() - started >= maxLifeMs) return 'expired';
    if (now() >= next) {
      await beat(true);
      try { await deliver(sessionId, { cwd }); } catch { /* the next beat tries again */ }
      // The machine's inventory: with the first beat, then every tenth.
      if (beats % INVENTORY_EVERY === 0) {
        try { await inventory({ cwd }); } catch { /* the next one is twenty minutes away */ }
      }
      beats += 1;
      next = now() + beatMs;
    }
    try { await checkBack(sessionId, { now: now(), deliver, notify, cwd }); } catch { /* fails open */ }
    await sleep(pollMs);
  }
}

// Timings may be shortened only inside the test sandbox.
function testMs(name, fallback) {
  const value = Number(process.env[name]);
  return process.env.TEAMFLOW_TEST_SANDBOX && value > 0 ? value : fallback;
}

/* c8 ignore next 3 */
function isEntry() {
  try { return fs.realpathSync(process.argv[1] || '') === fs.realpathSync(SCRIPT); } catch { return false; }
}

if (isEntry()) {
  const [sessionId, watch, continues] = process.argv.slice(2);
  try {
    await runHeartbeat({
      sessionId,
      continues,
      watchPid: Number(watch),
      beatMs: testMs('TEAMFLOW_HEARTBEAT_BEAT_MS', BEAT_MS),
      pollMs: testMs('TEAMFLOW_HEARTBEAT_POLL_MS', POLL_MS),
      maxLifeMs: testMs('TEAMFLOW_HEARTBEAT_MAX_LIFE_MS', MAX_LIFE_MS),
    });
  } catch { /* fails open */ }
  process.exit(0);
}
