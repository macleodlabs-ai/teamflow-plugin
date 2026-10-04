// What GitHub Copilot is told back on its own hook events (MACLEOD-972).
//
// The adapter in adapters.mjs renames Copilot's payload into Claude
// Code's shape; this file does the opposite for the answer. It takes
// what the Claude Code path already decided — the session context from
// claudeContext, an answer from two-way.mjs, a next step from
// continue.mjs — and spells it in Copilot's own fields. It decides
// nothing of its own.
//
// One hooks file is read by two dialects, so each answer carries both
// spellings where they differ, read on 2026-10-04:
//
//   - SessionStart: Copilot CLI reads a flat `additionalContext`; VS Code
//     reads `hookSpecificOutput.additionalContext`.
//   - PermissionRequest (Copilot CLI only; VS Code has no such event):
//     `{ behavior: "allow" | "deny", message }`, flat in both spellings.
//   - Stop: Copilot CLI reads a flat `decision` and `reason`; VS Code
//     reads them under `hookSpecificOutput`. SubagentStop is flat in both.
//
// The hard rules hold here as everywhere: an answer is Copilot's own
// decision field, never a command; nothing received reaches a shell; a
// permission is allowed only when a person pressed Allow.

import { claudeContext } from './hook-core.mjs';
import { drivenBy } from './driven.mjs';
import { twoWaySwitch, waitForAnswer, WAIT_MAX_S } from './two-way.mjs';

// Copilot's default hook timeout is 30 s, and a timed-out hook fails
// open. The PermissionRequest entry gets the longest wait plus room for
// the shim to start, as Claude Code's answer hook does.
export const COPILOT_ANSWER_TIMEOUT_S = WAIT_MAX_S + 20;

function parsed(text) {
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

async function sessionStart({ input, result }, { context, driven }) {
  if (driven(input, process.env, input.cwd)) return undefined;
  const { state, justBound, event, project, signedIn, refused, credentialRefused, notices } = result || {};
  if (!state) return undefined;
  const said = parsed(context(event || 'SessionStart', state, justBound, undefined, project,
    signedIn, refused, credentialRefused, notices));
  const text = said.hookSpecificOutput?.additionalContext;
  if (typeof text !== 'string' || !text) return undefined;
  return { additionalContext: text, hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
}

async function permission({ input }, { twoWay, wait, driven }) {
  if (!twoWay().on) return undefined;
  if (driven(input, process.env, input.cwd)) return undefined;
  const answer = await wait(input);
  const decision = answer?.hookSpecificOutput?.decision;
  // Only the two shapes decisionFor can produce. Anything else is
  // dropped, so Copilot asks the person as it always does.
  if (decision?.behavior === 'allow') return { behavior: 'allow' };
  if (decision?.behavior === 'deny') {
    return { behavior: 'deny', message: String(decision.message || 'Your developer said no in TeamFlow.') };
  }
  return undefined;
}

async function stop({ event, input }, { decide, record, driven }) {
  // Without the last message TeamFlow cannot tell a finished turn from a
  // question to the person, and must not talk over a question.
  if (typeof input.last_assistant_message !== 'string' || !input.last_assistant_message.trim()) return undefined;
  if (driven(input, process.env, input.cwd)) return undefined;
  const decideFn = decide || (await import('./continue.mjs')).decide;
  const decision = decideFn(input);
  if (!decision?.continue || !decision.direction?.reason) return undefined;
  if (record) record(decision);
  else {
    const { record: keep } = await import('./continue.mjs');
    const { acquireLock, runsLockPath } = await import('./dispatch.mjs');
    keep(decision, {
      lock: (fn) => {
        const release = acquireLock(runsLockPath(), { waitMs: 500 });
        if (!release) return { locked: false };
        try { return { locked: true, value: fn() }; } finally { release(); }
      },
    });
  }
  const reason = decision.direction.reason;
  if (event === 'SubagentStop') return { decision: 'block', reason };
  return { decision: 'block', reason, hookSpecificOutput: { hookEventName: 'Stop', decision: 'block', reason } };
}

/**
 * The one line Copilot reads on stdout for this event, or undefined.
 * `said` is the day's sign-in notice, already in Copilot's
 * `systemMessage` field; it is merged in so stdout stays one object.
 */
export async function copilotOutput({ event, input = {}, result, said } = {}, deps = {}) {
  const use = {
    context: deps.context || claudeContext,
    twoWay: deps.twoWay || twoWaySwitch,
    wait: deps.wait || waitForAnswer,
    driven: deps.driven || drivenBy,
    decide: deps.decide,
    record: deps.record,
  };
  let out;
  if (event === 'SessionStart') out = await sessionStart({ input, result }, use);
  else if (event === 'PermissionRequest') out = await permission({ input }, use);
  else if (event === 'Stop' || event === 'SubagentStop') out = await stop({ event, input }, use);
  const merged = { ...parsed(said), ...(out || {}) };
  return Object.keys(merged).length ? JSON.stringify(merged) : undefined;
}
