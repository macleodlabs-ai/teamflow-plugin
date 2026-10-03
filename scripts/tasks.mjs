// Tasks (MACLEOD-970, docs/PROJECTS.md "Sorting a task").
//
// A session runs for days over many topics, so a session is not a
// project. A task is one thing a person asked for, plus the edits, agents
// and commits it caused. It is keyed by the Claude Code session id and a
// number, `<session>#<n>`, never by the account: a rotated session keeps
// its id, so its tasks keep their projects.
//
// A prompt that starts no work joins no task. A task starts at the first
// edit, agent dispatch or commit after a prompt, and is sorted, first
// match wins:
//
//   1. key      a ticket key bound from the prompt, the branch or a brief:
//               that ticket's formal project
//   2. files    the same files (hashed) or agents as a live task: its project
//   3. claude   `teamflow task new "<name>"` or `teamflow task in <id>`,
//               which the UserPromptSubmit line asks Claude to run
//   4. default  the project of the session's last task
//
// A task sorted by a key, by Claude or by a person is never sorted again
// by the plugin; a move by hand sticks.
//
// The prompt text is read once, to tell a slash command or a one-word
// reply from work, and is never stored and never reported. File names
// are hashed. What is reported, through tracks.mjs, is the task's id,
// its project's id and the name Claude or a person gave.
//
// Every hook path fails open: the callers catch a throw.

import fs from 'node:fs';
import path from 'node:path';

import {
  dataDir, digest, isAdHocKey, latestSessionForCwd, ownPromptText, publishState, readJson, readWorkflows,
  saveSession, sessionPath, writeJson,
} from './core.mjs';
import { projectFor, projectsCachePath } from './project.mjs';
import { NAME_MAX, moveThread, readTracks, writeTracks } from './tracks.mjs';
import { newId } from './workflow.mjs';
import { promptLine, taskCommand } from './task-line.mjs';

export { isTaskLine, noIssueLine, promptLine, taskCommand } from './task-line.mjs';

export const PROJECTS_LISTED = 8;
const FILES_KEPT = 40;
const AGENTS_KEPT = 20;
const SAME_WORK_MS = 2 * 60 * 60 * 1000;
const OPEN_MS = 3 * 24 * 60 * 60 * 1000;
const LOOK_BACK_MS = 4 * 24 * 60 * 60 * 1000;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DISPATCH_TOOLS = new Set(['Agent', 'Task']);
// Sorted for good: the plugin never sorts these tasks again.
const STICKY = new Set(['key', 'claude', 'person']);

const time = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : 0;
};
const iso = (now) => new Date(now).toISOString();

// --- the session's task file ----------------------------------------

function tasksDir() {
  return path.join(dataDir(), 'tasks');
}

function tasksPath(sessionId) {
  return path.join(tasksDir(), `${String(sessionId).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 120)}.json`);
}

/** One session's tasks. Keyed by the session id alone. */
export function readTasks(sessionId) {
  const held = readJson(tasksPath(sessionId), {}) || {};
  return {
    session: String(sessionId),
    n: Number(held.n) || 0,
    current: held.current,
    promptAt: held.promptAt,
    quiet: Boolean(held.quiet),
    tasks: held.tasks && typeof held.tasks === 'object' ? held.tasks : {},
  };
}

function writeTasks(file) {
  writeJson(tasksPath(file.session), file);
}

function allTaskFiles() {
  let names = [];
  try { names = fs.readdirSync(tasksDir()); } catch { return []; }
  return names.filter((n) => n.endsWith('.json')).map((n) => readJson(path.join(tasksDir(), n))).filter((f) => f?.session);
}

/** The task this session works on now, or a new one when the last prompt came after it. */
function currentOrNew(file, now) {
  const current = file.tasks[file.current];
  if (current && (!file.promptAt || time(current.startedAt) >= time(file.promptAt))) return current;
  file.n += 1;
  // The service's shape: no '#', '/', '\\' or space before the '#', at most 72.
  const id = `${file.session.replace(/[#/\\\s]+/g, '-').slice(0, 70)}#${file.n}`;
  const task = { id, n: file.n, startedAt: iso(now), lastAt: iso(now), files: [], agents: [] };
  file.tasks[id] = task;
  file.current = id;
  return task;
}

// --- the prompt -----------------------------------------------------

/** A prompt that starts no work by rule: a slash command or a one-word reply. */
export function quietPrompt(prompt) {
  const text = ownPromptText(prompt).trim();
  if (!text || text.startsWith('/')) return true;
  return text.split(/\s+/).length <= 1;
}

/**
 * UserPromptSubmit, the main session only: note that a prompt came and
 * whether it can start work. Never the text. Returns the one line for
 * Claude, or nothing for a prompt that starts no work.
 */
