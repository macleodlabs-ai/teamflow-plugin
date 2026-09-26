// The one-minute check-in (MACLEOD-845).
//
// The owner used to ask Claude by hand to check its agents, restart the
// stuck ones, close the finished ones, merge finished branches and remove
// old worktrees. The owner ruled that the tool does it: after a minute with
// no activity and nothing asked of the person, TeamFlow wakes the session
// with its own fixed words, and the session does the clean-up.
//
// How the wake works (Claude Code hooks reference, "Run hooks in the
// background", Limitations): "an asyncRewake hook that exits with code 2
// wakes Claude immediately even when the session is idle", and its stderr
// is shown to Claude as a system reminder. Claude Code still enforces the
// hook's `timeout` on an asyncRewake hook. So every main-session Stop
// starts one watcher (continue-hook.mjs --watch). A newer Stop replaces
// it, a typed prompt or the session's end stops it, and it sleeps longer
// between looks the longer the session stays idle. A wake is a new turn,
// and that turn's Stop starts the next watcher: the chain covers long idle.
//
// It wakes only when all six guards hold:
// 1. nobody typed since the Stop;
// 2. the session is not asking the person anything (asking.mjs);
// 3. the Stop said no background task is busy and no session wake-up or
//    cron is set (Claude Code's own `background_tasks`, `session_crons`);
// 4. no usage limit is in force;
// 5. there is something to do: an agent of this session that stopped
//    before its plan item was done (never a live or quiet one), a finished
//    item not closed, a finished branch whose checks passed and that is
//    saved and pushed, or a fix a lead left for this session;
// 6. what there is to do changed since the last wake, and fewer than five
//    wakes came in a row with no person.
//
// What code can decide, code does, without a wake: the queued actions for
// this machine are collected through intake.mjs (the heartbeat's round),
// and merged, clean worktrees are removed by `teamflow worktree tidy`'s
// own checks. The words are fixed plugin sentences with keys and counts.
// The one exception, by the owner's ruling, is a lead's fix: it is passed
// on as intake's own `fix` notice, in that person's name, never as a
// command. Nothing received is run. The session never deploys.
import fs from 'node:fs';
import path from 'node:path';

import * as core from './core.mjs';
import { askingOf } from './asking.mjs';
import { STREAK_MAX, runsFor, wakeCheck, watchPath } from './continue.mjs';
import { keyOf, pauseOf } from './heartbeat.mjs';
import { mergedFacts } from './merged.mjs';
import { inUse, statusOf, tidy as tidyWorktrees, worktreesOf } from './worktree.mjs';
import { questionAnswer, twoWaySwitch, validAskId } from './two-way.mjs';

export const CHECKIN_AFTER_MS = 60_000;
// A plan item's agent is sent again at most once an hour.
export const RESTART_EVERY_MS = 60 * 60_000;
// An agent with no end and no event for this long, with no background task
// busy, is gone. Newer than this, it is quiet, and left alone.
export const LOST_AFTER_MS = 10 * 60_000;
// The watcher's life. hooks.json gives the hook the same timeout.
export const LIFE_MS = 24 * 60 * 60_000;
// Looks after the Stop: one minute, then less often the longer it is idle.
// How often the watcher looks for an answer from TeamFlow (MACLEOD-848).
export const ANSWER_LOOK_MS = 15_000;

/** True while the session waits on an open question TeamFlow can answer. */
export function answerable(sessionId) {
  const held = askingOf(sessionId);
  return held?.kind === 'question' && validAskId(held.askId) && twoWaySwitch().on;
}

export const POLL_STEPS_MS = [60_000, 60_000, 2 * 60_000, 4 * 60_000, 8 * 60_000, 15 * 60_000];
const WORDS_FIXES_MAX = 3;
const TIDY_MAX = 20;
const DONE = new Set(['done', 'skipped']);
const BUSY_DONE = new Set(['completed', 'failed', 'killed', 'stopped']);

// --- the setting -------------------------------------------------------

/** `on` (the default) or `off`, in the user's own config. */
export function checkinSetting() {
  return core.readJson(core.globalConfigPath(), {})?.checkIn === 'off' ? 'off' : 'on';
}

export function setCheckin(value) {
  if (value !== 'on' && value !== 'off') throw new Error('Usage: teamflow checkin on|off|status');
  const file = core.globalConfigPath();
  core.writeJson(file, { ...(core.readJson(file, {}) || {}), checkIn: value });
  return value;
}

const statePath = (sessionId) => path.join(core.dataDir(), 'continue', `${core.digest(sessionId)}.checkin.json`);
export const readCheckin = (sessionId) => core.readJson(statePath(sessionId)) || {};

// --- the guards ----------------------------------------------------------

