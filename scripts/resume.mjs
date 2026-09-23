// Where a session was, kept before a limit can stop it (MACLEOD-641).
//
// The owner: "Do preemptive workflow saving / resume status saving when
// nearing limits." A session can stop at a usage limit, at a context
// compaction, or when a tool moves it to another account. Whatever
// resumes it (the same session, a compacted one, or a successor linked
// by `continues`) should know at once what it was doing.
//
// So each session keeps one small snapshot on this machine, at
// `<data>/resume/<digest>.json`: the bound key, the plan runs that hold
// its cards with each node's state, its open agents (name, key, stage,
// status and their one-line task), the last step each card reached, its
// pause, and the time. It is never sent anywhere: the task line stays on
// this machine, like everything else a snapshot holds. It is written
// atomically and only when something in it changed, and it is kept for
// seven days.
import fs from 'node:fs';
import path from 'node:path';

import * as core from './core.mjs';
import { pauseOf } from './heartbeat.mjs';

export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const OPEN_RUNS = new Set(['running', 'stalled', 'planning']);
const AGENTS_MAX = 20;

/** One session's snapshot file, named by the same digest a beat carries. */
export function snapshotPath(digest) {
  return path.join(core.dataDir(), 'resume', `${digest}.json`);
}

const clip = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined);

/** What the session is doing now, from this machine's own records. */
export function snapshotOf(sessionId, config = {}, now = Date.now()) {
  const actors = core.sessionActors(sessionId);
  const main = actors.find((one) => !one.agentKey);
  const agents = actors
    .filter((one) => one.agentKey && one.agent?.startedAt && !one.agent.endedAt && !one.ended && !one.absorbedInto)
    .slice(0, AGENTS_MAX)
    .map((one) => ({
      name: clip(one.agent?.name, 64) || 'agent',
      key: one.binding?.key,
      stage: one.stage,
      status: one.status,
      task: clip(one.agent?.task, 200),
    }));
  const keys = new Set([main?.binding?.key, ...agents.map((a) => a.key)].filter(Boolean));
  const steps = {};
  for (const one of actors) if (one.binding?.key && one.stage) steps[one.binding.key] = one.stage;
  let workflows = {};
  try { workflows = core.readWorkflows(config)?.workflows || {}; } catch { /* no plan on this machine */ }
  const plans = Object.values(workflows)
    .filter((run) => OPEN_RUNS.has(run?.status) && (run.tickets || []).some((t) => keys.has(t.key)))
    .map((run) => ({ id: run.id, name: clip(run.name, 80), status: run.status, nodes: (run.tickets || []).map((t) => ({ key: t.key, state: t.state })) }));
  const paused = pauseOf(sessionId, now);
  return {
    key: main?.binding?.key,
    plans,
    agents,
    steps,
    ...(paused ? { timers: { pausedUntil: paused.until, estimated: paused.estimated } } : {}),
  };
}

/**
 * Save the snapshot when it changed. Returns true when it wrote. Cheap:
 * a few local reads, and one atomic write only when the content moved.
 */
export function saveSnapshot(sessionId, { config = {}, now = Date.now() } = {}) {
  if (!sessionId || sessionId === 'unknown-session') return false;
  const file = snapshotPath(core.digest(sessionId));
  const next = snapshotOf(sessionId, config, now);
  const held = core.readJson(file);
  if (held) {
    const { at: _at, ...before } = held;
    if (JSON.stringify(before) === JSON.stringify(next)) return false;
  }
  core.writeJson(file, { ...next, at: new Date(now).toISOString() });
  return true;
}

/** Delete snapshots older than a week. */
export function pruneSnapshots(now = Date.now()) {
  const dir = path.join(core.dataDir(), 'resume');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  let gone = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > KEEP_MS) { fs.rmSync(file, { force: true }); gone += 1; }
    } catch { /* already gone */ }
  }
  return gone;
}

const STEP = {
  BACKLOG: 'Backlog', LOCAL_DEV: 'Local Dev', LOCAL_TEST: 'Local Test', LOCAL_AUDIT: 'Local Audit',
  LOCAL_REWORK: 'Local Rework', MERGE: 'Merge', CI_BUILD: 'CI/CD', DEPLOY_DEV: 'CI/CD', DEV_TEST: 'Dev Test',
  DEV_AUDIT: 'Dev Audit', DEV_REWORK: 'Dev Rework', DEV_VERIFIED: 'Dev Verified', DONE: 'Done',
};