export function onPrompt(sessionId, prompt, { config = {}, now = Date.now(), env = process.env } = {}) {
  const file = readTasks(sessionId);
  file.promptAt = iso(now);
  file.quiet = quietPrompt(prompt);
  writeTasks(file);
  if (file.quiet) return undefined;
  return promptLine(openProjects({ config, now }), taskCommand(env));
}

/** The person's open projects, newest first, at most eight: informal ones and the formal ones their tasks are in. */
export function openProjects({ config = {}, now = Date.now() } = {}) {
  const found = new Map();
  const add = (id, name, lastAt) => {
    if (!id || !name) return;
    const was = found.get(id);
    if (!was || time(lastAt) > time(was.lastAt)) found.set(id, { id, name: String(name).slice(0, NAME_MAX), lastAt });
  };
  for (const track of Object.values(readTracks(config).tracks)) {
    if (track.state === 'ended' || track.project) continue;
    add(track.id, track.name, track.lastAt);
  }
  for (const f of allTaskFiles()) {
    for (const task of Object.values(f.tasks || {})) {
      if (task.project?.kind === 'formal' && now - time(task.lastAt) < OPEN_MS) add(task.project.id, task.project.name, task.lastAt);
    }
  }
  return [...found.values()].sort((a, b) => time(b.lastAt) - time(a.lastAt)).slice(0, PROJECTS_LISTED);
}

/** The one line the UserPromptSubmit hook adds. Plain words; "project", never track or plan. */

// --- the work -------------------------------------------------------

/**
 * The formal project that holds a ticket, from what this machine already
 * has: a Jira project by the key's prefix; a Linear project named by the
 * filter of a local run that holds the ticket (`workflow create --tracker
 * linear --project <p>`); else the repository's project. A Linear issue's
 * own project is not read here: that would be a network call per task.
 */
export function formalProjectFor(key, repository, projects = [], runs = {}) {
  if (!key || isAdHocKey(key) || !Array.isArray(projects)) return undefined;
  const prefix = String(key).split('-')[0].toUpperCase();
  const jira = projects.find((p) => (p.jira || []).some((j) => String(j?.key || '').toUpperCase() === prefix));
  if (jira) return jira;
  for (const run of Object.values(runs?.workflows || {})) {
    const wanted = String(run?.filter?.project || '').toLowerCase();
    if (!wanted || (run.filter.tracker && run.filter.tracker !== 'linear')) continue;
    if (!(run.tickets || []).some((t) => t?.key === key)) continue;
    const linear = projects.find((p) => (p.linear || []).some((l) => [l?.id, l?.name].some((v) => String(v || '').toLowerCase() === wanted)));
    if (linear) return linear;
  }
  return projectFor(repository, projects);
}

function localRuns(config) {
  try { return readWorkflows(config); } catch { return {}; }
}

function cachedProjects(config) {
  try { return readJson(projectsCachePath(config))?.projects || []; } catch { return []; }
}

function workOf(input = {}) {
  if (EDIT_TOOLS.has(input.tool_name)) {
    const file = input.tool_input?.file_path || input.tool_input?.notebook_path;
    return typeof file === 'string' && file ? { file } : undefined;
  }
  if (DISPATCH_TOOLS.has(input.tool_name)) {
    const name = input.tool_input?.name || input.tool_input?.description || input.tool_input?.subagent_type;
    return { agent: name ? String(name) : 'agent' };
  }
  if (input.tool_name === 'Bash' && /\bgit\b[^\n]*\bcommit\b/.test(String(input.tool_input?.command || ''))) return { commit: true };
  return undefined;
}

/** The project of the most recent live task elsewhere that shares a file or an agent with this one. */
function sameWork(task, now) {
  let best;
  for (const f of allTaskFiles()) {
    for (const other of Object.values(f.tasks || {})) {
      if (other.id === task.id || !other.project || now - time(other.lastAt) > SAME_WORK_MS) continue;
      const files = (other.files || []).some((g) => (task.files || []).some((h) => h.h === g.h && Math.abs(time(h.at) - time(g.at)) <= SAME_WORK_MS));
      const agents = (other.agents || []).some((a) => (task.agents || []).includes(a));
      if ((files || agents) && (!best || time(other.lastAt) > time(best.task.lastAt))) best = { task: other, by: files ? 'files' : 'agents' };
    }
  }
  return best;
}

/**
 * PostToolUse, the main session only: an edit, an agent dispatch or a
 * commit. Starts a task after a prompt that may start work, adds the
 * hashed file or agent to it and sorts it. Returns the task, or nothing.
 */
