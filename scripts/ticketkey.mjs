// The right ticket, from the source (MACLEOD-845).
//
// The audit (2026-09-26) found about 16 of 28 "left unfinished" cards
// were work that landed under another key: an agent bound to a plan's
// child ticket wrote the parent's key, or none, in its commit subjects
// and its branch was `worktree-agent-…`, so git held no proof for the
// child. This module makes the key travel with the work itself:
//
// - `work-on` / `bind` write the bound key into a one-line file in the
//   working copy's own git directory, and install a `prepare-commit-msg`
//   hook that adds `TeamFlow-Key: <KEY>` to every commit made there. The
//   hook is plain shell: no network, no node, no plugin path, and it
//   always exits 0, so it can never stop a commit.
// - A branch with no key is renamed to carry it, but only when that is
//   safe: not the default branch, not pushed anywhere, and not a Claude
//   Code isolation branch (`worktree-…`), which Claude Code names in its
//   own result and cleans up by that name.
// - merged.mjs reads the trailer, and a commit's trailer is the one key
//   it counts for. A commit whose subject names key B while its working
//   copy is bound to key A is a wrong-key commit: the owner ruled it
//   moves to the right ticket (A) by itself. It is kept as derived state
//   only, `{ key: A, named: B, sha: <7 hex> }`, never the subject.
//
// git runs with no shell and fixed arguments. A key is used only after
// it passes the tracker-key pattern.
import fs from 'node:fs';
import path from 'node:path';

import * as core from './core.mjs';
import { branchOk, keyOk, keysIn } from './merged.mjs';
import { GIT_BEGIN, GIT_END, TRAILER, gitHooksDir, trailerHookBody } from './hooks.mjs';
import { removeBlock, writeBlock } from './write.mjs';

export { TRAILER, trailerHookBody };
export const KEY_FILE = 'teamflow-key';
export const MOVES_MAX = 200;
const SHORT = /^[0-9a-f]{7,12}$/;

function git(root, args) {
  return core.safeExec(process.env.TEAMFLOW_GIT_BIN || 'git', ['-C', root, ...args], { cwd: root, timeout: 3000 });
}

/** This working copy's own git directory: `.git`, or `.git/worktrees/<name>` in a worktree. */
export function ownGitDir(root, run = git) {
  const got = run(root, ['rev-parse', '--absolute-git-dir']);
  return got.ok && got.stdout ? got.stdout : undefined;
}

export function keyFilePath(root, run = git) {
  const dir = ownGitDir(root, run);
  return dir ? path.join(dir, KEY_FILE) : undefined;
}

/** Remember the bound key for this working copy's commits. False when it cannot. */
export function writeKeyFile(root, key, run = git) {
  const ok = keyOk(key);
  const file = keyFilePath(root, run);
  if (!ok || !file) return false;
  try { fs.writeFileSync(file, `${ok}\n`); return true; } catch { return false; }
}

export function clearKeyFile(root, run = git) {
  const file = keyFilePath(root, run);
  if (file) fs.rmSync(file, { force: true });
}

/** The key this working copy's commits carry, or undefined. */
export function keyFileOf(root, run = git) {
  const file = keyFilePath(root, run);
  try { return keyOk(fs.readFileSync(file, 'utf8').trim()); } catch { return undefined; }
}

/**
 * True when a hook file outside the repository hands over to the
 * working copy's own `prepare-commit-msg`, as a chaining global hook
 * does (`$(git rev-parse --git-dir)/hooks/prepare-commit-msg`).
 */
export function chainsToRepo(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  return /rev-parse --git-dir/.test(text) && /hooks\/prepare-commit-msg/.test(text);
}

/** Where the trailer hook must go for git to run it here, or `{ skipped }`. */
export function trailerHookDir(root, run = git) {
  const dir = gitHooksDir(root);
  if (!dir) return { skipped: 'not a git repository' };
  if (typeof dir === 'string') return { dir };
  // A global core.hooksPath: TeamFlow never writes there. When that
  // hook chains to the working copy's own hooks, the block goes there.
  if (chainsToRepo(path.join(dir.outside, 'prepare-commit-msg'))) {
    const own = ownGitDir(root, run);
    if (own) return { dir: path.join(own, 'hooks') };
  }
  return { skipped: 'git reads hooks from a folder outside this repository' };
}

/**
 * Install the trailer hook where git runs it for this working copy.
 * Returns `{ file }`, or `{ skipped: why }` without throwing: binding a
 * ticket never fails because a hook could not be written.
 */
export function installTrailerHook(root, { dryRun = false } = {}) {
  const where = trailerHookDir(root);
  if (where.skipped) return where;
  const file = path.join(where.dir, 'prepare-commit-msg');
  if (dryRun) return { file };
  try {
    writeBlock(file, trailerHookBody(), [], { begin: GIT_BEGIN, end: GIT_END, header: '#!/bin/sh', mode: 0o755 });
    return { file };
  } catch (error) {
    return { skipped: String(error?.code || 'write failed') };
  }
}

export function uninstallTrailerHook(root, written = []) {
  const where = trailerHookDir(root);
  if (where.dir) removeBlock(path.join(where.dir, 'prepare-commit-msg'), written, { begin: GIT_BEGIN, end: GIT_END, header: '#!/bin/sh' });
  return written;
}

