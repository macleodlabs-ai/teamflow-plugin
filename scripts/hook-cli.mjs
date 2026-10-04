#!/usr/bin/env node
// `teamflow hook --for <tool> [--event <name>]`: the hook entry every
// tool other than Claude Code calls.
//
// Claude Code has plugin/hooks/hooks.json and scripts/hook.mjs. Every
// other tool's hook configuration points here instead, because their
// payloads differ and the classifier's does not: this reads the event
// off stdin, puts it through that tool's adapter in adapters.mjs, and
// hands the result to the same pipeline hook.mjs uses.
//
// The contract with every one of these tools is the same and is not
// negotiable:
//
//   - exit 0, always, whatever happened;
//   - say nothing on stdout that the tool could read as a denial,
//     because in Cursor, Copilot, Gemini CLI and Cline stdout is how a
//     hook denies an action and a reporter that accidentally denied a
//     shell command would be worse than no reporter at all;
//   - never wait long enough to be noticed.
//
// failOpen() in hook-core.mjs enforces the first. The second is
// PASSIVE_STDOUT in adapters.mjs, which is empty for every tool that
// treats silence as consent and the smallest possible "carry on" for
// Gemini CLI, which parses stdout as JSON, and Cline, which reads a
// decision object. It is written before any reporting happens, so a
// slow or broken report cannot hold the tool up either.

import fs from 'node:fs';
import path from 'node:path';

import { ADAPTERS, noticeFor, PASSIVE_STDOUT } from './adapters.mjs';
import { claudeContext, failOpen, handleEvent, readStdin } from './hook-core.mjs';
import {
  dataDir, loadConfig, readJson, repositoryRoot, safeExec, transportOf, writeJson,
} from './core.mjs';
import { BY_ID } from './tools.mjs';
import { drivenBy } from './driven.mjs';

/**
 * The quietest failure the plugin has, said in the one channel each
 * tool documents as not a denial (MACLEOD-569).
 *
 * Claude Code hears this on SessionStart, from hook-core.mjs. Most of
 * these tools have no session-start event TeamFlow subscribes to and
 * stdout is how they deny an action, so it goes out through
 * `noticeFor`, on whichever of that tool's events the vendor documents
 * an informational field for, once a day and no more.
 *
 * Two texts, because three of the six live channels are read by the
 * model and not by the person — Cursor's `additional_context`, Cline's
 * `contextModification`, Junie's `PreToolUse` fallback — and the same
 * words cannot serve both. Which one is used is decided by `audience`
 * in the channel's own record in tools.mjs, never guessed here. Both
 * are constants with nothing interpolated into them.
 */

/**
 * For a channel the vendor says the person reads. An instruction,
 * because the person is the one who can carry it out, and the shell
 * command rather than a slash command, because outside Claude Code
 * there are no slash commands.
 */
export const NOT_SIGNED_IN = 'TeamFlow: nothing is reaching the board — this machine is not '
  + 'signed in, so every report is being dropped. Run `teamflow login` once (or '
  + '`npx -y github:macleodlabs-ai/teamflow-plugin login`), then `teamflow status` to check it. '
  + 'There is no key to copy.';

/**
 * For a channel the vendor says goes into the model's context.
 *
 * The text above must never go here. It is an imperative, it names a
 * command, and it arrives immediately before somebody else's agent
 * takes its next tool call — so an agent that simply does as it is told
 * abandons the customer's task to sign a machine in, and
 * `teamflow login` opens a browser and blocks on a loopback listener
 * for three minutes, which can hang the turn outright. That is not an
 * injection — this string is a constant and no report ever reaches it —
 * it is this plugin giving instructions to an agent that is not ours to
 * instruct, and the fact that it would usually be harmless is not a
 * reason to do it.
 *
 * So: declarative. It states the condition, says in terms that it is
 * not a task, and asks for the one thing an agent is the right party to
 * do — pass it on to the person the next time it speaks to them. It
 * deliberately contains no command, no backticks and none of the verbs
 * an agent would read as a step, which is asserted by a test rather
 * than left to whoever edits it next.
 */
export const NOT_SIGNED_IN_FOR_AGENT = 'TeamFlow is installed in this repository and this '
  + 'machine is not signed in, so the work in this session is not reaching the team\'s '
  + 'delivery board. This is information for the person you are working with, not a task for '
  + 'you: it needs no command, no browser and no change to any file or setting, and acting on '
  + 'it would interrupt what they actually asked for. Please mention it the next time you '
  + 'report back to them, and otherwise carry on.';