export function noteTaskWork(sessionId, input = {}, { config = {}, state = {}, repository, projects, now = Date.now() } = {}) {
  const work = workOf(input);
  if (!work) return undefined;
  const file = readTasks(sessionId);
  const current = file.tasks[file.current];
  const startsNew = file.promptAt && !file.quiet && !(current && time(current.startedAt) >= time(file.promptAt));
  if (!startsNew && !current) return undefined;
  const previous = current;
  const task = startsNew ? currentOrNew(file, now) : current;
  const at = iso(now);
  task.lastAt = at;
  if (work.file) {
    const h = digest(path.resolve(input.cwd || state.cwd || '.', work.file), 16);
    task.files = [...(task.files || []).filter((f) => f.h !== h), { h, at }].slice(-FILES_KEPT);
  }
  if (work.agent) task.agents = [...new Set([...(task.agents || []), digest(work.agent, 12)])].slice(-AGENTS_KEPT);
  if (!STICKY.has(task.by)) sortTask(task, { state, repository, projects: projects || cachedProjects(config), runs: localRuns(config), previous: startsNew ? previous : undefined, now });
  writeTasks(file);
  // A new task lets go of the last task's card: it was that task's alone.
  if (startsNew && previous && state?.binding?.source === 'task' && state.binding.key === previous.key) task.releasedCard = previous.key;
  return task;
}

function sortTask(task, { state, repository, projects, runs, previous, now }) {
  const key = state?.binding?.key;
  if (key && !isAdHocKey(key)) {
    task.key = key;
    const formal = formalProjectFor(key, repository, projects, runs);
    if (formal) {
      task.project = { kind: 'formal', id: formal.id, name: formal.name };
      task.by = 'key';
      return;
    }
  }
  const same = sameWork(task, now);
  if (same) {
    task.project = same.task.project;
    task.by = same.by;
    return;
  }
  if (!task.project && previous?.project) {
    task.project = previous.project;
    task.by = 'default';
  }
}

// --- for the tracks pass --------------------------------------------

/** Every task on this machine touched in the last few days, as a thread the tracks pass groups. */
export function taskThreads(now = Date.now()) {
  const out = [];
  for (const f of allTaskFiles()) {
    const ended = Boolean(readJson(path.join(dataDir(), 'sessions', `${f.session}.json`))?.ended);
    for (const task of Object.values(f.tasks || {})) {
      if (now - time(task.lastAt) >= LOOK_BACK_MS) continue;
      out.push({
        id: task.id,
        kind: 'task',
        session: f.session,
        key: task.key,
        files: task.files || [],
        startedAt: task.startedAt,
        lastAt: task.lastAt,
        ended,
        assigned: task.project,
        sortedBy: task.by,
      });
    }
  }
  return out;
}

/**
 * The threads the pass groups: a session that has tasks is its tasks, not
 * one thread, so a long session's tasks can sit in different projects.
 * An agent's parent is the task that was current when it started.
 */
export function withTasks(threads = [], now = Date.now()) {
  const tasks = taskThreads(now);
  const bySession = new Map();
  for (const t of tasks) bySession.set(t.session, [...(bySession.get(t.session) || []), t]);
  const out = [];
  for (const thread of threads) {
    if (thread.kind === 'session' && bySession.has(thread.id)) continue;
    const mine = thread.kind === 'agent' ? bySession.get(thread.parent) : undefined;
    if (mine) {
      const started = time(thread.startedAt);
      const at = mine.filter((t) => time(t.startedAt) <= started).sort((a, b) => time(b.startedAt) - time(a.startedAt))[0];
      out.push({ ...thread, parent: at?.id });
      continue;
    }
    out.push(thread);
  }
  return [...out, ...tasks];
}

// --- `teamflow task` ------------------------------------------------

export const TASK_USAGE = 'Usage: teamflow task new "<name>" | in <id> | show';

function sessionOf({ sessionId, cwd, config }) {
  if (sessionId) return sessionId;
  if (process.env.TEAMFLOW_SESSION_ID) return process.env.TEAMFLOW_SESSION_ID;
  try { return latestSessionForCwd(cwd || process.cwd(), config)?.sessionId; } catch { return undefined; }
}

/** Take a task out of every project it was held in, so the new word is the only one. */
function release(held, taskId) {
  for (const kind of ['together', 'apart']) held.constraints[kind] = held.constraints[kind].filter((p) => !p.includes(taskId));
  for (const track of Object.values(held.tracks)) {
    if (track.members?.includes(taskId)) track.members = track.members.filter((m) => m !== taskId);
  }
  delete held.taskMoves[taskId];
}

function findProject(held, wanted, config) {
  const want = String(wanted || '').trim();
  const lower = want.toLowerCase();
  const track = held.tracks[want] || Object.values(held.tracks).find((t) => t.state !== 'ended' && String(t.name).toLowerCase() === lower);
  if (track && !track.project) return { kind: 'informal', id: track.id, name: track.name };
  const formal = cachedProjects(config).find((p) => p.id === want || String(p.name).toLowerCase() === lower)
    || (track?.project ? cachedProjects(config).find((p) => p.id === track.project) : undefined);
  return formal ? { kind: 'formal', id: formal.id, name: formal.name } : undefined;
}

