#!/usr/bin/env node
// `teamflow hooks`: the automatic half of TeamFlow outside Claude Code.
//
//   teamflow hooks install --for cursor   the tool's own hook config
//   teamflow hooks install --git          the repo-level git fallback
//   teamflow hooks status                 what is installed here, per tool
//
// `skills install --for <tool>` calls installHooks() too, so a developer
// who follows the documented one-liner gets the hooks without knowing
// this command exists. This module exists separately because git hooks
// are not a tool's hooks: they belong to the repository and cover a
// different, coarser set of moments.
//
// Nothing written here can block anything. A git hook that reports runs
// the reporter and ignores its result; a tool hook prints nothing on
// stdout, because stdout is how most of these tools are told to deny an
// action.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { fetchAccount, gitInfo, loadConfig, safeExec, transportOf } from './core.mjs';
// Namespace import, for one function that is not on this branch yet.
// MACLEOD-586 files the user binding under the organisation as well as
// under the legacy tenant and adds `userBindingPaths` as the one list of
// both — the list `unbind` and `adhoc clearBinding` already use. A named
// import of a function that is not there is a load-time error in every
// hook on the machine, and this module is imported by all of them.
import * as core from './core.mjs';
import { BY_ID } from './tools.mjs';
import {
  mergeJson, removeBlock, removeEmptyDir, removeFile, unmergeJson, writeBlock, writeFile,
} from './write.mjs';

const PACKAGE = 'github:macleodlabs-ai/teamflow-plugin';

const home = () => process.env.HOME || os.homedir();

export const GIT_BEGIN = '# BEGIN teamflow';
export const GIT_END = '# END teamflow';

// --- the rule, in the project's own instructions (MACLEOD-639) ---------
//
// The owner's ruling: every plan and every dispatched agent is on the
// board, always, and the plugin says so in CLAUDE.md so no orchestrator
// has to remember. Its own markers, distinct from the skills block, so
// an AGENTS.md that carries both keeps both. Written between markers
// and replaced in place: nothing of the user's above or below moves.
export const RULE_BEGIN = '<!-- BEGIN teamflow workflow -->';
export const RULE_END = '<!-- END teamflow workflow -->';

export const WORKFLOW_RULE = `## TeamFlow: every plan and every dispatched agent is on the board

Before any agent or team is dispatched, the run exists on the board and each
piece of work is a node in it. In Claude Code the command is
\`node "\${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs"\`; elsewhere it is \`teamflow\`.

1. \`teamflow workflow create "<name>"\` (or \`/teamflow:build\`) — one run per plan.
2. \`teamflow workflow plan --keys A,B,C\` or \`teamflow workflow add <KEY>\` for every
   ticket; \`teamflow adhoc start "<what the work is>"\` for work that has none.
3. \`teamflow workflow depends <KEY> --on <KEY> --reason "<why>"\` for each edge, so the
   board shows the phases.
4. \`teamflow workflow ticket <KEY> --state running|done|rework\` as each one moves.

If a session dispatches agents without doing this, the TeamFlow plugin does it:
it creates a run marked as auto-created, mints an ad hoc node for each agent
sent to a worktree (titled from the agent's name and description, never its
prompt), and binds the agent to it. \`teamflow status\` then reads
"N agents dispatched, 0 unrepresented", and the auto-created run still wants
\`depends\` before the board can draw its phases.

When another tool runs the plan, do not create TeamFlow runs. TeamFlow reads that tool's run instead.`;

/**
 * Put the rule in the project's instructions, idempotently.
 *
 * `file` defaults to CLAUDE.md. With `onlyExisting` the file is never
 * created -- that is the SessionStart hook's contract, which writes only
 * into a CLAUDE.md the project already keeps -- and an unchanged block
 * is not rewritten, so a second call changes nothing.
 */
export function installWorkflowRule({ root = process.cwd(), file, onlyExisting = false, written = [] } = {}) {
  const target = file || path.join(root, 'CLAUDE.md');
  if (onlyExisting && !fs.existsSync(target)) {
    written.push({ file: target, action: 'absent' });
    return written;
  }
  writeBlock(target, WORKFLOW_RULE, written, { begin: RULE_BEGIN, end: RULE_END });
  return written;
}

/** Take the rule back out. Only what install put there goes. */
export function uninstallWorkflowRule({ root = process.cwd(), file, written = [] } = {}) {
  removeBlock(file || path.join(root, 'CLAUDE.md'), written, { begin: RULE_BEGIN, end: RULE_END });
  return written;
}

// The three moments a repository knows about without any agent at all.
// Each maps to a stage through the same classifier every other hook
// uses; see adapters.mjs.
export const GIT_HOOKS = {
  'post-commit': { stage: 'LOCAL_DEV', covers: 'a commit reports local work' },
  'post-merge': { stage: 'MERGE', covers: 'a merge reports MERGE' },
  'pre-push': { stage: 'LOCAL_TEST', covers: 'a push runs the configured test command and reports a local test pass or failure' },
};