/** The pair, as `noticeFor` takes it. */
export const NOT_SIGNED_IN_TEXT = {
  person: NOT_SIGNED_IN,
  agent: NOT_SIGNED_IN_FOR_AGENT,
};

const noticeDir = () => path.join(dataDir(), 'notices');
const stampFile = () => path.join(dataDir(), 'notices.json');

const day = (now = new Date()) => now.toISOString().slice(0, 10);

/**
 * Whether today's one line has already been said on this machine.
 *
 * Once per machine per day, never per event: a reminder on every edit
 * is noise, and noise is how a real notice gets ignored. Per machine
 * rather than per tool for the same reason — signing in is one act and
 * it fixes every tool at once.
 *
 * The question is about the transport and not about the credential
 * (MACLEOD-569 review). A machine on the legacy S3 transport has a
 * `dataUri` and no credential, and its reports land: telling it daily
 * that "every report is being dropped" would be false, and in Cursor
 * and Cline that false sentence goes into the model's context. Only
 * `none` — nothing configured at all — is the case this notice is for.
 *
 * This is the cheap pre-check, not the claim. `claimNotice` is what
 * actually decides, atomically, because several hooks can be in flight
 * at once.
 */
export function noticeDue(config, { now = new Date(), file = stampFile() } = {}) {
  if (transportOf(config) !== 'none') return false;
  return readJson(file, {})?.notSignedIn !== day(now);
}

/**
 * Take today's notice, or return false because somebody else has it.
 *
 * Read-then-write is not enough here and was a bug: Cursor fires
 * `afterFileEdit` and `postToolUse` for one edit, Copilot registers six
 * event names, and a burst of hooks are separate processes racing on
 * the same file — so a read-then-write claim hands the notice to all of
 * them and the customer gets it N times at once. The claim is an
 * exclusive create instead: exactly one process can create
 * `notices/<day>.lock` with `wx`, and everybody else gets EEXIST and
 * says nothing.
 *
 * The claim happens before the line is printed, never after: a data
 * directory that cannot be written is a machine that would otherwise
 * say this on every single event, so a failure to claim is a failure to
 * speak. Saying nothing is the safer failure.
 *
 * `notices.json` is written after the lock purely so `noticeDue` has a
 * cheap answer that costs no filesystem create per event; the lock is
 * the authority. Yesterday's locks are swept at the same time, which
 * runs at most once a day.
 */
export function claimNotice({ now = new Date(), file = stampFile(), dir = noticeDir() } = {}) {
  const today = day(now);
  try {
    fs.mkdirSync(dir, { recursive: true });
    // `wx` is the whole mechanism: create, and fail if it is already
    // there. One syscall, no window between the check and the write.
    fs.closeSync(fs.openSync(path.join(dir, `${today}.lock`), 'wx'));
  } catch {
    return false;                    // EEXIST, or nowhere to write it
  }
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.lock') && name !== `${today}.lock`) {
        fs.rmSync(path.join(dir, name), { force: true });
      }
    }
  } catch {}
  try { writeJson(file, { ...(readJson(file, {}) || {}), notSignedIn: today }); } catch {}
  return true;
}

// The event, in the tool's own vocabulary, because the notice table
// keys off what the vendor documents rather than off the translated
// shape.
const eventNameOf = (payload = {}) => payload.hook_event_name
  || payload.hookName || payload.agent_action_name;

/**
 * What to print instead of the passive value, or undefined.
 *
 * The order is the rule the review asked for in code: the table is
 * asked first, and the day's notice is claimed only once there is
 * something to print. A tool or an event with no documented channel
 * therefore cannot spend it — which is the whole of the Junie
 * regression, where `Stop` produced a `systemMessage` the TUI never
 * shows and burnt the notice that Cursor would have carried.
 */
export function sayOnce(tool, payload, text = NOT_SIGNED_IN_TEXT, options = {}) {
  const said = noticeFor(tool, eventNameOf(payload), text);
  if (!said) return undefined;
  return claimNotice(options) ? said : undefined;
}

export function parse(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const eq = body.indexOf('=');
    const name = eq >= 0 ? body.slice(0, eq) : body;
    options[name] = eq >= 0 ? body.slice(eq + 1) : argv[++i];
  }
  return options;
}

// The only place TeamFlow runs a developer's command rather than
// watching one. It exists for the git pre-push fallback, where there is
// no agent to watch and a push is otherwise no evidence of anything.
// Opt-in: nothing runs unless `.teamflow.json` names the command.
// safeExec captures rather than inherits, so the suite's output is
// echoed to stderr once it finishes: a developer whose push just ran
// the tests has to be able to see why they failed, and stderr is the
// stream a git hook may write to freely.
export function runTestCommand(config, cwd, echo = (text) => process.stderr.write(text)) {
  const command = config.testCommand ? String(config.testCommand).trim() : '';
  if (!command) return undefined;
  echo(`TeamFlow: running \`${command}\` before the push. The push is not gated on it.\n`);
  const result = safeExec('/bin/sh', ['-c', command], { cwd, timeout: 10 * 60 * 1000 });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (output) echo(`${output}\n`);
  return { command, ok: result.ok, output: output.slice(-4000) };
}

