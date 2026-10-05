// The session pin and its threads, on this machine (MACLEOD-982,
// docs/PROJECTS.md sections 3, 4 and 10).
//
// A session is in one project from the moment a person or Claude says so
// (`teamflow project create|use`, the /teamflow:project picker, or Move to
// project in the app) until `teamflow project end`. That is the pin. It is
// kept on the session's own file as `project: {id, name}` and, beside it,
// the thread the session works on now as `thread: {id, name}`.
//
// The last pin is kept per person, repository root and machine in
// `<data>/projects/last.json`, so a restart, a resume, a clear or a
// compaction continues the same project whatever the new session id is.
// Agents copy their parent's pin; an agent in a worktree reads the pin
// `work-on` wrote into the worktree's own `.teamflow/binding.json`.
//
// A thread is one purpose inside the project. The prompt line asks the
// session's own model to run `teamflow thread new "<purpose>"` when a
// prompt starts a different purpose; the prompt itself is read only to
// tell a slash command or a one-word reply from work, and is never kept
// or sent. Work in a project with no current thread starts one, named
// from the card, never from the prompt. Thread ids are minted here
// (`th-` + 8 hex), so a machine can make one offline; the service is told
// on the next pass that can reach it.
//
// What leaves the machine: project and thread ids on the heartbeat and
// the issue report, and a thread's name. Every hook path fails open.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  accountScope, credential, dataDir, digest, latestSessionForCwd, localBindingPath, ownPromptText, readJson, repositoryRoot,
  requestBeat, saveSession, serviceUrl, sessionPath, writeJson,
} from './core.mjs';
import { projectFor, projectsCachePath } from './project.mjs';
import {
  LISTED, NAME_MAX, PROJECT_ID, THREAD_ID, cleanPin, cleanThread, continuingLine, isClosed, noProjectLine,
  teamflowCommand, threadLine,
} from './pin-line.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const THREADS_KEPT = 400;
const TOUCH_EVERY_MS = 60 * 1000;
const SYNC_BATCH = 10;
const SESSION_ID = /^[A-Za-z0-9_-]{1,120}$/;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const DISPATCH_TOOLS = new Set(['Agent', 'Task']);

const time = (iso) => {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : 0;
};
const iso = (now) => new Date(now).toISOString();
const oneLine = (text, max = NAME_MAX) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);

export function newThreadId() {
  return `th-${crypto.randomBytes(4).toString('hex')}`;
}

// --- the service ---------------------------------------------------------

/**
 * One call to a members route. `{ok, status, body}`; never throws. No
 * credential is `{ok: false, status: 0}`, the same as no network.
 */