// `teamflow` when it is on PATH, the public package when it is not, so
// the same hook file works for a teammate who has never installed
// anything. Resolved at run time rather than install time: whoever
// commits next may not be whoever installed.
function invocation(event, { quiet }) {
  const args = `hook --for git --event ${event}`;
  const redirect = quiet ? ' >/dev/null 2>&1' : '';
  return [
    'if command -v teamflow >/dev/null 2>&1; then',
    `  teamflow ${args} </dev/null${redirect} || true`,
    'else',
    `  npx -y ${PACKAGE} ${args} </dev/null${redirect} || true`,
    'fi',
  ].join('\n');
}

export function gitHookBody(event) {
  // pre-push runs the test suite, so its output belongs on the
  // developer's terminal. The other two are a single HTTP POST and
  // have nothing worth saying.
  const quiet = event !== 'pre-push';
  return [
    '# TeamFlow delivery reporting. Observability, never a blocker: this',
    '# block always succeeds, so a TeamFlow outage cannot stop a commit,',
    '# a merge or a push. Remove the block to stop reporting.',
    invocation(event, { quiet }),
  ].join('\n');
}

// The ticket-key trailer ticketkey.mjs installs (MACLEOD-845).
export const TRAILER = 'TeamFlow-Key';

/**
 * The `prepare-commit-msg` block. It reads the key from the working
 * copy's own git directory, checks its shape, and adds or replaces the
 * trailer. Every path ends in success.
 */
export function trailerHookBody() {
  return [
    '# TeamFlow ticket key (MACLEOD-845). Adds a TeamFlow-Key trailer that names',
    '# the ticket this working copy is bound to. It never stops a commit.',
    'tf_msg="$1"',
    'tf_dir=$(git rev-parse --absolute-git-dir 2>/dev/null)',
    'if [ -n "$tf_msg" ] && [ -n "$tf_dir" ] && [ -f "$tf_dir/teamflow-key" ]; then',
    '  tf_key=$(head -c 40 "$tf_dir/teamflow-key" | tr -d \'\\r\\n\')',
    "  if printf '%s' \"$tf_key\" | grep -Eq '^[A-Z][A-Z0-9]{0,19}-[0-9]{1,9}$'; then",
    `    git interpret-trailers --in-place --if-exists replace --trailer "${TRAILER}: $tf_key" "$tf_msg" >/dev/null 2>&1 || true`,
    '  fi',
    'fi',
    'true',
  ].join('\n');
}

// Where this repository's hooks actually live, and never anywhere else.
//
// `git rev-parse --git-path hooks` looks like the answer and is a trap:
// it follows `core.hooksPath`, which on a machine that sets it globally
// resolves to something like ~/.config/git/hooks. Installing there
// would put TeamFlow into every repository the developer owns, which
// nobody asked for. So the directory is computed from --git-dir, and a
// core.hooksPath pointing outside the repository is refused rather than
// followed or silently ignored: git would not read .git/hooks at all in
// that case, so writing there would install nothing and say it worked.
export function gitHooksDir(root) {
  // --git-common-dir, not --git-dir: in a linked worktree --git-dir is
  // `.git/worktrees/<name>`, and git never reads hooks from there
  // (MACLEOD-845). In an ordinary checkout the two are the same.
  const gitDir = safeExec('git', ['-C', root, 'rev-parse', '--git-common-dir'], { cwd: root, timeout: 2000 });
  if (!gitDir.ok || !gitDir.stdout.trim()) return undefined;
  const local = path.resolve(root, gitDir.stdout.trim(), 'hooks');

  const configured = safeExec('git', ['-C', root, 'config', '--get', 'core.hooksPath'], { cwd: root, timeout: 2000 });
  const override = configured.ok ? configured.stdout.trim() : '';
  if (!override) return local;

  const resolved = path.resolve(root, override);
  const inside = resolved === path.resolve(root) || resolved.startsWith(path.resolve(root) + path.sep);
  if (inside) return resolved;
  return { outside: resolved };
}

function hooksDirOrThrow(root) {
  const dir = gitHooksDir(root);
  if (!dir) throw new Error(`${root} is not a git repository, so there is nowhere to install git hooks`);
  if (typeof dir !== 'string') {
    throw new Error(`core.hooksPath points at ${dir.outside}, outside this repository. `
      + 'TeamFlow will not write hooks that would run in every repository on this machine. '
      + `Add the block to ${path.join(dir.outside, 'post-commit')} by hand, or unset core.hooksPath for this repository.`);
  }
  return dir;
}

