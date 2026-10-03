// Tracks: one person's interlocking threads, grouped by themselves
// (MACLEOD-936).
//
// One person on one machine starts several threads that depend on each
// other: a main session, its agents, a second session on a fix the
// first one found, a review. A track is that impromptu project. It has
// a name, a state and an end, and the board lists it with the plans.
//
// What joins two threads, strongest first (the rethink doc, "Tracks"):
//
//   project  the same Claude Code Project id, when a payload names one
//   parent   one session started the other (an agent, a worktree team)
//   run      both hold tickets of the same TeamFlow run
//   ticket   the same ticket key
//   branch   the same branch, or a branch made from the other's branch
//   files    two or more of the same files changed within two hours
//   waits    one ticket depends on the other's in a run
//
// The same repository in the same hour joins nothing on its own: it is
// how two unrelated jobs look, and it is not a signal here at all.
//
// The grouping runs on the machine. File names are hashed when they are
// noted and never leave it; prompts are never read. What is reported is
// the track's id, its name, its members' session and agent ids, its
// state and its times: derived state, as docs/REPORTING_CONTRACT.md
// lists. A track is reported as a workflow document, because a plan and
// a track are one kind of thing: a plan is a track somebody planned.
//
// A person's correction sticks. Rename, merge, split and move are kept
// as constraints, per organisation: a pair of threads held together or
// held apart. Every later pass applies them before any signal, so a
// split by hand is never joined again by the signal that joined it.
//
// Every path fails open: the hook catches a throw and exits 0.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

import {
  dataDir, digest, organisationScope, readJson, readWorkflows, reportScope, sendReport, writeJson,
} from './core.mjs';
import { newId, published } from './workflow.mjs';

export const SIGNALS = ['project', 'parent', 'run', 'ticket', 'branch', 'files', 'waits'];
export const NAME_MAX = 80;
export const MEMBERS_MAX = 50;
const FILES_KEPT = 40;
const FILE_WINDOW_MS = 2 * 60 * 60 * 1000;
const FILES_TO_JOIN = 2;
const LIVE_MS = 60 * 60 * 1000;
const END_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const LOOK_BACK_MS = 4 * 24 * 60 * 60 * 1000;
const PASS_EVERY_MS = 2 * 60 * 1000;
const TRUNKS = new Set(['main', 'master', 'trunk', 'develop', 'HEAD']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// --- on the hook: what this thread touched --------------------------

/**
 * Note what an event says about this thread, on its own state: a hashed
 * file name and the time for an edit, and a Claude Code Project id when
 * the payload carries one. Never the path, never the content.
 */
export function noteTrackSignals(state, input = {}, now = Date.now()) {
  const project = input.project_id ?? input.claude_project_id;
  if (typeof project === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(project)) state.ccProject = project;
  if (!EDIT_TOOLS.has(input.tool_name)) return;
  const file = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (typeof file !== 'string' || !file) return;
  const h = digest(path.resolve(state.cwd || '.', file), 16);
  const at = new Date(now).toISOString();
  const kept = (Array.isArray(state.trackFiles) ? state.trackFiles : []).filter((f) => f.h !== h);
  state.trackFiles = [...kept, { h, at }].slice(-FILES_KEPT);
}

// --- the threads, from local files ----------------------------------

const time = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : 0;
};

/**
 * One thread from one actor's saved state. A session's id is its own;
 * an agent's is the id Claude Code gave it, else its actor file's hash.
 */
export function threadOf(state = {}) {
  if (!state.sessionId) return undefined;
  const agent = state.agentKey ? (state.agent?.id || `agent-${digest(state.agentKey, 12)}`) : undefined;
  const key = state.binding?.key;
  return {
    id: String(agent || state.sessionId).slice(0, 80),
    kind: agent ? 'agent' : 'session',
    parent: agent ? state.agent?.parent || state.sessionId : undefined,
    key,
    title: key && state.jira?.key === key ? state.jira.title : undefined,
    task: agent ? state.agent?.task : undefined,
    branch: state.git?.branch || state.reportedBranch,
    project: state.ccProject,
    account: state.account,
    files: Array.isArray(state.trackFiles) ? state.trackFiles : [],
    startedAt: state.startedAt || state.updatedAt,
    lastAt: state.updatedAt || state.startedAt,
    ended: Boolean(state.ended),
  };
}

