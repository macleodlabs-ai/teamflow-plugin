// Auto-continue: TeamFlow gives the next direction when a session stops
// (MACLEOD-726).
//
// The owner: "another common thing I type over and over is a nudge...
// continue... that NEEDS TO BE AUTOMATED". And the ruling beside it:
// TeamFlow is the manager, so the words are a direction, never a nudge.
// They name the next concrete item and why it is next.
//
// Claude Code's documented way (https://code.claude.com/docs/en/hooks,
// "Stop decision control"): a synchronous Stop or SubagentStop hook that
// prints `{"decision": "block", "reason": "..."}` keeps Claude working,
// and `reason` is its next instruction. An async hook cannot do this, so
// continue-hook.mjs is registered on its own, without `async`.
//
// This is the one hook that deliberately prints a "block". Everything
// else about it fails open: any doubt, any error, and it prints nothing
// and the session stops as it always did.
//
// The guards, all of them required:
// - the setting is on (on by default for a session in a plan run);
// - there is a direction: a failed check or open points on the bound
//   ticket, its plan item not done, or a ready item in the plan;
// - the last turn did not end with a question to the person;
// - nobody typed in the last minute (the person is driving);
// - no usage limit is in force, and the turn did not end on an error;
// - the session is not in plan mode. While its own agents still run in
//   the background, it continues only with a ready plan item that none
//   of them holds (the owner's ruling, 2026-09-23);
// - at most five in a row, and never twice with no change in the work;
// - Claude Code's `stop_hook_active`: set by another hook's block, this
//   one does not stack on it.
//
// The reason is fixed plugin words and facts: keys, step names, counts,
// and the plan's name reduced to plain characters. Never text received
// from the service: no titles, no point text, no notes.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import * as core from './core.mjs';
import { launchesOf } from './dispatch.mjs';
import { drivenBy } from './driven.mjs';
import { keyOf, pauseOf } from './heartbeat.mjs';
import { STEP } from './resume.mjs';
import { BRANCH } from './workflow.mjs';

export const STREAK_MAX = 5;
// A person who typed this recently is at the keyboard and drives.
export const QUIET_MS = 60_000;
// Directions kept on a run, like its hygiene rows.
export const DIRECTIONS_MAX = 20;
const LIVE_RUNS = new Set(['running', 'stalled']);
// Tools whose use is work: an edit, a command (tests and checks run
// there), a dispatched agent. A read is not a change.
export const WORK_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Agent', 'Task']);
const REWORK = new Set(['LOCAL_REWORK', 'DEV_REWORK']);

// --- the setting -------------------------------------------------------

/**
 * `on` (every bound session), `off`, or absent: on for a session in a
 * plan run only. In the user's own config, which a repository cannot write.
 */
export function settingOf() {
  const value = core.readJson(core.globalConfigPath(), {})?.autoContinue;
  return value === 'on' || value === 'off' ? value : 'plans';
}

export function setSetting(value) {
  if (value !== 'on' && value !== 'off') throw new Error('Usage: teamflow continue on|off|status');
  const file = core.globalConfigPath();
  const next = { ...(core.readJson(file, {}) || {}), autoContinue: value };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  core.writeJson(file, next);
  return value;
}

// --- what the last turn said -------------------------------------------

const ASKS = /\b(let me know|would you like|do you want|shall i|should i|can you confirm|please (confirm|choose|decide|review|advise)|which (one|option|do you)|your call|up to you|waiting for your)\b/i;