/**
 * The task's ad hoc card, bound to this session only. `adhoc start` writes
 * the working copy's binding, which would move every other session in the
 * repository onto this card; this writes the session's own state and
 * nothing else. Source `task`: sticky against a branch key, never ended by
 * the end of a turn, and let go when the session's next task starts.
 */
export async function sessionTaskCard(title, sessionId, {
  config = {}, info = {}, now = Date.now(), mintKey, publish = publishState,
} = {}) {
  const state = readJson(sessionPath(sessionId));
  if (!state?.sessionId) throw new Error('TeamFlow has no record of this session yet');
  const adhoc = await import('./adhoc.mjs');
  const minted = await (mintKey || adhoc.mint)(config);
  if (!minted?.ok) throw new Error(minted?.reason || 'the service did not answer');
  const at = new Date(now).toISOString();
  state.binding = { key: minted.key, tracker: adhoc.TRACKER, confidence: 1000, source: 'task', sticky: true, boundAt: at };
  state.jira = { key: minted.key, title };
  state.status = 'running';
  state.summary = 'Ad hoc work started';
  state.updatedAt = at;
  saveSession(state);
  try { await publish(state, config, info, { force: true }); } catch { /* the next hook event reports it */ }
  try { saveSession(state); } catch { /* saved above */ }
  return { key: minted.key, title };
}

async function defaultAsk(method, route, body, config) {
  const { credential, serviceUrl } = await import('./core.mjs');
  const cred = await credential(config);
  if (!cred) return { ok: false };
  try {
    const response = await fetch(`${serviceUrl(config)}/v1/members/tracks${route}`, {
      method,
      headers: { [cred.header]: cred.value, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 5000)),
    });
    return { ok: response.ok };
  } catch {
    return { ok: false };
  }
}

/** `teamflow task new "<name>"`, `teamflow task in <id>` and `teamflow task show`. One plain line each. */
export async function taskMain(args = [], {
  config = {}, cwd, info = {}, sessionId, startCard, mintKey, publish, ask = defaultAsk, print = console.log, now = Date.now(),
} = {}) {
  const [verb, ...rest] = args;
  const session = sessionOf({ sessionId, cwd, config });
  if (!session) {
    print('TeamFlow cannot tell which session this is. Run the command from the session.');
    return 1;
  }
  const file = readTasks(session);
  const held = readTracks(config);

  if (!verb || verb === 'show') {
    const task = file.tasks[file.current];
    print(task?.project ? `This task is in project "${task.project.name}".` : 'This session has no task in a project yet.');
    return 0;
  }

  if (verb === 'new') {
    const name = rest.join(' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
    if (!name) {
      print(TASK_USAGE);
      return 2;
    }
    let card;
    let reason;
    try {
      card = await (startCard ? startCard(name) : sessionTaskCard(name, session, { config, info, now, mintKey, publish }));
    } catch (error) {
      reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    }
    const task = currentOrNew(file, now);
    release(held, task.id);
    const id = newId();
    held.tracks[id] = {
      id, name, named: name, made: true, members: [task.id], kinds: { [task.id]: 'task' },
      keys: card?.key ? [card.key] : [], by: ['person'], state: 'active', startedAt: iso(now), lastAt: iso(now),
    };
    task.project = { kind: 'informal', id, name };
    task.by = 'claude';
    if (card?.key) task.key = card.key;
    task.lastAt = iso(now);
    writeTasks(file);
    writeTracks(held, config);
    if (card?.key) print(`New project "${name}". This task is in it, and card ${card.key} is on the board.`);
    else print(`New project "${name}". This task is in it. TeamFlow could not add its card: ${reason || 'no reason given'}.`);
    return 0;
  }

  if (verb === 'in' && rest.length === 1) {
    const target = findProject(held, rest[0], config);
    if (!target) {
      print('TeamFlow has no open project with that id.');
      return 1;
    }
    const task = currentOrNew(file, now);
    release(held, task.id);
    if (target.kind === 'informal') {
      moveThread(held, task.id, target.id);
      held.tracks[target.id].kinds = { ...held.tracks[target.id].kinds, [task.id]: 'task' };
      delete held.sent[target.id];
    }
    held.taskMoves[task.id] = target;
    task.project = target;
    task.by = 'person';
    task.moved = true;
    task.lastAt = iso(now);
    writeTasks(file);
    writeTracks(held, config);
    if (target.kind === 'informal') {
      try { await ask('POST', `/${target.id}/move`, { thread: task.id }, config); } catch { /* the next pass reports it */ }
    }
    print(`This task is now in project "${target.name}".`);
    return 0;
  }

  print(TASK_USAGE);
  return 2;
}