/** Every thread on this machine touched in the last few days. */
export function localThreads(now = Date.now()) {
  const dir = path.join(dataDir(), 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const thread = threadOf(readJson(path.join(dir, name)));
    if (thread && now - time(thread.lastAt) < LOOK_BACK_MS) out.push(thread);
  }
  return out;
}

/** The branch a branch was made from, from git's own record, or nothing. */
export function createdFrom(cwd, branch) {
  if (!cwd || !branch || TRUNKS.has(branch)) return undefined;
  try {
    const log = execFileSync('git', ['reflog', 'show', '--format=%gs', `refs/heads/${branch}`], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1500,
    }).trim().split('\n');
    const made = /^branch: Created from (\S+)$/.exec(log[log.length - 1] || '');
    const from = made?.[1]?.replace(/^refs\/heads\//, '').replace(/^origin\//, '');
    return from && !TRUNKS.has(from) && from !== branch ? from : undefined;
  } catch {
    return undefined;
  }
}

/** Ticket key to the runs that hold it, and the depends edges, from this organisation's runs. */
export function runFacts(runs = {}) {
  const keyRuns = new Map();
  const edges = [];
  for (const run of Object.values(runs.workflows || {})) {
    if (!run || ['done', 'cancelled', 'archived'].includes(run.status)) continue;
    for (const t of run.tickets || []) {
      if (!t?.key) continue;
      keyRuns.set(t.key, [...(keyRuns.get(t.key) || []), run.id]);
    }
    for (const d of run.dependencies || []) if (d?.from && d?.on) edges.push([d.from, d.on]);
  }
  return { keyRuns, edges };
}

// --- the grouping ---------------------------------------------------

/**
 * Every pair of threads a signal joins, strongest signal first. Pure:
 * the threads, the runs' facts and the lineage map in, edges out.
 */
export function joins(threads, { keyRuns = new Map(), edges = [], lineage = {} } = {}) {
  const out = [];
  const add = (a, b, by) => { if (a !== b) out.push({ a, b, by }); };
  const byId = new Map(threads.map((t) => [t.id, t]));
  const each = (fn) => {
    for (let i = 0; i < threads.length; i += 1) for (let j = i + 1; j < threads.length; j += 1) fn(threads[i], threads[j]);
  };
  each((x, y) => { if (x.project && x.project === y.project) add(x.id, y.id, 'project'); });
  for (const t of threads) if (t.parent && byId.has(t.parent)) add(t.parent, t.id, 'parent');
  each((x, y) => {
    const a = keyRuns.get(x.key) || [];
    if (x.key && y.key && x.key !== y.key && (keyRuns.get(y.key) || []).some((r) => a.includes(r))) add(x.id, y.id, 'run');
  });
  each((x, y) => { if (x.key && x.key === y.key) add(x.id, y.id, 'ticket'); });
  each((x, y) => {
    const xb = x.branch && !TRUNKS.has(x.branch) ? x.branch : undefined;
    const yb = y.branch && !TRUNKS.has(y.branch) ? y.branch : undefined;
    if (!xb || !yb) return;
    if (xb === yb || lineage[xb] === yb || lineage[yb] === xb) add(x.id, y.id, 'branch');
  });
  each((x, y) => {
    let shared = 0;
    for (const f of x.files || []) {
      if ((y.files || []).some((g) => g.h === f.h && Math.abs(time(g.at) - time(f.at)) <= FILE_WINDOW_MS)) shared += 1;
    }
    if (shared >= FILES_TO_JOIN) add(x.id, y.id, 'files');
  });
  each((x, y) => {
    if (x.key && y.key && edges.some(([from, on]) => (from === x.key && on === y.key) || (from === y.key && on === x.key))) add(x.id, y.id, 'waits');
  });
  return out;
}

/**
 * The threads in groups. A person's constraints first: pairs held
 * together are joined, pairs held apart are never joined by any signal.
 * Then each signal's joins, strongest first. Returns groups of ids with
 * the signals that made each one.
 */