/** True when the turn ended by asking the person something. Never auto-answered. */
export function endsWithQuestion(message) {
  const text = String(message || '').replace(/```[\s\S]*?```/g, '').trim();
  if (!text) return false;
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const last = paragraphs.at(-1) || '';
  return /\?["')\]*_\s]*$/.test(last) || ASKS.test(last);
}

const HALTED = /\b(usage limit|rate limit|limit reached|hit your limit|limit will reset|API Error|overloaded_error|credit balance)\b/i;

/** True when the turn ended on a limit or an error. The pause logic handles those. */
export function endedOnError(message) {
  return HALTED.test(String(message || '').slice(-600));
}

// --- the facts -----------------------------------------------------------

/** A plan's name in plain characters, clipped: never a frame for other words. */
export function plainName(name) {
  const clean = String(name || '').replace(/[^\p{L}\p{N} ._:#/+-]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return clean || 'plan';
}

const stepOf = (stage) => STEP[stage];
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const itemsLeft = (n) => `${n < WORDS.length ? WORDS[n] : n} ${n === 1 ? 'item is' : 'items are'} left.`;

/** The live plan runs that hold any of these keys. */
export function runsFor(keys, config = {}) {
  let workflows = {};
  try { workflows = core.readWorkflows(config)?.workflows || {}; } catch { return []; }
  return Object.values(workflows)
    .filter((run) => LIVE_RUNS.has(run?.status) && (run.tickets || []).some((t) => keys.has(t.key)));
}

/** The first phase that is not done, and its open items: rework first, then the plan's order. */
function readyOf(run) {
  const tickets = run.tickets || [];
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const finished = (key) => ['done', 'skipped'].includes(byKey.get(key)?.state);
  const phase = (run.phases || []).find((p) => !(p.tickets || []).every(finished));
  if (!phase) return { phase: undefined, open: [] };
  const open = (phase.tickets || []).map((k) => byKey.get(k))
    .filter((t) => t && (t.state === 'waiting' || t.state === 'rework') && keyOf(t.key))
    .sort((a, b) => (a.state === 'rework' ? 0 : 1) - (b.state === 'rework' ? 0 : 1) || (a.rank || 0) - (b.rank || 0));
  return { phase, open };
}

const leftOf = (run) => (run.tickets || []).filter((t) => !['done', 'skipped'].includes(t.state)).length;

function checkWord(stage) {
  if (stage === 'LOCAL_TEST' || stage === 'DEV_TEST') return 'tests';
  if (stage === 'LOCAL_AUDIT' || stage === 'DEV_AUDIT') return 'audit';
  return 'last check';
}

/**
 * The next direction for one actor, or undefined. In this order: a
 * failed check on its ticket, open points on it, its own plan item not
 * done, the plan's next ready item. With a plan and nothing ready, a
 * `waiting` direction that says what blocks it; it is logged, never sent
 * as a continue, because there is nothing to do but wait.
 */
export function directionFor(actor, { runs = [], steps = {}, subagent = false, skip = new Set() } = {}) {
  const key = keyOf(actor?.binding?.key);
  const run = runs.find((r) => key && (r.tickets || []).some((t) => t.key === key)) || runs[0];
  const node = key ? run?.tickets?.find((t) => t.key === key) : undefined;
  const plan = run ? plainName(run.name) : undefined;
  if (key && (actor.status === 'failed' || REWORK.has(actor.stage))) {
    const word = checkWord(actor.stage === 'LOCAL_REWORK' ? actor.reworkFrom || 'LOCAL_TEST' : actor.stage === 'DEV_REWORK' ? actor.reworkFrom || 'DEV_TEST' : actor.stage);
    const verb = word === 'tests' ? 'have' : 'has';
    return { kind: 'fix', key, run, reason: `TeamFlow: next, fix ${key}. Its ${word} ${verb} not passed yet, and a failed check comes first.` };
  }
  const open = (node?.points || []).filter((p) => p.state === 'open').length;
  if (node && open) {
    return { kind: 'points', key, run, reason: `TeamFlow: next, fix ${count(open, 'open point', 'open points')} on ${key} from its last check. teamflow status lists them. When you fix one, mark it done in the plan.` };
  }
  if (subagent || !run) return undefined;
  if (node && (node.state === 'running' || node.state === 'rework')) {
    const step = stepOf(steps[key] || actor.stage);
    return { kind: 'finish', key, run, reason: `TeamFlow: carry on with ${key}${step ? ` at ${step}` : ''}. Its item in the plan '${plan}' is not done. When it is done, mark it done in the plan. ${itemsLeft(leftOf(run))}` };
  }
  const { phase, open: inPhase } = readyOf(run);
  const ready = inPhase.filter((t) => !skip.has(t.key));
  if (ready.length) {
    const next = ready[0];
    const step = stepOf(steps[next.key]);
    const first = next === inPhase[0];
    const why = next.state === 'rework' ? `it failed a check and goes ${first ? 'first' : 'next'}`
      : first ? `it is first in phase ${phase.n} of the plan` : `it is the next free item in phase ${phase.n} of the plan`;
    return { kind: 'next', key: next.key, run, reason: `TeamFlow: continue with the plan '${plan}'. Next is ${next.key}${step ? ` at ${step}` : ''}, because ${why}. ${itemsLeft(leftOf(run))}` };
  }
  if (!leftOf(run)) return undefined;
  const waiting = run.status === 'stalled' && keyOf(run.stalledOn?.key)
    ? `${run.stalledOn.key} at its ${plainName(run.stalledOn.gate)} check`
    : (run.tickets || []).filter((t) => ['running', 'blocked'].includes(t.state) && keyOf(t.key)).slice(0, 3)
      .map((t) => `${t.key} (${t.state === 'blocked' ? 'blocked' : 'in progress'})`).join(', ');
  return { kind: 'waiting', key: undefined, run, reason: `TeamFlow: the plan '${plan}' has no ready item. It waits on ${waiting || 'items that are not ready'}.` };
}

// --- what an actor waits for (MACLEOD-733) ---------------------------------

/**
 * The commit a branch has on `origin`, or undefined. `git ls-remote`
 * with no shell; the branch is a plain name from the plan, checked again
 * here, never words the service or a model sent.
 */
export function gitRemoteHead(cwd, branch, { run = execFileSync } = {}) {
  if (!cwd || !BRANCH.test(String(branch || ''))) return undefined;
  try {
    const out = String(run('git', ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], {
      cwd, timeout: 2500, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: false,
    }) || '');
    const sha = out.split(/\s+/)[0];
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined;
  } catch { return undefined; }
}

/** True when the actor has done work: any for an agent, since the last prompt for the session. */
export function started(actor, { main, subagent = false } = {}) {
  if (!actor?.workAt) return false;
  return subagent || !main?.promptAt || actor.workAt >= main.promptAt;
}

const hhmm = (iso) => `${String(iso).slice(11, 16)} UTC`;

/**
 * What an actor that has not started waits for, from facts TeamFlow holds:
 * the plan's edges from its node (the other item done; or, for an edge
 * with a branch, that branch on `origin`) and the usage limit's reset.
 * Undefined when it waits for nothing, or has started.
 * `{ over: true, direction: start }` or `{ over: false, direction: wait }`.
 */
export function waitOf(actor, runs = [], { main, subagent = false, now = Date.now(), remoteHead = gitRemoteHead, paused } = {}) {
  const key = keyOf(actor?.binding?.key);
  if (!key || started(actor, { main, subagent })) return undefined;
  const run = runs.find((r) => (r.tickets || []).some((t) => t.key === key));
  const byKey = new Map((run?.tickets || []).map((t) => [t.key, t]));
  const facts = [];
  const pending = [];
  const until = [];
  let branchSha;
  for (const edge of (run?.dependencies || []).filter((d) => d.from === key && keyOf(d.on))) {
    const done = ['done', 'skipped'].includes(byKey.get(edge.on)?.state);
    if (edge.branch && BRANCH.test(edge.branch)) {
      const sha = remoteHead(actor.cwd || main?.cwd, edge.branch);
      if (sha) {
        if (done) facts.push(`${edge.on} is done.`);
        facts.push(`Commit ${sha.slice(0, 7)} is on origin/${edge.branch}.`);
        branchSha = branchSha || sha;
      } else {
        pending.push(`Waiting for ${edge.branch} to reach origin.`);
        until.push(`${edge.branch} reaches origin`);
      }
    } else if (done) facts.push(`${edge.on} is done.`);
    else {
      pending.push(`Waiting for ${edge.on} to finish.`);
      until.push(`${edge.on} is done`);
    }
  }
  if (paused && now >= Date.parse(paused.until)) facts.push(`The usage limit reset at ${hhmm(paused.until)}.`);
  if (!facts.length && !pending.length) return undefined;
  if (pending.length) {
    return { over: false, direction: { kind: 'wait', key, run, reason: `TeamFlow: ${pending.join(' ')}`, until: until.join(' and ') } };
  }
  const then = branchSha ? 'Start from that commit.' : `Start the work on ${key}.`;
  return { over: true, facts, sha: branchSha, direction: { kind: 'start', key, run, reason: `TeamFlow: start now. ${facts.join(' ')} ${then}` } };
}

// --- waking a session that went idle waiting (MACLEOD-733) ------------------
//
// An agent that ended its turn to wait gets no later Stop. Claude Code's
// one way back in is an `asyncRewake` hook: it runs in the background and,
// when it exits 2, wakes the session at once with its stderr as a system
// reminder (https://code.claude.com/docs/en/hooks, "Run hooks in the
// background"). So each main-session Stop starts one watcher. It looks
// at the recorded waits every so often and wakes the session when one is
// over: the session itself, or its parent for an agent that has ended,
// which cannot be woken and must be sent again. A newer Stop's watcher
// replaces it. Nothing types into a terminal and nothing starts `claude`.

const waitsPath = (sessionId) => path.join(core.dataDir(), 'continue', `${core.digest(sessionId)}.waits.json`);
export const watchPath = (sessionId) => path.join(core.dataDir(), 'continue', `${core.digest(sessionId)}.watch`);

/** Remember that an actor stopped to wait, for the watcher. */
export function recordWait(sessionId, agentKey, direction, now = Date.now()) {
  if (!sessionId || !direction?.key) return;
  const held = core.readJson(waitsPath(sessionId)) || {};
  held[agentKey || 'main'] = { key: direction.key, at: new Date(now).toISOString() };
  core.writeJson(waitsPath(sessionId), held);
}

/**
 * One look at the recorded waits: the words to wake the session with,
 * or undefined. A wait that is over, or whose actor has started, is
 * dropped. Every guard of a continue still holds.
 */
export function wakeCheck(sessionId, { now = Date.now(), setting = settingOf(), remoteHead = gitRemoteHead } = {}) {
  const held = core.readJson(waitsPath(sessionId));
  if (!held || setting === 'off') return undefined;
  const paused = pauseOf(sessionId, now);
  if (paused && now < Date.parse(paused.until)) return undefined;
  const main = core.readJson(core.sessionPath(sessionId));
  const streak = core.readJson(streakPath(sessionId)) || {};
  if ((Number(streak.streak) || 0) >= STREAK_MAX) return undefined;
  let words;
  for (const [who, entry] of Object.entries(held)) {
    const subagent = who !== 'main';
    const actor = subagent ? core.readJson(core.sessionPath(sessionId, who)) : main;
    const config = core.loadConfig(main?.cwd || actor?.cwd || process.cwd());
    const runs = runsFor(new Set([entry.key]), config);
    const got = actor && keyOf(entry.key) === keyOf(actor.binding?.key) ? waitOf(actor, runs, { main, subagent, now, remoteHead, paused }) : undefined;
    if (got?.over === false || (got && words)) continue;
    delete held[who];
    if (!got) continue;
    words = subagent
      ? `TeamFlow: send the agent for ${entry.key} again. It stopped to wait, and what it waited for is done. ${got.facts.join(' ')}${got.sha ? ` Tell it to start from commit ${got.sha.slice(0, 7)}.` : ''}`
      : got.direction.reason;
    logDirection(got.direction, config, { continued: true });
    noteDirection(sessionId, subagent ? who : undefined, got.direction, now);
  }
  core.writeJson(waitsPath(sessionId), held);
  if (words) {
    core.writeJson(streakPath(sessionId), { ...streak, streak: (Number(streak.streak) || 0) + 1, total: (Number(streak.total) || 0) + 1 });
  }
  return words;
}

/**
 * The watcher's loop. Returns the words to wake with (the hook writes
 * them to stderr and exits 2), or undefined when it ends quietly: a newer
 * watcher took over, nothing waits any more, or its time ran out.
 */
export async function watch(sessionId, { pollMs = 30_000, lifeMs = 25 * 60_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), check = wakeCheck, now = () => Date.now() } = {}) {
  if (!sessionId || sessionId === 'unknown-session') return undefined;
  const token = `${process.pid}-${now()}`;
  fs.mkdirSync(path.dirname(watchPath(sessionId)), { recursive: true });
  fs.writeFileSync(watchPath(sessionId), token);
  const end = now() + lifeMs;
  const promptAt = core.readJson(core.sessionPath(sessionId))?.promptAt;
  while (now() < end) {
    let mine = false;
    try { mine = fs.readFileSync(watchPath(sessionId), 'utf8') === token; } catch { /* gone */ }
    if (!mine) return undefined;
    // The person typed: they drive now, and that turn's Stop watches again.
    if (core.readJson(core.sessionPath(sessionId))?.promptAt !== promptAt) return undefined;
    if (Object.keys(core.readJson(waitsPath(sessionId)) || {}).length) {
      const words = check(sessionId, { now: now() });
      if (words) return words;
    }
    await sleep(pollMs);
  }
  return undefined;
}

// --- the work, and the streak --------------------------------------------

function streakPath(sessionId, agentKey) {
  return path.join(core.dataDir(), 'continue', `${core.digest(agentKey ? `${sessionId}--${agentKey}` : sessionId)}.json`);
}

/** What counts as a change: new work by any actor of the session, a step, a loop, a node state. */
export function fingerprint(actors, runs) {
  return JSON.stringify({
    work: actors.map((a) => [a.agentKey || '', a.workAt || '', a.stage || '', a.loopCount || 0]).sort(),
    nodes: runs.map((r) => [r.id, (r.tickets || []).map((t) => `${t.key}:${t.state}:${(t.points || []).filter((p) => p.state === 'open').length}`)]),
  });
}

/** How many automatic continues this session has had, in total. */
/**
 * Why the last stop of a main session did not continue, in words a person
 * reads. Without it a person who types "continue" by hand cannot tell a
 * broken hook from one that held back on purpose (MACLEOD-726).
 */
export const HELD_WORDS = {
  'background work': 'an agent this session sent out was still working',
  'scheduled wake-up': 'the session had a wake-up set',
  'not in a plan': "this session's ticket is in no running plan",
  'person typing': 'you typed less than a minute before',
  question: 'the session asked you a question',
  error: 'the session ended on an error',
  limit: 'a usage limit was in force',
  'plan mode': 'the session was in plan mode',
  'setting off': 'it is turned off',
  'nothing to do': 'the plan had nothing for this session',
  'nothing ready': 'no item in the plan was ready',
  waiting: 'the work waits for other work to finish',
  streak: 'it had already continued 5 times in a row',
  'no change': 'nothing changed since the last time',
  'another hook': 'another hook was keeping the session going',
};

function heldPath(sessionId) {
  return path.join(core.dataDir(), 'continue', `${core.digest(sessionId)}.held.json`);
}

/** Keep why a main session's stop was not continued; only reasons a person can act on. */
export function noteHeld(sessionId, why, { now = Date.now() } = {}) {
  if (!sessionId || !HELD_WORDS[why]) return false;
  core.writeJson(heldPath(sessionId), { why, at: new Date(now).toISOString() });
  return true;
}

export function continuesOf(sessionId) {
  if (!sessionId) return 0;
  return Number(core.readJson(streakPath(sessionId))?.total) || 0;
}

// --- the decision -----------------------------------------------------------

/**
 * Whether to continue, and with what. Pure but for local reads.
 * Returns `{ continue: false, why }` or `{ continue: true, direction }`,
 * and a `waiting` direction to log when the plan has nothing ready.
 */
export function decide(input = {}, { now = Date.now(), setting = settingOf(), remoteHead = gitRemoteHead, env = process.env } = {}) {
  const no = (why, extra = {}) => ({ continue: false, why, ...extra });
  const event = input.hook_event_name;
  const subagent = event === 'SubagentStop';
  if (event !== 'Stop' && !subagent) return no('not a stop');
  const sessionId = input.session_id;
  if (!sessionId || sessionId === 'unknown-session') return no('no session');
  // Another tool runs this session's loop (MACLEOD-908): never hold it open.
  if (drivenBy(input, env, input.cwd)) return no('driven by another tool');
  if (setting === 'off') return no('setting off');
  if (input.permission_mode === 'plan') return no('plan mode');
  if (endsWithQuestion(input.last_assistant_message)) return no('question');
  if (endedOnError(input.last_assistant_message)) return no('error');
  const paused = pauseOf(sessionId, now);
  if (paused && now < Date.parse(paused.until)) return no('limit');
  const busy = (input.background_tasks || []).some((t) => !['completed', 'failed', 'killed', 'stopped'].includes(String(t?.status)));
  if ((input.session_crons || []).length) return no(busy ? 'background work' : 'scheduled wake-up');

  const agentKey = subagent ? String(input.agent_id || '').trim().slice(0, 80) : undefined;
  if (subagent && !agentKey) return no('no agent');
  const main = core.readJson(core.sessionPath(sessionId));
  const actor = subagent ? core.readJson(core.sessionPath(sessionId, agentKey)) : main;
  if (!actor) return no('no actor');
  // The person is at the keyboard: what they typed drives the session.
  if (!subagent && now - Date.parse(main?.promptAt || 0) < QUIET_MS) return no('person typing');

  const actors = subagent ? [actor] : core.sessionActors(sessionId).filter((a) => !a.ended && !a.absorbedInto);
  const keys = new Set(actors.map((a) => keyOf(a.binding?.key)).filter(Boolean));
  const config = core.loadConfig(main?.cwd || actor.cwd || input.cwd || process.cwd());
  const runs = runsFor(keys, config);
  if (!runs.length && setting !== 'on') return no('not in a plan');
  const steps = {};
  for (const one of actors) if (keyOf(one.binding?.key) && one.stage) steps[one.binding.key] = one.stage;
  // A subagent is directed only when a plan sent it (its ticket is a node).
  if (subagent && !runs.length) return no('not sent by a plan');
  // An actor told to wait for something (MACLEOD-733): start it when
  // that is done, and when it is not, record what it waits for.
  const waited = waitOf(actor, runs, { main, subagent, now, remoteHead, paused });
  if (waited && !waited.over) return no('waiting', { direction: waited.direction, agentKey, config });
  let direction;
  if (busy) {
    // Background work still runs (the owner's ruling, 2026-09-23): go on
    // only with plan work that nothing of this session holds, never with
    // the session's own ticket, which its agent may be working on.
    const holds = heldOf(sessionId, runs);
    const start = waited?.direction;
    // A start is the actor's own key: held when anything but the actor holds it.
    if (start && heldOf(sessionId, runs, agentKey || '').keys.has(start.key)) return no('background work');
    direction = start || directionFor(actor, { runs, steps, subagent, skip: holds.keys });
    if (!direction || !['next', 'start'].includes(direction.kind)) return no('background work');
    direction = { ...direction, reason: direction.reason.replace(/^TeamFlow: /, `TeamFlow: ${stillRunning(holds.agents)} Meanwhile, `) };
  } else {
    direction = waited?.direction || directionFor(actor, { runs, steps, subagent });
    if (!direction) return no('nothing to do');
    if (direction.kind === 'waiting') return no('nothing ready', { direction, config });
  }

  const file = streakPath(sessionId, agentKey);
  const held = core.readJson(file) || {};
  const print = fingerprint(actors, runs);
  // Claude Code sets it while a stop hook's block is being carried out.
  // Not ours: another hook is driving; this one does not stack on it.
  if (input.stop_hook_active && !held.last) return no('another hook');
  const streak = input.stop_hook_active ? Number(held.streak) || 0 : 0;
  if (streak >= STREAK_MAX) return no('streak');
  if (input.stop_hook_active && held.last?.print === print) return no('no change');
  return { continue: true, direction, file, held, print, streak, config, sessionId, agentKey };
}

/**
 * The plan items this session holds while its background work runs: a
 * key any live actor of the session is bound to, a node whose state is
 * running, or a key a dispatch record of the session points at. `agents`
 * is what its agents work on, for the words. `without` leaves one actor
 * out: '' the main session, or an agent's id.
 */
export function heldOf(sessionId, runs = [], without = undefined) {
  const live = core.sessionActors(sessionId)
    .filter((a) => !a.ended && !a.absorbedInto && (without === undefined || (a.agentKey || '') !== without));
  const bound = live.map((a) => keyOf(a.binding?.key)).filter(Boolean);
  const agents = new Set(live.filter((a) => a.agentKey).map((a) => keyOf(a.binding?.key)).filter(Boolean));
  const launched = launchesOf(sessionId).map((l) => keyOf(l.key)).filter(Boolean);
  const byKey = new Map(runs.flatMap((r) => r.tickets || []).map((t) => [t.key, t]));
  for (const key of launched) if (!['done', 'skipped'].includes(byKey.get(key)?.state)) agents.add(key);
  const running = [...byKey.values()].filter((t) => t.state === 'running').map((t) => t.key);
  return { keys: new Set([...bound, ...launched, ...running]), agents: [...agents] };
}

/** What still runs, in words: the agents' keys, or the plain fact. */
function stillRunning(keys) {
  if (!keys.length) return 'your background work is still running.';
  const named = keys.slice(0, 3);
  const list = named.length === 1 ? named[0] : `${named.slice(0, -1).join(', ')} and ${named.at(-1)}`;
  return `${keys.length === 1 ? 'your agent is' : 'your agents are'} still working on ${list}.`;
}

/** Record one continue: the streak on this machine, the direction on the run. */
export function record(decision, { now = Date.now(), lock } = {}) {
  const { direction, file, held, print, streak, config } = decision;
  const at = new Date(now).toISOString();
  if (!decision.agentKey && decision.sessionId) fs.rmSync(heldPath(decision.sessionId), { force: true });
  core.writeJson(file, {
    streak: streak + 1,
    total: (Number(held.total) || 0) + 1,
    last: { print, at, kind: direction.kind, key: direction.key },
  });
  logDirection(direction, config, { at, lock, continued: true });
  noteDirection(decision.sessionId, decision.agentKey, direction, now);
}

// --- the card's own line (MACLEOD-726/733) ----------------------------------
//
// The Progress view reads `directions[]` on the ticket: `{ at, text, next }`,
// drawn as "<text>, 5 min ago" or "Next: <text>". Kept in a file of its
// own per actor, because the async hook rewrites the actor's state at the
// same moment; hook-core puts it on the next report.

const CARD_WORDS = {
  fix: 'Told the agent to fix the failed check',
  points: 'Told the agent to fix the open points',
  finish: 'Told the agent to carry on with the plan',
  next: 'Told the agent to carry on with the plan',
  start: 'Told the agent to start. What it waited for is done',
};

const cardPath = (sessionId, agentKey) => path.join(core.dataDir(), 'continue', `${core.digest(agentKey ? `${sessionId}--${agentKey}` : sessionId)}.card.json`);

/** One line for the actor's card. A wait is a next step; a repeat of the last line is not added. */
export function noteDirection(sessionId, agentKey, direction, now = Date.now()) {
  if (!sessionId || !direction) return false;
  // `note`: a fact the plugin wrote itself in fixed words, such as a
  // commit moved to its right ticket (MACLEOD-845).
  const entry = direction.kind === 'wait'
    ? { at: new Date(now).toISOString(), text: `Start when ${direction.until}`.slice(0, 120), next: true }
    : direction.kind === 'note' && direction.text ? { at: new Date(now).toISOString(), text: String(direction.text).slice(0, 120) }
      : CARD_WORDS[direction.kind] && { at: new Date(now).toISOString(), text: CARD_WORDS[direction.kind] };
  if (!entry) return false;
  const file = cardPath(sessionId, agentKey);
  const held = core.readJson(file) || [];
  if (held.at(-1)?.text === entry.text) return false;
  core.writeJson(file, [...held, entry].slice(-10));
  return true;
}

/** The lines for one actor's card, for its next report. A wait it has since started work after is over. */
export function cardDirections(sessionId, agentKey, workAt = undefined) {
  const held = sessionId ? core.readJson(cardPath(sessionId, agentKey)) : undefined;
  return (Array.isArray(held) ? held : []).filter((entry) => !(entry.next && workAt && workAt > entry.at));
}

/** Put one direction on its run, capped, owed to the board. A repeat of the last one is not added. */
export function logDirection(direction, config = {}, { at = new Date().toISOString(), lock, continued = false } = {}) {
  const runId = direction?.run?.id;
  if (!runId) return false;
  const apply = () => {
    const state = core.readWorkflows(config);
    const run = state.workflows?.[runId];
    if (!run) return false;
    const said = direction.reason.replace(/^TeamFlow: /, '').slice(0, 240);
    const last = (run.directions || []).at(-1);
    if (!continued && last?.said === said) return false;
    const row = { at, kind: direction.kind, said, ...(direction.key ? { key: direction.key } : {}) };
    run.directions = [...(run.directions || []), row].slice(-DIRECTIONS_MAX);
    if (continued) run.continued = (Number(run.continued) || 0) + 1;
    run.directionsOwed = true;
    core.writeWorkflows(state, config);
    return true;
  };
  const locked = lock ? lock(apply) : { locked: true, value: apply() };
  return Boolean(locked.locked && locked.value);
}

/**
 * Send the runs that carry new directions, then clear the mark. Called
 * at a turn's end by the async hook, because the continue hook may not
 * wait on the network. A failed send keeps the mark for the next turn.
 */
export async function publishDirections(config = {}, { publish } = {}) {
  let owed = [];
  try { owed = Object.values(core.readWorkflows(config)?.workflows || {}).filter((run) => run?.directionsOwed); } catch { return 0; }
  if (!owed.length) return 0;
  const send = publish ?? (await import('./workflow.mjs')).publish;
  let sent = 0;
  for (const run of owed) {
    try { await send(run, config); } catch { continue; }
    const state = core.readWorkflows(config);
    const held = state.workflows?.[run.id];
    if (held) { delete held.directionsOwed; core.writeWorkflows(state, config); }
    sent += 1;
  }
  return sent;
}

/** The hook's output for a continue, exactly as Claude Code reads it. */
export function blockOutput(direction) {
  return JSON.stringify({ decision: 'block', reason: direction.reason });
}

/** The `teamflow status` line. */
export function continueLine(sessionId, setting = settingOf()) {
  const said = setting === 'on' ? 'on' : setting === 'off' ? 'off' : 'on for plan runs (the default)';
  const n = continuesOf(sessionId);
  const held = sessionId ? core.readJson(heldPath(sessionId)) : undefined;
  const last = held && HELD_WORDS[held.why] ? ` At the last stop it did not continue: ${HELD_WORDS[held.why]}.` : '';
  return `${said}. ${count(n, 'automatic continue', 'automatic continues')} in this session.${last}`;
}