// A repository may already have a post-commit hook, and it is not ours
// to replace. The block goes at the end of whatever is there, under a
// `#!/bin/sh` line when the file is new.
export function installGitHooks({ root = process.cwd(), dryRun = false } = {}) {
  const dir = hooksDirOrThrow(root);
  const written = [];
  for (const event of Object.keys(GIT_HOOKS)) {
    const file = path.join(dir, event);
    if (dryRun) { written.push({ file, action: 'would write' }); continue; }
    writeBlock(file, gitHookBody(event), written, {
      begin: GIT_BEGIN,
      end: GIT_END,
      header: '#!/bin/sh',
      mode: 0o755,
    });
  }
  // The ticket-key trailer (MACLEOD-845): a commit names the bound ticket.
  if (!dryRun) {
    writeBlock(path.join(dir, 'prepare-commit-msg'), trailerHookBody(), written, {
      begin: GIT_BEGIN, end: GIT_END, header: '#!/bin/sh', mode: 0o755,
    });
  } else written.push({ file: path.join(dir, 'prepare-commit-msg'), action: 'would write' });
  // And the rule (MACLEOD-639), into the instructions file the repository
  // keeps: CLAUDE.md when there is one, else AGENTS.md, which every other
  // agent tool reads.
  if (!dryRun) {
    const claude = path.join(root, 'CLAUDE.md');
    installWorkflowRule({ root, file: fs.existsSync(claude) ? claude : path.join(root, 'AGENTS.md'), written });
  }
  return { scope: 'git', dir, written, covers: Object.values(GIT_HOOKS).map((h) => h.covers) };
}

// The way back out, and it is the markers that make it exact: what is
// between `# BEGIN teamflow` and `# END teamflow` is ours and everything
// else in the file is not. A repository that had its own post-commit
// hook keeps it, without the block; a file that is nothing but the block
// and the `#!/bin/sh` the installer wrote above it is the installer's
// and goes.
export function uninstallGitHooks({ root = process.cwd(), dryRun = false } = {}) {
  const dir = hooksDirOrThrow(root);
  const written = [];
  for (const event of Object.keys(GIT_HOOKS)) {
    const file = path.join(dir, event);
    if (dryRun) {
      const installed = fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(GIT_BEGIN);
      written.push({ file, action: installed ? 'would remove' : 'absent' });
      continue;
    }
    removeBlock(file, written, { begin: GIT_BEGIN, end: GIT_END, header: '#!/bin/sh' });
  }
  if (!dryRun) removeBlock(path.join(dir, 'prepare-commit-msg'), written, { begin: GIT_BEGIN, end: GIT_END, header: '#!/bin/sh' });
  return { scope: 'git', dir, written };
}

export function gitHooksInstalled(root = process.cwd()) {
  const dir = gitHooksDir(root);
  if (typeof dir !== 'string') return {};
  const out = {};
  for (const event of Object.keys(GIT_HOOKS)) {
    const file = path.join(dir, event);
    out[event] = fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(GIT_BEGIN);
  }
  return out;
}

// --- a tool's own hooks ----------------------------------------------

// Every hook config points at a shim rather than at a command line,
// for two reasons. The tools disagree about whether `command` is a
// program or a shell line, and about how arguments are quoted; and the
// question of where `teamflow` actually lives has one answer that has
// to be re-asked on every machine the repository is checked out on.
// One small script answers both, and the hook configs stay trivial.
export function shimPath(root, tool, ext = 'sh') {
  return path.join(root, '.teamflow', 'hooks', `${tool}.${ext}`);
}

// What goes in the config file, as opposed to where the file is
// written. These configs are committed and read on every teammate's
// machine, so an absolute path would name the installer's home
// directory and work nowhere else. Every one of these tools documents
// a hook command as relative to the project root — Cursor's own example
// is `.cursor/hooks/format.sh` — and Gemini CLI names the root
// explicitly as $GEMINI_PROJECT_DIR.
export function shimRef(tool, ext = 'sh') {
  const relative = `.teamflow/hooks/${tool}.${ext}`;
  return tool === 'gemini' ? `$GEMINI_PROJECT_DIR/${relative}` : relative;
}

// Every repository shim sits exactly two levels below the root it was
// installed into — `.teamflow/hooks/<tool>.sh`, and Cline's
// `.clinerules/hooks/PostToolUse` — so it can put itself back there
// before reporting. That matters because no tool here promises the
// working directory it runs a hook with, and several of the events do
// not carry a cwd of their own: Cascade's post_write_code has none,
// nor has Cursor's stop. What is left is the process's own directory,
// and a subdirectory hashes to a different projectId, which is a
// different binding and a ticket that stops moving.
//
// Junie's shim is the exception. It is installed into
// ~/.junie/teamflow-hook.sh, where two levels up is the home
// directory's parent, so it is written without the cd and reports
// against the cwd and project_path Junie sends.
const CD_TO_ROOT = `root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." 2>/dev/null && pwd)
[ -n "$root" ] && cd -- "$root" || :
`;

export function shimScript(tool, { inRepository = true } = {}) {
  return `#!/bin/sh
# TeamFlow delivery reporting for ${tool}. Written by
# \`teamflow hooks install --for ${tool}\`; delete this file to stop.
#
# Observability, never a gate. This script exits 0 whatever happens, so
# a TeamFlow outage, a missing node or an unreachable network can never
# block an edit, a command or a turn.
${inRepository ? CD_TO_ROOT : ''}if command -v teamflow >/dev/null 2>&1; then
  teamflow hook --for ${tool}
else
  npx -y ${PACKAGE} hook --for ${tool}
fi
exit 0
`;
}

