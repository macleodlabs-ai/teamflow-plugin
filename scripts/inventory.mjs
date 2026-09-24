// What this machine holds, now and then, so the service can reconcile
// (MACLEOD-641).
//
// The owner: "the plugin heartbeat should occasionally be sending all
// active agents/worktrees/workflows to the app, so it can reconcile".
// Beats say who is alive; this says everything the machine thinks is
// open, so the board can close what the machine already finished and
// end agents the machine no longer runs.
//
// Its own report kind (`kind: "inventory"`), not a field on the beat: a
// beat is capped at 50 agents of one session and sent every two minutes,
// and this lists every session's agents, the repository's worktrees and
// the plan runs, about every 20 minutes. Free and never counted, like a
// beat. Derived state only, and every list is capped: agent ids, names,
// keys, stages, status words and times; a worktree as a digest of its
// path, its bound key, a digest of its branch and one yes-or-no for
// uncommitted work; a run's id, status and each node's key and state.
// Never a path, a branch name, a raw session id or any text the work
// produced.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import * as core from './core.mjs';
import { settleMovedAgents } from './dispatch.mjs';
import { openKeys, reportMerged, withBoardKeys } from './merged.mjs';

// heartbeat.mjs hands in its own row and key checks (`helpers`), so the
// inventory and the beat say an agent the same way. They are passed in,
// not imported: heartbeat.mjs is the process's entry and still running
// when it loads this file, and importing it back would wait for ever.

export const AGENTS_MAX = 100;
export const WORKTREES_MAX = 30;
export const RUNS_MAX = 30;
export const NODES_MAX = 100;
export const FINISHED_MAX = 100;
export const SESSIONS_MAX = 50;
const FINISHED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const OPEN = new Set(['planning', 'running', 'blocked', 'stalled']);
const FINISHED = new Set(['done', 'cancelled', 'archived']);
const NODE_STATES = new Set(['waiting', 'running', 'done', 'blocked', 'rework', 'skipped']);
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

/** A digest the service stores in place of a path, a branch or an id. */
export function hashOf(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
}

/** git, with no shell and a short timeout. */
function git(cwd, args) {
  return core.safeExec(process.env.TEAMFLOW_GIT_BIN || 'git', ['-C', cwd, ...args], { cwd, timeout: 2000 });
}

/** The worktrees of the repository at `root`, from `git worktree list --porcelain`. */
export function worktreesOf(root, { run = git } = {}) {
  const got = run(root, ['worktree', 'list', '--porcelain']);
  if (!got.ok) return [];
  const out = [];
  let at;
  for (const line of got.stdout.split('\n')) {
    if (line.startsWith('worktree ')) { at = { path: line.slice(9) }; out.push(at); }
    else if (at && line.startsWith('branch ')) at.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return out;
}

function boundKey(dir, config, keyOf) {
  const local = core.readJson(path.join(dir, '.teamflow', 'binding.json'));
  const held = local ?? core.readJson(core.projectBindingPath(dir, config));
  return keyOf(held?.key);
}

/** The bound worktrees: digests, the key, and whether anything is uncommitted. */
export function worktreeRows(trees, config, { run = git, keyOf }) {
  const rows = [];
  for (const tree of trees) {
    if (rows.length >= WORKTREES_MAX) break;
    const key = boundKey(tree.path, config, keyOf);
    if (!key) continue;
    const status = run(tree.path, ['status', '--porcelain']);
    rows.push({
      path: hashOf(tree.path),
      key,
      ...(tree.branch ? { branch: hashOf(tree.branch) } : {}),
      dirty: Boolean(status.ok && status.stdout),
    });
  }
  return rows;
}

/** Every agent record this machine has on this repository, as written. */
export function actorsOn(roots) {
  const dir = path.join(core.dataDir(), 'sessions');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  return names
    .map((name) => core.readJson(path.join(dir, name)))
    .filter((one) => one?.agentKey && roots.has(one.cwd));
}

/** Every open agent this machine has on this repository, newest first. */
export function openAgents(roots, agentRow) {
  return actorsOn(roots)
    .filter((one) => one.agent?.startedAt && !one.agent.endedAt && !one.ended && !one.absorbedInto)
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
    .map(agentRow)
    .filter(Boolean)
    .slice(0, AGENTS_MAX);
}

/**
 * The sessions on this repository whose heartbeat still runs, by the
 * digest their beats carry: how the service knows the machine is alive.
 */
export function liveSessions(roots, alive) {
  const dir = path.join(core.dataDir(), 'heartbeats');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^[0-9a-f]{8,64}\.json$/.test(n)); } catch { return []; }
  return names
    .filter((name) => {
      const held = core.readJson(path.join(dir, name));
      return held?.pid && !held.endedReason && roots.has(held.root) && alive(held.pid);
    })
    .map((name) => name.slice(0, -5))
    .slice(0, SESSIONS_MAX);
}

