// Waiting on a person (MACLEOD-845).
//
// The audit found 45 issues "waiting" and none saying who they wait on.
// The owner ruled that a question waiting on the user goes to Needs you
// on the board, at the top, and is answered there. So the plugin tells
// the board when the session is asking, and what kind of thing it asks:
//
// - `permission`: Claude Code asks to use a tool (PermissionRequest, or
//   the `permission_prompt` notification). For a built-in tool, its name,
//   only when it has the shape of one (`Bash`, `Edit`, `WebFetch`).
// - `choice`: the AskUserQuestion tool, a multiple-choice question.
// - `elicitation`: an MCP server opens a form or asks to open a URL.
// - `question`: the turn ended with a question to the person. The
//   pattern that sees it is crude, so it stays a local mark until
//   Claude Code's own `idle_prompt` confirms the person has not answered
//   for a minute. Only then does the board hear of it.
//
// Never the question, the tool's input, the command, the URL or a path.
// The one exception is agent view (MACLEOD-852): when the person and the
// organisation both turned it on, `askLines` gives the question and its
// option labels, or a permission's plain words, as stream lines. Those go
// only into the agent view stream, never onto the report.
//
// A local mark (`asking/<digest>.json`) lets the one-minute check-in
// leave a session alone while it asks. A typed prompt or a tool that ran
// clears it.
import fs from 'node:fs';
import path from 'node:path';

import * as core from './core.mjs';
import { endsWithQuestion } from './continue.mjs';
import { cleanLine, redactSecrets } from './redact.mjs';
import { askIdOf, twoWaySwitch } from './two-way.mjs';

