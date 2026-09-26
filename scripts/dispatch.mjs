#!/usr/bin/env node
// Every plan and every dispatched agent is a node on the board
// (MACLEOD-639, the owner's ruling: "ALL work must be represented.
// Find a non deterministic way to ensure it").
//
// What happened: an orchestrating session dispatched thirteen teams
// into worktrees without `teamflow workflow create`, so the board had
// no run, no phases and no edges for a day's work. "Non deterministic"
// means it may not depend on the orchestrator remembering: the hooks
// see the dispatch happen, and the plugin represents it itself.
//
// Three things are recognised as a session dispatching work, all from
// events the hooks already see and none from a prompt:
//
//   - the `Agent` (`Task`) tool being used, from its PreToolUse in
//     the parent (registered in hooks.json for that tool alone) --
//     `name`, `description`, `subagent_type` and `isolation`, never
//     `prompt`;
//   - `git worktree add` run through Bash, which is how a session
//     makes room for a team by hand;
//   - `claude` spawned non-interactively through Bash, which is how a
//     session starts a teammate.
//
// On the first of these in an organisation with no live run, the
// plugin creates one -- named after the bound ticket, or "Unplanned
// run <date>" -- marked `origin: auto` so the board draws it as
// unplanned rather than as somebody's plan. Every agent sent to a
// worktree, and every agent dispatched by a session that holds no
// ticket, gets an ad hoc item minted for it (the same `POST /v1/adhoc`
// `teamflow adhoc start` uses) whose title is the agent's label and
// one-line task -- derived state, capped, one line, never the prompt --
// and that item goes into the run's pool as a node. The mint happens on
// the async events of the dispatch, never on the synchronous PreToolUse
// (see `planLaunch` and `settle`), and only in a repository bound to
// TeamFlow, at most SESSION_NODE_CAP per session and one level deep. The
// agent's own events bind it to its node; a `work-on` in the worktree
// still wins, because a person's word always does.
//
// Nothing is ever silently dropped. When the service will not mint a
// key the agent inherits the dispatching session's ticket instead,
// and `teamflow status` and `doctor` say how many agents were
// dispatched and how many are represented under a node of their own,
// under the session's key, or not at all. The last number is the
// proof and is meant to read 0.
//
// Every path here fails open: a throw is caught, the hook exits 0 and
// the tool is told nothing.

import { currentBinding, mint, TITLE_MAX, TRACKER } from './adhoc.mjs';
import { title } from './words.mjs';
import {
  agentLabel, believable, dataDir, followKeyAliases, isAdHocKey, knownPrefixes, isAgentTool, isWorkflowTool, issuePayload, launchesPath, launchFields,
  organisationScope, readJson, readWorkflows, reportScope, saveSession, sendReport, sessionActors, workflowsPath, writeJson,
  writeWorkflows,
} from './core.mjs';
import { projectFor, projectsCachePath } from './project.mjs';
import { launchRole, roleBlock } from './launch-role.mjs';
import { addDispatched, autoCreate, finishRun, liveRun, move, placeFor, publish, stated } from './workflow.mjs';

import fs from 'node:fs';
import path from 'node:path';

/**
 * What this event says about dispatching, or nothing.
 *
 * Reads names and flags only. The `Agent` tool's `prompt` sits in the
 * same `tool_input` and is never touched; a Bash command is matched for
 * its shape and never recorded.
 */
