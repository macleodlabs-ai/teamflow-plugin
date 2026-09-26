// `teamflow worktree tidy` (MACLEOD-845).
//
// The audit found 142 worktrees using 5.8 GB, 136 of them already in main,
// and nothing ever removed one. This command removes a linked worktree
// only when all of these hold, and the checks are the machine's own, never
// a model's judgement and never anything the service sent:
//
// - its branch (or detached head) arrived on the default branch through a
//   merge commit: reachable from it, and not on its own first-parent line;
//   or, for a squash merge git cannot see, `gh pr view` says its pull
//   request is merged with this very commit as its head (MACLEOD-884).
//   When gh cannot answer, the worktree stays;
// - nothing in it is modified or staged;
// - no commit on it is missing from the default branch or a remote;
// - TeamFlow made or bound it (MACLEOD-909): a Claude Code `worktree-`
//   branch, a `work-on` key file or binding in it, or a session this
//   machine knows worked in it. A worktree under ~/.archon/ or on a branch
//   another tool made (`archon/*`) is that tool's, and is never removed;
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
import { branchOk, defaultRef, foreignBranch, historyOf, prCheck } from './merged.mjs';

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

/** True when `dir` sits in a folder another tool keeps its worktrees in (~/.archon/). */
export function foreignDir(dir) {
  return path.resolve(String(dir || '')).split(path.sep).includes('.archon');
}