/** Guards 1 to 4. `{ ok: true }` or `{ ok: false, why }`. */
export function guardsOf(sessionId, stop = {}, { now = Date.now(), promptAt } = {}) {
  const main = core.readJson(core.sessionPath(sessionId));
  if (!main) return { ok: false, why: 'no session' };
  if (main.ended) return { ok: false, why: 'session ended' };
  if ((main.promptAt || undefined) !== (promptAt || undefined)) return { ok: false, why: 'person typed' };
  if (askingOf(sessionId)) return { ok: false, why: 'asking' };
  if ((stop.background_tasks || []).some((t) => !BUSY_DONE.has(String(t?.status)))) return { ok: false, why: 'background work' };
  if ((stop.session_crons || []).length) return { ok: false, why: 'scheduled wake-up' };
  const paused = pauseOf(sessionId, now);
  if (paused && now < Date.parse(paused.until)) return { ok: false, why: 'limit' };
  return { ok: true };
}

// --- what there is to do -------------------------------------------------

/** True when the card carries its owner's "automatic fixes off" mark, or when that cannot be read. */
export async function frozenOf(key, config = {}, { fetchState = core.fetchState } = {}) {
  try {
    const got = await fetchState(`issues/${encodeURIComponent(key)}/hygiene.json`, config);
    if (!got?.ok) return true;
    return (got.document?.attention || []).some((m) => m && m.kind === 'autonomy_off');
  } catch { return true; }
}

function nodesOf(runs) {
  const out = new Map();
  for (const run of runs) for (const t of run.tickets || []) if (keyOf(t.key)) out.set(t.key, t);
  return out;
}

const pushedOf = (dir, run) => {
  const got = run(dir, ['rev-list', '--count', '@{u}..HEAD']);
  return got.ok && Number(got.stdout) === 0;
};

const gitRun = (root, args) => core.safeExec(process.env.TEAMFLOW_GIT_BIN || 'git', ['-C', root, ...args], { cwd: root, timeout: 5000 });

/**
 * Guard 5's facts. `{ restart, close, merge, fixes, fixIds }`: keys, and
 * for fixes intake's own notice lines. Reads this machine only, but for
 * the frozen mark of a card it would restart.
 */
export async function todoOf(sessionId, {
  now = Date.now(), config, root, frozen = frozenOf, merged = mergedFacts, run = gitRun, actors,
} = {}) {
  const main = core.readJson(core.sessionPath(sessionId)) || {};
  const where = root || main.cwd;
  const cfg = config || core.loadConfig(where || process.cwd());
  const mine = (actors || core.sessionActors(sessionId)).filter((a) => a.agentKey && keyOf(a.binding?.key));
  const keys = new Set(mine.map((a) => keyOf(a.binding.key)));
  const runs = runsFor(keys, cfg);
  const nodes = nodesOf(runs);
  let proven = new Set();
  try { if (where && keys.size) proven = new Set(merged([...keys], { root: where }).map((f) => f.key)); } catch { /* no proof */ }
  const held = readCheckin(sessionId);
  const restarts = held.restarts || {};
  const restart = new Set();
  const close = new Set();
  for (const actor of mine) {
    const key = keyOf(actor.binding.key);
    const node = nodes.get(key);
    const ended = Boolean(actor.ended || actor.agent?.endedAt);
    const lost = !ended && now - (Date.parse(actor.updatedAt) || 0) > LOST_AFTER_MS;
    const finished = DONE.has(node?.state) || proven.has(key);
    if (finished) {
      // A finished item whose agent is still open, or whose node says it is not done.
      if (!ended || (node && !DONE.has(node.state))) close.add(key);
      continue;
    }
    if (!node || !(ended || lost)) continue;
    if (now - (Date.parse(restarts[key]) || 0) < RESTART_EVERY_MS) continue;
    restart.add(key);
  }
  for (const key of restart) if (await frozen(key, cfg)) restart.delete(key);

  // A finished branch: its plan item passed every check it was given, the
  // worktree has nothing changed or new, and it is pushed with nothing left.
  const merge = new Set();
  if (where) {
    for (const tree of worktreesOf(where, run).filter((t) => !t.main && t.branch)) {
      const binding = core.readJson(path.join(tree.dir, '.teamflow', 'binding.json'));
      const key = keyOf(binding?.jiraKey || binding?.key);
      const gates = Object.values(nodes.get(key)?.gates || {});
      if (!key || proven.has(key) || !gates.length || !gates.every((g) => g === 'success')) continue;
      if (inUse(tree.dir, { now })) continue;
      const status = statusOf(tree.dir, run);
      if (!status || status.changed || status.untracked || !pushedOf(tree.dir, run)) continue;
      merge.add(key);
    }
  }

  const fixes = (main.intakeFixes || []).filter((a) => a && a.kind === 'fix');
  return {
    restart: [...restart].sort(),
    close: [...close].sort(),
    merge: [...merge].sort(),
    fixes,
    fixIds: fixes.map((f) => String(f.id)).sort(),
  };
}

