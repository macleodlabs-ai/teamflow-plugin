#!/usr/bin/env node
// What TeamFlow can automate in each tool, as data.
//
// One record per tool. The site generator reads this file rather than
// being told the same facts again in prose, so a tool that gains a hook
// system changes one record here and the guides, the landing page and
// `teamflow hooks status` all follow. A test asserts that every tool
// the skills installer knows has a record, and that `automation` is
// what the hooks installer actually writes, so a record cannot promise
// automation the code does not install.
//
// `automation` is exactly three values and means what TeamFlow achieves
// for that tool, not what the vendor might one day ship:
//
//   hooks      the tool calls `teamflow hook --for <id>` on its own
//              events, so reporting is automatic per tool call the way
//              it is in Claude Code
//   git-hooks  the tool has no hook system a command can subscribe to;
//              `teamflow hooks install --git` reports on commit, merge
//              and push instead, which is coarser but needs nobody to
//              remember anything
//   rules      neither is possible; the skills and the rules file are
//              installed and the agent decides whether to report
//
// There is deliberately no `uninstall` field, and adding one would be a
// mistake (MACLEOD-582). Uninstall is not a per-tool capability: it is
// the inverse of whatever install wrote for that tool, derived from the
// same HOOK_SPECS and skills tables, so every tool with an install has
// one. A field here could only repeat that, and would be the thing that
// went stale.
//
// `events` lists what is covered in that tool's own vocabulary, so a
// reader can check it against their vendor's documentation.
//
// `verified` says how far the payload behind those events has actually
// been confirmed, because "documented" and "seen arriving" are not the
// same claim and a reader deciding whether to trust a board is entitled
// to know which one this is. `from` is one of:
//
//   docs    read off the vendor's own hook documentation
//   source  read out of the tool's own source or repository, which
//           beats a vendor page and is how Cline's field names were
//           fixed
//   run     the plugin was installed in the tool and the payload was
//           watched arriving
//
// Nothing here says `run` yet. Upgrading one is a real session in the
// tool, not an edit: docs/PLUGIN.md says what to run and what to look
// for.
//
// `notice` is the one thing a hook is allowed to say out loud
// (MACLEOD-569). stdout is how these tools are told to DENY an action,
// so the reporter is silent on it — but several of them document a
// field on that same stdout that is explicitly informational, and
// without one there is no way at all to tell a customer that nobody has
// signed in and the board will stay empty. Each entry is:
//
//   events    the tool's own event names this field works on, in order
//             of preference. Only events the installer registers.
//   field     the field name, spelled as that vendor spells it
//   audience  'person' when the vendor says it is shown to the user,
//             'agent' when it says it goes into the model's context.
//             Never blurred: a line the model reads is not a line the
//             customer read, and a table that said otherwise would be
//             promising something nobody sees.
//   quote     the vendor wording the claim rests on
//
// An empty list means there is no such field, which is a real answer
// and is Windsurf's. `noticeFor` in adapters.mjs is the only reader,
// `hook-cli.mjs` never claims the day's one notice unless this table
// produced something to print, and a test per tool asserts that what
// was claimed actually appeared.
//
// Every `doc` URL was read on 2026-09-17, re-read on 2026-09-18, and
// the `notice` entries were read on 2026-09-19.
//
// `tested` says whether TeamFlow has been run in that tool, day to day,
// with a real session moving real cards (MACLEOD-639). It is a stronger
// claim than `verified.from: 'run'`: one payload watched arriving is not
// a tool we use every day. Only Claude Code is tested today. Hook-payload
// unit tests in plugin/tests do not count, because they feed the adapter
// a payload copied from the docs and never start the tool. Every page
// that lists a tool reads this field: a tested tool says so, and an
// untested one is shown dimmed as "Untested · coming shortly", with its
// install steps kept in full.
//
// `vendorHooks` names hooks a tool documents that TeamFlow does not read
// yet (MACLEOD-639, the tools added 2026-09-23). A tool listed with it
// reports through the git fallback until an adapter is written against
// a payload somebody has seen, so the pages can say "it has hooks, and
// TeamFlow does not use them yet" rather than "it has no hooks".