export function dispatchOf(event, input = {}) {
  const tool = input.tool_name || '';
  // The `Agent` tool before it runs, so the node exists for the agent's
  // first event; Bash after it ran, on the async path, because a
  // synchronous hook on every shell command is a cost every command
  // would pay and neither of these needs to be first.
  //
  // The `Agent` tool's PostToolUse too (MACLEOD-640): its PreToolUse has
  // two seconds and a busy machine can miss them, and then the launch
  // was never recorded and `status` said "0 agents dispatched". The hook
  // plans on PostToolUse only a launch its PreToolUse did not record.
  if ((event === 'PreToolUse' || event === 'PostToolUse') && isWorkflowTool(tool)) {
    // A workflow run always gets a node of its own: its agents fire no
    // SubagentStart to bind them to anything else (MACLEOD-641).
    const given = launchFields(tool, input.tool_input);
    return { kind: 'agent', name: agentLabel(given.name, 64), task: agentLabel(given.description, 80), type: 'workflow', isolated: true };
  }
  if ((event === 'PreToolUse' || event === 'PostToolUse') && isAgentTool(tool)) {
    const given = input.tool_input || {};
    return {
      kind: 'agent',
      name: agentLabel(given.name, 64),
      task: agentLabel(given.description, 80),
      type: agentLabel(given.subagent_type, 40),
      // A worktree is a repository root of its own: nothing there
      // attributes the agent's hooks to a ticket unless something binds
      // it, which is the case this module exists for.
      isolated: given.isolation === 'worktree',
    };
  }
  if (event === 'PostToolUse' && tool === 'Bash') {
    const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
    if (/\bgit\s+worktree\s+add\b/.test(command)) return { kind: 'worktree' };
    if (/(^|[\s;&|(])claude\s+(?:-p|--print|--worktree|-w)\b/.test(command)) return { kind: 'claude' };
  }
  return undefined;
}

/**
 * The item's title: the agent's label and its one-line task, as the
 * launch registry already holds them, in plain words (MACLEOD-646): the
 * writer drops branch words and ticket keys and keeps the task when it
 * says more than the label. Derived state, one line, 60 characters. The
 * prompt is not an input to this function and cannot become one:
 * `dispatchOf` never reads it.
 */
export function nodeTitle(dispatch = {}) {
  const name = agentLabel(dispatch.name, 64);
  const task = agentLabel(dispatch.task, 80);
  const type = agentLabel(dispatch.type, 40);
  // The task is the Agent tool's description, what the work is; the name
  // is a code name ("ws-d-opus") and only a fallback.
  const sources = [task, name, name && task ? `${name}: ${task}` : '', type ? `${type} agent` : ''];
  const said = sources.map((text) => title(text)).find((t) => t !== 'Agent work') || 'Agent work';
  return agentLabel(said, TITLE_MAX);
}

/*
 * The ticket a launch names (MACLEOD-888).
 *
 * The owner, 2026-09-26: tickets minted for agents are noise. A brief
 * that names its ticket ("MACLEOD-880", "Plan as a file (880)") binds the
 * agent to THAT ticket; nothing is minted. Only a key of the tracker's
 * own form counts: written in capitals, with a prefix this machine knows
 * is real (knownPrefixes). A code name such as `redmain-881` is lower
 * case and is never a key, so no REDMAIN-881 card is invented. A number
 * in brackets takes the prefix of the session's own ticket, never an
 * invented one. The name and description are read first, then the
 * prompt's opening lines, in memory only. A source that names two or
 * more tickets names none: guessing between them bound agents to the
 * wrong one.
 */
const NAMED_KEY_RE = /(?<![A-Za-z0-9-])([A-Z][A-Z0-9]{1,19}-\d{1,9})(?![A-Za-z0-9-])/g;
const BRACKET_NUMBER_RE = /\((\d{1,9})\)/g;
const PROMPT_LEAD = 300;

function keysNamed(text, known, prefix, brackets) {
  const out = new Set();
  for (const found of String(text || '').matchAll(NAMED_KEY_RE)) {
    if (believable(found[1], known)) out.add(found[1]);
  }
  if (brackets && prefix) {
    for (const found of String(text || '').matchAll(BRACKET_NUMBER_RE)) out.add(`${prefix}-${Number(found[1])}`);
  }
  return out;
}

export function namedKey(launch = {}, { config = {}, state = {}, keys = [] } = {}) {
  try {
    const known = knownPrefixes(config, [state.binding?.key, ...keys]);
    // Nothing known: nobody to ask, so nothing is believed here. A dispatch
    // is no reason to take a key on trust.
    if (!known) return undefined;
    const session = String(state.binding?.key || '');
    const prefix = /^[A-Z][A-Z0-9]{1,19}-\d+$/.test(session) && !isAdHocKey(session)
      ? session.split('-')[0]
      : (known.size === 1 ? [...known][0] : undefined);
    const sources = [
      [launch.name, launch.description].filter(Boolean).join(' '),
      String(launch.prompt || '').slice(0, PROMPT_LEAD),
    ];
    for (const [i, text] of sources.entries()) {
      const found = keysNamed(text, known, prefix, i === 0);
      if (found.size === 1) return [...found][0];
      if (found.size > 1) return undefined;
    }
  } catch { /* no key is the safe answer */ }
  return undefined;
}

/** The keys of the runs on this machine: what teaches the prefixes. */
function runKeys(config) {
  const out = [];
  try {
    for (const run of Object.values(readWorkflows(config).workflows || {})) {
      for (const ticket of run.tickets || []) out.push(ticket.key);
    }
  } catch { /* none */ }
  return out;
}

/** The run's name: the bound ticket and its title, or the date. */
export function runName(state = {}, at = new Date()) {
  const key = state.binding?.key;
  const title = agentLabel(state.jira?.title, 60);
  if (key && title) return agentLabel(`${key}: ${title}`, 80);
  if (key) return `${key} run`;
  return `Unplanned run ${at.toISOString().slice(0, 10)}`;
}

/**
 * The one line said when the plugin had to create the run. On the
 * async path only, and once: the dispatching event stores it and the
 * next event that may speak prints it.
 */
export function createdNotice(workflow) {
  return `TeamFlow created run "${workflow.name}" for this work; plan it with `
    + '`teamflow workflow depends` so the board shows the phases.';
}

/**
 * The item document, published once by the dispatcher so the node has
 * a title on the board before the agent's first report. No execution:
 * nobody has done anything yet, and a placeholder row would stand
 * `waiting` beside the agent's real one for ever.
 */
async function publishItem(key, title, dispatch, state, cwd, config, info) {
  const at = new Date().toISOString();
  const payload = issuePayload({
    sessionId: state.sessionId,
    cwd,
    binding: { key, tracker: TRACKER, confidence: 1000, source: 'dispatch', sticky: true, boundAt: at },
    jira: { key, title },
    stage: 'BACKLOG',
    status: 'waiting',
    summary: `Dispatched to ${dispatch.name || (dispatch.type ? `agent ${dispatch.type}` : 'an agent')}`,
    updatedAt: at,
  }, config, info);
  payload.executions = [];
  return sendReport('issue', undefined, payload, config, { account: reportScope(config) });
}

/*
 * The two halves of representing a dispatch (MACLEOD-639 audit).
 *
 * The `Agent` tool's PreToolUse is synchronous: Claude Code holds the
 * dispatch until the hook exits. So that half is local only -- the run
 * is created or joined in workflows.json under a lock, and the launch is
 * recorded with `pending` when it needs a node -- and it is registered
 * with a two-second timeout. The network half, `settle`, runs on the
 * async events of the same dispatch: the tool's PostToolUse, the
 * agent's SubagentStart, or the agent's first tool event, whichever
 * comes first. A foreground agent's PostToolUse only arrives when it has
 * finished, which is why the agent's own events can settle it too.
 */

/** Nodes one session may mint; past it an agent goes under the session's ticket. */
export const SESSION_NODE_CAP = 50;
/** How often a mint that failed on the network is tried again, all events together. */
const MINT_ATTEMPTS = 5;
/** A mint claimed this long ago and never answered is somebody who died. */
const MINTING_STALE_MS = 30_000;
const LOCK_STALE_MS = 10_000;

/** Next to the workflows file, because what it guards is that file. */
export function runsLockPath() {
  return `${workflowsPath()}.lock`;
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * An O_EXCL lockfile, the gate lock's pattern: whoever creates the file
 * holds it, everyone else waits up to `waitMs` and then gives up. A file
 * older than `staleMs` belongs to a process that died holding it and is
 * taken over. Returns the release, or undefined when it was not had.
 */
export function acquireLock(file, { waitMs = 1500, staleMs = LOCK_STALE_MS } = {}) {
  const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
  const until = Date.now() + waitMs;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { return undefined; }
  for (;;) {
    try {
      fs.writeFileSync(file, token, { flag: 'wx', mode: 0o600 });
      return () => {
        try { if (fs.readFileSync(file, 'utf8') === token) fs.unlinkSync(file); } catch { /* gone */ }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') return undefined;
    }
    try {
      if (Date.now() - fs.statSync(file).mtimeMs > staleMs) {
        fs.renameSync(file, `${file}.stale-${token}`);
        fs.unlinkSync(`${file}.stale-${token}`);
        continue;
      }
    } catch { continue; }
    if (Date.now() >= until) return undefined;
    sleepSync(5 + Math.floor(Math.random() * 20));
  }
}

function withRunsLock(fn, options) {
  const release = acquireLock(runsLockPath(), options);
  if (!release) return { locked: false };
  try {
    return { locked: true, value: fn() };
  } finally {
    release();
  }
}

/**
 * Whether this repository reports to TeamFlow at all, from local files
 * only. Minting a node in a repository nobody bound would put somebody's
 * side project on an organisation's board. Any one of: a binding on disk
 * for this repository in this organisation, the session bound by a
 * person or by a dispatch, the project's `.teamflow.json` naming this
 * organisation in `org`, or the organisation's cached projects claiming
 * the repository.
 */
export function boundToTeamflow(cwd, config = {}, state = {}, repository = undefined) {
  try {
    if (['manual', 'dispatch', 'adhoc'].includes(state.binding?.source)) return true;
    if (cwd && currentBinding(cwd, config)) return true;
    const org = organisationScope(config);
    const named = cwd ? readJson(path.join(cwd, '.teamflow.json'), {})?.org : undefined;
    if (org && typeof named === 'string' && named.trim()) {
      const clean = named.trim().toLowerCase().replace(':', '-').replace(/[^a-z0-9._-]+/g, '-');
      if (clean === org || `account-${clean}` === org) return true;
    }
    const cached = readJson(projectsCachePath(config));
    if (repository && projectFor(repository, cached?.projects)) return true;
    // The session made or chose a run in this organisation (MACLEOD-761):
    // somebody put this work on the board by hand, so its agents belong there.
    if (state.sessionId && readWorkflows(config, { sessionId: state.sessionId }).via === 'session') return true;
  } catch { /* unbound is the safe answer */ }
  return false;
}

/** Where a dispatch happens: the session, its repository and that repository's project. */
export function dispatchPlace(config, state = {}, info = {}, cwd = undefined) {
  return placeFor({
    config,
    cwd: cwd || state.cwd,
    info: { ...info, repository: info?.repository || state.reportedRepository },
    sessionId: state.sessionId,
  });
}

/**
 * The run this organisation's dispatches go into, created when there is
 * none, with the session's ticket in it. Local, under the lock, and
 * re-read after the lock is had, so thirty dispatches at once make one
 * run. Undefined when the lock was not had in time; the async half
 * tries again.
 */
export function ensureRun(config, state = {}, info = {}, { waitMs, keys = [], cwd } = {}) {
  const held = withRunsLock(() => {
    // This session's run, and only if the work fits it; else the run for
    // this repository or project (MACLEOD-761). Never another session's
    // run because it was the newest on the machine.
    const runs = readWorkflows(config, dispatchPlace(config, state, info, cwd));
    let run = liveRun(runs);
    let created = false;
    if (!run) {
      run = autoCreate(runs, runName(state), stated(config, info));
      created = true;
    }
    let changed = created;
    // Joined, so it is this session's now: pointed at, never only inherited.
    if (runs.current !== run.id || runs.via === 'legacy') { runs.current = run.id; runs.via = 'dispatch'; changed = true; }
    for (const key of [state.binding?.key, ...keys].filter(Boolean)) {
      if (!(run.tickets || []).some((t) => t.key === key)) {
        addDispatched(run, key, runs.place);
        changed = true;
      }
    }
    if (changed) writeWorkflows(runs, config);
    return { run, created };
  }, waitMs === undefined ? undefined : { waitMs });
  return held.locked ? held.value : undefined;
}

/**
 * The synchronous half, on the `Agent` tool's PreToolUse (and, for the
 * shell dispatches, on their PostToolUse). What the launch registry
 * should remember -- `pending` when a node is to be minted, `under` when
 * the agent reports under a ticket that already exists, `reason` when it
 * gets neither a node nor the ticket it would want -- plus `notice` on
 * the dispatch that created the run. No network. Never throws.
 */
export function planLaunch(config, { state = {}, dispatch = {}, cwd, info = {}, nested = false, launch = {}, session = {} } = {}) {
  const out = {};
  try {
    const sessionKey = state.binding?.key;
    // An agent launching an agent: one level of nodes, never a tree of
    // them. The nested one reports under its parent's node, which is the
    // launching actor's own binding.
    if (nested) {
      if (sessionKey) out.under = sessionKey;
      out.reason = 'nested';
      return out;
    }
    // What the agent is for (MACLEOD-722; MACLEOD-714 decided it by
    // position alone): a reviewer of the card's step gets no node, it
    // belongs to the card. `launch` is the Agent tool's own input; its
    // prompt is scored in memory by `launchRole` and never kept.
    const role = dispatch.kind === 'agent' && dispatch.type !== 'workflow'
      ? launchRole({ ...launch, isolated: dispatch.isolated }, { ...session, key: sessionKey, stage: state.stage })
      : undefined;
    if (role) out.role = roleBlock(role);
    if (role?.as === 'reviewer') {
      out.under = sessionKey;
      out.review = role.step;
      if (role.features.lens) out.lens = role.features.lens;
      return out;
    }
    if (!boundToTeamflow(cwd, config, state, info?.repository)) {
      if (sessionKey) out.under = sessionKey;
      out.reason = 'unbound';
      return out;
    }
    // The ticket the brief names is the agent's node (MACLEOD-888): it
    // joins the run and nothing is minted for it.
    const named = dispatch.kind === 'agent' && dispatch.type !== 'workflow'
      ? namedKey(launch, { config, state, keys: runKeys(config) }) : undefined;
    const made = ensureRun(config, state, info, { cwd, keys: named ? [named] : [] });
    if (made?.created) out.notice = createdNotice(made.run);
    if (made) out.run = { id: made.run.id, name: made.run.name };
    if (dispatch.kind !== 'agent') return out;
    if (named) {
      out.key = named;
      out.under = named;
      return out;
    }
    if (sessionKey) out.under = sessionKey;
    // Else a node of its own, on the board only. Under a session's ticket
    // it is a step of that ticket: the service puts it on the ticket as a
    // checklist line and never makes it a ticket (adhoc_tickets.py).
    if (dispatch.isolated || !sessionKey) out.pending = true;
  } catch (error) {
    out.reason = out.reason || `TeamFlow could not represent the dispatch: ${error instanceof Error ? error.message : String(error)}`;
  }
  return out;
}

/** Where a session's mints are recorded, one file per launch. */
function mintsPath(sessionId) {
  return path.join(dataDir(), 'sessions', `${sessionId}.mints`);
}

/**
 * What was minted for one launch, or why not. The file is named for the
 * session and the tool call, which is the mint's idempotency key: a
 * re-entered hook reads the key instead of asking for another.
 */
export function mintOf(sessionId, id) {
  return id ? readJson(path.join(mintsPath(sessionId), `${id}.json`)) : undefined;
}

function writeMint(sessionId, id, value) {
  writeJson(path.join(mintsPath(sessionId), `${id}.json`), value);
}

/**
 * Claim the right to mint for one launch, under the lock: nobody else
 * is minting it, it has no key, a failure is worth another try, and the
 * session is under its cap. Returns what to do.
 */
function claimMint(sessionId, launch) {
  return withRunsLock(() => {
    const held = mintOf(sessionId, launch.id);
    if (held?.key) return { done: held };
    if (held?.state === 'minting' && Date.now() - Date.parse(held.at) < MINTING_STALE_MS) return { busy: true };
    if (held?.state === 'failed' && (!held.retry || (held.attempts || 0) >= MINT_ATTEMPTS)) return { done: held };
    if (held?.state === 'cap') return { done: held };
    let names = [];
    try { names = fs.readdirSync(mintsPath(sessionId)).filter((n) => n.endsWith('.json') && n !== `${launch.id}.json`); } catch { /* none yet */ }
    const spent = names.map((n) => readJson(path.join(mintsPath(sessionId), n)))
      .filter((m) => m?.key || (m?.state === 'minting' && Date.now() - Date.parse(m.at) < MINTING_STALE_MS)).length;
    if (spent >= SESSION_NODE_CAP) {
      const capped = { state: 'cap', reason: 'cap', at: new Date().toISOString() };
      writeMint(sessionId, launch.id, capped);
      return { done: capped };
    }
    writeMint(sessionId, launch.id, { state: 'minting', at: new Date().toISOString(), attempts: (held?.attempts || 0) + 1 });
    return { go: true, attempts: (held?.attempts || 0) + 1 };
  }, { waitMs: 5000 });
}

/**
 * The async half: mint the node a pending launch is owed, put it in the
 * run, publish the item and the run. Bounded by the service timeout on
 * each call, on events Claude Code does not wait for. Returns the mint
 * record (`key` and `title`, or `reason`), or nothing when the launch
 * was not owed a node. Never throws.
 */
export async function settle(config, { sessionId, launch, state = {}, cwd, info = {}, publishRun = false } = {}) {
  let result;
  let minted = false;
  try {
    if (launch?.id && launch.pending) {
      const claim = claimMint(sessionId, launch);
      const plan = claim.locked ? claim.value : undefined;
      if (plan?.done) result = await publishMinted(sessionId, launch, plan.done, { state, cwd, config, info });
      if (plan?.go) {
        const got = await mint(config);
        if (got.ok) {
          const title = nodeTitle(launch);
          // `published: false` until the card is out, so a hook killed
          // between the mint and the publish leaves a card owed, not lost
          // (MACLEOD-641, tracking gap 3: ADHOC-62 and 63 were minted and
          // never reached the board). The card goes before the run lock,
          // which may wait five seconds.
          result = { state: 'minted', key: got.key, title, at: new Date().toISOString(), published: false };
          writeMint(sessionId, launch.id, result);
          minted = true;
          result = await publishMinted(sessionId, launch, result, { state, cwd, config, info });
          ensureRun(config, state, info, { waitMs: 5000, keys: [got.key], cwd });
        } else {
          result = {
            state: 'failed',
            reason: got.reason || 'the service did not mint a key',
            // The network is worth another try; a refusal is an answer.
            retry: !got.status || got.status >= 500,
            attempts: plan.attempts,
            at: new Date().toISOString(),
          };
          writeMint(sessionId, launch.id, result);
        }
      }
      if (!result) result = mintOf(sessionId, launch.id);
    }
    if (minted || publishRun) {
      const run = liveRun(readWorkflows(config, dispatchPlace(config, state, info, cwd)));
      if (run) { try { await publish(run, config); } catch { /* queued or refused; the run is on this machine */ } }
    }
  } catch { /* fails open: the launch stays pending and status counts it */ }
  return result;
}

/** Whether some actor of the session already reported under this key. */
function reportedUnder(sessionId, key) {
  return sessionActors(sessionId).some((one) => one.binding?.key === key && one.lastPublishedAt);
}

/**
 * Publish the card a mint is owed (MACLEOD-641, tracking gap 3). Returns
 * the mint record as it now stands. A card sent, or queued for the
 * outbox, is published; so is one an agent already reported under,
 * because the item would overwrite the agent's own report. A refusal
 * counts as an attempt, and after MINT_ATTEMPTS nothing is tried again.
 * A record from before this field existed is left alone. Never throws.
 */
async function publishMinted(sessionId, launch, held, { state = {}, cwd, config, info } = {}) {
  if (!held?.key || held.published !== false || (held.publishAttempts || 0) >= MINT_ATTEMPTS) return held;
  let out;
  if (reportedUnder(sessionId, held.key)) {
    out = { ...held, published: true };
  } else {
    let sent;
    try { sent = await publishItem(held.key, held.title, launch, state, cwd, config, info); } catch { sent = undefined; }
    out = sent?.ok || sent?.queued
      ? { ...held, published: true }
      : { ...held, publishAttempts: (held.publishAttempts || 0) + 1 };
  }
  writeMint(sessionId, launch.id, out);
  return out;
}

/**
 * Publish the cards this session's mints still owe, at most `limit` a
 * turn (MACLEOD-641, tracking gap 3). On `Stop` and `SubagentStop`, so a
 * card whose first publish was lost reaches the board on the next turn.
 * Returns how many were tried. Never throws.
 */
export async function publishOwed(config, { sessionId, state = {}, cwd, info = {}, limit = 3 } = {}) {
  let tried = 0;
  try {
    for (const launch of launchesOf(sessionId)) {
      if (tried >= limit) break;
      const held = mintOf(sessionId, launch.id);
      if (!held?.key || held.published !== false || (held.publishAttempts || 0) >= MINT_ATTEMPTS) continue;
      tried += 1;
      await publishMinted(sessionId, launch, held, { state, cwd, config, info });
    }
  } catch { /* the next turn tries again */ }
  return tried;
}

/**
 * Give a node to every agent the session sent while its repository was
 * not yet on TeamFlow (MACLEOD-761). The website session dispatched an
 * agent, then made a run and bound a ticket; the launch kept "unbound"
 * for ever and its work reached no card. Once the repository counts as
 * bound, each such launch is owed a node like any other and is settled
 * here. At most `limit` a turn, on `Stop` and `SubagentStop`. Returns
 * how many were given one. Never throws.
 */
export async function replanUnbound(config, { sessionId, state = {}, cwd, info = {}, limit = 3 } = {}) {
  let done = 0;
  try {
    if (!sessionId) return 0;
    const waiting = launchesOf(sessionId).filter((l) => l.reason === 'unbound' && !l.key && !l.launchedBy && l.id);
    if (!waiting.length || !boundToTeamflow(cwd, config, state, info?.repository)) return 0;
    if (!ensureRun(config, state, info, { cwd })) return 0;
    for (const launch of waiting.slice(0, limit)) {
      const owed = { ...launch, pending: true };
      delete owed.reason;
      writeJson(path.join(launchesPath(sessionId), `${launch.id}.json`), owed);
      const got = await settle(config, { sessionId, launch: owed, state, cwd, info });
      if (got?.key) done += 1;
    }
  } catch { /* the next turn tries again */ }
  return done;
}

/**
 * Close the node minted for one agent (MACLEOD-641, audit K1 and K7).
 *
 * A node changed state only through `teamflow workflow ticket`, which an
 * orchestrator has to remember to run, so a finished agent's node read
 * "building" for a day. Now the agent's own end closes it: `done` when
 * its last report passed, `rework` when it failed. `skipped` with a note
 * when the agent went to work on another key instead.
 *
 * Only an ad hoc node the plugin put in a run for a dispatch, or the
 * ticket that node became (`was`, the ad hoc key it was minted as;
 * MACLEOD-726). Any other tracker ticket is never closed by an agent: an
 * agent finishing is not the ticket finishing. Idempotent: a node already
 * closed is left as it is. Under the runs lock; the run is published
 * after. Never throws.
 */
export async function closeDispatched(config, { key, was, outcome = 'done', note, movedTo } = {}) {
  try {
    const converted = !isAdHocKey(key) && isAdHocKey(was);
    if (!isAdHocKey(key) && !converted) return undefined;
    const mine = (t) => t.key === key && t.addedBy === (converted ? 'converted' : 'dispatch');
    const held = withRunsLock(() => {
      const runs = readWorkflows(config);
      const holding = Object.values(runs.workflows || {})
        .filter((wf) => (wf.tickets || []).some(mine));
      // A live run first; else the newest that holds it, because a run
      // closed on this machine before the agent moved still owes the
      // board the node's end (MACLEOD-641, tracking gap 2).
      const run = holding.find((wf) => !['done', 'cancelled', 'archived'].includes(wf.status))
        || holding.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
      const ticket = run?.tickets.find((t) => t.key === key);
      if (!ticket || ['done', 'skipped', outcome].includes(ticket.state)) return undefined;
      move(run, key, { state: outcome, ...(note ? { note } : {}) });
      // The agent went to work on a tracker ticket (MACLEOD-733): that
      // ticket is the plan's work now, so it joins the same run in the
      // node's place. Without this the run lost the agent at once and the
      // ticket sat in no plan.
      const live = !['done', 'cancelled', 'archived'].includes(run.status);
      if (movedTo && live && !(run.tickets || []).some((t) => t.key === movedTo)) addDispatched(run, movedTo);
      finishRun(run);
      writeWorkflows(runs, config);
      return run;
    }, { waitMs: 1500 });
    const run = held.locked ? held.value : undefined;
    if (!run) return undefined;
    try { await publish(run, config); } catch { /* the run is saved on this machine */ }
    return { key, state: outcome };
  } catch {
    return undefined;
  }
}

/**
 * The move a dispatched agent's own next event would settle, settled by
 * the heartbeat's inventory pass instead (MACLEOD-726, MACLEOD-713).
 *
 * An agent that reported under its minted node and was then bound to
 * another ticket (`work-on`) moves the node to `skipped, moved to KEY`
 * on its next hook event. An agent that goes quiet, or finishes before
 * another event, never sends one, so its node stayed `running` on the
 * board, and its heartbeat row names the new ticket, not the card its
 * node holds. Only actors whose node is still unsettled are touched;
 * the alias is followed first, so a node converted to a ticket closes
 * too. Returns how many moved.
 */
export async function settleMovedAgents(config, { actors = [], close = closeDispatched } = {}) {
  let settled = 0;
  for (const held of actors) {
    const dispatch = held?.dispatch;
    if (!held?.agentKey || !held.sessionId || !dispatch?.key || dispatch.nested || !dispatch.bound
      || dispatch.moved || held.ended) continue;
    const state = { ...held, dispatch: { ...dispatch }, binding: held.binding ? { ...held.binding } : undefined };
    followKeyAliases(state, undefined, config);
    const to = state.binding?.key;
    if (!to || to === state.dispatch.key) continue;
    const moved = await close(config, {
      key: state.dispatch.key, was: state.dispatch.was, outcome: 'skipped', note: `moved to ${to}`, movedTo: to,
    });
    if (!moved) continue;
    saveSession({ ...held, dispatch: { ...state.dispatch, moved: true } });
    settled += 1;
  }
  return settled;
}

/** A launch with what was minted for it, as status and the agent's binding read it. */
export function withMint(sessionId, launch) {
  if (!launch) return launch;
  const held = launch.id ? mintOf(sessionId, launch.id) : undefined;
  if (!held) return launch;
  const out = { ...launch };
  if (held.key) { out.key = held.key; out.title = held.title; delete out.pending; }
  if (!held.key && held.reason) out.reason = held.reason;
  if (!held.key && held.state !== 'minting' && !(held.state === 'failed' && held.retry && (held.attempts || 0) < MINT_ATTEMPTS)) delete out.pending;
  return out;
}

/** Every launch the session recorded, claimed or not. Local files only. */
export function launchesOf(sessionId) {
  const dir = launchesPath(sessionId);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => withMint(sessionId, readJson(path.join(dir, name))))
    .filter(Boolean);
}

/**
 * How many agents this session dispatched and how each is represented.
 *
 * `own` has a node of its own in a run; `under` reports under the
 * session's ticket; `unrepresented` has neither -- the service would
 * not mint a key and the session held no ticket to inherit. The last
 * is the number that should always be 0.
 */
export function dispatchSummary(sessionId) {
  const launches = sessionId ? launchesOf(sessionId) : [];
  const own = launches.filter((l) => l.key).length;
  const under = launches.filter((l) => !l.key && l.under).length;
  const unrepresented = launches.length - own - under;
  // Why any of them has no node of its own, whether or not it found a key to
  // report under: "under the session's ticket" is a fallback, and a person
  // reading the line should know what made it one.
  const reasons = [...new Set(launches.filter((l) => !l.key && l.reason).map((l) => l.reason))];
  return { dispatched: launches.length, own, under, unrepresented, reasons };
}

/** The status/doctor line. Always printed, so 0 is a fact and not silence. */
export function dispatchLine(summary) {
  const { dispatched, own, under, unrepresented, reasons = [] } = summary;
  const parts = [`${dispatched} agent${dispatched === 1 ? '' : 's'} dispatched`, `${unrepresented} unrepresented`];
  if (own) parts.push(`${own} with a node of their own`);
  if (under) parts.push(`${under} under the session's ticket`);
  const line = parts.join(', ');
  return reasons.length ? `${line} (${reasons.join('; ')})` : line;
}