export function group(threads, found = [], constraints = {}) {
  const ids = threads.map((t) => t.id);
  const root = new Map(ids.map((id) => [id, id]));
  const find = (id) => {
    let r = id;
    while (root.get(r) !== r) r = root.get(r);
    root.set(id, r);
    return r;
  };
  const apart = (constraints.apart || []).filter(([a, b]) => root.has(a) && root.has(b));
  const kept = (ra, rb) => !apart.some(([a, b]) => {
    const fa = find(a); const fb = find(b);
    return (fa === ra && fb === rb) || (fa === rb && fb === ra);
  });
  const by = new Map();
  const unite = (a, b, signal) => {
    if (!root.has(a) || !root.has(b)) return;
    const ra = find(a); const rb = find(b);
    if (ra === rb || !kept(ra, rb)) return;
    root.set(rb, ra);
    by.set(ra, new Set([...(by.get(ra) || []), ...(by.get(rb) || []), signal]));
  };
  for (const [a, b] of constraints.together || []) unite(a, b, 'person');
  const order = (s) => SIGNALS.indexOf(s);
  for (const edge of [...found].sort((x, y) => order(x.by) - order(y.by))) unite(edge.a, edge.b, edge.by);
  const groups = new Map();
  for (const id of ids) {
    const r = find(id);
    groups.set(r, [...(groups.get(r) || []), id]);
  }
  return [...groups.entries()].map(([r, members]) => ({ members, by: [...(by.get(r) || [])] }));
}

/**
 * Which earlier track each group continues, so a track keeps its id from
 * pass to pass: the one it shares most threads with. An auto-created run
 * holding the group's tickets gives its id to a group that continues no
 * track, so the run and the track are one thing.
 */
export function carryIds(groups, previous = {}, { autoRunOf = () => undefined, forced = [] } = {}) {
  const taken = new Set(forced.filter(Boolean));
  const scored = groups.map((g, i) => {
    let best; let score = 0;
    for (const [id, track] of Object.entries(previous)) {
      if (taken.has(id)) continue;
      const n = (track.members || []).filter((m) => g.members.includes(m)).length;
      if (n > score) { best = id; score = n; }
    }
    return { i, best, score };
  }).sort((a, b) => b.score - a.score);
  const ids = new Array(groups.length);
  for (const { i, best } of scored) {
    if (forced[i]) { ids[i] = forced[i]; continue; }
    if (best && !taken.has(best)) { ids[i] = best; taken.add(best); continue; }
    const run = autoRunOf(groups[i]);
    if (run && !taken.has(run)) { ids[i] = run; taken.add(run); continue; }
    ids[i] = newId();
    taken.add(ids[i]);
  }
  return ids;
}

/** A track's name: a person's, else its tickets' titles, else its first agent's task. Never a prompt. */
export function nameOf(threads, named) {
  if (named) return String(named).slice(0, NAME_MAX);
  const titles = [...new Set(threads.map((t) => t.title).filter(Boolean))];
  if (titles.length) return (titles.length > 1 ? `${titles[0]} and ${titles.length - 1} more` : titles[0]).slice(0, NAME_MAX);
  const first = threads.filter((t) => t.kind === 'agent' && t.task).sort((a, b) => time(a.startedAt) - time(b.startedAt))[0];
  if (first) return String(first.task).slice(0, NAME_MAX);
  const key = threads.map((t) => t.key).find(Boolean);
  return (key ? `Work on ${key}` : 'Work with no ticket').slice(0, NAME_MAX);
}

/**
 * The track's state. Active while a thread is live; quiet otherwise.
 * Ended when every thread ended or went quiet for three days: the plan
 * rule R5 (MACLEOD-934). When that rule's own function is on this
 * branch's base, call it here instead of this test.
 */
export function stateOf(threads, now = Date.now()) {
  const last = Math.max(0, ...threads.map((t) => time(t.lastAt)));
  if (threads.some((t) => !t.ended && now - time(t.lastAt) < LIVE_MS)) return 'active';
  if (threads.every((t) => t.ended) || now - last >= END_AFTER_MS) return 'ended';
  return 'quiet';
}

/** Whether a track is worth a row: two threads or more, or one a person made. */
export function reportable(track) {
  return (track.members || []).length >= 2 || Boolean(track.named) || Boolean(track.made) || Boolean(track.project);
}

// --- tasks (MACLEOD-970) --------------------------------------------

const BY_SIGNAL = { key: 'ticket', files: 'files', agents: 'parent' };