export const ASK_KINDS = new Set(['permission', 'question', 'choice', 'elicitation']);
// A built-in tool's name. An MCP tool (`mcp__server__tool`) never matches.
export const BUILTIN_TOOL = /^[A-Z][A-Za-z]{0,29}$/;
const ELICITATION = new Set(['elicitation_dialog', 'elicitation_url_dialog']);
// Events that mean the person answered, or the turn went on without them.
const CLEARS = new Set(['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'SessionEnd', 'SessionStart']);

export const askingPath = (sessionId) => path.join(core.dataDir(), 'asking', `${core.digest(sessionId)}.json`);

/** The session's asking mark, or undefined. */
export function askingOf(sessionId) {
  if (!sessionId) return undefined;
  const held = core.readJson(askingPath(sessionId));
  return held && ASK_KINDS.has(held.kind) ? held : undefined;
}

export function clearAsking(sessionId) {
  if (!sessionId) return false;
  const file = askingPath(sessionId);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}

function mark(sessionId, ask, now) {
  const entry = {
    kind: ask.kind, ...(ask.tool ? { tool: ask.tool } : {}), sure: Boolean(ask.sure), at: new Date(now).toISOString(),
    ...(ask.askId ? { askId: ask.askId } : {}),
  };
  core.writeJson(askingPath(sessionId), entry);
  return entry;
}

/** True for the events this module reads without classifying a stage. */
export function isAskEvent(input = {}) {
  const event = input.hook_event_name;
  return event === 'Notification' || event === 'PermissionRequest'
    || (event === 'PreToolUse' && input.tool_name === 'AskUserQuestion');
}

/**
 * What one event says about asking. `{ ask: { kind, tool? } }` when the
 * board should show the session waiting on a person, `{ clear: true }`
 * when it no longer waits, or `{}`. Writes or clears the local mark.
 */
export function askStep(input = {}, { now = Date.now() } = {}) {
  const sessionId = input.session_id;
  const event = input.hook_event_name;
  if (!sessionId || sessionId === 'unknown-session') return {};
  if (CLEARS.has(event)) return clearAsking(sessionId) ? { clear: true } : {};
  if (event === 'PermissionRequest') {
    const tool = BUILTIN_TOOL.test(String(input.tool_name || '')) ? input.tool_name : undefined;
    return { ask: pick(mark(sessionId, { kind: 'permission', tool, sure: true }, now)) };
  }
  if (event === 'PreToolUse' && input.tool_name === 'AskUserQuestion') {
    return { ask: pick(mark(sessionId, { kind: 'choice', sure: true }, now)) };
  }
  if (event === 'Notification') {
    const type = String(input.notification_type || '');
    if (type === 'permission_prompt') {
      // PermissionRequest may already have named the tool.
      const held = askingOf(sessionId);
      const tool = held?.kind === 'permission' ? held.tool : undefined;
      return { ask: pick(mark(sessionId, { kind: 'permission', tool, sure: true }, now)) };
    }
    if (ELICITATION.has(type)) return { ask: pick(mark(sessionId, { kind: 'elicitation', sure: true }, now)) };
    if (type === 'idle_prompt') {
      // A minute with no answer confirms a question the pattern saw.
      const held = askingOf(sessionId);
      if (held?.kind === 'question' && !held.sure) {
        // Its id (MACLEOD-848): the same in every process, from the Stop's time.
        const askId = askIdOf(input, held);
        return { ask: pick(mark(sessionId, { ...held, sure: true, askId }, Date.parse(held.at) || now)) };
      }
    }
    return {};
  }
  if (event === 'Stop') {
    if (endsWithQuestion(input.last_assistant_message)) {
      mark(sessionId, { kind: 'question', sure: false }, now);
      return {};
    }
    return clearAsking(sessionId) ? { clear: true } : {};
  }
  return {};
}

const pick = (entry) => ({ kind: entry.kind, ...(entry.tool ? { tool: entry.tool } : {}) });

/** Put what `askStep` said on the actor's state. Returns the state. */
export function applyAsk(state, step = {}, now = Date.now()) {
  if (step.ask) {
    return { ...state, status: 'waiting', waitingOn: 'human', asks: step.ask, updatedAt: new Date(now).toISOString() };
  }
  if (step.clear && state.waitingOn === 'human') {
    const { asks, waitingOn, ...rest } = state;
    return { ...rest, status: state.status === 'waiting' ? 'running' : state.status };
  }
  return state;
}

// --- the question's words, for agent view only (MACLEOD-852) -----------------

// What a built-in tool asks to do, in plain words. Any other built-in is "use <name>".
const TOOL_WORDS = {
  Bash: 'run a Bash command', Edit: 'change a file', MultiEdit: 'change a file', Write: 'write a file',
  NotebookEdit: 'change a notebook', Read: 'read a file', Glob: 'find files', Grep: 'search the files',
  WebFetch: 'open a web page', WebSearch: 'search the web', Agent: 'start an agent', Task: 'start an agent',
  Skill: 'use a skill',
};
const QUESTION_MAX = 300;
const OPTION_MAX = 80;
const OPTIONS_MAX = 8;
const COMMAND_MAX = 2000;

const short = (value, max) => {
  const text = cleanLine(String(value ?? '')).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** A permission in plain words: "wants to run a Bash command". Never the command. */
export function permissionWords(tool) {
  if (!tool || !BUILTIN_TOOL.test(String(tool))) return 'wants to use a tool';
  return `wants to ${TOOL_WORDS[tool] ?? `use ${tool}`}`;
}

/**
 * The stream lines a pending question makes, for agent view only. `lines`
 * are the safe layer: each AskUserQuestion question with its option labels
 * (`asks: 'choice'`), or a permission's tool and plain words
 * (`asks: 'permission'`). `detail` holds a Bash command, secrets redacted,
 * for the detail layer; the caller sends it only while the organisation
 * allows sensitive detail. Every safe text passes `cleanLine` first.
 */
export function askLines(input = {}, now = Date.now(), { twoWay = twoWaySwitch().on } = {}) {
  const t = new Date(now).toISOString();
  const event = input.hook_event_name;
  // MACLEOD-848: the id an answer from TeamFlow names, only while this
  // machine's two-way switch is on. Without it, nothing can be answered.
  const askId = twoWay ? askIdOf(input, event === 'Notification' ? askingOf(input.session_id) : undefined) : undefined;
  if (event === 'Notification') {
    const held = askingOf(input.session_id);
    if (!askId || input.notification_type !== 'idle_prompt' || held?.kind !== 'question') return { lines: [], detail: [] };
    return { lines: [{ t, role: 'assistant', asks: 'question', text: 'the question above', askId }], detail: [] };
  }
  if (event === 'PreToolUse' && input.tool_name === 'AskUserQuestion') {
    const questions = Array.isArray(input.tool_input?.questions) ? input.tool_input.questions : [];
    const lines = [];
    const counted = questions.filter((q) => short(q?.question, QUESTION_MAX)).length;
    for (const q of questions) {
      const text = short(q?.question, QUESTION_MAX);
      if (!text) continue;
      const options = (Array.isArray(q?.options) ? q.options : [])
        .map((o) => short(typeof o === 'string' ? o : o?.label, OPTION_MAX)).filter(Boolean).slice(0, OPTIONS_MAX);
      lines.push({ t, role: 'assistant', asks: 'choice', text, ...(options.length ? { options } : {}), ...(askId ? { askId, questions: counted } : {}) });
    }
    return { lines, detail: [] };
  }
  if (event === 'PermissionRequest') {
    const tool = BUILTIN_TOOL.test(String(input.tool_name || '')) ? input.tool_name : undefined;
    const words = permissionWords(tool);
    const lines = [{ t, role: 'assistant', asks: 'permission', ...(tool ? { tool } : {}), text: words, ...(askId ? { askId } : {}) }];
    const command = tool === 'Bash' ? String(input.tool_input?.command ?? '').trim() : '';
    const detail = command
      ? [{ t, role: 'assistant', kind: 'text', text: `${words}: ${redactSecrets(command).slice(0, COMMAND_MAX)}` }]
      : [];
    return { lines, detail };
  }
  return { lines: [], detail: [] };
}