export async function request(method, route, body, config = {}, { timeoutMs } = {}) {
  try {
    const cred = await credential(config);
    if (!cred) return { ok: false, status: 0, body: { message: 'This machine is not signed in. Run /teamflow:login once.' } };
    const response = await fetch(`${serviceUrl(config)}/v1/members${route}`, {
      method,
      headers: { [cred.header]: cred.value, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(Number(timeoutMs || config.serviceTimeoutMs || 5000)),
    });
    let parsed;
    try { parsed = await response.json(); } catch { parsed = undefined; }
    return { ok: response.ok, status: response.status, body: parsed };
  } catch {
    return { ok: false, status: 0 };
  }
}

// --- the organisation's projects, as this machine last read them ----------

export function cachedProjects(config = {}) {
  try {
    const held = readJson(projectsCachePath(config));
    return { projects: Array.isArray(held?.projects) ? held.projects : undefined, fetchedAt: Number(held?.fetchedAt) || 0 };
  } catch {
    return { projects: undefined, fetchedAt: 0 };
  }
}

/** Put one project the service just answered into the cache, so the next hook sees it. */
export function rememberProject(project, config = {}) {
  if (!project?.id) return;
  try {
    const file = projectsCachePath(config);
    const held = readJson(file) || {};
    const rest = (Array.isArray(held.projects) ? held.projects : []).filter((p) => p.id !== project.id);
    writeJson(file, { fetchedAt: Number(held.fetchedAt) || 0, projects: [...rest, project] });
  } catch { /* the next list reads it */ }
}

/**
 * Whether a project is still open, by the cached list. Fails open: no
 * cache, or a cache older than the pin, is "open". A project the list
 * leaves out after the pin was made is gone.
 */
export function stillOpen(id, config = {}, since = undefined) {
  const { projects, fetchedAt } = cachedProjects(config);
  if (!projects) return true;
  const found = projects.find((p) => p.id === id);
  if (found) return !isClosed(found);
  return !(fetchedAt && since && fetchedAt > time(since));
}

// --- the last pin ----------------------------------------------------------

function lastPath() {
  return path.join(dataDir(), 'projects', 'last.json');
}

function person() {
  try { return os.userInfo().username; } catch { return ''; }
}

/** The digest of person, organisation and repository root: the key of `last.json`. */
export function lastKey(cwd, config = {}) {
  let root;
  try { root = repositoryRoot(cwd); } catch { root = path.resolve(cwd || '.'); }
  return digest(`${accountScope(config) || ''}|${person()}|${root}`, 24);
}

export function readLast(cwd, config = {}) {
  const entry = (readJson(lastPath(), {}) || {})[lastKey(cwd, config)];
  return entry && PROJECT_ID.test(String(entry.project || '')) ? entry : undefined;
}

export function writeLast(cwd, config = {}, pin, now = Date.now()) {
  if (!cwd || !cleanPin(pin)) return;
  try {
    const held = readJson(lastPath(), {}) || {};
    held[lastKey(cwd, config)] = { project: pin.id, name: pin.name, at: iso(now) };
    writeJson(lastPath(), held);
  } catch { /* a sandboxed agent cannot write here; its parent did */ }
}

export function clearLast(cwd, config = {}) {
  try {
    const held = readJson(lastPath(), {}) || {};
    const key = lastKey(cwd, config);
    if (!(key in held)) return;
    delete held[key];
    writeJson(lastPath(), held);
  } catch { /* nothing to clear */ }
}

/** Every last pin on this machine, newest first: the "recent" half of a picker. */
export function recentPins() {
  return Object.values(readJson(lastPath(), {}) || {})
    .filter((e) => PROJECT_ID.test(String(e?.project || '')))
    .sort((a, b) => time(b.at) - time(a.at));
}

// --- threads this machine made ---------------------------------------------

function threadsPath() {
  return path.join(dataDir(), 'projects', 'threads.json');
}

export function readThreads() {
  const held = readJson(threadsPath(), {}) || {};
  return held.threads && typeof held.threads === 'object' ? held.threads : {};
}

function writeThreads(threads) {
  const kept = Object.values(threads).sort((a, b) => time(b.lastAt) - time(a.lastAt)).slice(0, THREADS_KEPT);
  writeJson(threadsPath(), { threads: Object.fromEntries(kept.map((t) => [t.id, t])) });
}

/** Record a thread made here, to be posted to the service on the next pass. */
export function recordThread({ id = newThreadId(), name, project, by = 'claude', key, now = Date.now() } = {}) {
  const thread = {
    id, name: oneLine(name) || 'New work', project, by, createdAt: iso(now), lastAt: iso(now), sent: false,
    ...(key ? { key } : {}),
  };
  try {
    const threads = readThreads();
    threads[id] = thread;
    writeThreads(threads);
  } catch { /* the session still holds it */ }
  return thread;
}

function touchThread(id, now, extra = {}) {
  try {
    const threads = readThreads();
    const t = threads[id];
    if (!t) return;
    if (!extra.key && now - time(t.lastAt) < TOUCH_EVERY_MS) return;
    threads[id] = { ...t, ...extra, lastAt: iso(now) };
    writeThreads(threads);
  } catch { /* a missed touch costs nothing */ }
}

/**
 * The open threads of a project, newest first: the service's list, as
 * the cache holds it, and the ones this machine made. The current one is
 * always listed.
 */
export function openThreads(projectId, { config = {}, current, now = Date.now() } = {}) {
  const found = new Map();
  const cached = (cachedProjects(config).projects || []).find((p) => p.id === projectId);
  for (const t of cached?.threads || []) {
    if (THREAD_ID.test(String(t?.id || '')) && t.state !== 'ended') found.set(t.id, { id: t.id, name: oneLine(t.name), lastAt: t.lastAt });
  }
  for (const t of Object.values(readThreads())) {
    if (t.project !== projectId || t.state === 'ended') continue;
    const was = found.get(t.id);
    if (!was || time(t.lastAt) > time(was.lastAt)) found.set(t.id, { id: t.id, name: oneLine(t.name), lastAt: t.lastAt, ...(t.key ? { key: t.key } : {}) });
  }
  const all = [...found.values()].filter((t) => t.id === current || now - time(t.lastAt) < 30 * DAY_MS)
    .sort((a, b) => time(b.lastAt) - time(a.lastAt));
  const mine = all.find((t) => t.id === current);
  const rest = all.filter((t) => t.id !== current);
  return (mine ? [mine, ...rest] : rest).slice(0, LISTED);
}

/** A thread by id, from this machine's list or the cached project. */
export function findThread(id, config = {}) {
  const own = readThreads()[id];
  if (own) return own;
  for (const p of cachedProjects(config).projects || []) {
    const t = (p.threads || []).find((one) => one?.id === id);
    if (t) return { ...t, project: p.id };
  }
  return undefined;
}

// --- the session's pin -----------------------------------------------------

/** The project a session works in: its pin, else the repository's default. */
export function effectiveProject(state = {}, { config = {}, repository } = {}) {
  const projects = (cachedProjects(config).projects || []).filter((p) => !isClosed(p));
  const pin = cleanPin(state.project);
  if (pin) {
    const full = projects.find((p) => p.id === pin.id);
    return { project: full || pin, viaRepo: pin.by === 'repo' };
  }
  const repo = repository ? projectFor(repository, projects) : undefined;
  return repo ? { project: repo, viaRepo: true } : undefined;
}

/** Set a session's pin on its own file; the thread goes unless it is the new project's. */
export function pinState(state, project, { thread, by = 'person' } = {}) {
  const pin = cleanPin({ ...project, by });
  if (!pin) return state;
  state.project = pin;
  const kept = cleanThread(thread) || (state.thread && findThread(state.thread.id)?.project === pin.id ? cleanThread(state.thread) : undefined);
  if (kept) state.thread = kept;
  else delete state.thread;
  return state;
}

/**
 * Pin a session, from a command or the app: the session's file, the last
 * pin for its repository, and a beat so the board sees it in seconds.
 */
export function setPin(sessionId, project, { thread, by = 'person', cwd, config = {}, now = Date.now() } = {}) {
  const held = readJson(sessionPath(sessionId)) || { sessionId, ...(cwd ? { cwd } : {}) };
  pinState(held, project, { thread, by });
  held.updatedAt = iso(now);
  saveSession(held);
  if (by !== 'repo') writeLast(held.cwd || cwd, config, held.project, now);
  try { requestBeat(sessionId); } catch { /* the next beat carries it */ }
  return held;
}

/** `project end`: the session leaves its project, and a restart does not bring it back. */
export function clearPin(sessionId, { cwd, config = {}, now = Date.now() } = {}) {
  const held = readJson(sessionPath(sessionId));
  if (held) {
    delete held.project;
    delete held.thread;
    held.updatedAt = iso(now);
    saveSession(held);
  }
  clearLast(held?.cwd || cwd, config);
  try { requestBeat(sessionId); } catch { /* the next beat carries it */ }
  return held;
}

/**
 * On every SessionStart, and on the first event of a session whose tool
 * has no SessionStart: a session with no pin takes the worktree's pin,
 * else the last pin for this person and repository, while that project
 * is still open. Changes `state` in place and returns the line to say,
 * or undefined. An agent says nothing; its parent did.
 */
export function reconnect(state, { cwd, config = {}, event, agent = false, env = process.env } = {}) {
  const command = teamflowCommand(env);
  const held = cleanPin(state.project);
  if (held && held.by !== 'repo') {
    return event === 'SessionStart' && !agent ? continuingLine(held.name, command) : undefined;
  }
  let found;
  try {
    const local = readJson(localBindingPath(cwd || state.cwd || '.'));
    const pin = cleanPin(local?.project);
    if (pin) found = { pin, thread: cleanThread(local?.thread), by: 'worktree', at: local.boundAt };
  } catch { /* no worktree file */ }
  if (!found && !agent) {
    const last = readLast(cwd || state.cwd, config);
    if (last) found = { pin: { id: last.project, name: last.name }, by: 'last', at: last.at };
  }
  if (!found || !stillOpen(found.pin.id, config, found.at)) return undefined;
  pinState(state, found.pin, { thread: found.thread, by: found.by });
  return agent ? undefined : continuingLine(state.project.name, command);
}

/**
 * `work-on` in a worktree (section 10, "On the machine"): the parent
 * session's pin goes into the worktree's `.teamflow/binding.json` beside
 * the key, the one file a sandboxed agent can write. The session is the
 * one the command runs in, else the newest here. Returns the pin written.
 */
export function pinForWorktree(cwd, config = {}, { env = process.env } = {}) {
  const sessions = [];
  if (env.TEAMFLOW_SESSION_ID) sessions.push(readJson(sessionPath(env.TEAMFLOW_SESSION_ID)));
  try { sessions.push(latestSessionForCwd(cwd, config)); } catch { /* none here */ }
  const from = sessions.find((one) => cleanPin(one?.project));
  if (!from) return undefined;
  const file = localBindingPath(cwd);
  const held = readJson(file);
  if (!held || typeof held !== 'object') return undefined;
  const project = cleanPin(from.project);
  const thread = cleanThread(from.thread);
  writeJson(file, { ...held, project: { id: project.id, name: project.name }, ...(thread ? { thread } : {}) });
  return project;
}

// --- the prompt and the work ----------------------------------------------

/** A prompt that starts no work by rule: a slash command or a one-word reply. */
export function quietPrompt(prompt) {
  const text = ownPromptText(prompt).trim();
  if (!text || text.startsWith('/')) return true;
  return text.split(/\s+/).length <= 1;
}

/** The team's open projects for a picker or a line: this machine's recent ones first. */
export function teamProjects(config = {}) {
  const projects = (cachedProjects(config).projects || []).filter((p) => !isClosed(p));
  const recent = new Map(recentPins().map((e, i) => [e.project, i]));
  return [...projects].sort((a, b) => {
    const ra = recent.has(a.id) ? recent.get(a.id) : Infinity;
    const rb = recent.has(b.id) ? recent.get(b.id) : Infinity;
    if (ra !== rb) return ra - rb;
    return String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || ''));
  });
}