/** This worktree's own git folder, from the `.git` file git writes in it. */
function gitDirOf(dir) {
  try {
    const line = fs.readFileSync(path.join(dir, '.git'), 'utf8').match(/^gitdir: (.+)$/m)?.[1]?.trim();
    return line ? path.resolve(dir, line) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when TeamFlow made or bound this worktree: Claude Code named its
 * branch (TeamFlow binds the agent sent there), `work-on` ran in it, or a
 * session this machine knows worked in it, ended or not.
 */
export function ours(tree, actors = []) {
  if (tree.branch?.startsWith('worktree-')) return true;
  if (fs.existsSync(path.join(tree.dir, '.teamflow', 'binding.json'))) return true;
  const own = gitDirOf(tree.dir);
  if (own && fs.existsSync(path.join(own, 'teamflow-key'))) return true;
  return actors.some((a) => inside(tree.dir, a?.cwd));
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
export function assess(root, { run = git, actors, now = Date.now(), here = process.cwd(), pr } = {}) {
  const trees = worktreesOf(root, run).filter((t) => !t.main && !t.bare);
  if (!trees.length) return [];
  const known = actors ?? core.allActors();
  const ref = defaultRef(root, run);
  const history = ref ? historyOf(root, ref, run) : undefined;
  return trees.map((tree) => {
    const verdict = { ...tree, remove: false };
    // Another tool's worktree is its own to remove (MACLEOD-909).
    if (foreignDir(tree.dir) || foreignBranch(tree.branch)) return { ...verdict, why: 'another tool' };
    if (!ours(tree, known)) return { ...verdict, why: 'not ours' };
    if (!history) return { ...verdict, why: 'no default branch' };
    if (tree.locked) return { ...verdict, why: 'locked' };
    if (!tree.head || history.line.has(tree.head)) return { ...verdict, why: 'not merged' };
    // git ancestry first; for a squash merge, the merged PR whose head is
    // this very commit (MACLEOD-884). Only a clear "merged" counts: an
    // unknown answer keeps the worktree, and says so.
    let byPr = false;
    if (!history.arrival.has(tree.head)) {
      const said = pr && tree.branch ? pr(tree.branch, tree.head) : undefined;
      if (said?.state === 'unknown') return { ...verdict, why: 'merge unknown' };
      if (said?.state !== 'merged') return { ...verdict, why: 'not merged' };
      byPr = true;
    }
    if (inUse(tree.dir, { actors: known, now, here })) return { ...verdict, why: 'in use' };
    const status = statusOf(tree.dir, run);
    if (!status) return { ...verdict, why: 'unreadable' };
    if (status.changed) return { ...verdict, why: 'unsaved work', changed: status.changed, untracked: status.untracked };
    // A merged PR holds this exact commit on the host, so its commits are
    // saved even when the host deleted the branch after the merge.
    if (!byPr) {
      const unsaved = unsavedCommits(root, tree.head, ref, run);
      if (unsaved !== 0) return { ...verdict, why: 'unpushed commits' };
    }
    return { ...verdict, remove: true, untracked: status.untracked, ...(byPr ? { byPr: true } : {}) };
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
export function tidy(root, { dryRun = false, run = git, actors, now = Date.now(), here = process.cwd(), limit = Infinity, pr } = {}) {
  const top = run(root, ['rev-parse', '--show-toplevel']);
  const base = top.ok && top.stdout ? top.stdout : root;
  const verdicts = assess(base, { run, actors, now, here, pr });
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
    // git refuses `-d` for a squash merge; the merged PR holds this very
    // commit, so `-D` loses nothing (MACLEOD-884).
    if (verdict.branch) run(mainDir, ['branch', verdict.byPr ? '-D' : '-d', verdict.branch]);
    removed.push(verdict);
  }
  if (!dryRun && removed.length) run(mainDir, ['worktree', 'prune']);
  return { removed, kept, saved, dryRun };
}

// The copy list (MACLEOD-884). A new worktree holds only what git
// tracks, so ignored files such as `.env` or local fixtures are missing
// and its first test run fails and reads as rework. An owner who wants
// them opts in with `.teamflow/worktree.json` in the main folder:
// `{ "copy": [".env", "fixtures/local.json"] }`. The files are copied
// from the main folder into the new worktree when `work-on` runs there,
// and nowhere else: nothing leaves the machine. A path must stay inside
// the repository: an absolute path, a `..` step, or a link that leads
// out is refused. A file already in the worktree is never overwritten.
export const COPY_FILE = path.join('.teamflow', 'worktree.json');
export const COPY_MAX = 50;

const realOf = (dir) => { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } };

/** The paths the list names: `{ files, refused }`, each checked as text. */
export function copyListOf(mainDir) {
  const held = core.readJson(path.join(mainDir, COPY_FILE));
  const list = Array.isArray(held?.copy) ? held.copy : [];
  const files = [];
  const refused = [];
  for (const raw of list.slice(0, COPY_MAX)) {
    const rel = typeof raw === 'string' ? raw.trim() : '';
    const bad = !rel || rel.includes('\0') || path.isAbsolute(rel) || path.win32.isAbsolute(rel)
      || rel.split(/[\\/]+/).includes('..') || path.normalize(rel) === '.';
    if (bad) refused.push(String(raw));
    else files.push(path.normalize(rel));
  }
  return { files, refused };
}

/** Copy the listed files from `mainDir` into `treeDir`. Returns `{ copied, missing, refused }`. */
export function applyCopyList(mainDir, treeDir) {
  const { files, refused } = copyListOf(mainDir);
  const copied = [];
  const missing = [];
  const realMain = realOf(mainDir);
  const realTree = realOf(treeDir);
  if (realMain === realTree) return { copied, missing, refused };
  for (const rel of files) {
    const from = path.resolve(realMain, rel);
    const to = path.resolve(realTree, rel);
    if (!inside(realMain, from) || !inside(realTree, to)) { refused.push(rel); continue; }
    let real;
    try { real = fs.realpathSync(from); } catch { missing.push(rel); continue; }
    // A link that leads out of the repository is not the repository's file.
    if (!inside(realMain, real) || real === realMain) { refused.push(rel); continue; }
    if (fs.existsSync(to)) continue;
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      // A folder in the worktree that is a link out of it is refused too.
      if (!inside(realTree, realOf(path.dirname(to)))) { refused.push(rel); continue; }
      fs.cpSync(real, to, { recursive: true, force: false, errorOnExist: false });
      copied.push(rel);
    } catch {
      missing.push(rel);
    }
  }
  return { copied, missing, refused };
}

/** The plain lines a person reads after a copy, or none when the list is empty. */
export function copyLines({ copied = [], missing = [], refused = [] } = {}) {
  const lines = [];
  if (copied.length) {
    lines.push(`TeamFlow copied ${plural(copied.length, 'file', 'files')} from the main folder into this folder: ${copied.join(', ')}.`);
    lines.push('Warning: these files can hold secrets, such as passwords and keys. TeamFlow keeps them on this computer only.');
  }
  if (missing.length) lines.push(`TeamFlow did not find ${plural(missing.length, 'file', 'files')} from your copy list: ${missing.join(', ')}.`);
  if (refused.length) lines.push(`TeamFlow did not copy ${plural(refused.length, 'path', 'paths')} that point outside the repository: ${refused.join(', ')}.`);
  return lines;
}

/**
 * For `work-on` in a linked worktree: copy the main folder's list into
 * it. Returns the lines to print. Never throws: a copy that fails must
 * not stop the binding.
 */
export function copyIntoWorktree(dir, { run = git } = {}) {
  try {
    const top = run(dir, ['rev-parse', '--show-toplevel']);
    if (!top.ok || !top.stdout) return [];
    const mainDir = worktreesOf(top.stdout, run).find((t) => t.main)?.dir;
    if (!mainDir || realOf(mainDir) === realOf(top.stdout)) return [];
    return copyLines(applyCopyList(mainDir, top.stdout));
  } catch {
    return [];
  }
}

const WHY_WORDS = {
  'another tool': 'are from another tool',
  'not ours': 'are not from TeamFlow',
  'unsaved work': 'have changes that are not committed',
  'unpushed commits': 'have commits that are not on main or pushed',
  'not merged': 'are not merged',
  'merge unknown': 'have no answer from GitHub about a merge',
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
  const result = tidy(cwd, { dryRun: rest.includes('--dry-run'), pr: prCheck(cwd) });
  print(summaryLine(result));
  return 0;
}