// The same shim for a Windows developer, because these repositories are
// shared. Cursor, Copilot CLI and Windsurf each document a Windows or
// PowerShell form of a hook command; the other four do not, and nothing
// is written for them rather than guessing at a field their parser
// would reject.
//
// The shebang line is deliberate and is not dead weight. Cursor has no
// Windows field: its `command` runs through whatever shell the platform
// gives it, so both shims are named in `.cursor/hooks.json` and each
// platform hands one of them to the wrong interpreter. A POSIX shell
// handed this file execs `/usr/bin/env true`, which ignores the body and
// exits 0, so the wrong shim is silent on macOS and Linux instead of a
// page of syntax errors. PowerShell reads the same line as a comment.
export const WINDOWS_TOOLS = new Set(['cursor', 'copilot', 'windsurf']);

export function powershellShim(tool) {
  return `#!/usr/bin/env true
# TeamFlow delivery reporting for ${tool} on Windows. Written by
# \`teamflow hooks install --for ${tool}\`; delete this file to stop.
#
# The shebang above is what makes this file safe for a POSIX shell to
# run: it execs \`true\`, which ignores everything below. PowerShell
# reads that line as a comment and runs the rest.
#
# Observability, never a gate. This script exits 0 whatever happens, so
# a TeamFlow outage, a missing node or an unreachable network can never
# block an edit, a command or a turn.
#
# \`$PSScriptRoot\` is this file's own directory, and this file is two
# levels below the repository root, for the reason CD_TO_ROOT gives.
try {
  Set-Location (Join-Path $PSScriptRoot '..\..')
} catch { }
try {
  if (Get-Command teamflow -ErrorAction SilentlyContinue) {
    teamflow hook --for ${tool}
  } else {
    npx -y ${PACKAGE} hook --for ${tool}
  }
} catch { }
exit 0
`;
}

// Both shims for a tool that has a Windows form, as install targets.
function shims(root, tool) {
  const targets = [{ file: shimPath(root, tool), script: shimScript(tool) }];
  if (WINDOWS_TOOLS.has(tool)) {
    targets.push({ file: shimPath(root, tool, 'ps1'), script: powershellShim(tool) });
  }
  return targets;
}

// One entry as each tool spells it. Cursor and Windsurf take a bare
// `command`; VS Code's Copilot, Copilot CLI and Gemini CLI take an
// object with `type: "command"`.
//
// Copilot CLI and Windsurf both document a sibling `powershell` field
// carrying the Windows form of the same hook, so an entry for either of
// them names both shims and the tool picks. Cursor documents no such
// field — its `command` goes to the platform shell — so Cursor gets two
// entries per event instead and the shims sort themselves out; see
// powershellShim().
const entry = {
  bare: (command, extra = {}) => ({ command, ...extra }),
  typed: (command, extra = {}) => ({ type: 'command', command, ...extra }),
};

// The Windows half of an entry, for the tools that name a field for it.
const windows = (tool) => ({ powershell: shimRef(tool, 'ps1') });