/**
 * UserPromptSubmit, the main session only: the one line about the
 * project and its threads, or nothing for a prompt that starts no work.
 */
export function promptLine(state = {}, prompt, { config = {}, repository, env = process.env, now = Date.now() } = {}) {
  if (quietPrompt(prompt)) return undefined;
  const command = teamflowCommand(env);
  const found = effectiveProject(state, { config, repository });
  if (!found) return noProjectLine(teamProjects(config), { command });
  const current = cleanThread(state.thread)?.id;
  return threadLine(found.project, openThreads(found.project.id, { config, current, now }), { current, command, viaRepo: found.viaRepo });
}

function isWork(input = {}) {
  if (EDIT_TOOLS.has(input.tool_name) || DISPATCH_TOOLS.has(input.tool_name)) return true;
  return input.tool_name === 'Bash' && /\bgit\b[^\n]*\bcommit\b/.test(String(input.tool_input?.command || ''));
}

/**
 * PostToolUse, the main session only: an edit, an agent dispatch or a
 * commit. A session in a project with no current thread there starts
 * one, named from its card. The repository's default becomes the pin
 * (`by: repo`) so the beat names the project. Changes `state` in place;
 * returns the thread, or undefined.
 */
export function noteThreadWork(state, input = {}, { config = {}, repository, now = Date.now() } = {}) {
  if (!isWork(input)) return undefined;
  const found = effectiveProject(state, { config, repository });
  if (!found) return undefined;
  if (!cleanPin(state.project)) pinState(state, found.project, { by: 'repo' });
  const current = cleanThread(state.thread);
  const known = current ? findThread(current.id, config) : undefined;
  if (current && (!known || known.project === state.project.id)) {
    touchThread(current.id, now);
    return current;
  }
  const key = state.binding?.key;
  const thread = recordThread({ name: state.jira?.title || key || 'New work', project: state.project.id, key, now });
  state.thread = { id: thread.id, name: thread.name };
  return state.thread;
}

