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

export const TOOL_CAPABILITIES = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    automation: 'hooks',
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
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    automation: 'rules',
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

export const BY_ID = Object.fromEntries(TOOL_CAPABILITIES.map((tool) => [tool.id, tool]));

export const AUTOMATION_LEVELS = ['hooks', 'git-hooks', 'rules'];

// How far a record's payload claim has been taken, weakest first.
export const VERIFICATION_SOURCES = ['docs', 'source', 'run'];

export function capability(id) {
  return BY_ID[id];
}