// --- the modes whose output a tool acts on (MACLEOD-972) ---------------
//
// Only for a tool that sends Claude Code's own envelope (`envelope` in
// tools.mjs), because only there is the output Claude Code's decision
// fields, which that tool documents as its own. Today that is Codex.
const claudeEnvelope = (tool) => BY_ID[tool]?.envelope === 'claude-code';

// The events whose output is context for the model, as hook-core's FAST.
const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);

/**
 * The answer to a permission request, from TeamFlow, or undefined.
 *
 * The same waiting as answer-hook.mjs for Claude Code (MACLEOD-848/946),
 * given the adapter's event so the question id matches the one the
 * report path sent. What comes back is kept only if it is a
 * PermissionRequest decision: Codex reads
 * `hookSpecificOutput.decision.behavior` "allow" or "deny", and nothing
 * here can make anything else. No answer is no output, and Codex asks in
 * its own way. Never a default Allow; nothing received reaches a shell.
 */
export async function answerFor(tool, payload = {}, { wait, on } = {}) {
  if (!claudeEnvelope(tool) || payload.hook_event_name !== 'PermissionRequest') return undefined;
  const twoWay = await import('./two-way.mjs');
  if (!(on ?? twoWay.twoWaySwitch().on)) return undefined;
  if (drivenBy(payload, process.env, payload.cwd)) return undefined;
  const event = ADAPTERS[tool](payload, { cwd: payload.cwd });
  if (!event) return undefined;
  const output = await (wait || twoWay.waitForAnswer)(event);
  const decision = output?.hookSpecificOutput;
  if (decision?.hookEventName !== 'PermissionRequest') return undefined;
  if (!['allow', 'deny'].includes(decision.decision?.behavior)) return undefined;
  return output;
}

async function runMode(tool, mode) {
  if (!claudeEnvelope(tool)) return;
  const payload = await readStdin();
  if (mode === 'answer') {
    const output = await answerFor(tool, payload);
    if (output) process.stdout.write(JSON.stringify(output));
    return;
  }
  if (mode === 'continue') {
    if (!['Stop', 'SubagentStop'].includes(payload.hook_event_name)) return;
    const event = ADAPTERS[tool](payload, { cwd: payload.cwd });
    if (!event) return;
    // Codex's session id is its own, kept whole as the adapter keeps it,
    // so the continue check finds the session the reports wrote.
    const output = await (await import('./continue.mjs')).stopOutput(event);
    if (output) process.stdout.write(output);
  }
}

/**
 * One JSON object for a context event: the context Claude Code would get,
 * plus the day's sign-in notice, if this run claimed it. Codex reads one
 * object; two would be invalid output.
 */
function contextOutput(result, said) {
  let out = {};
  try {
    // signedIn is passed as true: the sign-in line meant for Claude Code
    // names a slash command, and Codex has the person-facing notice below.
    const text = claudeContext(result.event, result.state, result.justBound, undefined,
      result.project, true, result.refused, result.credentialRefused, result.notices);
    if (text) out = JSON.parse(text);
  } catch { out = {}; }
  if (said) {
    try { out = { ...JSON.parse(said), ...out }; } catch { /* the context alone */ }
  }
  return Object.keys(out).length ? JSON.stringify(out) : '';
}