/** Remember which card a thread works on, so switching back to it brings the card back. */
export function noteThreadCard(threadId, key, now = Date.now()) {
  if (THREAD_ID.test(String(threadId || '')) && key) touchThread(threadId, now, { key });
}

// --- the passes that need the network (Stop, and the commands) -------------

/** Post every thread this machine made that the service has not heard of. Idempotent by id. */
export async function syncThreads(config = {}, { ask = request, timeoutMs = 2000, only } = {}) {
  let threads;
  try { threads = readThreads(); } catch { return 0; }
  const owed = Object.values(threads)
    .filter((t) => !t.sent && PROJECT_ID.test(String(t.project || '')) && (!only || t.id === only)).slice(0, SYNC_BATCH);
  let sent = 0;
  for (const t of owed) {
    const got = await ask('POST', `/projects/${t.project}/threads`, { id: t.id, name: t.name, by: t.by || 'claude' }, config, { timeoutMs });
    if (got.status === 0) break;
    // A refusal for good (gone, not allowed) is not tried again either.
    if (got.ok || (got.status >= 400 && got.status < 500 && got.status !== 429)) {
      threads[t.id] = { ...t, sent: true, ...(got.ok ? {} : { refused: got.status }) };
      sent += got.ok ? 1 : 0;
    }
  }
  if (owed.length) { try { writeThreads(threads); } catch { /* tried again next pass */ } }
  return sent;
}