export const TOOL_CAPABILITIES = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    automation: 'hooks',
    tested: true,
    events: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'TaskCompleted', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd'],
    doc: 'https://code.claude.com/docs/en/hooks',
    verified: {
      date: '2026-09-18',
      from: 'docs',
      note: 'Claude Code\'s own event shape is the shape the classifier reads, so there is nothing to translate and nothing to drift.',
    },
    // Claude Code's notice is not on this path at all: hook.mjs prints
    // `additionalContext` on SessionStart through claudeContext in
    // hook-core.mjs, which is a decision field of its own and predates
    // this table. Empty here means `teamflow hook --for claude-code`
    // says nothing, which is right, because nothing calls it.
    notice: [],
    description: 'The plugin carries its own hooks, so every edit, test run, audit, merge and deploy reports itself with nothing to install per repository.',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    automation: 'hooks',
    tested: false,
    events: ['afterFileEdit', 'postToolUse', 'postToolUseFailure', 'afterShellExecution', 'stop'],
    doc: 'https://cursor.com/docs/agent/hooks',
    verified: {
      date: '2026-09-18',
      from: 'docs',
      note: '`afterShellExecution` still documents `command`, `output`, `duration` and `sandbox` and no exit status, so a shell command is reported only through `postToolUse` and `postToolUseFailure`; not yet watched arriving from a real Cursor session.',
    },
    // `sessionStart` first, because that is once a session and at the
    // start of it, which is when a sign-in notice is worth reading.
    // The installer registers it for the notice alone — it reports
    // nothing, which is why it is not in `events` above. The two
    // post-call events stay in the list as the fallback for a
    // repository whose `.cursor/hooks.json` was written before this
    // release and has no `sessionStart` entry; the daily stamp is what
    // stops that fallback becoming a line per edit.
    notice: [{
      events: ['sessionStart', 'postToolUse', 'postToolUseFailure'],
      field: 'additional_context',
      audience: 'agent',
      quote: 'sessionStart: "Additional context to add to the conversation\'s initial system context"; '
        + 'postToolUse: "Extra context injected into the conversation after the tool result".',
    }],
    description: 'Cursor has the fullest hook set outside Claude Code, including a distinct failure event, so a red test run reports rework rather than a green gate.',
  },
  {
    id: 'copilot',
    name: 'VS Code with GitHub Copilot',
    automation: 'hooks',
    tested: false,
    events: ['PostToolUse', 'PostToolUseFailure', 'Stop', 'postToolUse', 'postToolUseFailure', 'agentStop'],
    doc: 'https://code.visualstudio.com/docs/copilot/customization/hooks',
    verified: {
      date: '2026-09-18',
      from: 'docs',
      note: 'The two dialects out of one file were confirmed field for field: `toolResult.resultType` for the CLI against `tool_result.result_type` for VS Code, and `postToolUseFailure` against `PostToolUseFailure`.',
    },
    // The only one of these that the vendor says reaches the person in
    // so many words, and it is documented for every hook rather than
    // per event, so both dialects carry it.
    notice: [{
      events: ['PostToolUse', 'PostToolUseFailure', 'Stop',
        'postToolUse', 'postToolUseFailure', 'agentStop'],
      field: 'systemMessage',
      audience: 'person',
      quote: 'One of the three fields "all hooks support", beside `continue` and `stopReason`: '
        + 'it "displays a warning to the user in the chat".',
    }],
    description: 'One hook file in .github/hooks covers both the VS Code agent and Copilot CLI, which read the same directory in two different dialects.',
  },
  {
    id: 'windsurf',
    name: 'Windsurf / Devin Desktop',
    automation: 'hooks',
    tested: false,
    events: ['post_write_code', 'post_run_command', 'post_cascade_response'],
    doc: 'https://docs.devin.ai/desktop/cascade/hooks',
    verified: {
      date: '2026-09-18',
      from: 'docs',
      note: '`post_run_command` documents `command_line` and `cwd` inside `tool_info` and neither an output nor an exit status, so a finished command is not reported until Cascade says how it ended.',
    },
    // Nothing, and it stays nothing. Cascade documents exit codes and
    // no output schema at all; a hook's stdout and stderr reach its UI
    // only when the hook is configured `show_output`, which would put a
    // line in front of the developer on every edit and every command
    // rather than once. Guessing a field here would be a reporter
    // denying a write.
    notice: [],
    description: 'Cascade hooks report every write and every finished command, so the board follows a Windsurf session without anyone typing a command.',
  },
  {
    id: 'cline',
    name: 'Cline',
    automation: 'hooks',
    tested: false,
    events: ['PostToolUse'],
    doc: 'https://cline.bot/blog/cline-v3-36-hooks',
    verified: {
      date: '2026-09-18',
      from: 'source',
      note: 'Field names are from Cline\'s own repository rather than a vendor page: `.clinerules/hooks/README.md` prints the payload as a schema, and it is where `success` turned out to be a sibling of `result` rather than something inside it.',
    },
    notice: [{
      events: ['PostToolUse'],
      field: 'contextModification',
      audience: 'agent',
      quote: 'Documented beside `cancel: false` as text that "inject[s] text into the conversation, '
        + 'affecting future AI decisions" without cancelling. Cline adds that it "shape[s] the next '
        + 'API request, not the current one", which is fine: this is not about the call that just ran.',
    }],
    description: 'Cline runs an executable named after the event rather than reading a config file, and hooks have to be switched on once in Settings before it will.',
  },
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    automation: 'hooks',
    tested: false,
    events: ['PostToolUse', 'Stop'],
    doc: 'https://learn.chatgpt.com/docs/hooks',
    verified: {
      date: '2026-09-18',
      from: 'docs',
      note: 'The envelope is Claude Code\'s field for field, so the only check that matters is the event list, and `PostToolUse` and `Stop` are both still there.',
    },
    notice: [{
      events: ['PostToolUse', 'Stop'],
      field: 'systemMessage',
      audience: 'person',
      quote: 'Claude Code\'s field, kept field for field: "surfaced as a warning in the UI or event '
        + 'stream". The fields that block are `decision`, `continue` and `permissionDecision`.',
    }],
    description: 'Codex adopted Claude Code’s hook shape field for field, so TeamFlow reports from it exactly as it does from Claude Code.',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    automation: 'hooks',
    tested: false,
    events: ['AfterTool', 'AfterAgent'],
    doc: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md',
    verified: {
      date: '2026-09-18',
      from: 'docs',
      note: '`AfterTool` carries `tool_name`, `tool_input` and `tool_response` over Claude Code\'s base fields, and stdout is still parsed as JSON, which is why the hook answers `{}`.',
    },
    notice: [{
      events: ['AfterTool', 'AfterAgent'],
      field: 'systemMessage',
      audience: 'person',
      quote: 'Documented as a non-blocking informational display to the user, against `decision: "deny"` '
        + 'which is the field that blocks. It goes in place of the bare `{}` the hook already prints.',
    }],
    description: 'AfterTool fires on every finished tool call, which is everything TeamFlow needs; the hook stays silent because Gemini parses a hook’s stdout as JSON.',
  },
  {
    id: 'jetbrains',
    name: 'JetBrains Junie',
    automation: 'hooks',
    tested: false,
    events: ['PreToolUse', 'Stop'],
    doc: 'https://junie.jetbrains.com/docs/junie-cli-hooks.html',
    verified: {
      date: '2026-09-18',
      from: 'docs',
      note: 'Still no `PostToolUse` of any kind: the reference names a planned `PostToolUseFailure` and nothing else after a tool call, so the gates still need the git fallback.',
    },
    // Read again on 2026-09-19 and it does not say what a first reading
    // of it suggested. `systemMessage` is "honoured by the SessionStart,
    // SessionEnd and UserPromptSubmit executors", and the page says in
    // so many words that "the Stop executor does not currently surface
    // it in the TUI" — so the obvious place to put this, the one event
    // after a turn, is the one place nobody would ever read it. Worse
    // than useless: it would have spent the machine's one notice for
    // the day printing into nothing, leaving a Junie-and-Cursor user
    // told less than before this existed.
    //
    // So SessionStart, which the installer now registers for the notice
    // alone (it reports nothing, which is why it is not in `events`).
    // SessionEnd is not used even though it is on the same list,
    // because the page also says hook output is discarded there.
    //
    // PreToolUse is the fallback, for a machine whose
    // ~/.junie/config.json was written before this release. It is
    // agent-facing and that is stated rather than smoothed over:
    // `additionalContext` is documented as "agent-facing, never
    // published to the TUI", so on an old install the model is told and
    // the person is not. Re-running the installer is what fixes that.
    notice: [
      {
        events: ['SessionStart'],
        field: 'systemMessage',
        audience: 'person',
        quote: '"user-facing TUI info message, published as `<Event> hook: <message>`", '
          + '"honoured by the SessionStart, SessionEnd and UserPromptSubmit executors". '
          + 'Explicitly NOT Stop: "the Stop executor does not currently surface it in the TUI".',
      },
      {
        events: ['PreToolUse'],
        field: 'additionalContext',
        audience: 'agent',
        quote: '"agent-facing, never published to the TUI". The fallback for an install that '
          + 'predates the SessionStart registration; the model is told, the person is not.',
      },
    ],
    description: 'Junie CLI fires before a tool call and never after one, so edits report as work in progress and the test and audit gates need the git fallback.',
  },
  {
    id: 'zed',
    name: 'Zed',
    automation: 'git-hooks',
    tested: false,
    events: ['post-commit', 'post-merge', 'pre-push'],
    doc: 'https://zed.dev/docs/ai/agent-panel',
    verified: {
      date: '2026-09-18',
      from: 'docs',
      note: 'The agent panel exposes no hook a local command can subscribe to, so there is no payload to verify and the git fallback is the whole story.',
    },
    // The git fallback's stdout goes nowhere a person reads: two of the
    // three hooks TeamFlow writes redirect both streams to /dev/null so
    // a commit stays quiet, so a line there would be burnt unread.
    // `hooks install --git` says it at install time instead.
    notice: [],
    description: 'Zed’s agent panel has no hook a local command can subscribe to, so TeamFlow reports from the repository’s own git hooks instead.',
  },
  {
    id: 'aider',
    name: 'Aider',
    automation: 'git-hooks',
    tested: false,
    events: ['post-commit', 'post-merge', 'pre-push'],
    doc: 'https://aider.chat/docs/usage/lint-test.html',
    verified: {
      date: '2026-09-18',
      from: 'docs',
      note: 'No hook system, so there is no payload to verify; what matters is that Aider still commits after every edit by default, which is what the post-commit hook rides on.',
    },
    notice: [],   // the git fallback; see zed
    description: 'Aider has no hook system, but it commits after every edit by default, so the git post-commit hook tracks an Aider session closely.',
  },
  // The tools added on 2026-09-23 at the owner's request (MACLEOD-639).
  // Each was read off its vendor's own page that day. None is tested,
  // and none has an adapter yet, so each reports through the git
  // fallback; `vendorHooks` names the hooks it documents.
  {
    id: 'grok',
    name: 'Grok Build',
    automation: 'git-hooks',
    tested: false,
    events: ['post-commit', 'post-merge', 'pre-push'],
    vendorHooks: ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'SessionStart', 'SessionEnd', 'Stop'],
    doc: 'https://docs.x.ai/build/features/hooks',
    verified: {
      date: '2026-09-23',
      from: 'docs',
      note: 'Hooks run a command with the event as JSON on stdin: `hookEventName`, `sessionId`, `cwd`, `workspaceRoot`, and `toolName` and `toolInput` for tool events. No tool result is documented, so a test run cannot be read as passed or failed yet.',
    },
    notice: [],
    description: 'Grok Build has its own hooks, and it also reads Claude Code and Cursor hook files. TeamFlow does not read its payload yet, so it reports on commit, merge and push.',
  },
  {
    id: 'codex-ide',
    name: 'OpenAI Codex IDE extension',
    automation: 'git-hooks',
    tested: false,
    events: ['post-commit', 'post-merge', 'pre-push'],
    vendorHooks: [],
    doc: 'https://developers.openai.com/codex/ide',
    verified: {
      date: '2026-09-23',
      from: 'docs',
      note: 'The extension shares `~/.codex/config.toml` with Codex CLI, but Codex hooks fire in the CLI only (openai/codex#17930), so the extension has no hook to subscribe to.',
    },
    notice: [],
    description: 'The Codex extension for VS Code and Cursor shares the CLI’s configuration but not its hooks, so TeamFlow reports from git hooks here.',
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    automation: 'git-hooks',
    tested: false,
    events: ['post-commit', 'post-merge', 'pre-push'],
    vendorHooks: ['tool.execute.after', 'file.edited', 'session.idle'],
    doc: 'https://opencode.ai/docs/plugins/',
    verified: {
      date: '2026-09-23',
      from: 'docs',
      note: 'OpenCode events reach JavaScript or TypeScript plugins only; there is no configured shell command to run on an event, so a TeamFlow plugin for OpenCode is the next step.',
    },
    notice: [],
    description: 'OpenCode hooks are JavaScript plugins, not commands. Until TeamFlow ships one, OpenCode work reports on commit, merge and push.',
  },
  {
    id: 'openhands',
    name: 'OpenHands',
    automation: 'git-hooks',
    tested: false,
    events: ['post-commit', 'post-merge', 'pre-push'],
    vendorHooks: ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd'],
    doc: 'https://docs.openhands.dev/sdk/guides/hooks',
    verified: {
      date: '2026-09-23',
      from: 'docs',
      note: 'The hooks are documented for the OpenHands SDK, set in Python with `HookConfig`; the CLI documents no hook file, so there is nothing for an installer to write yet.',
    },
    notice: [],
    description: 'OpenHands documents hooks in its SDK and not in its CLI, so TeamFlow reports OpenHands work on commit, merge and push.',
  },
  {
    id: 'pi',
    name: 'Pi',
    automation: 'git-hooks',
    tested: false,
    events: ['post-commit', 'post-merge', 'pre-push'],
    vendorHooks: ['tool_call', 'tool_result', 'session_start', 'session_shutdown'],
    doc: 'https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md',
    verified: {
      date: '2026-09-23',
      from: 'docs',
      note: 'Pi events reach TypeScript or JavaScript extensions through `pi.on()`, not a configured command, and Pi has no MCP client, so the rules point it at the `teamflow` command.',
    },
    notice: [],
    description: 'Pi hooks are extensions written in TypeScript, and Pi has no MCP client. TeamFlow reports Pi work on commit, merge and push.',
  },
  {
    id: 'kiro',
    name: 'Kiro',
    automation: 'git-hooks',
    tested: false,
    events: ['post-commit', 'post-merge', 'pre-push'],
    vendorHooks: ['PreToolUse', 'PostToolUse', 'PostFileSave', 'Stop'],
    doc: 'https://kiro.dev/docs/hooks/',
    verified: {
      date: '2026-09-23',
      from: 'docs',
      note: 'Hooks live in `.kiro/hooks/*.json` and a command hook gets session context as JSON on stdin, but the fields are not documented, and stdout goes into the agent’s context.',
    },
    notice: [],
    description: 'Kiro has hooks, but it does not document what they send. Until that is seen, TeamFlow reports Kiro work on commit, merge and push.',
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    automation: 'git-hooks',
    tested: false,
    events: ['post-commit', 'post-merge', 'pre-push'],
    vendorHooks: ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop'],
    doc: 'https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/',
    verified: {
      date: '2026-09-23',
      from: 'docs',
      note: '`PostToolUse` documents `tool_name`, `tool_input`, `tool_response`, `tool_use_id` and `duration_ms` in `.qwen/settings.json` hooks, close to Claude Code’s shape; an adapter is the next step once a real session is watched.',
    },
    notice: [],
    description: 'Qwen Code has hooks close to Claude Code’s. TeamFlow does not read them yet, so it reports Qwen Code work on commit, merge and push.',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    automation: 'rules',
    tested: false,
    events: [],
    doc: 'https://code.claude.com/docs/en/desktop',
    verified: {
      date: '2026-09-18',
      from: 'docs',
      note: 'No local command runs on the chat side, so there is nothing to hook and nothing to verify.',
    },
    notice: [],   // no local command runs at all, so there is no hook to say it in
    description: 'The chat side runs no local command and has no hooks; the Code tab is Claude Code and is covered by installing the plugin there.',
  },
];