// The hook configuration each tool reads, from the vendor documentation
// read on 2026-09-17. The URLs are in tools.mjs beside each record.
//
// Only events that mean "a tool call finished" or "a turn finished" are
// registered, because TeamFlow reports what happened rather than what
// is about to. Junie is the exception and only because it has no
// after-event at all; see its adapter for what that costs.
export const HOOK_SPECS = {
  cursor: (root) => {
    // Two entries per event, one shim each. Cursor runs `command`
    // through the platform shell, so a repository shared between a Mac
    // and a Windows machine cannot name one file and be right on both.
    // On POSIX the .ps1 execs `true` and reports nothing, so exactly one
    // of the two ever reports and the board never double-counts.
    const both = () => [entry.bare(shimRef('cursor')), entry.bare(shimRef('cursor', 'ps1'))];
    return {
      covers: 'file edits, finished tool calls, finished shell commands and turn end',
      targets: [
        ...shims(root, 'cursor'),
        {
          file: path.join(root, '.cursor', 'hooks.json'),
          json: {
            version: 1,
            hooks: {
              // Registered for the sign-in notice and nothing else: it
              // reports no stage, which is why it is not in this tool's
              // `events` in tools.mjs. Cursor documents
              // `additional_context` on it as "additional context to
              // add to the conversation's initial system context",
              // which is once a session and at the start of it
              // (MACLEOD-569).
              sessionStart: both(),
              afterFileEdit: both(),
              postToolUse: both(),
              postToolUseFailure: both(),
              afterShellExecution: both(),
              stop: both(),
            },
          },
        },
      ],
    };
  },

  // One file for both Copilot agents. VS Code sends Claude Code's
  // envelope under PascalCase event names; Copilot CLI sends its own
  // camelCase ones, down to PostToolUseFailure against
  // postToolUseFailure. Neither fires an event name it does not know, so
  // registering both dialects in the one file `.github/hooks/*.json`
  // that both of them read is what makes a single install cover the
  // IDE and the CLI.
  copilot: (root) => {
    const ref = shimRef('copilot');
    // `powershell` is Copilot CLI's own field for the Windows form of a
    // hook. VS Code's half of this file does not document it and ignores
    // the extra key, so one entry shape serves both dialects.
    const hook = () => [entry.typed(ref, windows('copilot'))];
    return {
      covers: 'finished tool calls and turn end, in VS Code and in Copilot CLI',
      targets: [
        ...shims(root, 'copilot'),
        {
          file: path.join(root, '.github', 'hooks', 'teamflow.json'),
          json: {
            version: 1,
            hooks: {
              PostToolUse: hook(),
              PostToolUseFailure: hook(),
              Stop: hook(),
              postToolUse: hook(),
              postToolUseFailure: hook(),
              agentStop: hook(),
            },
          },
        },
      ],
    };
  },

  windsurf: (root) => {
    const ref = shimRef('windsurf');
    const hook = () => [entry.bare(ref, windows('windsurf'))];
    return {
      covers: 'finished edits, finished commands and Cascade response end',
      targets: [
        ...shims(root, 'windsurf'),
        {
          file: path.join(root, '.windsurf', 'hooks.json'),
          json: {
            hooks: {
              post_write_code: hook(),
              post_run_command: hook(),
              post_cascade_response: hook(),
            },
          },
        },
      ],
    };
  },

  // Cline has no hooks config file at all: the hook is an executable
  // named exactly after the event. So the shim is the hook, and there
  // is nothing to merge. It also has to be switched on by hand in
  // Settings -> Features, which is why the note says so.
  cline: (root) => ({
    covers: 'finished tool calls, once hooks are enabled in Settings -> Features',
    targets: [
      { file: path.join(root, '.clinerules', 'hooks', 'PostToolUse'), script: shimScript('cline') },
    ],
  }),

  // Codex copied Claude Code's hooks wholesale, matcher shape included,
  // so this is the one config here that would be recognisable to
  // somebody who only knows plugin/hooks/hooks.json.
  codex: (root) => {
    const ref = shimRef('codex');
    const matched = (matcher) => ({ matcher, hooks: [entry.typed(ref)] });
    return {
      covers: 'finished tool calls and turn end',
      targets: [
        ...shims(root, 'codex'),
        {
          file: path.join(root, '.codex', 'hooks.json'),
          json: { hooks: { PostToolUse: [matched('*')], Stop: [{ hooks: [entry.typed(ref)] }] } },
        },
      ],
    };
  },

  // Junie reads ~/.junie/config.json and ignores a project one unless
  // it is passed --config-location, so this is the only entry here that
  // has to be written into the developer's home directory rather than
  // into the repository. Same rule as the MCP configs for Codex, Gemini
  // CLI, Windsurf, Cline and Zed, which are all user-scoped too.
  jetbrains: () => {
    const sh = path.join(home(), '.junie', 'teamflow-hook.sh');
    return {
      covers: 'edits, as local work; Junie fires no PostToolUse, so tests and audits need the git fallback',
      targets: [
        { file: sh, script: shimScript('jetbrains', { inRepository: false }) },
        {
          file: path.join(home(), '.junie', 'config.json'),
          json: {
            hooks: {
              // For the sign-in notice, not for reporting — Junie's
              // own page says `systemMessage` is "honoured by the
              // SessionStart, SessionEnd and UserPromptSubmit
              // executors" and that "the Stop executor does not
              // currently surface it in the TUI", so Stop, the obvious
              // place, is the one place nobody would read it
              // (MACLEOD-569). SessionEnd is on that list too and is
              // not used, because the same page says hook output is
              // discarded there.
              SessionStart: [{ hooks: [entry.typed(sh, { timeout: 10 })] }],
              PreToolUse: [{ matcher: '*', hooks: [entry.typed(sh, { timeout: 10 })] }],
              Stop: [{ hooks: [entry.typed(sh, { timeout: 10 })] }],
            },
          },
        },
      ],
    };
  },

  gemini: (root) => {
    const ref = shimRef('gemini');
    const hook = { hooks: [entry.typed(ref, { name: 'teamflow', timeout: 10000 })] };
    return {
      covers: 'finished tool calls and turn end',
      targets: [
        ...shims(root, 'gemini'),
        {
          file: path.join(root, '.gemini', 'settings.json'),
          json: { hooks: { AfterTool: [hook], AfterAgent: [hook] } },
        },
      ],
    };
  },
};

// Writes whatever HOOK_SPECS[tool] describes. A tool with no entry has
// no hook system TeamFlow can attach to, and says so rather than
// writing a file nothing will read.
export function installHooks(tool, { root = process.cwd(), dryRun = false } = {}) {
  const spec = BY_ID[tool];
  if (!spec) throw new Error(`Unknown tool "${tool}". Known: ${Object.keys(BY_ID).sort().join(', ')}`);
  const written = [];
  if (!HOOK_SPECS[tool]) return { tool, label: spec.name, hooks: false, written };
  const { targets, covers } = HOOK_SPECS[tool](root);
  for (const target of targets) {
    if (dryRun) { written.push({ file: target.file, action: 'would write' }); continue; }
    // A hooks config is shared with the user's own hooks, so it is
    // merged rather than replaced, exactly like an MCP config. Cline
    // has no config file at all: its hook IS an executable named after
    // the event, so that one is written as a script.
    if (target.json) mergeJson(target.file, target.json, written, { arrayUnion: true });
    else if (target.script) writeFile(target.file, target.script, written, { mode: 0o755 });
  }
  return { tool, label: spec.name, hooks: true, files: targets.map((t) => t.file), covers, written };
}

