// The lines the hook adds about a session's project and its threads
// (MACLEOD-982, docs/PROJECTS.md sections 3 and 4). Kept apart from
// pin.mjs so the hook can build them on every event without loading the
// rest. Pure functions only: no file, no network.

import path from 'node:path';

export const PROJECT_ID = /^prj-[0-9a-f]{8}$/;
export const THREAD_ID = /^th-[0-9a-f]{8}$/;
export const NAME_MAX = 80;
/** How many threads, or projects, one line lists. */
export const LISTED = 8;

/** The command Claude can run: the plugin's own path in Claude Code, `teamflow` elsewhere. */
export function teamflowCommand(env = process.env) {
  const root = env.CLAUDE_PLUGIN_ROOT;
  return root ? `node "${path.join(root, 'scripts', 'cli.mjs')}"` : 'teamflow';
}

const quote = (name) => `"${String(name || '').replace(/"/g, "'").slice(0, NAME_MAX)}"`;

/**
 * The tracker badge: `(Linear)`, `(Jira)`, `(Linear · Jira)`, or
 * `(GitHub · 4 repos)` for a project linked only to repositories. An
 * empty string for a project linked to nothing.
 */
export function badge(project = {}) {
  const parts = [];
  if ((project.linear || []).length) parts.push('Linear');
  if ((project.jira || []).length) parts.push('Jira');
  const repos = (project.repos || []).length;
  if (!parts.length && repos) parts.push(`GitHub · ${repos} ${repos === 1 ? 'repo' : 'repos'}`);
  return parts.length ? `(${parts.join(' · ')})` : '';
}

/** `"Payments" (Linear)`, the way every line names a project. */
export function projectWords(project = {}) {
  const b = badge(project);
  return `${quote(project.name)}${b ? ` ${b}` : ''}`;
}

/** True for a project that no line may offer: closed or ended. */
export function isClosed(project = {}) {
  return Boolean(project.closed) || project.state === 'closed' || project.state === 'ended';
}

/** True for the line `threadLine` or `noProjectLine` writes, so a caller can tell it apart. */
export function isThreadLine(line) {
  return typeof line === 'string' && /^TeamFlow: (project "|this session is in no project)/.test(line);
}

/** A session with no ticket: one short line; the thread line beside it says the rest. */
export function noIssueLine() {
  return 'TeamFlow: no ticket. Run /teamflow:next for the top one.';
}

/**
 * The one line on each prompt (section 4): the project with its badge,
 * up to eight open threads with the current one marked, and what to run.
 * "Otherwise do nothing" is the common case and costs no tool call.
 */
export function threadLine(project, threads = [], { current, command = 'teamflow', viaRepo = false } = {}) {
  const listed = threads.slice(0, LISTED);
  const head = `TeamFlow: project ${projectWords(project)}${viaRepo ? ", this repository's default" : ''}.`;
  const named = listed.length
    ? ` Threads: ${listed.map((t) => `${t.id} ${quote(t.name)}${t.id === current ? ' (current)' : ''}`).join(', ')}.`
    : ' No threads yet.';
  const start = ` If this prompt starts a different purpose, run \`${command} thread new "<purpose>"\`.`;
  const other = listed.some((t) => t.id !== current) ? ` If it continues another listed thread, run \`${command} thread <id>\`.` : '';
  return `${head}${named}${start}${other} Otherwise do nothing.`;
}

/** No pin and no repository default: offer to make a project or to use one of the team's. */
export function noProjectLine(projects = [], { command = 'teamflow' } = {}) {
  const listed = projects.slice(0, LISTED);
  const make = `run \`${command} project create "<name>"\` with a short name for the work`;
  if (!listed.length) return `TeamFlow: this session is in no project. If this prompt starts work, ${make}. Otherwise do nothing.`;
  const open = listed.map((p) => `${p.id} ${projectWords(p)}`).join(', ');
  return `TeamFlow: this session is in no project. Open team projects: ${open}. `
    + `If the work belongs to one, run \`${command} project use <id>\`. For new work, ${make}. Otherwise do nothing.`;
}

/** The opening line after a restart, a resume or a compaction (section 3). */
export function continuingLine(name, command = 'teamflow') {
  return `TeamFlow: continuing project ${quote(name)}. Run \`${command} project create "<name>"\` for other work.`;
}

/** `{id, name}` when the value is a usable pin, else undefined. */
export function cleanPin(value) {
  if (!value || typeof value !== 'object' || !PROJECT_ID.test(String(value.id || ''))) return undefined;
  const name = String(value.name || value.id).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return { id: value.id, name, ...(value.by ? { by: String(value.by).slice(0, 20) } : {}) };
}

/** `{id, name}` when the value is a usable thread, else undefined. */
export function cleanThread(value) {
  if (!value || typeof value !== 'object' || !THREAD_ID.test(String(value.id || ''))) return undefined;
  return { id: value.id, name: String(value.name || value.id).replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) };
}

/**
 * An agent takes its parent's pin (section 3, "Agents and worktrees
 * inherit"). Its own pin, if it has one, stays: a worktree's binding
 * file may have named another project.
 */
export function inheritPin(state = {}, parent = {}) {
  if (cleanPin(state.project)) return state;
  const project = cleanPin(parent?.project);
  if (!project) return state;
  const thread = cleanThread(parent?.thread);
  return { ...state, project, ...(thread ? { thread } : {}) };
}