/**
 * Where each sorted task belongs: a person's move first, else the task's
 * own sort. Tasks in one project are joined; tasks in two are held apart
 * for this pass, so no signal carries a task out of the project it was
 * sorted into.
 */
export function taskAssignments(threads, held) {
  const pinned = threads.filter((t) => t.kind === 'task' && (held.taskMoves?.[t.id] || t.assigned))
    .map((t) => ({ t, at: held.taskMoves?.[t.id] || t.assigned }));
  const edges = [];
  const apart = [];
  for (let i = 0; i < pinned.length; i += 1) {
    for (let j = i + 1; j < pinned.length; j += 1) {
      const x = pinned[i]; const y = pinned[j];
      if (x.at.kind === y.at.kind && x.at.id === y.at.id) {
        const by = held.taskMoves?.[y.t.id] ? 'person' : BY_SIGNAL[y.t.sortedBy] || 'person';
        edges.push({ a: x.t.id, b: y.t.id, by });
      } else {
        apart.push([x.t.id, y.t.id]);
      }
    }
  }
  return { pinned: new Map(pinned.map(({ t, at }) => [t.id, at])), edges, apart };
}

// --- the local state ------------------------------------------------

export function tracksPath(config = {}) {
  const org = organisationScope(config) || 'default';
  return path.join(dataDir(), 'tracks', `${org.replace(/[^A-Za-z0-9._-]+/g, '-')}.json`);
}

export function readTracks(config = {}) {
  const held = readJson(tracksPath(config), {}) || {};
  return {
    tracks: held.tracks && typeof held.tracks === 'object' ? held.tracks : {},
    constraints: {
      together: Array.isArray(held.constraints?.together) ? held.constraints.together : [],
      apart: Array.isArray(held.constraints?.apart) ? held.constraints.apart : [],
    },
    lineage: held.lineage && typeof held.lineage === 'object' ? held.lineage : {},
    sent: held.sent && typeof held.sent === 'object' ? held.sent : {},
    applied: Array.isArray(held.applied) ? held.applied : [],
    // MACLEOD-970: a formal project's lane id on this machine, and the
    // tasks a person moved by hand, which no pass sorts back.
    formal: held.formal && typeof held.formal === 'object' ? held.formal : {},
    taskMoves: held.taskMoves && typeof held.taskMoves === 'object' ? held.taskMoves : {},
    passAt: held.passAt,
  };
}

export function writeTracks(held, config = {}) {
  writeJson(tracksPath(config), held);
}

const samePair = ([a, b], [c, d]) => (a === c && b === d) || (a === d && b === c);

/** Hold two threads together or apart. The newer word about a pair replaces the older. */
export function constrain(held, kind, a, b) {
  if (!a || !b || a === b) return;
  const other = kind === 'together' ? 'apart' : 'together';
  held.constraints[other] = held.constraints[other].filter((p) => !samePair(p, [a, b]));
  if (!held.constraints[kind].some((p) => samePair(p, [a, b]))) held.constraints[kind].push([a, b]);
  held.constraints[kind] = held.constraints[kind].slice(-500);
}

// --- one pass -------------------------------------------------------

/**
 * Group the threads and update the tracks. Pure over its inputs apart
 * from the clock: the threads, the runs and the held state in, the new
 * held state out. Returns the tracks that changed.
 */