/**
 * The block a resumed session reads first: at most six short lines, from
 * a snapshot. Undefined when there is nothing to say.
 */
export function resumeBlock(snapshot) {
  if (!snapshot || (!snapshot.key && !snapshot.agents?.length && !snapshot.plans?.length)) return undefined;
  const lines = [];
  if (snapshot.key) {
    const step = STEP[snapshot.steps?.[snapshot.key]];
    const plan = snapshot.plans?.find((p) => p.nodes?.some((n) => n.key === snapshot.key))?.name;
    lines.push(`You were working on ${snapshot.key}${step ? ` (${step})` : ''}${plan ? ` in the plan '${plan}'` : ''}.`);
  }
  const open = (snapshot.agents || []).slice(0, 4)
    .map((a) => `${a.name}${a.key ? ` (${a.key}${STEP[a.stage] ? `, ${STEP[a.stage]}` : ''})` : ''}`);
  if (open.length) lines.push(`Agents still open: ${open.join('; ')}.`);
  const waiting = (snapshot.plans || []).flatMap((p) => (p.nodes || []).filter((n) => n.state === 'running' && n.key !== snapshot.key).map((n) => n.key));
  if (waiting.length) lines.push(`Plan work in progress: ${[...new Set(waiting)].slice(0, 6).join(', ')}.`);
  lines.push('Carry on from there. Dispatch again any agent that stopped.');
  return `TeamFlow: ${lines.join(' ')}`;
}

/**
 * The block for a session that just started, once per session: its own
 * snapshot after a resume or a compaction, or its predecessor's when it
 * carries on after a hand-off (`continues`).
 */
export function resumeNotice(state, { source, continues } = {}) {
  if (!state?.sessionId || state.resumeShown) return undefined;
  const digest = continues || (source === 'resume' || source === 'compact' ? core.digest(state.sessionId) : undefined);
  if (!digest) return undefined;
  const block = resumeBlock(core.readJson(snapshotPath(digest)));
  if (block) state.resumeShown = true;
  return block;
}

// Where Claude Code says how close a limit is: only the statusline's JSON
// (`rate_limits.five_hour|seven_day|spend_limit.used_percentage`, and
// `context_window.used_percentage`). No hook event warns before a limit.
const NEAR = 80;
const WINDOWS = ['five_hour', 'seven_day', 'spend_limit'];

/** The windows at or past 80 % in one statusline JSON, e.g. ['five_hour', 'context']. */
export function nearLimits(status = {}) {
  const out = WINDOWS.filter((w) => Number(status.rate_limits?.[w]?.used_percentage) >= NEAR);
  if (Number(status.context_window?.used_percentage) >= NEAR) out.push('context');
  return out;
}

/**
 * The statusline tap (`teamflow statusline-tap`, MACLEOD-641). When a
 * window first crosses 80 %, save the snapshot and publish the session's
 * open plan runs, so the board holds the latest plan before the limit
 * hits. Once per crossing: a window that drops back under 80 % may cross
 * again. Returns the windows it acted on.
 */
export async function usageTap(status = {}, { config = {}, now = Date.now(), publish } = {}) {
  const sessionId = status.session_id;
  if (!sessionId) return [];
  const file = snapshotPath(core.digest(sessionId)).replace(/\.json$/, '.near');
  const near = nearLimits(status);
  const held = core.readJson(file) || {};
  const fresh = near.filter((w) => !held[w]);
  if (near.length !== Object.keys(held).length || fresh.length) {
    core.writeJson(file, Object.fromEntries(near.map((w) => [w, held[w] || new Date(now).toISOString()])));
  }
  if (!fresh.length) return [];
  saveSnapshot(sessionId, { config, now });
  const send = publish ?? (await import('./workflow.mjs')).publish;
  const ids = new Set((core.readJson(snapshotPath(core.digest(sessionId)))?.plans || []).map((p) => p.id));
  const runs = Object.values(core.readWorkflows(config)?.workflows || {}).filter((run) => ids.has(run.id));
  for (const run of runs) {
    try { await send(run, config); } catch { /* the next report carries it */ }
  }
  return fresh;
}

/** The `teamflow status` line. */
export function snapshotLine(sessionId, now = Date.now()) {
  const held = sessionId ? core.readJson(snapshotPath(core.digest(sessionId))) : undefined;
  const at = Date.parse(held?.at || '');
  if (!Number.isFinite(at)) return 'none yet. It is saved at the next stop, compaction or limit.';
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes < 1 ? 'saved less than a minute ago.' : `saved ${minutes} min ago.`;
}