// Every shim this module writes says this, in a comment, in both
// dialects. It is what tells a file TeamFlow wrote from a file of the
// same name that somebody else wrote: Cline's hook IS a file called
// `.clinerules/hooks/PostToolUse`, and a customer who had one there
// before TeamFlow arrived keeps it.
export const SHIM_MARKER = 'TeamFlow delivery reporting';

// The inverse of installHooks. It is knowable for the same reason a
// reinstall is a no-op: HOOK_SPECS says exactly what install adds, so
// exactly that is what comes out, entry by entry. Anything else in the
// same file — another vendor's hook, the customer's own — is untouched,
// and a tool that was never installed for succeeds quietly, because
// `uninstall` is what somebody runs when they are not sure.
export function uninstallHooks(tool, { root = process.cwd(), dryRun = false } = {}) {
  const spec = BY_ID[tool];
  if (!spec) throw new Error(`Unknown tool "${tool}". Known: ${Object.keys(BY_ID).sort().join(', ')}`);
  const written = [];
  if (!HOOK_SPECS[tool]) return { tool, label: spec.name, hooks: false, written };
  const { targets } = HOOK_SPECS[tool](root);
  for (const target of targets) {
    if (dryRun) {
      written.push({ file: target.file, action: fs.existsSync(target.file) ? 'would remove' : 'absent' });
      continue;
    }
    if (target.json) unmergeJson(target.file, target.json, written, { arrayUnion: true });
    else if (target.script) removeFile(target.file, written, { marker: SHIM_MARKER });
  }
  // `.teamflow/hooks` with its last shim gone, and nothing above it:
  // `.teamflow` holds the binding and `.github` is the customer's.
  if (!dryRun) {
    for (const dir of new Set(targets.map((t) => path.dirname(t.file)))) removeEmptyDir(dir, written);
  }
  return { tool, label: spec.name, hooks: true, files: targets.map((t) => t.file), written };
}

// The binding is the one piece of TeamFlow state in a repository that no
// installer wrote, and leaving it behind is how a reinstall six months
// later reports against a ticket nobody is working on. Removed by
// `uninstall --all` only: removing TeamFlow from Cursor while Claude Code
// still reports is not a reason to forget which ticket this is.
//
// `userBindingPaths` is the list of every file the user binding may live
// in — MACLEOD-586 added the organisation-scoped location beside the
// legacy tenant one, and an install with no credential still writes the
// legacy one. A second list here is how the two drift apart, so this
// calls that one; see the namespace import at the top for why it is
// reached this way.
export function bindingFiles(root, config = {}) {
  const user = typeof core.userBindingPaths === 'function'
    ? core.userBindingPaths(root, config)
    : [core.projectBindingPath(root, config)];
  return [core.localBindingPath(root), ...user];
}

// --- status -----------------------------------------------------------

// Does this repository look like it is used with this tool? Only files
// the tool itself owns count; `.agents/skills` is shared by seven of
// them and would report every tool for every repository.
export function detectedTools(root = process.cwd()) {
  const marker = {
    'claude-code': ['.claude', 'CLAUDE.md'],
    cursor: ['.cursor'],
    copilot: ['.github/copilot-instructions.md', '.vscode/mcp.json'],
    windsurf: ['.windsurf'],
    cline: ['.clinerules', '.cline'],
    gemini: ['GEMINI.md', '.gemini'],
    codex: ['.codex'],
    zed: ['.zed'],
    jetbrains: ['.junie', '.idea'],
    aider: ['CONVENTIONS.md', '.aider.conf.yml'],
    'claude-desktop': [],
    grok: ['.grok'],
    // Shares .codex with the CLI, so nothing on disk tells the two apart.
    'codex-ide': [],
    opencode: ['opencode.json', '.opencode'],
    openhands: ['.openhands'],
    pi: ['.pi'],
    kiro: ['.kiro'],
    qwen: ['QWEN.md', '.qwen'],
  };
  return Object.entries(marker)
    .filter(([, paths]) => paths.some((p) => fs.existsSync(path.join(root, p))))
    .map(([tool]) => tool);
}

// What `teamflow hooks status` prints: one row per tool this repository
// shows a sign of, plus the git fallback, plus whether the pre-push
// half of it can do anything.
export function hooksStatus(root = process.cwd(), config = {}) {
  const detected = detectedTools(root);
  const git = gitHooksInstalled(root);
  const tools = detected.map((tool) => {
    const spec = BY_ID[tool] || {};
    if (tool === 'claude-code') {
      return { tool, label: spec.name, automation: 'hooks', installed: 'with the plugin', covers: 'every tool call, prompt and session boundary' };
    }
    if (!HOOK_SPECS[tool]) {
      return { tool, label: spec.name, automation: 'git-hooks', installed: false, covers: 'no hook system; use the git fallback' };
    }
    const { targets, covers } = HOOK_SPECS[tool](root);
    const installed = targets.every((t) => fs.existsSync(t.file)
      && fs.readFileSync(t.file, 'utf8').includes('teamflow'));
    return { tool, label: spec.name, automation: 'hooks', installed, files: targets.map((t) => t.file), covers };
  });

  return {
    repository: root,
    detected: detected.length ? detected : ['none detected'],
    tools,
    git: {
      installed: git,
      testCommand: config.testCommand || undefined,
      prePush: config.testCommand
        ? `runs \`${config.testCommand}\` and reports a local test pass or failure`
        : 'installed but inactive: set "testCommand" in .teamflow.json to report local tests on push',
    },
  };
}