function migratedPath() {
  return path.join(dataDir(), 'projects', 'migrated.json');
}

/**
 * Plugin 0.3.68 rewrites the old `<data>/tasks/` once (section 8): each
 * session's last task's project becomes that session's pin, through the
 * service's aliases from old track ids to new project and thread ids,
 * and the newest session per repository becomes its last pin. Marked
 * done so it runs once; tried again next pass when the service cannot
 * be asked. The old files stay where they are, and nothing reads them.
 */
export async function migrateTasks(config = {}, { ask = request, now = Date.now() } = {}) {
  try {
    if (readJson(migratedPath())?.tasks) return { done: false, reason: 'already' };
    const dir = path.join(dataDir(), 'tasks');
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { names = []; }
    if (!names.length) {
      writeJson(migratedPath(), { tasks: iso(now), sessions: 0 });
      return { done: true, sessions: 0 };
    }
    const got = await ask('GET', '/projects/aliases', undefined, config, { timeoutMs: 3000 });
    if (!got.ok) return { done: false, reason: `the service answered ${got.status || 'nothing'}` };
    const aliases = got.body?.aliases && typeof got.body.aliases === 'object' ? got.body.aliases : {};
    const newest = new Map();
    let sessions = 0;
    for (const name of names) {
      const file = readJson(path.join(dir, name));
      if (!file?.session || !SESSION_ID.test(String(file.session))) continue;
      const last = Object.values(file.tasks || {}).filter((t) => t?.project?.id)
        .sort((a, b) => time(b.lastAt) - time(a.lastAt))[0];
      if (!last) continue;
      const alias = aliases[last.project.id];
      const project = PROJECT_ID.test(String(last.project.id)) ? last.project.id : alias?.project;
      if (!PROJECT_ID.test(String(project || ''))) continue;
      const thread = THREAD_ID.test(String(alias?.thread || '')) ? { id: alias.thread, name: last.project.name } : undefined;
      const held = readJson(sessionPath(file.session));
      if (!held?.sessionId) continue;
      if (!cleanPin(held.project)) {
        pinState(held, { id: project, name: last.project.name }, { thread, by: 'migration' });
        saveSession(held);
        sessions += 1;
      }
      if (held.cwd) {
        const key = lastKey(held.cwd, config);
        const was = newest.get(key);
        if (!was || time(last.lastAt) > time(was.at)) newest.set(key, { cwd: held.cwd, pin: held.project, at: last.lastAt });
      }
    }
    for (const { cwd, pin, at } of newest.values()) {
      if (!readLast(cwd, config)) writeLast(cwd, config, pin, time(at) || now);
    }
    writeJson(migratedPath(), { tasks: iso(now), sessions });
    return { done: true, sessions };
  } catch {
    return { done: false, reason: 'the rewrite failed; it is tried again' };
  }
}