/**
 * The table by id, on a null prototype, which is not a style choice.
 *
 * This table is indexed by strings that arrive from OUTSIDE the
 * process: `TEAMFLOW_TOOL` out of the environment, and the `client`
 * field of a device request, which the service takes as forty raw
 * characters and echoes back to the consent page without an allowlist.
 * Every one of its seven readers asks it the same way — `BY_ID[x]`,
 * then a truthiness test or `?.` — so with `Object.prototype` still
 * attached, `constructor`, `toString`, `valueOf`, `hasOwnProperty`,
 * `isPrototypeOf` and `__proto__` all answered something. That is how
 * `TEAMFLOW_TOOL=constructor` put the word "Object" on the screen
 * where a person grants a credential to a machine (MACLEOD-605): the
 * lookup that exists to reject unknown ids was accepting six of them.
 *
 * `Object.create(null)` is the fix rather than `Object.hasOwn` at the
 * call sites, because the property belongs to the table and not to
 * whoever reads it: there are seven readers here and in the dashboard,
 * which imports this same file, and a guard added at two of them
 * leaves five. A table asked about keys it does not have must say no.
 *
 * Spreading, `Object.keys` and plain indexing all behave unchanged; it
 * is only the inherited names that stop answering.
 */
export const BY_ID = Object.assign(
  Object.create(null),
  Object.fromEntries(TOOL_CAPABILITIES.map((tool) => [tool.id, tool])),
);

export const AUTOMATION_LEVELS = ['hooks', 'git-hooks', 'rules'];

// How far a record's payload claim has been taken, weakest first.
export const VERIFICATION_SOURCES = ['docs', 'source', 'run'];

export function capability(id) {
  return BY_ID[id];
}