export function regroup(held, threads, runs = {}, now = Date.now()) {
  const { keyRuns, edges } = runFacts(runs);
  const tasks = taskAssignments(threads, held);
  const constraints = { together: held.constraints.together, apart: [...held.constraints.apart, ...tasks.apart] };
  const groups = group(threads, [...tasks.edges, ...joins(threads, { keyRuns, edges, lineage: held.lineage })], constraints);
  const byId = new Map(threads.map((t) => [t.id, t]));
  const autoRunOf = (g) => {
    for (const run of Object.values(runs.workflows || {})) {
      if (run?.origin !== 'auto') continue;
      const keys = new Set((run.tickets || []).map((t) => t.key));
      if (g.members.some((m) => keys.has(byId.get(m)?.key))) return run.id;
    }
    return undefined;
  };
  // Only groups a track could be: more than one thread, or a thread a
  // track already holds (a person's split or move made it so).
  const holding = new Set(Object.values(held.tracks).flatMap((t) => t.members || []));
  const live = groups.filter((g) => g.members.length > 1 || holding.has(g.members[0]) || tasks.pinned.has(g.members[0]));
  // A group holding a sorted task takes its project's id: an informal
  // project's own, or this machine's lane id for a formal project.
  const homeOf = (g) => g.members.map((m) => tasks.pinned.get(m)).find(Boolean);
  const forced = live.map((g) => {
    const home = homeOf(g);
    if (!home) return undefined;
    if (home.kind === 'informal') return home.id;
    held.formal = held.formal || {};
    held.formal[home.id] = held.formal[home.id] || newId();
    return held.formal[home.id];
  });
  const ids = carryIds(live, held.tracks, { autoRunOf, forced });
  const next = {};
  live.forEach((g, i) => {
    const id = ids[i];
    const was = held.tracks[id] || {};
    const members = g.members.slice(0, MEMBERS_MAX);
    const mine = members.map((m) => byId.get(m)).filter(Boolean);
    const home = homeOf(g);
    next[id] = {
      id,
      name: home?.kind === 'formal' && !was.named ? String(home.name || nameOf(mine)).slice(0, NAME_MAX)
        : home?.kind === 'informal' && !was.named ? String(was.name || home.name || nameOf(mine)).slice(0, NAME_MAX)
          : nameOf(mine, was.named),
      named: was.named,
      made: was.made,
      project: home?.kind === 'formal' ? home.id : undefined,
      members,
      kinds: Object.fromEntries(mine.map((t) => [t.id, t.kind])),
      keys: [...new Set(mine.map((t) => t.key).filter(Boolean))].slice(0, 20),
      by: g.by,
      run: autoRunOf(g),
      state: stateOf(mine, now),
      startedAt: was.startedAt || new Date(Math.min(...mine.map((t) => time(t.startedAt) || now))).toISOString(),
      lastAt: new Date(Math.max(...mine.map((t) => time(t.lastAt)))).toISOString(),
    };
    if (next[id].state === 'ended') next[id].endedAt = was.endedAt || new Date(now).toISOString();
  });
  // A track whose threads aged out of view keeps its last word until it ends.
  for (const [id, was] of Object.entries(held.tracks)) {
    if (next[id] || was.state === 'ended') continue;
    if (now - time(was.lastAt) < END_AFTER_MS) next[id] = was;
  }
  held.tracks = next;
  return Object.values(next).filter((t) => reportable(t));
}

/** The workflow document a track is reported as: ids and derived state only. */
export function trackDocument(track, run = undefined) {
  const base = run ? published(run) : {
    id: track.id,
    name: track.name,
    status: track.state === 'ended' ? 'done' : 'running',
    tickets: track.keys.map((key) => ({ key, state: track.state === 'ended' ? 'done' : 'running', addedBy: 'dispatch' })),
    dependencies: [],
    phases: [],
    createdAt: track.startedAt,
    updatedAt: track.lastAt,
  };
  // An auto-created run keeps the run's name, so its two writers agree;
  // a person's name wins on both (the service keeps it, MACLEOD-936).
  base.name = run && !track.named ? run.name : track.name;
  if (!run) base.origin = 'track';
  base.track = {
    members: track.members.map((id) => ({ id, kind: ['agent', 'task'].includes(track.kinds?.[id]) ? track.kinds[id] : 'session' })),
    state: track.state,
    by: track.by.filter((s) => s === 'person' || SIGNALS.includes(s)),
    startedAt: track.startedAt,
    lastAt: track.lastAt,
  };
  if (track.endedAt) base.track.endedAt = track.endedAt;
  if (track.named) base.track.named = true;
  // A person's lane in a formal project (MACLEOD-970), not a project of its own.
  if (track.project) base.track.project = track.project;
  return base;
}

/**
 * The pass the `Stop` hook runs: at most every two minutes, on the main
 * session. Reads the threads, groups them, keeps the tracks and sends
 * each one that changed. Never throws.
 */