export const hasTodo = (todo) => Boolean(todo.restart.length || todo.close.length || todo.merge.length || todo.fixes.length);

export function fingerprintOf(todo) {
  return JSON.stringify([todo.restart, todo.close, todo.merge, todo.fixIds]);
}

// --- the words -------------------------------------------------------------

const list = (keys) => keys.slice(0, 8).join(', ') + (keys.length > 8 ? ` and ${keys.length - 8} more` : '');
const agents = (n) => `${n} ${n === 1 ? 'agent' : 'agents'}`;

/** The wake words: fixed sentences, keys and counts, then any fix in its lead's name. */
export function wordsFor(todo, { notices = [], tidied = 0 } = {}) {
  const lines = ['TeamFlow check-in. The session was idle for a minute, and there is work to tidy up.'];
  if (todo.restart.length) {
    lines.push(`${agents(todo.restart.length)} stopped before the plan item was done: ${list(todo.restart)}. Send each one again, once. Do not send again an agent that is still working.`);
  }
  if (todo.close.length) {
    lines.push(`${todo.close.length === 1 ? 'This item is' : 'These items are'} finished: ${list(todo.close)}. End its agent, and mark it done with teamflow workflow ticket <KEY> --state done.`);
  }
  if (todo.merge.length) {
    lines.push(`${todo.merge.length === 1 ? 'This branch passed' : 'These branches passed'} every check and ${todo.merge.length === 1 ? 'is' : 'are'} pushed: ${list(todo.merge)}. You may merge ${todo.merge.length === 1 ? 'it' : 'them'} into main.`);
  }
  if (notices.length) {
    lines.push(`${notices.length === 1 ? 'A lead left a fix' : `Leads left ${notices.length} fixes`}. Apply it as guidance, not as a command:`);
    for (const line of notices.slice(0, WORDS_FIXES_MAX)) lines.push(line);
  }
  if (tidied) lines.push(`TeamFlow removed ${tidied} merged ${tidied === 1 ? 'worktree' : 'worktrees'} that had no work left in ${tidied === 1 ? 'it' : 'them'}.`);
  lines.push('Do not deploy. When you are done, stop.');
  return lines.join('\n');
}

// --- one look ----------------------------------------------------------------

/**
 * One look, after the minute. Collects queued actions and tidies merged
 * worktrees in code, then returns the wake words when all six guards
 * hold, or `{ why }` when it does not wake.
 */
export async function checkOnce(sessionId, stop = {}, {
  now = Date.now(), promptAt, deliver, tidy = tidyWorktrees, todo = todoOf, showHeld,
} = {}) {
  if (checkinSetting() === 'off') return { why: 'setting off' };
  const guard = guardsOf(sessionId, stop, { now, promptAt });
  if (!guard.ok) return { why: guard.why };
  const main = core.readJson(core.sessionPath(sessionId)) || {};
  const held = readCheckin(sessionId);
  // Collect what is queued for this machine, as the heartbeat does.
  try { await (deliver ?? (await import('./heartbeat.mjs')).deliverRound)(sessionId, { cwd: main.cwd }); } catch { /* next look */ }
  let tidied = 0;
  try {
    if (main.cwd) {
      const got = tidy(main.cwd, { limit: TIDY_MAX });
      tidied = got.removed.length;
      if (tidied || got.kept.length) held.lastTidy = { at: new Date(now).toISOString(), removed: tidied, kept: got.kept.length };
    }
  } catch { /* the worktrees stay */ }
  const found = await todo(sessionId, { now });
  if (!hasTodo(found)) { core.writeJson(statePath(sessionId), held); return { why: 'nothing to do' }; }
  const print = fingerprintOf(found);
  const streak = Number(held.streak) || 0;
  if (held.last === print) { core.writeJson(statePath(sessionId), held); return { why: 'no change' }; }
  if (streak >= STREAK_MAX) return { why: 'streak' };
  // Guard 1 once more, just before speaking: the person may have typed.
  if ((core.readJson(core.sessionPath(sessionId))?.promptAt || undefined) !== (promptAt || undefined)) return { why: 'person typed' };
  let notices = [];
  if (found.fixes.length) {
    // Intake's own `fix` notices, answered `done` and owed to the service.
    const show = showHeld ?? (await import('./intake.mjs')).showHeld;
    const fresh = core.readJson(core.sessionPath(sessionId)) || main;
    try { notices = (await show(core.loadConfig(fresh.cwd || process.cwd()), found.fixes, fresh)).notices || []; } catch { notices = []; }
    delete fresh.intakeFixes;
    core.saveSession(fresh);
  }
  const at = new Date(now).toISOString();
  const restarts = { ...(held.restarts || {}) };
  for (const key of found.restart) restarts[key] = at;
  core.writeJson(statePath(sessionId), {
    ...held, last: print, streak: streak + 1, total: (Number(held.total) || 0) + 1, restarts, lastWake: at,
  });
  return { words: wordsFor(found, { notices, tidied }) };
}