/** Open runs with their nodes, and the runs finished in the last week with how they ended. */
export function runRows(config, now, keyOf) {
  let workflows = {};
  try { workflows = core.readWorkflows(config).workflows || {}; } catch { /* no runs here */ }
  const runs = [];
  const finished = [];
  for (const run of Object.values(workflows)) {
    if (!run || !RUN_ID.test(String(run.id || ''))) continue;
    if (OPEN.has(run.status) && runs.length < RUNS_MAX) {
      runs.push({
        id: run.id,
        status: run.status,
        nodes: (run.tickets || [])
          .filter((t) => keyOf(t?.key) && NODE_STATES.has(t.state))
          .slice(0, NODES_MAX)
          .map((t) => ({ key: t.key, state: t.state })),
      });
    } else if (FINISHED.has(run.status) && finished.length < FINISHED_MAX
      && now - (Date.parse(run.updatedAt) || 0) < FINISHED_WINDOW_MS) {
      finished.push({ id: run.id, status: run.status });
    }
  }
  return { runs, finished };
}

/**
 * The name issue reports give the repository (`gitInfo`'s `owner/name`),
 * with one git call instead of six, else its root. Only ever sent as a digest.
 */
export function repositoryName(root, run = git) {
  const remote = run(root, ['remote', 'get-url', 'origin']).stdout;
  if (!remote) return root;
  return remote.replace(/^git@github\.com:/, '').replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
}

/** The whole inventory for the repository at `cwd`. */
export function buildInventory({
  cwd = process.cwd(), config = core.loadConfig(cwd), now = Date.now(), run = git, helpers,
}) {
  const { agentRow, keyOf, isAlive } = helpers;
  const root = core.repositoryRoot(cwd);
  const trees = worktreesOf(root, { run });
  const roots = new Set([root, ...trees.map((t) => t.path)]);
  const machine = core.machineId();
  const { runs, finished } = runRows(config, now, keyOf);
  return {
    machine: hashOf(machine || 'unknown-machine'),
    // The same digest as the heartbeat's `repo` (heartbeat.mjs repoDigest),
    // so the service can put a machine's inventory beside its sessions.
    repo: core.digest(repositoryName(root, run)),
    at: new Date(now).toISOString(),
    agents: openAgents(roots, agentRow),
    worktrees: worktreeRows(trees, config, { run, keyOf }),
    runs,
    sessions: liveSessions(roots, isAlive),
    finished,
  };
}

/** Build and send one inventory. Never throws. */
export async function sendInventory({
  cwd = process.cwd(), send = core.sendInventory, sendMerged = core.sendMerged, settle = settleMovedAgents, ...rest
}) {
  try {
    const config = core.loadConfig(cwd);
    const inventory = buildInventory({ cwd, config, ...rest });
    const out = await send(inventory, config);
    // The same pass asks git which of those keys are merged (MACLEOD-726),
    // and which of the board's open cards (MACLEOD-773): a card whose
    // worktree is gone still finishes, and nobody runs the backfill.
    try {
      const merged = await reportMerged(withBoardKeys(openKeys(inventory), out), {
        root: core.repositoryRoot(cwd), config, run: rest.run, repo: inventory.repo, now: rest.now, send: sendMerged,
      });
      // The next prompt asks for the plain line of each card that just
      // merged and has none (MACLEOD-770). Local file only.
      if (merged?.keys?.length) {
        const { oweLines } = await import('./say.mjs');
        oweLines(merged.keys, 'merge');
      }
    } catch { /* the next pass is twenty minutes away */ }
    // An agent that moved to another ticket and then went quiet never
    // settles its own node; this pass does it for it (MACLEOD-713).
    try {
      const root = core.repositoryRoot(cwd);
      const roots = new Set([root, ...worktreesOf(root, { run: rest.run }).map((t) => t.path)]);
      await settle(config, { actors: actorsOn(roots) });
    } catch { /* the next pass is twenty minutes away */ }
    return out;
  } catch {
    return { ok: false };
  }
}
