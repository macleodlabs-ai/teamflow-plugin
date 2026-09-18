#!/usr/bin/env node
// The one hook pipeline, shared by every tool that can call a command
// on its own events.
//
// `hook.mjs` is still the Claude Code entry and hands its stdin JSON
// here unchanged; `hook-cli.mjs` (`teamflow hook --for <tool>`) puts
// every other tool's payload through `adapters.mjs` first, so what
// arrives here is always the same shape and `classifyTool` in core.mjs
// stays the only classifier. A stage that appears in Cursor and not in
// Claude Code would mean two classifiers, and two classifiers drift.

import {
  applyTransition,
  chooseBinding,
  classifyTool,
  detectCandidates,
  enrichBinding,
  loadConfig,
  publishState,
  readJson,
  saveSession,
  sessionPath,
  tenantId,
} from './core.mjs';

// Events that must stay synchronous and fast, because the tool is
// waiting on them before it shows the developer anything.
const FAST = ['SessionStart', 'UserPromptSubmit'];

export function newSession(sessionId, cwd) {
  return {
    sessionId,
    cwd,
    stage: 'BACKLOG',
    status: 'running',
    summary: 'Issue work detected',
    loopCount: 0,
    subagentCount: 0,
    updatedAt: new Date().toISOString(),
  };
}

// The additional context Claude Code injects into the turn. Only Claude
// Code asks for it; every other tool gets nothing on stdout, because
// stdout is how most of them are told to deny an action.
// A session with no ticket reports nothing at all, and nobody notices
// until the work is missing from the board. One sentence, because this
// is prepended to every turn until a ticket is bound.
const NO_ISSUE = 'TeamFlow: no issue is bound — run /teamflow:next '
  + '(the teamflow-next skill) to take the top-priority open ticket and bind it before editing.';

export function claudeContext(event, state, justBound) {
  if (!FAST.includes(event)) return undefined;
  if (!state.binding?.key) {
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: NO_ISSUE },
    });
  }
  const tracker = state.binding.tracker || 'jira';
  const context = [
    `TeamFlow: working on ${tracker} issue ${state.binding.key}.`,
    'Treat the issue as the work definition; continue normal development.',
    'TeamFlow reporting is automatic. Do not manually narrate tool calls for reporting.',
  ];
  if (justBound) context.push(`Binding source: ${state.binding.source}.`);
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context.join(' ') },
  });
}

// Everything between reading an event and having published it. Returns
// the state it saved and whether the binding is new, so a caller can
// decide what, if anything, to say on stdout.
export async function handleEvent(input = {}) {
  const event = input.hook_event_name || 'Unknown';
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || 'unknown-session';
  const config = loadConfig(cwd);
  const previous = readJson(sessionPath(sessionId), newSession(sessionId, cwd));
  let state = { ...previous, sessionId, cwd, ended: false, tenantId: tenantId(config) };

  // SessionEnd has a 1.5s default lifecycle budget. Keep it local and fast:
  // no git inspection, issue detection or S3 calls during shutdown.
  if (event === 'SessionEnd') {
    state.ended = true;
    if (state.status === 'running') state.status = 'idle';
    state.updatedAt = new Date().toISOString();
    saveSession(state);
    return { state, justBound: false, event };
  }

  const beforeKey = state.binding?.key;
  const { candidates, info } = detectCandidates(input, cwd, state, config);
  state.binding = chooseBinding(state, candidates);
  const justBound = Boolean(state.binding?.key && state.binding.key !== beforeKey);
  state = enrichBinding(state, input);

  if (event === 'SubagentStart') state.subagentCount = (state.subagentCount || 0) + 1;
  if (event === 'SubagentStop') state.subagentCount = Math.max(0, (state.subagentCount || 0) - 1);

  const transition = classifyTool(input, state, config);
  state = applyTransition(state, transition);

  if (event === 'SessionStart' && state.binding?.key) {
    state.summary = state.summary || 'Session started';
    state.status = state.status === 'idle' ? 'running' : state.status;
    state.updatedAt = new Date().toISOString();
  }
  if (event === 'Stop' && state.binding?.key && state.status === 'running') {
    state.status = 'idle';
    state.summary = state.summary || 'Claude session idle';
    state.updatedAt = new Date().toISOString();
  }
  saveSession(state);

  // Synchronous SessionStart/UserPromptSubmit must stay fast so they never hold up the tool.
  // Async tool/task/stop hooks publish to the service (or legacy S3).
  if (!FAST.includes(event) && state.binding?.key) {
    await publishState(state, config, info, { force: event === 'Stop' });
    saveSession(state);
  }

  return { state, justBound, event };
}

// Every hook entry runs inside this. Reporting must never break the
// tool or the developer's workflow, so nothing here can exit non-zero
// and nothing can throw past it.
export async function failOpen(fn) {
  try {
    await fn();
  } catch (error) {
    try {
      process.stderr.write(`TeamFlow reporter ignored error: ${error instanceof Error ? error.message : String(error)}\n`);
    } catch {}
  }
  process.exit(0);
}

// Malformed JSON throws, and failOpen turns that into a silent exit 0.
// Nothing is reported from an event that could not be read, which is
// the right answer: a guess would move somebody's ticket.
export async function readStdin(stream = process.stdin) {
  let text = '';
  for await (const chunk of stream) text += chunk;
  return text.trim() ? JSON.parse(text) : {};
}
