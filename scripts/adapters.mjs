#!/usr/bin/env node
// One classifier, many hook protocols.
//
// `classifyTool` in core.mjs reads Claude Code's event shape, and that
// is the only shape it will ever read. Everything else that can call a
// command on its own events gets a function here that translates its
// payload into that shape:
//
//   {
//     hook_event_name: 'PostToolUse' | 'PostToolUseFailure' | 'Stop' | ...,
//     tool_name:       'Edit' | 'Write' | 'Bash' | ...,
//     tool_input:      { command, file_path },
//     tool_response:   whatever the tool said back,
//     session_id, cwd
//   }
//
// A second classifier would drift: a stage would appear in Cursor and
// not in Claude Code, or the other way round, and nobody would notice
// until a board was wrong. So adapters are pure and dumb. They rename
// fields. They never decide a stage.
//
// Returning undefined means "this event carries nothing TeamFlow
// reports", which is the normal case for most events of most tools.



import { projectId, repositoryRoot } from './core.mjs';

// A tool that has no session concept still needs a stable key, because
// the session file is where the last published state lives and a fresh
// one every commit would republish the same stage forever. One per
// repository per tool is the right grain.
export function sessionFor(tool, cwd, given) {
  if (given) return String(given).slice(0, 120);
  // Per repository, which is why the root is resolved here too: an
  // event naming a package directory would otherwise open a second
  // session against the same work and republish the same stage forever.
  return `${tool}-${projectId(repositoryRoot(cwd))}`;
}

// Claude Code's own names for the things every one of these tools has.
// An edit is an edit whatever the tool calls it.
const EDIT = 'Edit';
const SHELL = 'Bash';

// Most of these tools name their events in their own dialect. This maps
// the ones that mean "a tool call finished" and "a turn finished"; an
// event that means neither is dropped rather than guessed at.
function outcome(ok) {
  return ok === false ? 'PostToolUseFailure' : 'PostToolUse';
}

