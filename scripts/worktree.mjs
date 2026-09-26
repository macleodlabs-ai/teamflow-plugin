// `teamflow worktree tidy` (MACLEOD-845).
//
// The audit found 142 worktrees using 5.8 GB, 136 of them already in main,
// and nothing ever removed one. This command removes a linked worktree
// only when all of these hold, and the checks are the machine's own, never
// a model's judgement and never anything the service sent:
//
// - its branch (or detached head) arrived on the default branch through a
//   merge commit: reachable from it, and not on its own first-parent line;
// - nothing in it is modified or staged;
// - no commit on it is missing from the default branch or a remote;
// - it is not locked, it is not the folder this command runs in, and no
//   session or agent this machine knows worked in it in the last 6 hours
//   and has not ended.
//
// A merged worktree whose only extra files are new ones (untracked, not
// ignored) is the owner's "pragmatic call": the files are copied into a
// dated folder under the plugin's data folder, then the worktree goes, and
// the summary says where they went. After a worktree goes, its branch is
// deleted with `git branch -d`, which git itself refuses for unmerged work.
//
// git runs with no shell and fixed arguments; a path is one git printed.
import fs from 'node:fs';
import path from 'node:path';

import * as core from './core.mjs';
import { branchOk, defaultRef, historyOf } from './merged.mjs';

export const IN_USE_MS = 6 * 60 * 60 * 1000;
const SHA = /^[0-9a-f]{40}$/;

function git(root, args, timeout = 15000) {
  return core.safeExec(process.env.TEAMFLOW_GIT_BIN || 'git', ['-C', root, ...args], { cwd: root, timeout, maxBuffer: 64 * 1024 * 1024 });
}

/** Every worktree git lists: `{ dir, head, branch?, locked, main }`. */
export function worktreesOf(root, run = git) {
  const got = run(root, ['worktree', 'list', '--porcelain']);
  if (!got.ok) return [];
  const out = [];
  for (const block of got.stdout.split(/\n\n+/)) {
    const lines = block.split('\n');
    const dir = lines.find((l) => l.startsWith('worktree '))?.slice(9);
    if (!dir) continue;
    const head = lines.find((l) => l.startsWith('HEAD '))?.slice(5);
    const ref = lines.find((l) => l.startsWith('branch refs/heads/'))?.slice(18);
    out.push({
      dir,
      head: SHA.test(head || '') ? head : undefined,
      ...(ref && branchOk(ref) ? { branch: ref } : {}),
      locked: lines.some((l) => l === 'locked' || l.startsWith('locked ')),
      bare: lines.includes('bare'),
      main: out.length === 0,
    });
  }
  return out;
}

const inside = (dir, other) => {
  if (!dir || !other) return false;
  const a = path.resolve(dir);
  const b = path.resolve(other);
  return b === a || b.startsWith(a + path.sep);
};

/** True when a session or agent on this machine may still be working in `dir`. */
export function inUse(dir, { actors = core.allActors(), now = Date.now(), here = process.cwd() } = {}) {
  if (inside(dir, here)) return true;
  return actors.some((a) => !a.ended && inside(dir, a.cwd) && now - (Date.parse(a.updatedAt) || 0) < IN_USE_MS);
}

