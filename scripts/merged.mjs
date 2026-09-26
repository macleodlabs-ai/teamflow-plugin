// Proof from git that a ticket's work is merged (MACLEOD-726, census fix 2).
//
// Agents dispatched to worktrees often never report under their own
// ticket key, so the board has no evidence the work landed and keeps the
// card open for a person. This machine does have the evidence: the
// branch names, the commit subjects, the worktree bindings. This module
// asks the local repository, and nothing else, one question per key:
// is a branch or a commit that names it merged into the default branch?
//
// - Local only. git runs with no shell, fixed arguments and a timeout.
//   A key or a branch name is used only after it passes a strict pattern,
//   and a key that came from the service is only ever compared with text
//   git printed; it is never an argument to git.
// - A branch counts when its name, its worktree's binding or the node
//   minted for the agent sent to that worktree carries the key, and its tip
//   arrived on the default branch through a merge. A
//   branch that was only created from the default branch, with no work
//   on it, is not a merge: its tip is on the default branch's own line.
// - A commit counts when its `TeamFlow-Key` trailer, or with no trailer
//   its subject, names the key (MACLEOD-845), and it arrived on the
//   default branch through a merge: reachable from it, but not on its own
//   first-parent line. A commit made straight on the default branch never
//   counts, however many name the key: in a repository whose main session
//   commits to main, the key is in every subject while the work goes on.
//   A worktree whose branch was deleted after the merge still counts.
// - `mergedAt` is when the work arrived on the default branch: the time
//   of the first commit on the default branch's own line that holds it.
//
// What leaves the machine is one derived fact per key:
// `{ key, merged: true, mergedAt, via: 'branch' | 'commit' }`.
// Never a branch name, a commit message, an id or a diff.
import fs from 'node:fs';
import path from 'node:path';

import * as core from './core.mjs';

export const FACTS_MAX = 200;
const COMMITS_MAX = 20000;
// A tracker key: `MACLEOD-688`, `ADHOC-10`. Upper case once read.
const KEY = /^[A-Z][A-Z0-9]{0,19}-[0-9]{1,9}$/;
const KEY_IN_TEXT = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{0,19}-[0-9]{1,9})(?![0-9])/g;
// git's own rules, narrowed: no `..`, no `//`, no leading `-` or `/`,
// no `.lock` end, no space or control character, at most 200 characters.
const BRANCH = /^(?![-/.])(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)(?!.*[/.]$)[A-Za-z0-9._/-]{1,200}$/;
const SHA = /^[0-9a-f]{40}$/;

/** The key upper-cased when it is a tracker key, else undefined. */
export function keyOk(value) {
  const key = String(value ?? '').trim().toUpperCase();
  return KEY.test(key) ? key : undefined;
}

/** Whether `name` is a branch name this module will hand to git. */
export function branchOk(name) {
  return typeof name === 'string' && BRANCH.test(name);
}

/** Every tracker key named in a line of text, upper-cased. */
export function keysIn(text) {
  const out = new Set();
  for (const match of String(text ?? '').matchAll(KEY_IN_TEXT)) out.add(match[1].toUpperCase());
  return out;
}