// --- what the install says last ----------------------------------------

/**
 * Installing the hooks is the moment the customer is looking (MACLEOD-569).
 *
 * After this command finishes there is no channel left. Claude Code
 * hears about a missing credential on SessionStart; Cursor, Copilot,
 * Windsurf, Cline, Codex CLI, Gemini CLI and Junie mostly do not, and
 * where they do it is one line a day in a field the vendor happens to
 * document. So the install ends by answering the only question that
 * decides whether any of this works: is this machine signed in, and if
 * it is, where does this repository's work appear.
 *
 * Both answers go on stderr and the short form goes into the JSON, so a
 * person reads it and a script can still parse stdout.
 */
export async function credentialNotice({ root = process.cwd(), config } = {}) {
  const resolved = config || loadConfig(root);
  // The transport, not the credential (MACLEOD-569 review). A machine
  // configured with a `dataUri` and no credential is on the legacy S3
  // transport and its reports land; telling it to sign in would be
  // wrong, and telling it nothing reaches the board would be false.
  const transport = transportOf(resolved);
  if (transport !== 'none' && transport !== 'service') {
    return {
      signIn: `reporting on the legacy ${transport} transport, which needs no sign-in; `
        + '`teamflow doctor` checks it',
      block: `\nTeamFlow: the hooks are in, reporting on the legacy ${transport} transport. `
        + '`teamflow doctor` checks the bucket.\n',
    };
  }
  if (transport === 'none') {
    return {
      signIn: 'NOT SIGNED IN: the hooks are installed and every report they make will be '
        + 'dropped until `teamflow login` is run on this machine',
      block: [
        '',
        '  ---------------------------------------------------------------',
        '  TeamFlow: the hooks are in. Nothing will reach the board yet.',
        '',
        '  This machine has no credential, so every report these hooks make',
        '  is dropped — silently, for ever, with an empty board as the only',
        '  symptom. Outside Claude Code a hook cannot tell you this later:',
        '  `stdout` is how a hook denies an action in these tools.',
        '',
        '      teamflow login            once: opens the consent page here, or',
        '                                prints a code for a browser anywhere',
        '      teamflow status           to check it',
        '',
        `  Without \`teamflow\` on PATH, put \`npx -y ${PACKAGE}\``,
        '  in front of each.',
        '  ---------------------------------------------------------------',
        '',
      ].join('\n'),
    };
  }

  // Signed in. Name the organisation and the project, because "it is
  // installed" and "your work will appear where you are looking" are
  // different claims and only the second one is the one being made.
  const probe = await fetchAccount(resolved);
  const { resolveProject } = await import('./project.mjs');
  const repository = gitInfo(root).repository;
  const project = await resolveProject(repository, resolved);
  const org = probe.ok ? probe.account?.account : undefined;
  const where = [
    org ? `org ${org}` : 'the organisation this credential belongs to',
    `project ${project.line}`,
  ].join(', ');
  const signIn = `signed in: ${repository || 'this repository'} syncs to TeamFlow under ${where}`;
  return { signIn, block: `\nTeamFlow: ${signIn}. \`teamflow status\` confirms it.\n` };
}

// --- cli --------------------------------------------------------------

export const USAGE = `teamflow hooks — report automatically from whatever you use

  teamflow hooks status
  teamflow hooks install --for <tool> [--dry-run]
  teamflow hooks install --git [--dry-run]

--for writes that tool's own hook configuration, so TeamFlow sees every
tool call the way it does in Claude Code. \`skills install --for <tool>\`
does this for you.

--git installs repository git hooks instead, for a tool with no hook
system: post-commit, post-merge and pre-push. Reporting is then on
commit rather than per tool call.

  teamflow hooks uninstall --for <tool> [--dry-run]
  teamflow hooks uninstall --git [--dry-run]
  teamflow hooks uninstall --all [--dry-run]

uninstall removes exactly what install added and nothing else: another
vendor's entry in the same file stays, a hook TeamFlow did not write
stays, and a tool that was never installed for succeeds quietly. --all
is every tool, the git hooks and this repository's ticket binding.
--dry-run lists what would go without touching anything.

Tools with hooks: ${Object.keys(HOOK_SPECS).sort().join(', ')}.
`;