/** What `git status` says: counts of changed (modified or staged) and new files. */
export function statusOf(dir, run = git) {
  // No optional locks: another session may be committing in that worktree.
  const got = run(dir, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all']);
  if (!got.ok) return undefined;
  let changed = 0;
  let untracked = 0;
  for (const line of got.stdout.split('\n').filter(Boolean)) {
    if (line.startsWith('??')) untracked += 1;
    else changed += 1;
  }
  return { changed, untracked };
}

/** Commits at `sha` that are on neither the default branch nor any remote. */
export function unsavedCommits(root, sha, ref, run = git) {
  const got = run(root, ['rev-list', '--count', sha, '--not', ref, '--remotes']);
  return got.ok ? Number(got.stdout) || 0 : undefined;
}

/**
 * The verdict for every linked worktree. `remove` is true only when all
 * the checks pass; otherwise `why` says which one kept it.
 */
export function assess(root, { run = git, actors, now = Date.now(), here = process.cwd() } = {}) {
  const trees = worktreesOf(root, run).filter((t) => !t.main && !t.bare);
  if (!trees.length) return [];
  const ref = defaultRef(root, run);
  const history = ref ? historyOf(root, ref, run) : undefined;
  return trees.map((tree) => {
    const verdict = { ...tree, remove: false };
    if (!history) return { ...verdict, why: 'no default branch' };
    if (tree.locked) return { ...verdict, why: 'locked' };
    if (!tree.head || !history.arrival.has(tree.head) || history.line.has(tree.head)) return { ...verdict, why: 'not merged' };
    if (inUse(tree.dir, { actors, now, here })) return { ...verdict, why: 'in use' };
    const status = statusOf(tree.dir, run);
    if (!status) return { ...verdict, why: 'unreadable' };
    if (status.changed) return { ...verdict, why: 'unsaved work', changed: status.changed, untracked: status.untracked };
    const unsaved = unsavedCommits(root, tree.head, ref, run);
    if (unsaved !== 0) return { ...verdict, why: 'unpushed commits' };
    return { ...verdict, remove: true, untracked: status.untracked };
  });
}

export const savedRoot = () => path.join(core.dataDir(), 'worktree-files');

/** Copy the new files of one worktree into a dated folder. Returns the folder. */
export function saveUntracked(dir, { run = git, now = Date.now() } = {}) {
  const got = run(dir, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (!got.ok) throw new Error('could not list the new files');
  const day = new Date(now).toISOString().slice(0, 10);
  const target = path.join(savedRoot(), day, path.basename(dir));
  for (const rel of got.stdout.split('\0').filter(Boolean)) {
    const from = path.resolve(dir, rel);
    if (!inside(dir, from)) continue;
    const to = path.join(target, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false });
  }
  return target;
}

/**
 * Tidy the repository at `root`. Returns `{ removed, kept, saved }`.
 * With `dryRun`, changes nothing and says what it would do.
 */
export function tidy(root, { dryRun = false, run = git, actors, now = Date.now(), here = process.cwd(), limit = Infinity } = {}) {
  const top = run(root, ['rev-parse', '--show-toplevel']);
  const base = top.ok && top.stdout ? top.stdout : root;
  const verdicts = assess(base, { run, actors, now, here });
  const removed = [];
  const kept = [];
  const saved = [];
  const mainDir = worktreesOf(base, run).find((t) => t.main)?.dir || base;
  for (const verdict of verdicts) {
    if (!verdict.remove) { kept.push(verdict); continue; }
    // A bounded pass (the check-in's): the rest wait for the next one.
    if (removed.length >= limit) continue;
    if (dryRun) { removed.push(verdict); if (verdict.untracked) saved.push({ dir: verdict.dir }); continue; }
    try {
      if (verdict.untracked) saved.push({ dir: verdict.dir, to: saveUntracked(verdict.dir, { run, now }) });
    } catch {
      kept.push({ ...verdict, remove: false, why: 'could not save new files' });
      continue;
    }
    const gone = run(mainDir, ['worktree', 'remove', ...(verdict.untracked ? ['--force'] : []), verdict.dir]);
    if (!gone.ok) { kept.push({ ...verdict, remove: false, why: 'git refused' }); continue; }
    if (verdict.branch) run(mainDir, ['branch', '-d', verdict.branch]);
    removed.push(verdict);
  }
  if (!dryRun && removed.length) run(mainDir, ['worktree', 'prune']);
  return { removed, kept, saved, dryRun };
}

const WHY_WORDS = {
  'unsaved work': 'have changes that are not committed',
  'unpushed commits': 'have commits that are not on main or pushed',
  'not merged': 'are not merged',
  'in use': 'are in use',
  locked: 'are locked',
  'could not save new files': 'have new files TeamFlow could not copy',
  'git refused': 'could not be removed',
  unreadable: 'could not be read',
  'no default branch': 'have no main branch to compare with',
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The plain summary a person reads. */
export function summaryLine(result) {
  const { removed = [], kept = [], saved = [], dryRun } = result;
  const parts = [];
  parts.push(`${dryRun ? 'Would remove' : 'Removed'} ${plural(removed.length, 'worktree', 'worktrees')}.`);
  const counts = new Map();
  for (const one of kept) counts.set(one.why, (counts.get(one.why) || 0) + 1);
  const one = (words) => words.replace(/^have /, 'has ').replace(/^are /, 'is ');
  if (kept.length) {
    parts.push(`Kept ${kept.length}: ${[...counts].map(([why, n]) => `${n} ${n === 1 ? one(WHY_WORDS[why] || why) : WHY_WORDS[why] || why}`).join(', ')}.`);
  }
  if (saved.length) {
    const where = saved.find((s) => s.to)?.to;
    parts.push(dryRun
      ? `New files from ${plural(saved.length, 'worktree', 'worktrees')} would be copied first.`
      : `TeamFlow copied new files from ${plural(saved.length, 'worktree', 'worktrees')} to ${path.dirname(where)}.`);
  }
  return parts.join(' ');
}

export const USAGE = 'Usage: teamflow worktree tidy [--dry-run]';

export async function main(args = [], { cwd = process.cwd(), print = console.log } = {}) {
  const [verb, ...rest] = args;
  if (verb !== 'tidy' || rest.some((a) => a !== '--dry-run')) {
    print(USAGE);
    return 2;
  }
  const result = tidy(cwd, { dryRun: rest.includes('--dry-run') });
  print(summaryLine(result));
  return 0;
}
