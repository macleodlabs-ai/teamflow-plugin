// What Kiro hears from a TeamFlow hook (MACLEOD-972).
//
// The adapter in adapters.mjs translates Kiro's payload; this decides
// what goes back on stdout, which kiro.dev/docs/hooks/actions defines:
//
//   "Exit code 0: Hook succeeded. STDOUT is added to context
//    (SessionStart, UserPromptSubmit) or ignored (others)."
//
// and for Stop (kiro.dev/docs/hooks/types, Agent Stop):
//
//   "When a stop hook returns "decision": "block", the reason is sent as
//    a new user message to the agent, continuing the conversation."
//
// So two outputs and nothing else:
//
// - SessionStart and UserPromptSubmit get the same lines Claude Code gets
//   from claudeContext, as plain text, because Kiro adds stdout as it is.
// - Stop gets `{"decision":"block","reason":...}` only when continue.mjs
//   says the plan has a next step, exactly as Claude Code's own Stop hook
//   does. Kiro reads the same field names.
//
// Nothing here ever exits non-zero. Exit 2 is how a Kiro hook blocks a
// tool or a prompt, and TeamFlow blocks neither.
import fs from 'node:fs';
import path from 'node:path';

import { claudeContext } from './hook-core.mjs';
import { HOOK_SPECS } from './hooks.mjs';
import { readJson, sessionPath } from './core.mjs';
// hook-cli.mjs loads this file only when a Kiro event arrives, so this
// import never runs while hook-cli.mjs is still loading.
import { NOT_SIGNED_IN_FOR_AGENT } from './hook-cli.mjs';

const FAST = new Set(['SessionStart', 'UserPromptSubmit']);

/** The text inside Claude Code's hook JSON, or '' when there is none. */
export function contextText(json) {
  if (typeof json !== 'string' || !json) return '';
  try {
    const said = JSON.parse(json)?.hookSpecificOutput?.additionalContext;
    return typeof said === 'string' ? said : '';
  } catch {
    return '';
  }
}

/**
 * Whether this Stop follows a continue TeamFlow gave, with no prompt
 * typed since. Claude Code says so in `stop_hook_active`; Kiro's Stop
 * has no such field, and without it every Stop would look like the first
 * and the streak limit in continue.mjs could never be reached.
 */
export function stopActive(session, held) {
  const last = Date.parse(held?.last?.at || '');
  if (!Number.isFinite(last)) return false;
  const prompt = Date.parse(session?.promptAt || '');
  return !Number.isFinite(prompt) || last > prompt;
}

async function stopOutput(input, deps) {
  const continueMod = deps.decide ? undefined : await import('./continue.mjs');
  const decide = deps.decide || continueMod.decide;
  const record = deps.record || ((decision) => continueMod.record(decision));
  let active = false;
  if (!deps.decide) {
    try {
      const held = readJson(continueMod.streakPath(input.session_id)) || {};
      active = stopActive(readJson(sessionPath(input.session_id)), held);
    } catch { active = false; }
  }
  const decision = decide({ ...input, stop_hook_active: active });
  if (!decision?.continue) return '';
  record(decision);
  return JSON.stringify({ decision: 'block', reason: decision.direction.reason });
}

/**
 * stdout for one Kiro event, given the event the adapter produced and
 * what handleEvent returned. '' means say nothing.
 */
export async function kiroOutput(event, result = {}, deps = {}) {
  const name = event?.hook_event_name;
  if (name === 'Stop') return stopOutput(event, deps);
  if (!FAST.has(name)) return '';
  const { state, justBound, project, signedIn = true, refused, credentialRefused, notices } = result;
  if (!state) return '';
  // Signed in is passed as true and the line is said here instead:
  // Claude Code's line names a slash command Kiro does not have.
  const json = claudeContext(name, state, justBound, undefined, project, true, refused, credentialRefused, notices);
  const lines = [];
  if (name === 'SessionStart' && !signedIn) lines.push(NOT_SIGNED_IN_FOR_AGENT);
  const text = contextText(json);
  if (text) lines.push(text);
  return lines.join(' ');
}

/**
 * The `teamflow doctor` line for Kiro, or undefined in a repository with
 * no `.kiro` folder. It compares the file on disk with what the installer
 * writes (HOOK_SPECS.kiro), so the two cannot drift.
 */
export function kiroHooksLine(root) {
  if (!fs.existsSync(path.join(root, '.kiro'))) return undefined;
  const target = HOOK_SPECS.kiro(root).targets.find((t) => t.json);
  const wanted = target.json.hooks.map((h) => h.trigger);
  const file = readJson(target.file);
  if (!file) return 'not installed. Run `teamflow hooks install --for kiro`.';
  const have = new Set((Array.isArray(file.hooks) ? file.hooks : [])
    .filter((h) => h?.enabled !== false && String(h?.name || '').startsWith('teamflow'))
    .map((h) => h.trigger));
  const missing = wanted.filter((trigger) => !have.has(trigger));
  if (missing.length) return `missing ${missing.join(', ')}. Run \`teamflow hooks install --for kiro\`.`;
  return `installed: ${wanted.join(', ')}`;
}
