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
// Every `doc` URL was read on 2026-09-17.

export const TOOL_CAPABILITIES = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    automation: 'hooks',
    events: ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'TaskCompleted', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd'],
    doc: 'https://code.claude.com/docs/en/hooks',
    description: 'The plugin carries its own hooks, so every edit, test run, audit, merge and deploy reports itself with nothing to install per repository.',
  },
  {
    id: 'cursor',
    name: 'Cursor',
    automation: 'hooks',
    events: ['afterFileEdit', 'postToolUse', 'postToolUseFailure', 'afterShellExecution', 'stop'],
    doc: 'https://cursor.com/docs/agent/hooks',
    description: 'Cursor has the fullest hook set outside Claude Code, including a distinct failure event, so a red test run reports rework rather than a green gate.',
  },
  {
    id: 'copilot',
    name: 'VS Code with GitHub Copilot',
    automation: 'hooks',
    events: ['PostToolUse', 'Stop', 'postToolUse', 'postToolUseFailure', 'agentStop'],
    doc: 'https://code.visualstudio.com/docs/copilot/customization/hooks',
    description: 'One hook file in .github/hooks covers both the VS Code agent and Copilot CLI, which read the same directory in two different dialects.',
  },
  {
    id: 'windsurf',
    name: 'Windsurf / Devin Desktop',
    automation: 'hooks',
    events: ['post_write_code', 'post_run_command', 'post_cascade_response'],
    doc: 'https://docs.devin.ai/desktop/cascade/hooks',
    description: 'Cascade hooks report every write and every finished command, so the board follows a Windsurf session without anyone typing a command.',
  },
  {
    id: 'cline',
    name: 'Cline',
    automation: 'hooks',
    events: ['PostToolUse'],
    doc: 'https://cline.bot/blog/cline-v3-36-hooks',
    description: 'Cline runs an executable named after the event rather than reading a config file, and hooks have to be switched on once in Settings before it will.',
  },
  {
    id: 'codex',
    name: 'OpenAI Codex CLI',
    automation: 'hooks',
    events: ['PostToolUse', 'Stop'],
    doc: 'https://learn.chatgpt.com/docs/hooks',
    description: 'Codex adopted Claude Code’s hook shape field for field, so TeamFlow reports from it exactly as it does from Claude Code.',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    automation: 'hooks',
    events: ['AfterTool', 'AfterAgent'],
    doc: 'https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md',
    description: 'AfterTool fires on every finished tool call, which is everything TeamFlow needs; the hook stays silent because Gemini parses a hook’s stdout as JSON.',
  },
  {
    id: 'jetbrains',
    name: 'JetBrains Junie',
    automation: 'hooks',
    events: ['PreToolUse', 'Stop'],
    doc: 'https://junie.jetbrains.com/docs/junie-cli-hooks.html',
    description: 'Junie CLI fires before a tool call and never after one, so edits report as work in progress and the test and audit gates need the git fallback.',
  },
  {
    id: 'zed',
    name: 'Zed',
    automation: 'git-hooks',
    events: ['post-commit', 'post-merge', 'pre-push'],
    doc: 'https://zed.dev/docs/ai/agent-panel',
    description: 'Zed’s agent panel has no hook a local command can subscribe to, so TeamFlow reports from the repository’s own git hooks instead.',
  },
  {
    id: 'aider',
    name: 'Aider',
    automation: 'git-hooks',
    events: ['post-commit', 'post-merge', 'pre-push'],
    doc: 'https://aider.chat/docs/usage/lint-test.html',
    description: 'Aider has no hook system, but it commits after every edit by default, so the git post-commit hook tracks an Aider session closely.',
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    automation: 'rules',
    events: [],
    doc: 'https://code.claude.com/docs/en/desktop',
    description: 'The chat side runs no local command and has no hooks; the Code tab is Claude Code and is covered by installing the plugin there.',
  },
];

export const BY_ID = Object.fromEntries(TOOL_CAPABILITIES.map((tool) => [tool.id, tool]));

export const AUTOMATION_LEVELS = ['hooks', 'git-hooks', 'rules'];

export function capability(id) {
  return BY_ID[id];
}
