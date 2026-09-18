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

import { safeExec } from './core.mjs';
import { BY_ID } from './tools.mjs';
import { mergeJson, writeBlock, writeFile } from './write.mjs';

const PACKAGE = 'github:macleodlabs-ai/teamflow-plugin';

const home = () => process.env.HOME || os.homedir();

export const GIT_BEGIN = '# BEGIN teamflow';
export const GIT_END = '# END teamflow';

// The three moments a repository knows about without any agent at all.
// Each maps to a stage through the same classifier every other hook
// uses; see adapters.mjs.
export const GIT_HOOKS = {
  'post-commit': { stage: 'LOCAL_DEV', covers: 'a commit reports LOCAL_DEV progress' },
  'post-merge': { stage: 'MERGE', covers: 'a merge reports MERGE' },
  'pre-push': { stage: 'LOCAL_TEST', covers: 'a push runs the configured test command and reports LOCAL_TEST or LOCAL_REWORK' },
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
    '# TeamFlow delivery reporting. Observability, never a gate: this',
    '# block always succeeds, so a TeamFlow outage cannot stop a commit,',
    '# a merge or a push. Remove the block to stop reporting.',
    invocation(event, { quiet }),
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
  const gitDir = safeExec('git', ['-C', root, 'rev-parse', '--git-dir'], { cwd: root, timeout: 2000 });
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
  return { scope: 'git', dir, written, covers: Object.values(GIT_HOOKS).map((h) => h.covers) };
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

export function shimScript(tool) {
  return `#!/bin/sh
# TeamFlow delivery reporting for ${tool}. Written by
# \`teamflow hooks install --for ${tool}\`; delete this file to stop.
#
# Observability, never a gate. This script exits 0 whatever happens, so
# a TeamFlow outage, a missing node or an unreachable network can never
# block an edit, a command or a turn.
if command -v teamflow >/dev/null 2>&1; then
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
  // camelCase ones. Neither fires an event name it does not know, so
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
      covers: 'edits, as LOCAL_DEV; Junie fires no PostToolUse, so gates need the git fallback',
      targets: [
        { file: sh, script: shimScript('jetbrains') },
        {
          file: path.join(home(), '.junie', 'config.json'),
          json: {
            hooks: {
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
        ? `runs \`${config.testCommand}\` and reports LOCAL_TEST or LOCAL_REWORK`
        : 'installed but inactive: set "testCommand" in .teamflow.json to report LOCAL_TEST on push',
    },
  };
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

Tools with hooks: ${Object.keys(HOOK_SPECS).sort().join(', ')}.
`;

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
    if (name === 'dry-run' || name === 'git' || name === 'help') { options[name] = true; continue; }
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
  if (action !== 'install') { err(`Unknown hooks action "${action}".\n\n${USAGE}`); return 2; }
  if (!options.git && !options.for) { err(`hooks install needs --for <tool> or --git.\n\n${USAGE}`); return 2; }

  try {
    const result = options.git
      ? installGitHooks({ root, dryRun: Boolean(options['dry-run']) })
      : installHooks(options.for, { root, dryRun: Boolean(options['dry-run']) });
    out(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