export async function run(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  const options = parse(argv);
  const tool = options.for;
  const adapter = tool ? ADAPTERS[tool] : undefined;
  // An unknown tool is a typo in somebody's hook config. Saying so on
  // stderr is safe; stdout is not.
  if (!adapter) {
    process.stderr.write(`TeamFlow: no hook adapter for "${tool || '(none)'}". Known: ${Object.keys(ADAPTERS).sort().join(', ')}\n`);
    return;
  }
  if (options.mode) {
    await runMode(tool, options.mode);
    return;
  }

  const passive = PASSIVE_STDOUT[tool];
  // The root, not wherever the shim was run from. These tools promise
  // nothing about the working directory they hand a hook, and
  // `.teamflow.json`, the project id and the binding all hang off it.
  const root = repositoryRoot(cwd);
  const config = loadConfig(root);
  // Is there anything to say today? Local and cheap: the configuration
  // and one small file, no network.
  // Both texts travel; `noticeFor` picks by the channel's `audience`,
  // because only the table knows whether this tool's field is read by
  // the person or by the model.
  const notice = noticeDue(config) ? NOT_SIGNED_IN_TEXT : undefined;

  // Consent first, work second: whatever else happens below, the tool
  // has already been told it may carry on.
  //
  // The one exception, and it is worth being explicit about what it
  // costs. Which field a notice may legally go in depends on which
  // event this is — Cursor documents `additional_context` for
  // `postToolUse` and not for `afterFileEdit`, Junie documents
  // `systemMessage` for `SessionStart` and not for `Stop` — and the
  // event is in the payload. So on a run that has a notice to deliver,
  // the passive value is **withheld until stdin reaches EOF**, because
  // stdout can only be written once and writing the consent first would
  // leave no way to amend it.
  //
  // That is at most one hook run a day, and it is safe for the reason
  // the whole pipeline already depends on: every one of these tools
  // writes the event and closes the stream, and `handleEvent` cannot do
  // anything before EOF either, so a tool that held stdin open would
  // already hang on the line below. What the delay does risk is a tool
  // that killed the hook on a timeout between the write and EOF — it
  // would see no consent rather than an empty one. Nothing is denied by
  // silence in any of these tools, and the `catch` below puts the
  // passive value back for a payload that cannot be parsed.
  if (!notice && passive) process.stdout.write(passive);

  let payload;
  try {
    payload = await readStdin();
  } catch (error) {
    if (notice && passive) process.stdout.write(passive);
    throw error;
  }
  // A context event of a tool whose output reaches the model (MACLEOD-972)
  // writes once, after the pipeline: the context and the notice go out as
  // one JSON object. Its passive value is empty, so nothing was written yet.
  // Copilot answers on the same stdout, so its notice waits too and travels
  // in the one object copilot.mjs writes at the end. A tool that reads an
  // answer back (Cursor) prints once, after the report, the same way.
  const speaks = Boolean(BY_ID[tool]?.context) && claudeEnvelope(tool)
    && CONTEXT_EVENTS.has(eventNameOf(payload)) && !passive;
  const answers = tool === 'cursor';
  const said = notice ? sayOnce(tool, payload, notice) : undefined;
  if (notice && !speaks && !answers && tool !== 'copilot') process.stdout.write(said ?? passive);

  const context = { cwd: root, event: options.event, config };
  if (tool === 'git' && options.event === 'pre-push') context.test = runTestCommand(config, root);

  const event = adapter(payload, context);
  if (!event && !answers) {
    if (said && (speaks || tool === 'copilot')) process.stdout.write(said);
    return;
  }
  // Which tool this is, so the report can name it (MACLEOD-532). After the
  // spread rather than before: the adapter translates the tool's payload and
  // has no business deciding what the tool is called. The context flag is
  // the tool's, or the adapter's for one event (Cursor's session start).
  let result;
  try {
    if (event) {
      result = await handleEvent({
        cwd: root, ...event, reporter_tool: tool,
        reporter_context: Boolean(BY_ID[tool]?.context || event.reporter_context),
      });
    }
  } finally {
    if (answers) {
      let out;
      try {
        const { respond } = await import('./cursor.mjs');
        out = await respond({ payload, event: event && { cwd: root, ...event }, result, said });
      } catch { /* the passive value, below */ }
      process.stdout.write(out ?? said ?? passive);
    }
  }
  if (answers) return;
  if (tool === 'copilot') {
    const { copilotOutput } = await import('./copilot.mjs');
    const out = await copilotOutput({ event: event.hook_event_name, input: { cwd: root, ...event }, result, said });
    if (out) process.stdout.write(out);
    return;
  }
  // Kiro reads stdout back: context on SessionStart and UserPromptSubmit,
  // and a continue on Stop (MACLEOD-972). kiro.mjs says why. A session
  // another tool drives hears nothing that could steer it (MACLEOD-908).
  if (tool === 'kiro') {
    if (!drivenBy(event, process.env, root)) {
      const { kiroOutput } = await import('./kiro.mjs');
      const out = await kiroOutput(event, result);
      if (out) process.stdout.write(out);
    }
    return;
  }
  if (!speaks) return;
  // A session another tool drives still reports, and hears nothing that
  // could steer it (MACLEOD-908), as in hook.mjs.
  if (drivenBy(event, process.env, root)) {
    if (said) process.stdout.write(said);
    return;
  }
  const output = contextOutput(result || {}, said);
  if (output) process.stdout.write(output);
}

export async function main(argv = process.argv.slice(2)) {
  await failOpen(() => run(argv));
}
