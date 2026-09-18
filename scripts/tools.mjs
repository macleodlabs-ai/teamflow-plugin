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
// Every `doc` URL was read on 2026-09-17 and re-read on 2026-09-18.

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