// What the uninstall says out loud. A silent uninstall is as bad as no
// uninstall: the whole point of the command is that a customer can see
// TeamFlow leave, and can see what it decided not to touch.
export function removalReport(written, root = process.cwd()) {
  const short = (file) => {
    const inside = path.relative(root, file);
    if (inside && !inside.startsWith('..')) return inside;
    return file.startsWith(home()) ? `~${file.slice(home().length)}` : file;
  };
  const lines = [];
  for (const item of written) {
    if (item.action === 'absent' || item.action === 'unchanged') continue;
    const why = item.reason ? ` — ${item.reason}` : '';
    const verb = item.action === 'updated' ? "TeamFlow's entries removed from" : item.action;
    lines.push(`  ${verb} ${short(item.file)}${why}`);
  }
  if (!lines.length) return 'TeamFlow was not installed here. Nothing to remove.\n';
  return `TeamFlow removed:\n${lines.join('\n')}\nTeamFlow touched nothing else.\n`;
}

// One tool, the git hooks, or everything. `--all` is the command a
// customer who is leaving actually wants, and it is the only one that
// takes the binding with it: removing TeamFlow from Cursor while Claude
// Code still reports is not a reason to forget which ticket this is.
//
// The git hooks are best-effort under `--all`. A checkout with no `.git`
// — a tarball, a Docker context — has no hooks to remove, and refusing
// to finish removing the rest over that would be absurd.
export function uninstallEverywhere(options, { root = process.cwd(), config = {}, dryRun = false } = {}) {
  if (options.for) return uninstallHooks(options.for, { root, dryRun });
  if (!options.all) return uninstallGitHooks({ root, dryRun });

  const written = [];
  const tools = Object.keys(HOOK_SPECS).sort();
  for (const tool of tools) written.push(...uninstallHooks(tool, { root, dryRun }).written);
  let git;
  try {
    git = uninstallGitHooks({ root, dryRun });
    written.push(...git.written);
  } catch (error) {
    written.push({ file: root, action: 'skipped', reason: error instanceof Error ? error.message : String(error) });
  }
  // Same reason as the git hooks: no repository, no local binding path,
  // and that is not a reason to stop.
  let bindings = [];
  try { bindings = bindingFiles(root, config); } catch { bindings = []; }
  for (const file of bindings) {
    if (dryRun) written.push({ file, action: fs.existsSync(file) ? 'would remove' : 'absent' });
    else removeFile(file, written);
  }
  return { scope: 'all', tools, git: git?.dir, written };
}

export async function main(argv = [], io = {}) {
  const out = io.stdout || ((text) => process.stdout.write(text));
  const err = io.stderr || ((text) => process.stderr.write(text));
  const cwd = io.cwd || process.cwd();
  const config = io.config || {};

  const [action = 'status', ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) { err(`unexpected argument: ${token}\n`); return 2; }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    const name = eq >= 0 ? body.slice(0, eq) : body;
    if (name === 'dry-run' || name === 'git' || name === 'all' || name === 'help') { options[name] = true; continue; }
    const value = eq >= 0 ? body.slice(eq + 1) : rest[++i];
    if (value === undefined) { err(`--${name} needs a value\n`); return 2; }
    options[name] = value;
  }

  if (options.help || action === 'help') { out(USAGE); return 0; }
  const root = options.root ? path.resolve(cwd, options.root) : cwd;

  if (action === 'status') {
    out(`${JSON.stringify(hooksStatus(root, config), null, 2)}\n`);
    return 0;
  }
  if (action === 'uninstall') {
    if (!options.git && !options.for && !options.all) {
      err(`hooks uninstall needs --for <tool>, --git or --all.\n\n${USAGE}`);
      return 2;
    }
    try {
      const dryRun = Boolean(options['dry-run']);
      const result = uninstallEverywhere(options, { root, config, dryRun });
      out(`${JSON.stringify(result, null, 2)}\n`);
      // The list goes to stderr for the same reason the install's notice
      // does: stdout stays parseable JSON, and this is the half a person
      // reads.
      err(removalReport(result.written, root));
      return 0;
    } catch (error) {
      err(`${error instanceof Error ? error.message : String(error)}\n`);
      return 2;
    }
  }
  if (action !== 'install') { err(`Unknown hooks action "${action}".\n\n${USAGE}`); return 2; }
  if (!options.git && !options.for) { err(`hooks install needs --for <tool> or --git.\n\n${USAGE}`); return 2; }

  try {
    const dryRun = Boolean(options['dry-run']);
    const result = options.git
      ? installGitHooks({ root, dryRun })
      : installHooks(options.for, { root, dryRun });
    // A dry run writes nothing and asks nobody anything, including the
    // service.
    // Loaded from `root` rather than reusing the caller's: `--root`
    // moves which `.teamflow.json` applies, and this answer is about
    // the repository being installed into.
    const notice = dryRun ? undefined : await credentialNotice({ root });
    out(`${JSON.stringify(notice ? { ...result, signIn: notice.signIn } : result, null, 2)}\n`);
    // Exit 0 even when nobody is signed in. The hooks *are* installed —
    // that is what was asked for and it happened — and a non-zero exit
    // would break `&&` in every setup script and fail a build image that
    // legitimately signs in later, or reports with an OIDC token that
    // only exists inside CI. Non-zero is reserved for "the thing you
    // asked for did not happen"; this is a warning, and it is loud.
    if (notice) err(notice.block);
    return 0;
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