function pick(object, names) {
  if (!object || typeof object !== 'object') return undefined;
  for (const name of names) {
    const value = object[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

// Every one of these tools calls a shell command's argument something
// slightly different, and a file's path something slightly different
// again. classifyTool reads `tool_input.command`, so this is where the
// dialects end.
export function normalizeInput(raw) {
  const input = {};
  const command = pick(raw, ['command', 'command_line', 'commandLine', 'cmd', 'shell_command']);
  if (typeof command === 'string') input.command = command;
  const file = pick(raw, ['file_path', 'filePath', 'absolute_path', 'absolutePath', 'path', 'target_file', 'targetFile']);
  if (typeof file === 'string') input.file_path = file;
  return input;
}

// The tool's own name for what it just did, mapped onto the four names
// classifyTool actually branches on. Shape decides before the name
// does: a call carrying a shell command is a shell call whatever the
// vendor calls it, which is what makes this survive a tool being
// renamed in the next release.
export function normalizeToolName(name, input = {}) {
  if (typeof input.command === 'string' && input.command.trim()) return SHELL;
  const label = String(name || '');
  if (/merge/i.test(label) && /(github|pull|pr)/i.test(label)) return 'github_merge_pull_request';
  if (/(edit|write|create_file|createfile|replace|apply_patch|applypatch|str_replace|notebook|insert)/i.test(label)) return EDIT;
  if (/(shell|terminal|bash|run_command|runcommand|execute)/i.test(label)) return SHELL;
  return label;
}

// Only Cursor, Copilot CLI and Claude Code have a distinct "that tool
// call failed" event. Everywhere else the failure is somewhere in the
// response, under one of these names. A response that says nothing is
// read as success, which is the same assumption Claude Code makes.
export function failedFrom(response) {
  if (!response || typeof response !== 'object') return false;
  if (response.success === false) return true;
  if (response.isError === true || response.is_error === true) return true;
  if (response.error) return true;
  for (const name of ['exitCode', 'exit_code', 'status', 'code', 'returncode']) {
    const value = response[name];
    if (typeof value === 'number' && value !== 0) return true;
  }
  // Copilot spells this `resultType` to its CLI and `result_type` to
  // VS Code, out of the same `.github/hooks/*.json` file.
  for (const name of ['resultType', 'result_type']) {
    if (typeof response[name] === 'string' && /error|fail|denied/i.test(response[name])) return true;
  }
  return false;
}

// One finished tool call, in the shape classifyTool reads.
export function toolEvent({ tool, input, response, ok, session, cwd }) {
  const normalized = normalizeInput(input);
  const name = normalizeToolName(tool, normalized);
  if (!name) return undefined;
  const failed = ok === false || (ok === undefined && failedFrom(response));
  return {
    hook_event_name: outcome(!failed),
    tool_name: name,
    tool_input: normalized,
    tool_response: response,
    session_id: session,
    cwd,
  };
}

// --- per-tool adapters ------------------------------------------------
//
// Each takes the payload that tool puts on stdin and returns a Claude
// Code shaped event, or undefined for an event that says nothing about
// delivery. Vendor field names are quoted from the documentation read
// on 2026-09-17 and re-read on 2026-09-18, except Cline's, which are
// from its own repository; see docs/PLUGIN.md for the URLs and what
// each check found.

export const ADAPTERS = {};

// What this tool must see on stdout to be sure it has not been told to
// block anything. Most want silence; Gemini CLI parses stdout as JSON
// and Cline reads a decision object, so those two get the smallest
// possible "carry on".
export const PASSIVE_STDOUT = {
  cursor: '',
  copilot: '',
  windsurf: '',
  cline: '{"cancel":false}',
  gemini: '{}',
  codex: '',
  jetbrains: '',
  git: '',
};

// --- Cursor -----------------------------------------------------------
//
// .cursor/hooks.json. Cursor is the closest of any of them to Claude
// Code: it has postToolUse AND postToolUseFailure, so the one thing
// every other adapter has to guess at is stated outright.
//
// afterShellExecution documents `command`, `output`, `duration` and
// `sandbox`, and still no exit status as of 2026-09-18. An event that
// cannot say whether the command passed cannot be classified, because
// "npm test" with an unknown outcome would otherwise report a green
// LOCAL_TEST for a red suite. So it is used only if Cursor does supply
// an exit code, and postToolUse / postToolUseFailure carry the shell
// calls otherwise — which they do, with cwd and tool_output of their
// own.
ADAPTERS.cursor = (payload = {}) => {
  const event = payload.hook_event_name;
  const cwd = payload.cwd || payload.workspace_roots?.[0] || process.cwd();
  const session = sessionFor('cursor', cwd, payload.conversation_id);
  const base = { session: session, cwd };

  if (event === 'afterFileEdit') {
    return toolEvent({ ...base, tool: EDIT, input: { file_path: payload.file_path }, ok: true });
  }
  if (event === 'postToolUse' || event === 'postToolUseFailure') {
    return toolEvent({
      ...base,
      tool: payload.tool_name,
      input: payload.tool_input,
      response: payload.tool_output,
      ok: event === 'postToolUse',
    });
  }
  if (event === 'afterShellExecution') {
    const exit = pick(payload, ['exit_code', 'exitCode', 'status']);
    if (typeof exit !== 'number') return undefined;
    return toolEvent({ ...base, tool: SHELL, input: { command: payload.command }, response: payload.output, ok: exit === 0 });
  }
  if (event === 'stop') {
    return { hook_event_name: 'Stop', session_id: session, cwd };
  }
  return undefined;
};

// --- GitHub Copilot ---------------------------------------------------
//
// .github/hooks/*.json, read by both the VS Code agent and Copilot CLI.
// The two speak different dialects of the same idea: VS Code sends
// Claude Code's envelope with PascalCase event names and camelCase
// tool_input keys, Copilot CLI sends camelCase event names with
// `toolName` and `toolArgs`, and `toolArgs` is a JSON *string*.
//
// One adapter reads both, because one hook file registers both.
ADAPTERS.copilot = (payload = {}) => {
  const event = payload.hook_event_name || payload.hookEventName || payload.eventName;
  const cwd = payload.cwd || process.cwd();
  const session = sessionFor('copilot', cwd, payload.session_id || payload.sessionId);
  const base = { session, cwd };

  if (/^(Stop|agentStop)$/.test(event || '')) {
    return { hook_event_name: 'Stop', session_id: session, cwd };
  }
  const failure = /^(postToolUseFailure|PostToolUseFailure)$/.test(event || '');
  // Copilot CLI's documented payload names no event at all: it is
  // `{timestamp, cwd, toolName, toolArgs}` and the hook is expected to
  // know which event it was registered for. So a payload that names a
  // tool is taken as a finished tool call, and whether it failed comes
  // out of `toolResult` the way it does for every other tool without a
  // failure event.
  const named = payload.tool_name || payload.toolName;
  if (!event && !named) return undefined;
  if (event && !/^(PostToolUse|postToolUse)$/.test(event) && !failure) return undefined;

  // `toolArgs` is documented as the parsed arguments, but it has been
  // seen as the JSON string of them; both end up as an object here.
  let input = payload.tool_input || payload.toolArgs || payload.toolArguments;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { input = {}; }
  }
  // `toolResult` to the CLI, `tool_result` to VS Code. There is no
  // `tool_response` in either dialect; it is kept because Copilot's
  // own docs used it before the reference page settled.
  const response = payload.toolResult || payload.tool_result || payload.tool_response || payload.toolResponse;
  return toolEvent({
    ...base,
    tool: payload.tool_name || payload.toolName,
    input,
    response,
    ok: failure ? false : undefined,
  });
};

// --- Windsurf ---------------------------------------------------------
//
// .windsurf/hooks.json. Everything arrives under `tool_info`, and the
// event name says what kind of thing it was rather than the payload:
// post_write_code is an edit, post_run_command is a shell call.
// Checked again on 2026-09-18: post_run_command's tool_info documents
// `command_line` and `cwd` and nothing else — no output and no exit
// status — so the same rule as Cursor applies and a command whose
// outcome is unknown is not reported. `output` and the exit code are
// read for the release that adds them.
ADAPTERS.windsurf = (payload = {}) => {
  const event = payload.agent_action_name || payload.hook_event_name;
  const info = payload.tool_info || {};
  const cwd = info.cwd || payload.cwd || process.cwd();
  const session = sessionFor('windsurf', cwd, payload.trajectory_id);
  const base = { session, cwd };

  if (event === 'post_write_code') {
    return toolEvent({ ...base, tool: EDIT, input: { file_path: info.file_path }, ok: true });
  }
  if (event === 'post_run_command') {
    const exit = pick(info, ['exit_code', 'exitCode', 'status']);
    if (typeof exit !== 'number') return undefined;
    return toolEvent({ ...base, tool: SHELL, input: { command: info.command_line }, response: info.output, ok: exit === 0 });
  }
  if (event === 'post_cascade_response') {
    return { hook_event_name: 'Stop', session_id: session, cwd };
  }
  return undefined;
};

// --- Cline ------------------------------------------------------------
//
// .clinerules/hooks/<HookName>, an executable named exactly after the
// event, with no config file at all. The payload nests the event's own
// fields under a key named for the event in lower camel case.
//
// These names are not from a vendor page: they are from Cline's own
// repository, .clinerules/hooks/README.md, read on 2026-09-18, which
// prints the payload as a schema. The adapter used to accept a second
// spelling of each of them — tool_name, toolInput, response — and none
// of the three exists. They are gone rather than kept, because an
// alternative that is wrong is not tolerance, it is a place for a real
// drift to hide.
//
// `success` is the field that matters and it is a sibling of `result`,
// not something inside it; `result` is a string. So the outcome is read
// here and not left to failedFrom, which would find nothing in a string
// and call every failed command a pass.
ADAPTERS.cline = (payload = {}) => {
  const event = payload.hookName || payload.hook_event_name;
  const cwd = payload.workspaceRoots?.[0] || payload.cwd || process.cwd();
  const session = sessionFor('cline', cwd, payload.taskId);
  const base = { session, cwd };

  if (event === 'PostToolUse') {
    const body = payload.postToolUse || {};
    return toolEvent({
      ...base,
      tool: body.toolName,
      input: body.parameters,
      response: body.result,
      ok: typeof body.success === 'boolean' ? body.success : undefined,
    });
  }
  // TaskCancel fires today. TaskComplete is in the documented hookName
  // union and marked "coming soon", so it is mapped now rather than
  // being a silent gap on the release that ships it.
  if (event === 'TaskComplete' || event === 'TaskCancel') {
    return { hook_event_name: 'Stop', session_id: session, cwd };
  }
  return undefined;
};

// --- Gemini CLI -------------------------------------------------------
//
// .gemini/settings.json. The envelope is Claude Code's in all but the
// event names: `AfterTool` rather than `PostToolUse`, and no failure
// event, so the outcome is read out of `tool_response`.
ADAPTERS.gemini = (payload = {}) => {
  const event = payload.hook_event_name;
  const cwd = payload.cwd || process.cwd();
  const session = sessionFor('gemini', cwd, payload.session_id);

  if (event === 'AfterTool') {
    return toolEvent({
      session,
      cwd,
      tool: payload.tool_name,
      input: payload.tool_input,
      response: payload.tool_response,
    });
  }
  if (event === 'AfterAgent' || event === 'SessionEnd') {
    return { hook_event_name: 'Stop', session_id: session, cwd };
  }
  return undefined;
};

// --- OpenAI Codex CLI -------------------------------------------------
//
// .codex/hooks.json, and the closest thing to a passthrough here: Codex
// copied Claude Code's envelope field for field, down to `tool_input`
// and `tool_response`. The only translations are its tool names
// (`apply_patch` for an edit) and the absence of a failure event, so
// the outcome comes out of the response like everywhere else.
ADAPTERS.codex = (payload = {}) => {
  const event = payload.hook_event_name;
  const cwd = payload.cwd || process.cwd();
  const session = sessionFor('codex', cwd, payload.session_id);

  if (event === 'PostToolUse') {
    return toolEvent({
      session,
      cwd,
      tool: payload.tool_name,
      input: payload.tool_input,
      response: payload.tool_response,
    });
  }
  if (event === 'Stop' || event === 'SessionEnd') {
    return { hook_event_name: event === 'Stop' ? 'Stop' : 'SessionEnd', session_id: session, cwd };
  }
  return undefined;
};

// --- JetBrains Junie CLI ----------------------------------------------
//
// ~/.junie/config.json. Junie fires SessionStart, UserPromptSubmit,
// PreToolUse, Stop, StopFailure, PermissionRequest and SessionEnd, and
// no PostToolUse at all. So Junie can say that an edit is about to
// happen and never that a command passed.
//
// An intended edit is still worth LOCAL_DEV, status running, which is
// exactly what it means. An intended `npm test` is worth nothing: a
// test that has not run yet has not passed, and reporting it green
// because it was about to start would be a lie the board could not
// recover from. So shell calls are dropped here and the git fallback
// covers the gates instead.
ADAPTERS.jetbrains = (payload = {}) => {
  const event = payload.hook_event_name;
  const cwd = payload.cwd || payload.project_path || process.cwd();
  const session = sessionFor('jetbrains', cwd, payload.session_id);

  if (event === 'PreToolUse') {
    const input = normalizeInput(payload.tool_input);
    if (input.command) return undefined;
    const name = normalizeToolName(payload.tool_name, input);
    if (name !== EDIT) return undefined;
    return toolEvent({ session, cwd, tool: EDIT, input, ok: true });
  }
  if (event === 'Stop' || event === 'SessionEnd') {
    return { hook_event_name: event === 'Stop' ? 'Stop' : 'SessionEnd', session_id: session, cwd };
  }
  return undefined;
};

// --- git --------------------------------------------------------------

// The fallback for every tool with no hook system. Three moments a
// repository knows about on its own, mapped through the same classifier
// so a git-hook LOCAL_TEST and a Claude Code LOCAL_TEST are the same
// report with the same summary.
//
// `test` is supplied by hook-cli.mjs after it has actually run the
// configured command; without a configured command a push reports
// nothing, because a push is not evidence that anything passed.
export function gitEvent(event, { cwd = process.cwd(), test } = {}) {
  const session = sessionFor('git', cwd);
  const base = { session_id: session, cwd };
  if (event === 'post-commit') {
    return { ...base, hook_event_name: 'PostToolUse', tool_name: EDIT, tool_input: {} };
  }
  if (event === 'post-merge') {
    return { ...base, hook_event_name: 'PostToolUse', tool_name: SHELL, tool_input: { command: 'git merge' } };
  }
  if (event === 'pre-push') {
    if (!test?.command) return undefined;
    return {
      ...base,
      hook_event_name: outcome(test.ok),
      tool_name: SHELL,
      tool_input: { command: test.command },
      tool_response: test.output,
    };
  }
  return undefined;
}

ADAPTERS.git = (payload = {}, options = {}) => gitEvent(options.event || payload.event, options);