const DEFAULTS = new Set(['main', 'master', 'trunk', 'develop']);

/**
 * Put the key in the branch name when that is safe. Returns
 * `{ branch, renamed }` or `{ branch, kept: why }`.
 */
export function branchCarryKey(root, key, run = git) {
  const ok = keyOk(key);
  const head = run(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = head.ok ? head.stdout : '';
  if (!ok || !branchOk(branch)) return { branch: branch || undefined, kept: 'no branch' };
  if (keysIn(branch).has(ok)) return { branch, kept: 'has the key' };
  if (DEFAULTS.has(branch)) return { branch, kept: 'default branch' };
  if (branch.startsWith('worktree-')) return { branch, kept: 'a branch Claude Code named' };
  if (run(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).ok) return { branch, kept: 'pushed' };
  const next = `${ok}-${branch}`.slice(0, 200);
  if (!branchOk(next)) return { branch, kept: 'name' };
  return run(root, ['branch', '-m', branch, next]).ok ? { branch: next, renamed: branch } : { branch, kept: 'rename failed' };
}

/** The newest commit here: short sha, its TeamFlow-Key trailers, its subject. */
export function lastCommit(root, run = git) {
  const got = run(root, ['log', '-1', `--format=%h%x09%(trailers:key=${TRAILER},valueonly,separator=%x2C)%x09%s`]);
  if (!got.ok) return undefined;
  const [sha, trailers = '', ...rest] = got.stdout.split('\t');
  if (!SHORT.test(sha || '')) return undefined;
  return { sha, trailers: trailers.split(',').map(keyOk).filter(Boolean), subject: rest.join('\t') };
}

/**
 * A commit made in a working copy bound to `bound` whose subject names
 * another key and not the bound one. `{ key, named, sha }` or undefined.
 */
export function wrongKeyOf(bound, commit) {
  const key = keyOk(bound);
  if (!key || !commit || !SHORT.test(commit.sha || '')) return undefined;
  const named = keysIn(commit.subject);
  if (!named.size || named.has(key)) return undefined;
  return { key, named: [...named].sort()[0], sha: commit.sha.slice(0, 7) };
}

export const movesPath = () => path.join(core.dataDir(), 'moves.json');

/** Keep one move, once per commit. True when it is new. */
export function recordMove(move, { now = Date.now() } = {}) {
  if (!move?.key || !move.named || !SHORT.test(move.sha || '')) return false;
  const held = core.readJson(movesPath(), []);
  const list = Array.isArray(held) ? held : [];
  if (list.some((m) => m.sha === move.sha)) return false;
  core.writeJson(movesPath(), [...list, { key: move.key, named: move.named, sha: move.sha, at: new Date(now).toISOString() }].slice(-MOVES_MAX));
  return true;
}

export function movesOf() {
  const held = core.readJson(movesPath(), []);
  return Array.isArray(held) ? held : [];
}

/** How many moves one report carries; the service takes 200. */
export const MOVES_BATCH = 50;

/**
 * Tell the service about the moves it has not heard of (MACLEOD-886),
 * so the wrong card's history follows the work. Two keys, a short
 * commit id and a time each. A move is marked sent only when the
 * service took it; anything else waits for the next pass. Never throws.
 */
export async function reportMoves({ config = {}, send = core.sendMoved, now = Date.now() } = {}) {
  try {
    const due = movesOf().filter((m) => !m.sent && m.key && m.named && SHORT.test(m.sha || '')).slice(0, MOVES_BATCH);
    if (!due.length) return { sent: 0 };
    const moved = due.map(({ key, named, sha, at }) => ({ key, named, sha, at }));
    const out = await send({ at: new Date(now).toISOString(), moved }, config);
    if (!out?.ok) return { sent: 0, reason: out?.reason };
    const shas = new Set(due.map((m) => m.sha));
    core.writeJson(movesPath(), movesOf().map((m) => (shas.has(m.sha) ? { ...m, sent: true } : m)));
    return { sent: due.length };
  } catch {
    return { sent: 0 };
  }
}

/** The card's line for a moved commit: keys and a short sha only, under 120 characters. */
export function moveLine(move) {
  return `Commit ${move.sha} named ${move.named}. TeamFlow counts it on ${move.key}.`;
}

/** The start of work on a key: the key file, the hook and the branch name. Never throws. */
export function carryKey(root, key) {
  const out = { key: keyOk(key) };
  if (!out.key || !root) return out;
  try { out.keyFile = writeKeyFile(root, out.key); } catch { out.keyFile = false; }
  try { out.hook = installTrailerHook(root); } catch { out.hook = { skipped: 'error' }; }
  try { out.branch = branchCarryKey(root, out.key); } catch { out.branch = { kept: 'error' }; }
  return out;
}

/** One plain sentence for the person who ran `work-on`. */
export function carryLine(result = {}) {
  if (!result.key) return '';
  const parts = [];
  if (result.keyFile && result.hook?.file) parts.push(`Each commit here now names ${result.key}.`);
  else if (result.hook?.skipped) parts.push(`Put ${result.key} in each commit message. TeamFlow cannot add it here.`);
  if (result.branch?.renamed) parts.push(`The branch is now ${result.branch.branch}.`);
  return parts.join(' ');
}