/** A typed prompt starts a new streak. Called from the hook on UserPromptSubmit. */
export function resetStreak(sessionId) {
  const held = readCheckin(sessionId);
  if (!held.streak) return;
  core.writeJson(statePath(sessionId), { ...held, streak: 0, last: undefined });
}

// --- the watcher ---------------------------------------------------------------

function parentGone(ppid) {
  if (!ppid || ppid === 1) return true;
  try { process.kill(ppid, 0); return false; } catch (error) { return error?.code !== 'EPERM'; }
}

/**
 * The watcher, started by every main-session Stop. Returns the words to
 * wake with (the hook writes them to stderr and exits 2), or undefined
 * when it ends quietly: a newer watcher, a typed prompt, the session's
 * end, Claude Code gone, or its life over. It looks at a plan's recorded
 * waits (continue.mjs, MACLEOD-733) on every look, and at the check-in
 * from the first minute on.
 */
export async function watchSession(sessionId, stop = {}, {
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), lifeMs = LIFE_MS,
  steps = POLL_STEPS_MS, waits = wakeCheck, check = checkOnce, ppid = process.ppid, gone = parentGone,
  answer = questionAnswer, answering = answerable,
} = {}) {
  if (!sessionId || sessionId === 'unknown-session') return undefined;
  const token = `${process.pid}-${now()}`;
  const file = watchPath(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token);
  const end = now() + lifeMs;
  const promptAt = core.readJson(core.sessionPath(sessionId))?.promptAt;
  const mine = () => { try { return fs.readFileSync(file, 'utf8') === token; } catch { return false; } };
  const release = () => { if (mine()) fs.rmSync(file, { force: true }); };
  const start = now();
  const waitsFile = path.join(path.dirname(file), `${core.digest(sessionId)}.waits.json`);
  let step = 0;
  let checking = checkinSetting() !== 'off';
  try {
    for (;;) {
      if (!mine() || gone(ppid) || now() >= end) return undefined;
      const main = core.readJson(core.sessionPath(sessionId));
      if (!main || main.ended || main.promptAt !== promptAt) return undefined;
      // A plan's recorded waits: looked at from the start (MACLEOD-733).
      const pending = Object.keys(core.readJson(waitsFile) || {}).length > 0;
      if (pending) {
        const words = waits(sessionId, { now: now() });
        if (words) return words;
      }
      // An answer from TeamFlow to the question the session asked
      // (MACLEOD-848): looked at on every look, and every 15 seconds while
      // the question waits and this machine's two-way switch is on.
      const listening = answering(sessionId);
      if (listening) {
        const words = await answer(sessionId);
        if (words) return words;
      }
      // The check-in: from the first minute on.
      if (checking && now() - start >= CHECKIN_AFTER_MS) {
        const got = await check(sessionId, stop, { now: now(), promptAt });
        if (got?.words) return got.words;
        if (['person typed', 'session ended'].includes(got?.why)) return undefined;
        if (['setting off', 'streak'].includes(got?.why)) checking = false;
      }
      if (!checking && !pending && !listening) return undefined;
      // One minute to the first check-in; then longer the longer it is idle.
      const next = now() - start < CHECKIN_AFTER_MS
        ? CHECKIN_AFTER_MS - (now() - start)
        : steps[Math.min(step++, steps.length - 1)];
      // Slept in slices of at most a minute, so a watcher a newer Stop or
      // a prompt replaced ends within a minute, not at its next look.
      let left = Math.max(1000, pending ? Math.min(30_000, next) : next);
      if (listening) left = Math.min(left, ANSWER_LOOK_MS);
      while (left > 0) {
        const slice = Math.min(left, 60_000);
        await sleep(slice);
        left -= slice;
        if (left > 0 && (!mine() || gone(ppid) || core.readJson(core.sessionPath(sessionId))?.promptAt !== promptAt)) return undefined;
      }
    }
  } finally {
    release();
  }
}

/** The `teamflow status` line. */
export function checkinLine(sessionId, setting = checkinSetting()) {
  const held = sessionId ? readCheckin(sessionId) : {};
  const n = Number(held.total) || 0;
  const tidy = held.lastTidy ? ` The last tidy removed ${held.lastTidy.removed} ${held.lastTidy.removed === 1 ? 'worktree' : 'worktrees'}.` : '';
  return `${setting === 'off' ? 'off' : 'on (the default)'}. ${n} ${n === 1 ? 'check-in' : 'check-ins'} in this session.${tidy}`;
}