function git(root, args) {
  return core.safeExec(process.env.TEAMFLOW_GIT_BIN || 'git', ['-C', root, ...args],
    { cwd: root, timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
}

/** The default branch's ref: local first, then origin's copy. */
export function defaultRef(root, run = git) {
  const head = run(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  const names = [...new Set([...(head.ok ? [head.stdout.replace(/^origin\//, '')] : []), 'main', 'master'])];
  for (const name of names.filter(branchOk)) {
    for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
      if (run(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).ok) return ref;
    }
  }
  return undefined;
}

/**
 * The default branch's history in one git call: for every commit, when
 * it arrived on the default branch, and for every key its subject
 * names, the newest such arrival.
 */
export function historyOf(root, ref, run = git) {
  // The TeamFlow-Key trailer (MACLEOD-845) before the subject, so a tab
  // in a subject cannot shift it.
  const got = run(root, ['log', ref, `--max-count=${COMMITS_MAX}`, '--format=%H %P%x09%ct%x09%(trailers:key=TeamFlow-Key,valueonly,separator=%x2C)%x09%s']);
  const commits = new Map();
  const order = [];
  for (const line of got.ok ? got.stdout.split('\n') : []) {
    const [ids, time, trailer = '', ...rest] = line.split('\t');
    const [sha, ...parents] = String(ids || '').split(' ').filter(Boolean);
    if (!SHA.test(sha || '')) continue;
    const keys = trailer.split(',').map(keyOk).filter(Boolean);
    commits.set(sha, { parents, time: Number(time) * 1000, subject: rest.join('\t'), keys });
    order.push(sha);
  }
  // The default branch's own line: its tip, then each first parent.
  const line = [];
  for (let at = order[0]; at && commits.has(at); at = commits.get(at).parents[0]) line.push(at);
  const arrival = new Map();
  for (const main of line.reverse()) {
    const when = commits.get(main).time;
    const stack = [main];
    while (stack.length) {
      const sha = stack.pop();
      if (arrival.has(sha) || !commits.has(sha)) continue;
      arrival.set(sha, when);
      const { parents } = commits.get(sha);
      // The line's own first parent arrived earlier; it is not this merge's.
      stack.push(...(sha === main ? parents.slice(1) : parents));
    }
  }
  const onLine = new Set(line);
  const byKey = new Map();
  for (const [sha, { subject, keys }] of commits) {
    const when = arrival.get(sha);
    // Only work that arrived through a merge: a commit made straight on
    // the default branch names its ticket while the work goes on.
    if (when === undefined || onLine.has(sha)) continue;
    // A trailer names the ticket the working copy was bound to, and it
    // is the one key the commit counts for: a subject that names another
    // key is the wrong-key case, moved to the bound ticket (MACLEOD-845).
    for (const key of keys.length ? keys : keysIn(subject)) byKey.set(key, Math.max(byKey.get(key) ?? 0, when));
  }
  return { arrival, line: onLine, byKey };
}

// The pull request as a second proof (MACLEOD-884). A squash merge puts
// a new commit on the default branch, so the branch tip never arrives
// there and git alone reads the work as not merged. `gh pr view` knows.
// Three answers, kept apart: 'merged', 'not merged' (a PR that is open or
// closed, or gh saying there is no PR) and 'unknown' (gh missing, not
// signed in, no network, a timeout, any answer it cannot read). Unknown
// is never "no PR": a caller treats it as not proven.
//
// gh runs with no shell, fixed arguments and a short timeout. The branch
// is a name git printed, checked by `branchOk`; nothing from the service
// reaches it. A branch name of digits only is refused, because gh reads
// it as a PR number.
export const PR_TIMEOUT_MS = 5000;
const PR_FIELDS = 'state,mergedAt,headRefOid';
const NO_PR = /no (?:open )?pull requests? found/i;

function gh(root, args) {
  return core.safeExec(core.ghBinary(), args, {
    cwd: root, timeout: PR_TIMEOUT_MS,
    env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' },
  });
}

/**
 * `{ state: 'merged', mergedAt }`, `{ state: 'not merged' }` or
 * `{ state: 'unknown' }` for `branch`. With `head`, a merged PR counts
 * only when its head is that commit: a commit made after the merge is
 * work the PR does not hold.
 */
export function prState(root, branch, { head, run = gh } = {}) {
  if (!root || !branchOk(branch) || /^[0-9]+$/.test(branch)) return { state: 'unknown' };
  let got;
  try { got = run(root, ['pr', 'view', branch, '--json', PR_FIELDS]); } catch { return { state: 'unknown' }; }
  if (!got?.ok) return { state: NO_PR.test(String(got?.stderr || '')) ? 'not merged' : 'unknown' };
  let pr;
  try { pr = JSON.parse(got.stdout); } catch { return { state: 'unknown' }; }
  if (pr?.state === 'OPEN' || pr?.state === 'CLOSED') return { state: 'not merged' };
  if (pr?.state !== 'MERGED') return { state: 'unknown' };
  if (head && pr.headRefOid !== head) return { state: 'not merged' };
  const at = Date.parse(pr.mergedAt);
  return Number.isFinite(at) ? { state: 'merged', mergedAt: new Date(at).toISOString() } : { state: 'unknown' };
}

export const PR_MEMO_MS = 30 * 60 * 1000;
const memoPath = () => path.join(core.dataDir(), 'pr-state.json');

/**
 * A `(branch, head) => answer` that asks gh at most `max` times. With
 * `memo`, an answer is kept for 30 minutes by branch and head, so the
 * check-in each minute does not ask gh about the same branches again.
 * Past `max`, the answer is 'unknown'.
 */
export function prCheck(root, { max = 20, memo = false, now = Date.now(), run } = {}) {
  let asked = 0;
  const held = memo ? core.readJson(memoPath(), {}) || {} : {};
  return (branch, head) => {
    const id = `${branch}@${head || ''}`;
    const kept = held[id];
    if (kept && now - (Date.parse(kept.at) || 0) < PR_MEMO_MS) return kept.answer;
    if (asked >= max) return { state: 'unknown' };
    asked += 1;
    const answer = prState(root, branch, { head, ...(run ? { run } : {}) });
    if (memo) {
      for (const [k, v] of Object.entries(held)) if (now - (Date.parse(v?.at) || 0) >= PR_MEMO_MS) delete held[k];
      held[id] = { at: new Date(now).toISOString(), answer };
      try { core.writeJson(memoPath(), held); } catch { /* ask again next time */ }
    }
    return answer;
  };
}

/** Local branches with their tips; a name that fails the pattern is skipped. */
export function branchesOf(root, run = git) {
  const got = run(root, ['for-each-ref', 'refs/heads', '--format=%(refname:short)%09%(objectname)']);
  const out = [];
  for (const row of got.ok ? got.stdout.split('\n') : []) {
    const [name, sha] = row.split('\t');
    if (branchOk(name) && SHA.test(sha || '')) out.push({ name, sha, keys: keysIn(name) });
  }
  return out;
}

/** `{ worktree path: branch name }`, from `git worktree list --porcelain`. */
export function worktreeBranches(root, run = git) {
  const got = run(root, ['worktree', 'list', '--porcelain']);
  const out = new Map();
  let dir;
  for (const line of got.ok ? got.stdout.split('\n') : []) {
    if (line.startsWith('worktree ')) dir = line.slice(9);
    else if (dir && line.startsWith('branch refs/heads/') && branchOk(line.slice(18))) out.set(dir, line.slice(18));
  }
  return out;
}

/**
 * The keys each branch works on, by branch name, from what this machine
 * wrote itself: a worktree's `work-on` binding, and the node minted for
 * an agent sent to a worktree (the agent's own record names the minted
 * key and the folder it worked in). A worktree removed since is found by
 * the branch name Claude Code gives it, `worktree-<folder>`, when that
 * branch is still here.
 */
export function boundBranches(root, run = git, { branches = [] } = {}) {
  const trees = worktreeBranches(root, run);
  const names = new Set(branches.map((b) => b.name));
  const out = new Map();
  const add = (name, key) => {
    if (!name || !key) return;
    if (!out.has(name)) out.set(name, new Set());
    out.get(name).add(key);
  };
  for (const [dir, name] of trees) {
    const held = core.readJson(path.join(dir, '.teamflow', 'binding.json'));
    add(name, keyOk(held?.jiraKey ?? held?.key));
  }
  const sessions = path.join(core.dataDir(), 'sessions');
  let files = [];
  try { files = fs.readdirSync(sessions).filter((n) => n.endsWith('.json')); } catch { /* no sessions here */ }
  for (const file of files) {
    const actor = core.readJson(path.join(sessions, file));
    const key = keyOk(actor?.dispatch?.key);
    if (!key || actor.dispatch.nested || typeof actor.cwd !== 'string') continue;
    const guess = `worktree-${path.basename(actor.cwd)}`;
    add(trees.get(actor.cwd) || (names.has(guess) ? guess : undefined), key);
  }
  return out;
}

/**
 * `{ ADHOC-n: TICKET-m }` from an alias map shaped like the service's
 * (`{ 'ADHOC-10': { to: 'MACLEOD-688' } }`), keys checked.
 */
export function aliasTargets(aliases = {}) {
  const out = new Map();
  for (const [from, alias] of Object.entries(aliases || {})) {
    const a = keyOk(from);
    const b = keyOk(alias?.to);
    if (a && b && a !== b) out.set(a, b);
  }
  return out;
}

/**
 * The merged facts for `keys`, one per ticket. An ad hoc key that became
 * a ticket reports as the ticket, and the ticket's evidence includes the
 * ad hoc key's (ADHOC-10's merge counts for MACLEOD-688).
 */
export function mergedFacts(keys, { root, run = git, aliases = {}, pr } = {}) {
  const became = aliasTargets(aliases);
  const wanted = new Set();
  for (const raw of keys || []) {
    const key = keyOk(raw);
    if (key) wanted.add(became.get(key) || key);
  }
  if (!wanted.size || !root) return [];
  const ref = defaultRef(root, run);
  if (!ref) return [];
  const history = historyOf(root, ref, run);
  const branches = branchesOf(root, run);
  const bound = boundBranches(root, run, { branches });
  const facts = [];
  for (const key of [...wanted].sort()) {
    const names = new Set([key, ...[...became].filter(([, to]) => to === key).map(([from]) => from)]);
    let best;
    const take = (at, via) => { if (at && (!best || at > best.at)) best = { at, via }; };
    for (const name of names) take(history.byKey.get(name), 'commit');
    for (const branch of branches) {
      const says = [...branch.keys, ...(bound.get(branch.name) || [])].some((k) => names.has(k));
      if (!says || history.line.has(branch.sha)) continue;
      const arrived = history.arrival.get(branch.sha);
      if (arrived) { take(arrived, 'branch'); continue; }
      // A squash merge: git cannot see it, the merged PR can (MACLEOD-884).
      const got = pr ? pr(branch.name, branch.sha) : undefined;
      if (got?.state === 'merged') take(Date.parse(got.mergedAt), 'branch');
    }
    if (best) facts.push({ key, merged: true, mergedAt: new Date(best.at).toISOString(), via: best.via });
    if (facts.length >= FACTS_MAX) break;
  }
  return facts;
}

/** The merged facts as one report payload, or undefined when there are none. */
export function mergedPayload(facts, { repo, now = Date.now() } = {}) {
  if (!facts.length) return undefined;
  return { ...(repo ? { repo } : {}), at: new Date(now).toISOString(), merged: facts.slice(0, FACTS_MAX) };
}

/**
 * The keys an inventory holds open: nodes of open runs not yet done or
 * skipped, bound worktrees and open agents. The board decides which of
 * them are still unfinished; this only offers what the machine has seen.
 */
export function openKeys(inventory = {}) {
  const keys = new Set();
  for (const run of inventory.runs || []) {
    for (const node of run.nodes || []) if (!['done', 'skipped'].includes(node.state)) keys.add(node.key);
  }
  for (const tree of inventory.worktrees || []) keys.add(tree.key);
  for (const agent of inventory.agents || []) keys.add(agent.key);
  return [...keys].filter(Boolean);
}

/** How many of the board's open keys one pass checks (the service sends at most 300). */
export const BOARD_KEYS_MAX = 300;

/**
 * The machine's open keys and the board's (MACLEOD-773): the inventory's
 * reply names every card the service holds open, so a card whose worktree
 * was removed after its merge is still checked, and nobody has to run
 * `teamflow reconcile --merged`. A received key that is not a tracker key
 * is dropped; each is only ever compared with what git printed.
 */
export function withBoardKeys(keys = [], reply = {}) {
  const board = Array.isArray(reply?.openKeys) ? reply.openKeys.slice(0, BOARD_KEYS_MAX) : [];
  return [...new Set([...keys, ...board.map(keyOk)].filter(Boolean))];
}

/**
 * How many facts go in one request. The service settles each card in the
 * request, and 122 in one request ran past its time limit on this
 * repository (2026-09-23). Ten stays well inside it.
 */
export const FACTS_PER_SEND = 10;

/** Send facts in batches. Stops at the first batch that fails; returns how many went. */
export async function sendInBatches(facts, { repo, now = Date.now(), send = core.sendMerged, config = {} } = {}) {
  let sent = 0;
  for (let i = 0; i < facts.length; i += FACTS_PER_SEND) {
    const batch = facts.slice(i, i + FACTS_PER_SEND);
    const out = await send(mergedPayload(batch, { repo, now }), config);
    if (!out?.ok) return { ok: false, sent, reason: out?.reason };
    sent += batch.length;
  }
  return { ok: true, sent };
}

/** Where this machine keeps the facts it already sent, so a pass sends only what is new. */
function sentPath() {
  return path.join(core.dataDir(), 'merged-sent.json');
}

/** The facts not sent before with the same `mergedAt`. */
export function unsent(facts) {
  const held = core.readJson(sentPath()) || {};
  return facts.filter((fact) => held[fact.key] !== fact.mergedAt);
}

/** Remember facts the service took. The file keeps the newest 2000 keys. */
export function markSent(facts) {
  const held = core.readJson(sentPath()) || {};
  for (const fact of facts) held[fact.key] = fact.mergedAt;
  const keys = Object.keys(held);
  const kept = Object.fromEntries(keys.slice(Math.max(0, keys.length - 2000)).map((k) => [k, held[k]]));
  core.writeJson(sentPath(), kept);
}

// --- `teamflow reconcile --merged`: the backfill -------------------------
//
// Agents already dispatched never report again, so the heartbeat's pass
// alone cannot reach the cards they left. This runs the same check once,
// for every card the board lists as open for this organisation. The board
// is read with the report credential (the dashboard's own bundle route);
// its keys are used as keys only: each passes the key pattern and is only
// compared with what git printed. Nothing received is ever run.

const OPEN_RUNS = new Set(['planning', 'running', 'blocked', 'stalled']);

/** The open keys and the alias map from a board bundle. */
export function boardKeys(bundle = {}) {
  const docs = bundle?.documents || {};
  const keys = new Set();
  for (const [key, issue] of Object.entries(docs.issues || {})) {
    const stage = String(issue?.stage || '');
    if (!issue?.deliveredAt && !['DONE', 'READY_PROD'].includes(stage)) keys.add(key);
  }
  for (const run of Object.values(docs.workflows || {})) {
    if (!OPEN_RUNS.has(run?.status)) continue;
    for (const node of run.tickets || []) if (!['done', 'skipped'].includes(node?.state)) keys.add(node?.key);
  }
  return { keys: [...keys].map(keyOk).filter(Boolean), aliases: docs.aliases || {} };
}

export const RECONCILE_USAGE = 'Usage: teamflow reconcile --merged [--dry-run]';

/** The command. 0 when it ran, 1 when the board could not be read, 2 on a bad argument. */
export async function main(args = [], ctx = {}) {
  const { config = {}, cwd = process.cwd() } = ctx;
  const print = ctx.print || ((line) => process.stdout.write(`${line}\n`));
  const fail = ctx.fail || ((line) => process.stderr.write(`${line}\n`));
  if (!args.includes('--merged') || args.some((a) => !['--merged', '--dry-run'].includes(a))) {
    fail(RECONCILE_USAGE);
    return 2;
  }
  const read = ctx.read || core.fetchState;
  const result = await read('bundle', { ...config, serviceTimeoutMs: Math.max(Number(config.serviceTimeoutMs) || 0, 30000) });
  if (!result?.ok || !result.document) {
    fail(`TeamFlow could not read your board: ${result?.missing ? 'the service has nothing for this organisation yet' : result?.reason}.`);
    return 1;
  }
  const { keys, aliases } = boardKeys(result.document);
  const root = core.repositoryRoot(cwd);
  const facts = mergedFacts(keys, { root, run: ctx.run, aliases, pr: ctx.pr && root ? ctx.pr(root) : undefined });
  if (!facts.length) {
    print(`The board has ${keys.length} open cards. Git shows none of them merged into main.`);
    return 0;
  }
  for (const fact of facts) print(`${fact.key}: merged into main at ${fact.mergedAt}.`);
  if (args.includes('--dry-run')) {
    print(`${facts.length} cards can finish. TeamFlow sent nothing.`);
    return 0;
  }
  const repository = (ctx.info || core.gitInfo)(cwd)?.repository;
  const out = await sendInBatches(facts, {
    repo: repository ? core.digest(repository) : undefined, now: ctx.now, send: ctx.send || core.sendMerged, config,
  });
  markSent(facts.slice(0, out.sent));
  if (!out.ok) {
    const why = out.reason || 'the service did not answer';
    fail(out.sent
      ? `TeamFlow sent ${out.sent} of ${facts.length} merged cards, then stopped: ${why}. Run it again to send the rest.`
      : `TeamFlow could not send the ${facts.length} merged cards: ${why}.`);
    return 1;
  }
  print(`TeamFlow sent ${facts.length} merged cards. Within five minutes, the board finishes each one nobody still works on.`);
  return 0;
}

/** Check `keys` against git and send what is merged. Returns how many facts went. */
export async function reportMerged(keys, {
  root, config = {}, run, aliases = core.readKeyAliases(config), repo, now = Date.now(), send = core.sendMerged,
} = {}) {
  const facts = unsent(mergedFacts(keys, { root, run, aliases }));
  if (!facts.length) return { ok: true, sent: 0 };
  const out = await sendInBatches(facts, { repo, now, send, config });
  markSent(facts.slice(0, out.sent));
  // The keys that went, for the next prompt's ask for a plain line (MACLEOD-770).
  return { ok: out.ok, sent: out.sent, ...(out.sent ? { keys: facts.slice(0, out.sent).map((fact) => fact.key) } : {}) };
}
