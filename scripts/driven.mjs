// A session another tool drives (MACLEOD-908, from the MACLEOD-907 audit).
//
// Our hooks are installed at user scope, so they fire inside sessions
// that the Agent SDK, Archon or the Claude Code GitHub Action run. Those
// tools own their own loop: which ticket, when to stop, what to ask. The
// plugin used to steer them anyway -- the "no issue is bound" line, the
// Stop auto-continue, the check-in rewake, the two-way answer wait and
// the auto-created run on dispatch -- and Archon's agents were pulled onto
// other tickets and held open. In a driven session every hook still
// reports derived state as usual, and prints nothing that directs work.
//
// One detector, so the hooks cannot disagree about who drives a session.
// Pure but for reading `.git/HEAD`; never throws.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code's own values: `sdk-ts`, `sdk-py` and `sdk-cli` (the Agent
// SDKs and `claude -p`), and the GitHub Action's.
const ACTION_ENTRYPOINT = 'claude-code-github-action';

function branchOf(cwd) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i += 1) {
    const dotGit = path.join(dir, '.git');
    let stat;
    try { stat = fs.statSync(dotGit); } catch { stat = undefined; }
    if (stat) {
      let gitDir = dotGit;
      if (stat.isFile()) {
        // A worktree: `.git` is a file naming its own git directory.
        const line = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
        if (!line) return undefined;
        gitDir = path.resolve(dir, line[1].trim());
      }
      const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
      const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
      return ref ? ref[1] : undefined;
    }
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

/**
 * Which tool drives this session, or undefined for a person's own.
 *
 * - `sdk`: CLAUDE_CODE_ENTRYPOINT starts with "sdk" (Agent SDK, `claude -p`).
 * - `github-action`: the Claude Code GitHub Action.
 * - `archon`: a cwd under ~/.archon/, or a current branch `archon/*`.
 */
export function drivenBy(payload = {}, env = process.env, cwd = undefined) {
  try {
    const entry = String(env?.CLAUDE_CODE_ENTRYPOINT || '');
    if (entry.startsWith('sdk')) return 'sdk';
    if (entry === ACTION_ENTRYPOINT) return 'github-action';
    const where = cwd || payload?.cwd;
    if (!where) return undefined;
    const home = env?.HOME || os.homedir();
    const archon = path.join(home, '.archon');
    const resolved = path.resolve(where);
    if (resolved === archon || resolved.startsWith(archon + path.sep)) return 'archon';
    if (/^archon\//.test(branchOf(resolved) || '')) return 'archon';
  } catch { /* unknown: a person's own session */ }
  return undefined;
}
