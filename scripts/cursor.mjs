// What Cursor hears back from TeamFlow (MACLEOD-972).
//
// adapters.mjs turns Cursor's payload into Claude Code's shape so the
// one classifier reads it. This file goes the other way, for the few
// events where Cursor reads an answer on stdout, and writes only the
// fields Cursor documents for that event (cursor.com/docs/agent/hooks,
// read 2026-10-04):
//
//   sessionStart  `additional_context`: "Additional context to add to the
//                 conversation's initial system context."
//   stop          `followup_message`: "Can optionally auto-submit a
//                 follow-up user message to keep iterating."
//
// Nothing here writes `permission`, `continue` or `user_message`. A hook
// that printed one of those would be TeamFlow deciding for the person,
// and the only decision TeamFlow may pass on is one a person pressed
// (MACLEOD-848). docs/TOOL_PARITY.md says why Cursor has no waiting
// answer hook: its permission events fire "before any shell command or
// MCP tool is executed", not only when Cursor would ask.
import fs from 'node:fs';
import path from 'node:path';

import { sessionFor } from './adapters.mjs';
import * as core from './core.mjs';

/** Every event the installer registers in `.cursor/hooks.json`. */
export const CURSOR_EVENTS = [
  'sessionStart', 'beforeSubmitPrompt', 'afterFileEdit', 'postToolUse', 'postToolUseFailure',
  'afterShellExecution', 'subagentStart', 'subagentStop', 'preCompact', 'afterAgentResponse',
  'stop', 'sessionEnd',
];

// How much of the agent's last answer is kept, on this machine only, so
// the stop check can tell a question to the person from a finished step.
const REPLY_TAIL = 500;

/**
 * Claude Code's plugin skills are `/teamflow:<name>`; the copies in
 * `.agents/skills` that Cursor reads are named by skills.mjs as
 * `teamflow-<name>`, or the name itself when it already says teamflow.
 */
export function cursorText(text) {
  return String(text ?? '').replace(/\/teamflow:([a-z0-9-]+)/g,
    (_, name) => (name.includes('teamflow') ? `/${name}` : `/teamflow-${name}`));
}

const contextOf = (json) => {
  if (!json) return '';
  try {
    const parsed = JSON.parse(json);
    return String(parsed?.hookSpecificOutput?.additionalContext ?? parsed?.additional_context ?? '');
  } catch {
    return '';
  }
};

/**
 * Cursor's sessionStart output: the day's sign-in notice (already
 * Cursor's JSON, from hook-cli.mjs) first, then what Claude Code's
 * SessionStart would have said. Undefined when there is nothing to say.
 */
export function sessionStartOutput(claudeJson, said = undefined) {
  const context = cursorText(contextOf(claudeJson)).trim();
  if (!context) return said || undefined;
  const notice = contextOf(said).trim();
  return JSON.stringify({ additional_context: notice ? `${notice} ${context}` : context });
}

const replyPath = (sessionId) => path.join(core.dataDir(), 'cursor', `${core.digest(sessionId)}.json`);

/** Keep the end of the agent's last answer. Never sent anywhere. */
export function rememberReply(sessionId, text) {
  if (!sessionId || typeof text !== 'string') return;
  core.writeJson(replyPath(sessionId), { tail: text.slice(-REPLY_TAIL), at: new Date().toISOString() });
}

export function lastReply(sessionId) {
  if (!sessionId) return undefined;
  return core.readJson(replyPath(sessionId))?.tail;
}

/**
 * The stop answer: a plan's next step as `followup_message`, decided by
 * the same `decide` Claude Code's Stop hook uses. Cursor gives no last
 * message on stop, so the one afterAgentResponse kept is passed in;
 * a turn that was aborted or failed is never continued.
 */
export function stopOutput(payload = {}, event = {}, {
  decideImpl, recordImpl, after = () => {},
} = {}) {
  if (payload.status !== 'completed') return undefined;
  const input = { ...event, last_assistant_message: lastReply(event.session_id) };
  const decision = decideImpl(input);
  if (!decision?.continue) {
    after(decision, input);
    return undefined;
  }
  recordImpl(decision);
  const reason = decision.direction?.reason;
  return reason ? JSON.stringify({ followup_message: String(reason) }) : undefined;
}

/**
 * What hook-cli.mjs prints for this Cursor event, or undefined for the
 * passive value. `result` is handleEvent's return; `said` is the day's
 * sign-in notice, if this run claimed it.
 */
export async function respond({ payload = {}, event, result, said } = {}) {
  const name = payload.hook_event_name;
  if (name === 'afterAgentResponse') {
    rememberReply(sessionOf(payload), payload.text);
    return undefined;
  }
  if (name === 'sessionStart' && result) {
    const { claudeContext } = await import('./hook-core.mjs');
    // No stale-build line (that one says /reload-plugins), and no
    // sign-in line: Cursor's agent hears the daily notice in `said`,
    // written for an agent, never the instruction meant for a person.
    const claude = claudeContext(result.event, result.state, result.justBound, null, result.project,
      true, undefined, undefined, result.notices);
    return sessionStartOutput(claude, said);
  }
  if (name === 'stop' && event) {
    const continueMod = await import('./continue.mjs');
    const { acquireLock, runsLockPath } = await import('./dispatch.mjs');
    const lock = (fn) => {
      const release = acquireLock(runsLockPath(), { waitMs: 500 });
      if (!release) return { locked: false };
      try { return { locked: true, value: fn() }; } finally { release(); }
    };
    return stopOutput(payload, event, {
      decideImpl: (input) => continueMod.decide(input),
      recordImpl: (decision) => continueMod.record(decision, { lock }),
      // As continue-hook.mjs does for Claude Code: what the plan waits
      // for goes in its log, so the board can say it.
      after: (decision, input) => {
        if (!decision) return;
        continueMod.noteHeld(input.session_id, decision.why);
        if (decision.direction) continueMod.logDirection(decision.direction, decision.config, { lock });
        if (decision.direction?.kind === 'wait') {
          continueMod.recordWait(input.session_id, decision.agentKey, decision.direction);
          continueMod.noteDirection(input.session_id, decision.agentKey, decision.direction);
        }
      },
    });
  }
  return undefined;
}

// The same session key the adapter gives every other event.
function sessionOf(payload) {
  const cwd = payload.cwd || payload.workspace_roots?.[0] || process.cwd();
  return sessionFor('cursor', cwd, payload.conversation_id);
}