// --- the app's Move to project (intake kind `pin`) -------------------------

export function pinMovedLine(by, name) {
  return `${by} moved this session to project "${oneLine(name)}". New work from now on goes there.`;
}

/** A session id as the service names it: the raw id, or its digest as the heartbeat sends it. */
function sessionNamed(named) {
  if (!SESSION_ID.test(named)) return undefined;
  const held = readJson(sessionPath(named));
  if (held?.sessionId === named) return held;
  try {
    const dir = path.join(dataDir(), 'sessions');
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json') || file.includes('--')) continue;
      const id = file.slice(0, -5);
      if (digest(id) === named) {
        const one = readJson(path.join(dir, file));
        if (one?.sessionId === id) return one;
      }
    }
  } catch { /* no sessions here */ }
  return undefined;
}

/**
 * `pin` (section 10, the eighth action kind): `{session, project,
 * thread?}`, queued by the service after its own check of who may move
 * the session. Here the ids must have their shapes and the session must
 * be one of this machine's own. Only that session's pin changes. Nothing
 * received reaches a shell. Returns `{outcome, reason}`.
 */
export function applyPin(action = {}, { config = {}, local, at = new Date().toISOString() } = {}) {
  const named = String(action.session ?? action.args?.session ?? '').trim();
  const project = String(action.project ?? action.args?.project ?? '').trim();
  const threadId = String(action.thread ?? action.args?.thread ?? '').trim();
  const by = oneLine(action.by, 80) || 'A lead';
  if (!PROJECT_ID.test(project)) return { outcome: 'refused', reason: 'The move names no project' };
  if (threadId && !THREAD_ID.test(threadId)) return { outcome: 'refused', reason: 'The move names a thread TeamFlow cannot read' };
  const held = sessionNamed(named);
  if (!held) return { outcome: 'refused', reason: 'That session is not on this machine' };
  const cached = (cachedProjects(config).projects || []).find((p) => p.id === project);
  const name = oneLine(cached?.name || action.name || action.args?.name) || project;
  const known = threadId ? findThread(threadId, config) : undefined;
  const thread = threadId ? { id: threadId, name: oneLine(known?.name) || threadId } : undefined;
  const line = pinMovedLine(by, name);
  const move = (one) => {
    pinState(one, { id: project, name }, { thread, by: 'app' });
    one.intakePending = [...(one.intakePending || []), line].slice(-8);
    one.updatedAt = at;
  };
  move(held);
  saveSession(held);
  writeLast(held.cwd, config, held.project, time(at) || Date.now());
  try { requestBeat(held.sessionId); } catch { /* the next beat carries it */ }
  if (local && local.sessionId === held.sessionId && !local.agentKey) move(local);
  return { outcome: 'done', reason: `${by} moved the session to project ${name}`.slice(0, 120) };
}