export async function tracksOnStop(config = {}, { cwd, now = Date.now(), send = sendReport, threads, runs, pull = pullCorrections } = {}) {
  try {
    const held = readTracks(config);
    if (held.passAt && now - time(held.passAt) < PASS_EVERY_MS) return { skipped: true };
    held.passAt = new Date(now).toISOString();
    await pull(config, held);
    const org = reportScope(config);
    const scope = organisationScope(config);
    let local = threads;
    if (!local) {
      local = localThreads(now);
      // A session that has tasks is its tasks (MACLEOD-970).
      try { local = (await import('./tasks.mjs')).withTasks(local, now); } catch { /* the sessions stand */ }
    }
    const mine = local.filter((t) => !scope || !t.account || t.account === scope);
    for (const t of mine) {
      if (t.branch && !(t.branch in held.lineage)) held.lineage[t.branch] = createdFrom(cwd, t.branch) || null;
    }
    const all = runs || readWorkflows(config);
    const changed = regroup(held, mine, all, now);
    const sent = [];
    for (const track of changed) {
      const doc = trackDocument(track, track.run ? all.workflows?.[track.run] : undefined);
      const hash = digest(JSON.stringify(doc), 16);
      if (held.sent[track.id] === hash) continue;
      await send('workflow', null, doc, config, { account: org, flush: false });
      held.sent[track.id] = hash;
      sent.push(track.id);
    }
    writeTracks(held, config);
    return { sent, tracks: changed.length };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// --- corrections ----------------------------------------------------

function trackOf(held, wanted) {
  const want = String(wanted || '').trim();
  if (held.tracks[want]) return held.tracks[want];
  const lower = want.toLowerCase();
  return Object.values(held.tracks).find((t) => t.name.toLowerCase() === lower);
}

/** Rename a track. A person's name stays until a person changes it. */
export function rename(held, id, name) {
  const track = trackOf(held, id);
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  if (!track) return { error: 'TeamFlow has no track with that name.' };
  if (!clean) return { error: 'Give the track a name.' };
  track.named = clean;
  track.name = clean;
  return { track };
}

/** Merge `from` into `into`. Their threads stay together from now on. */
export function merge(held, into, from) {
  const a = trackOf(held, into); const b = trackOf(held, from);
  if (!a || !b) return { error: 'TeamFlow has no track with that name.' };
  if (a.id === b.id) return { error: 'Pick two different tracks.' };
  for (const m of b.members) constrain(held, 'together', a.members[0], m);
  a.members = [...new Set([...a.members, ...b.members])];
  a.kinds = { ...b.kinds, ...a.kinds };
  delete held.tracks[b.id];
  return { track: a, gone: b.id };
}

/** Split threads out of a track into a new one. They stay apart from the rest. */
export function split(held, id, threads = [], newTrack = undefined) {
  const track = trackOf(held, id);
  if (!track) return { error: 'TeamFlow has no track with that name.' };
  const out = threads.filter((t) => track.members.includes(t));
  const rest = track.members.filter((m) => !out.includes(m));
  if (!out.length || !rest.length) return { error: 'Pick some of the track\'s threads, but not all of them.' };
  for (const o of out) for (const r of rest) constrain(held, 'apart', o, r);
  for (const o of out.slice(1)) constrain(held, 'together', out[0], o);
  track.members = rest;
  const made = {
    id: newTrack || newId(), name: `Split from ${track.name}`.slice(0, NAME_MAX), made: true,
    members: out, kinds: track.kinds, keys: [], by: ['person'], state: track.state, startedAt: track.startedAt, lastAt: track.lastAt,
  };
  held.tracks[made.id] = made;
  return { track, made };
}

/** Move one thread to another track. It stays there. */
export function moveThread(held, thread, to) {
  const target = trackOf(held, to);
  if (!target) return { error: 'TeamFlow has no track with that name.' };
  const from = Object.values(held.tracks).find((t) => t.members.includes(thread));
  if (from?.id === target.id) return { error: 'That thread is in that track already.' };
  if (from) {
    for (const m of from.members) if (m !== thread) constrain(held, 'apart', thread, m);
    from.members = from.members.filter((m) => m !== thread);
  }
  if (target.members[0]) constrain(held, 'together', target.members[0], thread);
  target.members = [...new Set([...target.members, thread])];
  return { track: target, from: from?.id };
}

/** Apply one correction, from this machine or from the board. */
export function applyCorrection(held, c = {}) {
  if (!c.kind) return { error: 'unknown' };
  if (c.kind === 'rename') return rename(held, c.track, c.name);
  if (c.kind === 'merge') return merge(held, c.track, c.from);
  if (c.kind === 'split') return split(held, c.track, c.threads, c.made);
  if (c.kind === 'move') {
    const moved = moveThread(held, c.thread, c.track);
    // A task moved on the board stays there (MACLEOD-970).
    if (!moved.error && String(c.thread).includes('#')) {
      moved.track.kinds = { ...moved.track.kinds, [c.thread]: 'task' };
      held.taskMoves = { ...(held.taskMoves || {}), [c.thread]: { kind: 'informal', id: moved.track.id, name: moved.track.name } };
    }
    return moved;
  }
  return { error: 'unknown' };
}

async function request(method, route, body, config = {}) {
  const { credential, serviceUrl } = await import('./core.mjs');
  const cred = await credential(config);
  if (!cred) return { ok: false, reason: 'TeamFlow has no sign-in on this machine.' };
  try {
    const response = await fetch(`${serviceUrl(config)}/v1/members/tracks${route}`, {
      method,
      headers: { [cred.header]: cred.value, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 5000)),
    });
    let parsed;
    try { parsed = await response.json(); } catch { parsed = undefined; }
    return response.ok ? { ok: true, body: parsed } : { ok: false, reason: parsed?.message || `The service answered ${response.status}.` };
  } catch {
    return { ok: false, reason: 'TeamFlow could not reach the service.' };
  }
}

/** The organisation's corrections this machine has not applied yet. */
export async function pullCorrections(config, held, ask = request) {
  const got = await ask('GET', '/corrections', undefined, config);
  for (const c of got.ok ? got.body?.corrections || [] : []) {
    if (!c?.id || held.applied.includes(c.id)) continue;
    applyCorrection(held, c);
    held.applied = [...held.applied, c.id].slice(-1000);
  }
}

export const TRACK_USAGE = 'Usage: teamflow track list | rename <track> "<name>" | merge <into> <from> | split <track> <thread>... | move <thread> <track>';

function lines(held) {
  const tracks = Object.values(held.tracks).filter(reportable);
  if (!tracks.length) return ['TeamFlow found no tracks on this machine yet.'];
  return tracks.map((t) => `${t.id}  ${t.name} · ${t.state} · ${t.members.length} threads`);
}

/** `teamflow track …`: list the tracks, or correct one. A correction is kept here and sent to the board. */
export async function trackMain(args = [], { config = {}, ask = request, print = console.log } = {}) {
  const [verb, ...rest] = args;
  const held = readTracks(config);
  if (!verb || verb === 'list') {
    for (const line of lines(held)) print(line);
    return 0;
  }
  let correction;
  if (verb === 'rename' && rest.length >= 2) correction = { kind: 'rename', track: rest[0], name: rest.slice(1).join(' ') };
  else if (verb === 'merge' && rest.length === 2) correction = { kind: 'merge', track: rest[0], from: rest[1] };
  else if (verb === 'split' && rest.length >= 2) correction = { kind: 'split', track: rest[0], threads: rest.slice(1), made: newId() };
  else if (verb === 'move' && rest.length === 2) correction = { kind: 'move', thread: rest[0], track: rest[1] };
  if (!correction) {
    print(TRACK_USAGE);
    return 2;
  }
  // Ids, not names, travel: the board knows a track by its id.
  const target = trackOf(held, correction.track);
  if (target) correction.track = target.id;
  if (correction.from) correction.from = trackOf(held, correction.from)?.id || correction.from;
  const done = applyCorrection(held, correction);
  if (done.error) {
    print(done.error);
    return 1;
  }
  delete held.sent[correction.track];
  if (correction.made) delete held.sent[correction.made];
  const route = `/${correction.track}/${verb}`;
  const body = { name: correction.name, from: correction.from, threads: correction.threads, made: correction.made, thread: correction.thread };
  const sent = await ask('POST', route, body, config);
  if (sent.ok && sent.body?.correction?.id) held.applied = [...held.applied, sent.body.correction.id].slice(-1000);
  writeTracks(held, config);
  print(sent.ok ? 'Done. TeamFlow keeps this change.' : `Done on this machine. The board gets it later. ${sent.reason}`);
  return 0;
}
