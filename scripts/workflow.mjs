#!/usr/bin/env node
// `teamflow workflow`: the pool of tickets a run works through.
//
// TeamFlow's plugin observes. Hooks watch a tool call, classifyTool
// derives a stage, the board draws it. A workflow is the other half:
// what the session is working through, in what order, and what waits
// on what. The orchestrating skill owns the run; this module owns the
// record of it, so the plan survives a session and reaches the board.
//
// Two boundaries decide almost everything here.
//
// The order does not travel. A workflow is created from a sentence
// somebody typed. That sentence is a prompt, prompts never leave the
// machine, and docs/REPORTING_CONTRACT.md makes no exception for this
// one. It is kept locally, because `teamflow workflow show` should be
// able to say what was asked for, and `published()` is the single
// place that decides what leaves.
//
// The filter is flags, not prose. Turning "everything in the backlog,
// skip the auth work" into a filter is a judgment call and belongs to
// the model; applying a filter is deterministic and belongs to code.
// The skill reads the sentence and calls this with flags.

import crypto from 'node:crypto';
import {
  actorsForKey, adoptWorkflow, readWorkflows, reportScope, resolveGithubRepo, saveSession,
  sendReport, trackerOf, unclaimedWorkflows, workflowsPath, writeWorkflows,
} from './core.mjs';
import { cardFor, cardLine, publishCard, readTracker, readWriteBack } from './card.mjs';

// Mirrors adapters/teamflow/schema.py. The service is the enforcement;
// these exist so a typo is a message here rather than a 400 there.
export const ORDERS = ['priority', 'rank', 'age'];
export const TRACKERS = ['jira', 'linear', 'github'];
// `archived` is a run that is over and should stop being offered
// (MACLEOD-601): `teamflow tidy` writes it on an empty planning run
// nobody ever filled. Not `cancelled`, which says somebody decided
// against work they meant to do.
export const STATUSES = ['planning', 'running', 'blocked', 'done', 'cancelled', 'archived'];
export const TICKET_STATES = ['waiting', 'running', 'done', 'blocked', 'skipped', 'rework'];
// Where a ticket is in the cycle. Coarser than the stage the hooks
// report, on purpose: the board draws the stage from what it observed,
// and this is the run's own account of which gate the ticket is at.
export const CYCLES = ['build', 'test', 'audit', 'status', 'deploy', 'verified', 'rework'];

const NAME_MAX = 80;

export const USAGE = `teamflow workflow — the pool of tickets a run works through

  teamflow workflow create <name> [--tracker jira|linear|github] [--project <p>]
                                  [--state <s>] [--label <l>]
                                  [--order priority|rank|age] [--deploy]
                                  [--order-text <sentence>]
      Start a workflow. --order-text records what was asked for; it stays
      on this machine and is never published.

  teamflow workflow add <KEY> [--to <name>]
      Put a ticket in the pool by hand. This is the escape hatch for one
      the filter missed; the pool is what a run works from. An ad hoc key
      (ADHOC-<n>, from \`teamflow adhoc start\`) is an ordinary node here:
      added, levelled and depended on exactly like a ticket.

  teamflow workflow show [<name>]
      The plan: phases, tickets and what waits on what.

  teamflow workflow adopt [--yes <id>] [--from <bucket>]
      Workflows started before 0.3.14, when this machine filed them by
      tenant rather than by organisation, and which organisation each
      belongs to cannot be worked out from anything here. Lists them,
      naming the bucket each came from; --yes <id> copies one into this
      organisation, and --from picks between two buckets holding the
      same id. Local, nothing is sent, and the older copy is left
      exactly where it is.

  teamflow workflow status <planning|running|blocked|done|cancelled> [--to <name>]
      Move the whole workflow.

  teamflow workflow plan [--keys A,B,C] [--to <name>]
      Fill the pool. --keys is the selection in tracker priority order,
      which is what a session with the tracker's MCP passes in. Without
      it, and for a GitHub project, the selection is made here with the
      same call and the same ordering rule as \`teamflow next\`.

  teamflow workflow depends <KEY> --on <KEY> [--reason <why>]
                            [--found planning|build] [--to <name>]
      One ticket waits on another. Re-levels the phases, because an edge
      a team found mid-build moves tickets between them.

  teamflow workflow depends --batch [--found planning|build] [--to <name>]
      The whole graph at once, as JSON on stdin: an array of
      {"from","on","reason","found"}, or {"dependencies": [...]}. This is
      what planning uses — one call, one levelling, one report, instead of
      one subprocess per edge. A malformed entry refuses the batch.

  teamflow workflow ready [--to <name>]
      What the current phase has open. This is what a run starts next.

  teamflow workflow ticket <KEY> [--state <s>] [--cycle <c>] [--reason <why>] [--to <name>]
      Move one ticket through the cycle. States: waiting, running, done,
      blocked, skipped, rework. Cycle: build, test, audit, status,
      deploy, verified, rework. Publishes the ticket's own card as well
      as the run's record, and prints what the card AND the tracker now
      say.

  teamflow workflow reconcile [--dry-run]
      Every divergence between the runs, the cards, the executions and
      the trackers, and the repair for each. A phase is not finished,
      and a run cannot be declared done, while this list is non-empty.
      \`teamflow tidy\` is the same pass.`;

// A hyphen, not the underscore the wf_ shape suggests: the id becomes a
// path segment and adapters/teamflow/store.py allows no underscore in
// one. Getting this wrong is a 400 at the far end, so it is asserted.
export const ID = /^wf-[0-9a-f]{8,32}$/;

export function newId() {
  return `wf-${crypto.randomBytes(4).toString('hex')}`;
}

// Where the file is and how it is keyed belongs to core.mjs, because a
// hook reads it too and core is what a hook already imports. What goes
// in it belongs here.
export const statePath = workflowsPath;
export const load = readWorkflows;
export const save = writeWorkflows;

// Name or id, and the current one when neither is given. Names are what
// a person says ("add MACLEOD-540 to Backlog sweep"); ids are what the
// document is addressed by.
export function find(state, wanted) {
  if (!wanted) return state.workflows[state.current] || null;
  if (state.workflows[wanted]) return state.workflows[wanted];
  const want = String(wanted).trim().toLowerCase();
  return Object.values(state.workflows)
    .find((w) => String(w.name || '').toLowerCase() === want) || null;
}

// The single place that decides what leaves the machine.
//
// Structural rather than a flat set of key names, which is the whole
// difference between this and `sanitizePayload`: `reason` is allowed
// inside a dependency and nowhere else, and `order` is allowed inside
// a filter and nowhere else -- so the sentence the user typed cannot
// reach the wire by being spelled the same as a filter's ordering.
// Unknown fields are dropped rather than refused, for the same reason
// the service drops them: a reporter that grows a field must not be
// able to publish it by naming it something nobody has heard of.
//
// The caps mirror adapters/teamflow/schema.py. A sweep over this
// repository selects several hundred tickets, so a cap set for an
// issue report's evidence list would silently lose most of a pool.
export const CAPS = { tickets: 1000, dependencies: 2000, phases: 200 };

function pick(source, names) {
  const out = {};
  if (!source || typeof source !== 'object') return out;
  for (const name of names) {
    if (source[name] !== undefined && source[name] !== null) out[name] = source[name];
  }
  return out;
}

/**
 * One field of an owner, as the service will take it (MACLEOD-578, audit F6).
 *
 * The cap is not cosmetic. `ACTOR_MAX` is 80 characters on the wire and a git
 * `user.name` longer than that would have made every publish of that
 * workflow a 400 — a run that silently stops reaching the board, which is
 * the failure mode this whole ticket exists to remove. Sliced here the way
 * `report-cli.mjs` already slices an actor's name, and non-strings are
 * dropped rather than coerced: `String({})` is "[object Object]", which the
 * service would accept and a reader would not understand.
 */
const capped = (value) => (typeof value === 'string' ? value.trim().slice(0, 80) : '');

/**
 * The two fields, or nothing (audit F9).
 *
 * Half an owner is a lane with no label, and an owner whose id is an empty
 * string is worse than none: it reads as owned, so nothing ever fills it in.
 * Both or neither, at every door.
 */
function ownerFields(source) {
  // The service's alphabet for an owner's id, and it refuses the WHOLE
  // document over one that is not: an id written into workflows.json by
  // anything but `stated()` would make every later publish of that run a
  // 400. Not a slug is no owner, which `own()` then repairs.
  const id = /^[a-z0-9._-]{1,80}$/.test(capped(source?.id)) ? capped(source.id) : '';
  const displayName = capped(source?.displayName);
  return id && displayName ? { id, displayName } : undefined;
}

/**
 * Who this machine can honestly say is running a workflow (audit F4).
 *
 * Deliberately NOT `actor(config, info)`. That function falls back to
 * `os.userInfo().username` so that a report always has some actor, which is
 * right for a report — the board would otherwise lose the row entirely. As a
 * run's OWNER it is wrong: it puts the operating system login on a workflow
 * and re-creates the phantom person this ticket set out to remove. A stated
 * identity or nothing, and nothing is a workflow that can be owned later.
 */
export function stated(config = {}, info = {}) {
  const displayName = capped(config.actorName || info.name);
  if (!displayName) return undefined;
  const source = capped(config.actorId) || capped(info.email?.split('@')[0]) || displayName;
  const id = source.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return ownerFields({ id, displayName });
}

export function published(workflow) {
  const out = {
    id: workflow.id,
    name: workflow.name,
    status: workflow.status,
    tickets: (workflow.tickets || []).slice(0, CAPS.tickets).map(
      (t) => pick(t, ['key', 'rank', 'phase', 'state', 'cycle', 'addedBy', 'updatedAt'])),
    dependencies: (workflow.dependencies || []).slice(0, CAPS.dependencies).map(
      (d) => pick(d, ['from', 'on', 'reason', 'found'])),
    phases: (workflow.phases || []).slice(0, CAPS.phases).map((phase) => ({
      ...pick(phase, ['n', 'state']),
      tickets: (phase.tickets || []).slice(0, CAPS.tickets).map(String),
    })),
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
  /*
   * Who is running it (MACLEOD-578). The same two fields a report already
   * carries and no more: an id and the name to draw. A workflow's queued
   * tickets have nobody on them by definition -- nobody has touched the
   * code yet -- so without this the board had no answer but "Unassigned"
   * for every ticket of a run somebody is sitting in front of.
   *
   * Optional, because a document written before this change has no owner
   * and must go on validating.
   */
  const owner = ownerFields(workflow.actor);
  if (owner) out.actor = owner;
  const filter = pick(workflow.filter, ['tracker', 'project', 'state', 'label', 'order']);
  if (Object.keys(filter).length) out.filter = filter;
  if (workflow.scope) out.scope = pick(workflow.scope, ['deploy']);
  return out;
}

export async function publish(workflow, config, { flush = true } = {}) {
  /*
   * Through the organisation check, like every other publisher
   * (MACLEOD-586, MACLEOD-601 audit finding 3). This document is the
   * most identifying thing the plugin sends -- every ticket key in the
   * pool, the run's name, its phases and who is running it -- and it
   * is republished once per ticket that moves, and now unprompted by
   * reconciliation. It was going round the check entirely.
   */
  return sendReport('workflow', null, published(workflow), config, {
    account: reportScope(config), flush,
  });
}

function now() {
  return new Date().toISOString();
}

function flag(args, name) {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} needs a value`);
  }
  return value;
}

export function buildFilter(args) {
  const filter = {};
  for (const name of ['tracker', 'project', 'state', 'label', 'order']) {
    const value = flag(args, name);
    if (value !== undefined) filter[name] = value;
  }
  if (filter.tracker && !TRACKERS.includes(filter.tracker)) {
    throw new Error(`--tracker must be one of ${TRACKERS.join(', ')}`);
  }
  if (filter.order && !ORDERS.includes(filter.order)) {
    throw new Error(`--order must be one of ${ORDERS.join(', ')}`);
  }
  return filter;
}

/**
 * Stamp the owner on a running workflow that has none (MACLEOD-578).
 *
 * Written once and never overwritten: a run started on one machine and
 * moved on by a teammate's `teamflow workflow status` stays the first
 * person's, which is what "a running workflow's tickets are its owner's"
 * means. It is also how a workflow created before this change gains an
 * owner -- the next command that publishes it stamps it.
 *
 * Running only (audit F8). A planned run is a draft and a finished one is
 * history; putting whoever happened to type `teamflow workflow show` on
 * either of them would write an owner into somebody else's record of what
 * was done, and the board attributes nothing from them anyway.
 */
export function own(workflow, config, info) {
  if (!workflow) return workflow;
  if (ownerFields(workflow.actor)) return workflow;
  if (workflow.status !== 'running') return workflow;
  const owner = stated(config || {}, info || {});
  if (owner) workflow.actor = owner;
  return workflow;
}

export function create(name, args, state, owner) {
  const clean = String(name || '').trim();
  if (!clean) throw new Error('Usage: teamflow workflow create <name>');
  if (clean.length > NAME_MAX) {
    throw new Error(`A workflow name is at most ${NAME_MAX} characters`);
  }
  if (find(state, clean)) throw new Error(`A workflow called "${clean}" already exists`);
  const at = now();
  const workflow = {
    id: newId(),
    name: clean,
    status: 'planning',
    filter: buildFilter(args),
    scope: { deploy: args.includes('--deploy') },
    tickets: [],
    dependencies: [],
    phases: [],
    createdAt: at,
    updatedAt: at,
  };
  const stamped = ownerFields(owner);
  if (stamped) workflow.actor = stamped;
  // Local only. Never copied into `published`.
  const order = flag(args, 'order-text');
  if (order) workflow.order = order;
  state.workflows[workflow.id] = workflow;
  state.current = workflow.id;
  return workflow;
}

export function add(workflow, key) {
  const clean = String(key || '').trim();
  if (!clean) throw new Error('Usage: teamflow workflow add <KEY>');
  if ((workflow.tickets || []).some((t) => t.key === clean)) {
    throw new Error(`${clean} is already in "${workflow.name}"`);
  }
  const ticket = {
    key: clean,
    rank: (workflow.tickets || []).length + 1,
    state: 'waiting',
    addedBy: 'manual',
    updatedAt: now(),
  };
  workflow.tickets = [...(workflow.tickets || []), ticket];
  workflow.updatedAt = ticket.updatedAt;
  return ticket;
}

/**
 * Move one ticket through the cycle.
 *
 * The run's own record, kept beside the stages the hooks report rather
 * than derived from them: a hook says a test command ran, and only the
 * run knows whether that was this ticket's test gate or a team checking
 * something on the way past.
 */
export function move(workflow, key, { state, cycle } = {}) {
  const ticket = (workflow.tickets || []).find((t) => t.key === String(key || '').trim());
  if (!ticket) throw new Error(`${key} is not in "${workflow.name}"`);
  if (state !== undefined) {
    if (!TICKET_STATES.includes(state)) {
      throw new Error(`A ticket state is one of ${TICKET_STATES.join(', ')}`);
    }
    ticket.state = state;
  }
  if (cycle !== undefined) {
    if (!CYCLES.includes(cycle)) {
      throw new Error(`A cycle step is one of ${CYCLES.join(', ')}`);
    }
    ticket.cycle = cycle;
  }
  ticket.updatedAt = new Date().toISOString();
  // Phase states are derived from their tickets, so moving one ticket
  // is what finishes a phase and lets the next one start.
  relevel(workflow);
  return ticket;
}

// --- a gate's verdict, on the ticket ---------------------------------
//
// The hooks report a rework when a command fails: a test run that exits
// non-zero, an audit script that does. A gate held by a REVIEWER has no
// command to fail. An auditor reads a diff and answers "rejected", the
// orchestrator sends the ticket back, and until this existed the only
// place that was written down was the workflow's own list -- so the
// board showed a ticket sitting quietly at Local Test while the most
// important thing that had happened to it all day, that it had been
// turned away, was drawn nowhere (MACLEOD-579).
//
// So sending a ticket back says so on the ticket, as the same runtime
// sidecar a background reporter writes: a failed execution at the gate
// that refused it. The dashboard already draws a failed execution at a
// later stage as the loop back from that gate, with its reason, and
// already clears it when the same gate is reached again -- which is the
// second half of this: when the reworked ticket is put back at the gate
// that refused it the same sidecar is written as running, and when it
// leaves that gate for a later one, as passed.
//
// Derived state only. The reason is the orchestrator's own sentence
// about the verdict -- which gate, how many findings of what weight --
// never the findings' text, which quotes code.

const GATES = {
  test: { slot: 'ci', kind: 'test', stage: 'LOCAL_TEST', label: 'Test gate' },
  audit: { slot: 'audit-local', kind: 'audit', stage: 'LOCAL_AUDIT', label: 'Audit gate' },
  deploy: { slot: 'deploy', kind: 'deploy', stage: 'DEPLOY_DEV', label: 'Deploy gate' },
};

/** Cycles in the order a ticket passes through them. */
const CYCLE_ORDER = ['build', 'test', 'audit', 'status', 'deploy', 'verified'];

/**
 * What each gate's verdict IS, read off the ticket as it stands now.
 *
 * The whole of MACLEOD-593 is here. The first version of this decided a
 * gate's status from a TRANSITION and from `refusedAt`, a marker kept in
 * the local workflow file: lose the marker -- a store keyed two ways
 * (MACLEOD-583), a restored backup, a second machine, a run adopted into
 * another scope -- and the write that would have cleared the chip never
 * happened, so a gate stayed lit `running` or `failed` on a ticket that
 * had been done for hours. Nothing ever revisited it, and the owner read
 * the board and asked why CI was stalled.
 *
 * A verdict nothing revisits is a verdict that can only be wrong, so the
 * status is derived rather than remembered: a ticket past a gate has
 * passed it, one sent back at it has failed it, one standing at it is
 * running it, and one that has not reached it has no verdict at all. No
 * local state is consulted, so no local state can be lost.
 */
function gateStatuses(ticket) {
  const at = CYCLE_ORDER.indexOf(ticket.cycle);
  const out = {};
  for (const cycle of Object.keys(GATES)) {
    const index = CYCLE_ORDER.indexOf(cycle);
    // `done` is past every gate, whatever cycle it stopped at: a ticket
    // cannot be finished with a gate still to pass.
    if (ticket.state === 'done' || (at >= 0 && at > index)) out[cycle] = 'success';
    else if (at === index && ticket.state === 'rework') out[cycle] = 'failed';
    else if (at === index && ticket.state === 'running') out[cycle] = 'running';
  }
  return out;
}

/**
 * The sidecars a ticket's gates want written, and none it does not.
 *
 * `ticket.gates` is what was last SAID, and it is a hint and nothing
 * more: it keeps a command that changed nothing from writing three
 * reports, and losing it costs one extra write rather than a chip lit
 * for ever. That is the difference this ticket is about -- the old
 * marker was the only source of truth, and this one is an optimisation
 * over a truth that is recomputed every time.
 *
 * A gate the ticket has not reached is left alone rather than cleared:
 * `wanted` says nothing about it, and a verdict already on the board
 * (a ticket sent back from audit all the way to build) is still true.
 */
export function gateReports(workflow, ticket, { reason, at = now() } = {}) {
  const told = (ticket.gates && typeof ticket.gates === 'object') ? ticket.gates : {};
  const wanted = gateStatuses(ticket);
  const out = [];

  for (const [cycle, status] of Object.entries(wanted)) {
    if (told[cycle] === status) continue;
    const gate = GATES[cycle];
    const was = told[cycle];
    const summary = status === 'failed'
      ? (reason || `${gate.label} sent this back`)
      : status === 'running'
        ? (was === 'failed'
          ? `Back at the ${gate.label.toLowerCase()} after rework`
          : `${gate.label} running`)
        : `${gate.label} passed${was === 'failed' ? ' on the way back' : ''}`;
    out.push({
      slot: gate.slot,
      cycle,
      payload: {
        jiraKey: ticket.key,
        slot: gate.slot,
        // One id per gate per workflow, so a pass replaces the refusal it
        // answers instead of sitting beside it. A sidecar lives at
        // `runtime/<key>/<slot>.json`, so two tickets sharing an id are
        // two separate files and neither stands on the other.
        id: `${workflow.id}-${gate.slot}`.slice(0, 120),
        kind: gate.kind,
        label: gate.label,
        stage: gate.stage,
        status,
        summary: String(summary).slice(0, 180),
        updatedAt: at,
      },
    });
  }

  return out;
}

/**
 * Remember that the board has been told, so the next command is quiet.
 *
 * Recorded by whoever SENT it and only once the report will land, which
 * is the half of this that is easy to get wrong: a hint written for a
 * report that failed is the original bug again with a new name -- the
 * board would be wrong and every later command would believe it had
 * already put it right. A report the outbox has queued counts as sent,
 * because it will go.
 */
export function gateSaid(ticket, verdict) {
  ticket.gates = { ...(ticket.gates || {}), [verdict.cycle]: verdict.payload.status };
}

// --- the ticket's own card, and the end of the run --------------------
//
// MACLEOD-601. The gate chips above are the run's verdict about a
// GATE; this is the run's verdict about the TICKET, which nothing
// published at all. The merge and the deploy happen in the
// orchestrator's session, bound to some other key, so the card kept
// whatever stage the last hook in some team's worktree had left on it.

/**
 * Remember that the card has been told, exactly as `gateSaid` does.
 *
 * A hint and nothing more, for the same reason: it keeps a command that
 * changed nothing from republishing, and losing it costs one extra
 * write rather than a card stuck for ever. The truth is recomputed from
 * `cardFor(ticket)` every time.
 */
export function cardSaid(ticket, card) {
  ticket.card = { stage: card.stage, status: card.status };
}

/** Whether the board already says what the ticket says. */
export function cardOwed(ticket) {
  const want = cardFor(ticket);
  if (!want) return undefined;
  const told = ticket.card;
  if (told && told.stage === want.stage && told.status === want.status) return undefined;
  return want;
}

/** What the run still has open: nothing done, skipped or cancelled out. */
export function openTickets(workflow) {
  return (workflow.tickets || []).filter((t) => t.state !== 'done' && t.state !== 'skipped');
}

/**
 * A run with nothing open finishes itself.
 *
 * "The last ticket verified finishes the run." A run left `running`
 * with nothing to do sits on the board and in every picker for ever,
 * and nothing was ever going to move it: the orchestrator's last act is
 * closing the last ticket, and the step after that is the one it is
 * most likely to be interrupted before reaching.
 *
 * Only from `running`. A `planning` run with no tickets has not
 * finished, it has not started; `blocked` and `cancelled` are
 * somebody's decision and not this function's to overturn.
 */
export function finishRun(workflow) {
  if (!workflow || workflow.status !== 'running') return false;
  if (!(workflow.tickets || []).length) return false;
  if (openTickets(workflow).length) return false;
  workflow.status = 'done';
  workflow.updatedAt = now();
  return true;
}

/**
 * Close every actor on this machine still working on a finished ticket.
 *
 * Widening MACLEOD-574's pending-end mechanism rather than building a
 * second one: the flag is set here and the existing bounded, fail-open
 * `flushPendingEnds` is what delivers it, so a send that does not land
 * leaves the end owed exactly as it already does.
 *
 * The run knows something the actor does not. An agent whose worktree
 * was removed or whose process was killed never sends `SubagentStop`
 * and never reaches `SessionEnd`, so it stands at `running` and the
 * lane counts it; the ticket being over is the only evidence anywhere
 * that it is not.
 */
export function closeActors(key, config = {}, at = now()) {
  let closed = 0;
  for (const state of actorsForKey(key, config)) {
    if (state.ended && state.status !== 'running') continue;
    saveSession({
      ...state,
      ended: true,
      status: state.status === 'running' ? 'idle' : state.status,
      agent: state.agent ? { ...state.agent, endedAt: state.agent.endedAt || at } : state.agent,
      // Carried by the next publish anything on this machine makes,
      // which is the same path a killed session's ends already take.
      pendingEnd: Boolean(state.binding?.key),
      updatedAt: at,
    });
    closed += 1;
  }
  return closed;
}

// --- printing --------------------------------------------------------

function line(ticket, workflow) {
  const waits = (workflow.dependencies || [])
    .filter((d) => d.from === ticket.key)
    .map((d) => d.on);
  const where = ticket.cycle ? `${ticket.state}/${ticket.cycle}` : ticket.state;
  const on = waits.length ? `  waits on ${waits.join(', ')}` : '';
  return `    ${String(ticket.rank).padStart(3)}. ${ticket.key}  ${where}${on}`;
}

export function render(workflow, state) {
  const out = [];
  const pool = workflow.tickets || [];
  const filter = Object.entries(workflow.filter || {})
    .map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
  out.push(`${workflow.name} (${workflow.id}) — ${workflow.status}`);
  out.push(`  filter: ${filter}`);
  out.push(`  deploy in scope: ${workflow.scope?.deploy ? 'yes' : 'no'}`);
  if (workflow.order) out.push(`  asked for: ${workflow.order}   (stays on this machine)`);
  if (!pool.length) {
    out.push('  pool: empty. Plan it, or `teamflow workflow add <KEY>`.');
  } else if (!(workflow.phases || []).length) {
    out.push(`  pool: ${pool.length} tickets, not yet levelled into phases`);
    for (const ticket of pool) out.push(line(ticket, workflow));
  } else {
    for (const phase of workflow.phases) {
      out.push(`  phase ${phase.n} — ${phase.state}`);
      for (const key of phase.tickets) {
        const ticket = pool.find((t) => t.key === key);
        if (ticket) out.push(line(ticket, workflow));
      }
    }
  }
  const found = (workflow.dependencies || []).filter((d) => d.found === 'build');
  if (found.length) {
    out.push('  found while building:');
    for (const d of found) out.push(`    ${d.from} waits on ${d.on}${d.reason ? ` — ${d.reason}` : ''}`);
  }
  // Archived runs leave the pickers (MACLEOD-601). They stay readable
  // by name and by id -- nothing is destroyed -- but a listing that
  // offered 144 empty runs nobody ever filled is a listing nobody reads.
  const others = Object.values(state.workflows)
    .filter((w) => w.id !== workflow.id && w.status !== 'archived');
  if (others.length) {
    out.push(`  other workflows: ${others.map((w) => w.name).join(', ')}`);
  }
  return out.join('\n');
}

// --- the command -----------------------------------------------------

/**
 * The edges a batch was given, off stdin.
 *
 * Not argv: a sweep over this repository is a couple of hundred edges with
 * a sentence on each, which is past what a shell will hand a process, and
 * quoting those sentences on a command line is a way to lose one.
 */
async function readJson(stream) {
  let text = '';
  for await (const chunk of stream) text += chunk;
  if (!text.trim()) throw new Error('--batch reads the edges as JSON on stdin, and nothing arrived.');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`--batch could not read the JSON on stdin: ${error.message}`);
  }
}

export async function main(args, {
  config = {}, info = {}, stdin = process.stdin,
  print = (s) => process.stdout.write(`${s}\n`),
} = {}) {
  const [sub = 'show', ...rest] = args;
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    print(USAGE);
    return 0;
  }

  const state = load(config);

  if (sub === 'create') {
    const name = rest.filter((a) => !a.startsWith('--'))[0];
    const workflow = create(name, rest, state, stated(config, info));
    save(state, config);
    const sent = await publish(workflow, config);
    print(`TeamFlow started workflow "${workflow.name}" (${workflow.id}).`);
    // A refusal and a queued retry are different facts and a run needs
    // to know which it got: a 400 from a service that has never heard
    // of this document kind will never succeed on its own, and telling
    // somebody it will be sent later would leave them waiting for it.
    print(sent.ok ? 'It is on the board. Plan it, or add tickets by hand.'
      : sent.queued ? `It is on this machine and queued: ${sent.reason || 'the service did not answer'}.`
        : `It is on this machine only. The service refused it: ${sent.reason || 'no reason given'}.`);
    return 0;
  }

  /*
   * Workflows this machine holds under a pre-0.3.14 key (MACLEOD-583).
   *
   * Before 0.3.14 a run was filed by tenant, which is `default` on
   * every service install and therefore the same bucket for every
   * organisation a person holds a seat on. Nothing on the machine
   * records which organisation started one, and every way of guessing
   * turned out to answer in favour of whoever is signed in now — so it
   * is said out loud and claimed by hand, and until then this
   * organisation simply does not have it.
   */
  if (sub === 'adopt') {
    const offered = unclaimedWorkflows(config);
    const wanted = flag(rest, 'yes');
    if (!offered.length) {
      print('Nothing to adopt: every workflow on this machine already belongs to an organisation.');
      return 0;
    }
    if (!wanted) {
      print('Workflows from before 0.3.14 are on this machine. Which organisation each belongs to '
        + 'is not recorded anywhere, so nothing is claimed until you say so:');
      for (const row of offered) {
        // The bucket is named on every row, not only when it matters:
        // two `TEAMFLOW_TENANT_ID` values on one machine can hold the
        // same id, and a listing that hid where each came from would
        // make the pair indistinguishable.
        print(`  ${row.id}  ${row.name}  ${row.tickets} ticket${row.tickets === 1 ? '' : 's'}`
          + `${row.status ? `, ${row.status}` : ''}  [${row.from}]`);
      }
      print('Adopt one with `teamflow workflow adopt --yes <id>`. It is copied, not moved: an older '
        + 'copy of the plugin on this machine goes on reading its own.');
      return 0;
    }
    const from = flag(rest, 'from');
    const matching = offered.filter((row) => row.id === wanted && (!from || row.from === from));
    if (matching.length > 1) {
      print(`Two workflows on this machine are called ${wanted}, in ${matching.map((r) => r.from).join(' and ')}. `
        + `Say which: \`teamflow workflow adopt --yes ${wanted} --from ${matching[0].from}\`.`);
      return 1;
    }
    const taken = adoptWorkflow(wanted, config, { from });
    if (!taken) {
      print(`No workflow ${wanted}${from ? ` in ${from}` : ''} to adopt. `
        + '`teamflow workflow adopt` lists what there is.');
      return 1;
    }
    print(`TeamFlow adopted "${taken.name}" (${taken.id}) into this organisation. `
      + 'Nothing was sent and nothing was removed.');
    return 0;
  }

  /*
   * The whole pass, on demand (MACLEOD-601). Before the workflow is
   * resolved, because reconciling is about every run this organisation
   * holds and not about whichever one is current — the 144 empty runs
   * and the 31 stale cards were spread over all of them, and a repair
   * that only ever looked at the current run would have found four.
   *
   * Dynamically imported: reconcile.mjs reads this module's own
   * `cardOwed` and `publish`, and a static import here would be a cycle
   * evaluated in whichever order the entry point happened to choose.
   */
  if (sub === 'reconcile') {
    const { reconcile, renderPass } = await import('./reconcile.mjs');
    const { FULL } = await import('./reconcile.mjs');
    const pass = await reconcile(config, {
      dryRun: rest.includes('--dry-run'),
      deep: true,
      limit: FULL,
      announce: (lines) => { for (const line of lines) print(line); },
    });
    print(renderPass(pass));
    return 0;
  }

  const target = find(state, flag(rest, 'to'));
  if (!target) {
    if (Object.keys(state.workflows).length) {
      print('No workflow chosen. Name one with --to, or `teamflow workflow show <name>`.');
      return 0;
    }
    print('No workflow yet. Start one with `teamflow workflow create <name>`.');
    // One line, and only when there is something to say: a run from
    // before 0.3.14 reads as "no workflow yet" otherwise, which is how
    // the owner's nineteen-ticket run appeared to vanish.
    if (unclaimedWorkflows(config).length) {
      print('A workflow from before 0.3.14 is on this machine. If it is this organisation\'s, '
        + 'run `teamflow workflow adopt`.');
    }
    return 0;
  }
  // A workflow from before MACLEOD-578 has no owner. The first command
  // that touches it gives it one rather than leaving its tickets
  // permanently nobody's.
  own(target, config, info);

  if (sub === 'add') {
    const key = rest.filter((a) => !a.startsWith('--'))[0];
    const ticket = add(target, key);
    save(state, config);
    await publish(target, config);
    print(`TeamFlow put ${ticket.key} in "${target.name}" at rank ${ticket.rank}.`);
    return 0;
  }

  if (sub === 'status') {
    const wanted = rest.filter((a) => !a.startsWith('--'))[0];
    if (!STATUSES.includes(wanted)) {
      throw new Error(`A workflow status is one of ${STATUSES.join(', ')}`);
    }
    target.status = wanted;
    // Owned again here: the call above ran while this was still a draft,
    // so a run that goes live in this command would publish ownerless once.
    own(target, config, info);
    target.updatedAt = now();
    save(state, config);
    await publish(target, config);
    print(`"${target.name}" is ${wanted}.`);
    return 0;
  }

  if (sub === 'plan') {
    const listed = flag(rest, 'keys');
    let keys = listed ? listed.split(',').map((k) => k.trim()).filter(Boolean) : null;
    if (!keys) {
      // Same split as `teamflow next`: GitHub is a credential the
      // developer already has, and Linear and Jira are read through the
      // MCP tools the session holds and the CLI cannot reach. Asking
      // for a tracker token here would put a second credential on every
      // machine to answer a question the session can already answer.
      const tracker = target.filter?.tracker || trackerOf(config);
      const repo = resolveGithubRepo(config, info);
      if (tracker !== 'github' || !repo) {
        print(`TeamFlow cannot select ${tracker} tickets from the command line. `
          + 'List them in the session with the tracker\'s MCP, in priority order, '
          + 'then pass them: `teamflow workflow plan --keys KEY-1,KEY-2,...`.');
        return 0;
      }
      const { ghIssues, orderIssues } = await import('./next.mjs');
      const got = ghIssues(repo);
      if (!got.ok) {
        print(`TeamFlow could not list ${repo}: ${got.reason}`);
        return 0;
      }
      keys = orderIssues(got.issues).map((i) => `${repo}#${i.number}`);
    }
    const before = (target.tickets || []).length;
    seed(target, keys);
    if (target.status === 'planning' && target.tickets.length) target.status = 'running';
    own(target, config, info);
    save(state, config);
    await publish(target, config);
    print(`TeamFlow put ${target.tickets.length - before} tickets in "${target.name}" `
      + `across ${target.phases.length} phase${target.phases.length === 1 ? '' : 's'}.`);
    print(render(target, state));
    return 0;
  }

  if (sub === 'depends') {
    if (rest.includes('--batch')) {
      const edges = dependsBatch(target, await readJson(stdin), { found: flag(rest, 'found') });
      save(state, config);
      await publish(target, config);
      print(`TeamFlow recorded ${edges.length} dependenc${edges.length === 1 ? 'y' : 'ies'} `
        + `in "${target.name}", now ${target.phases.length} phase`
        + `${target.phases.length === 1 ? '' : 's'}.`);
      print(render(target, state));
      return 0;
    }
    const positional = rest.filter((a) => !a.startsWith('--'));
    const edge = depends(target, positional[0], flag(rest, 'on'), {
      reason: flag(rest, 'reason'),
      found: flag(rest, 'found') || 'planning',
    });
    save(state, config);
    await publish(target, config);
    print(`${edge.from} waits on ${edge.on}${edge.reason ? ` — ${edge.reason}` : ''}.`);
    print(`"${target.name}" is now ${target.phases.length} phase`
      + `${target.phases.length === 1 ? '' : 's'}.`);
    return 0;
  }

  if (sub === 'level') {
    relevel(target);
    save(state, config);
    await publish(target, config);
    print(render(target, state));
    return 0;
  }

  if (sub === 'ready') {
    const open = ready(target);
    if (!open.phase) {
      print(`"${target.name}" has nothing left to start.`);
      return 0;
    }
    if (!open.tickets.length) {
      print(`Phase ${open.phase.n} of "${target.name}" is ${open.phase.state}; `
        + 'nothing in it is waiting to start.');
      return 0;
    }
    print(`Phase ${open.phase.n} of "${target.name}" has `
      + `${open.tickets.length} ready: ${open.tickets.map((t) => t.key).join(', ')}`);
    return 0;
  }

  if (sub === 'ticket') {
    const key = rest.filter((a) => !a.startsWith('--'))[0];
    const ticket = move(target, key, {
      state: flag(rest, 'state'), cycle: flag(rest, 'cycle'),
    });
    const said = gateReports(target, ticket, { reason: flag(rest, 'reason') });
    /*
     * And every OTHER ticket in the pool (MACLEOD-593). This is the
     * revisiting: a gate chip is only ever as true as the last write,
     * and the ticket it is on may never move again, so any command
     * puts the whole pool's gates right rather than only the one just
     * touched. It is cheap because `gateReports` writes nothing where
     * the board already says what the ticket says -- in the ordinary
     * case this loop sends nothing at all -- and it is what repairs a
     * board after a marker was lost, without anybody noticing it was.
     */
    const repaired = (target.tickets || [])
      .filter((t) => t !== ticket)
      .flatMap((t) => gateReports(target, t).map((verdict) => ({ on: t, verdict })));
    save(state, config);
    await publish(target, config);
    // After the workflow, so a board that draws the loop already knows
    // the ticket is in rework. Never fatal: the plan is saved either way.
    const send = async (on, verdict) => {
      // Keyed sidecars, up to thirteen of them per command, through the
      // organisation check like everything else (audit finding 3).
      const sent = await sendReport('runtime', verdict.slot, verdict.payload, config,
        { account: reportScope(config) })
        .catch(() => ({ ok: false }));
      // Queued counts: the outbox will deliver it. Anything else and the
      // hint is not written, so the next command says it again.
      if (sent.ok || sent.queued) gateSaid(on, verdict);
      return sent;
    };
    for (const verdict of said) {
      const sent = await send(ticket, verdict);
      print(sent.ok
        ? `${ticket.key}: the ${verdict.payload.label.toLowerCase()} is on the board as ${verdict.payload.status}.`
        : `${ticket.key}: the ${verdict.payload.label.toLowerCase()} could not be sent to the board${sent.queued ? '; it is queued' : ''}.`);
    }
    /*
     * A dozen at a time, and not one more after the first that does not
     * land. A repair is never urgent -- the next command does the rest --
     * and a command that sits through forty timeouts because the service
     * is unreachable has turned a quiet correction into the slowest thing
     * on the machine.
     */
    let put = 0;
    for (const { on, verdict } of repaired.slice(0, 12)) {
      const sent = await send(on, verdict);
      if (!sent.ok && !sent.queued) break;
      put += 1;
    }
    if (put) print(`Put ${put} gate ${put === 1 ? 'verdict' : 'verdicts'} on other tickets right.`);

    /*
     * And the ticket's own card (MACLEOD-601). The gate chips above say
     * what happened at a GATE; this says where the ticket now is, which
     * is what the board actually draws and what nothing published. The
     * merge and the deploy happen in this session, bound to some other
     * key, so without this the card keeps whatever stage the last hook
     * in some team's worktree left on it -- 31 of them did.
     */
    const card = cardFor(ticket);
    if (card) {
      const sent = await publishCard(ticket.key, card, { workflow: target, config, info })
        .catch(() => ({ ok: false }));
      if (sent.ok || sent.queued) cardSaid(ticket, card);
      /*
       * Done means done everywhere on this machine too. An agent whose
       * worktree was removed never sent a `SubagentStop`, so it stands
       * at `running` on a ticket the run has finished; the run knowing
       * the ticket is over is the only evidence anywhere that it is not.
       */
      if (ticket.state === 'done') {
        const closed = closeActors(ticket.key, config);
        if (closed) {
          const { flushPendingEnds } = await import('./hook-core.mjs');
          await flushPendingEnds(config, closed).catch(() => 0);
          print(`Closed ${closed} run${closed === 1 ? '' : 's'} still open on ${ticket.key}.`);
        }
      }
      if (!sent.ok && !sent.queued) {
        print(`${ticket.key}: the card could not be sent to the board`
          + `${sent.reason ? `: ${sent.reason}` : '.'}`);
      }
    }
    // Again, because what the board has been told is part of the plan now.
    save(state, config);

    /*
     * The last ticket verified finishes the run. Before the line below,
     * so what is printed is the run as it now stands rather than as it
     * was a moment ago.
     */
    if (finishRun(target)) {
      save(state, config);
      await publish(target, config);
      print(`"${target.name}" has nothing open left; the run is done.`);
    }

    const open = ready(target);
    print(`${ticket.key} is ${ticket.state}${ticket.cycle ? ` at ${ticket.cycle}` : ''}.`);
    /*
     * And the one line that says what the card AND the tracker now say.
     *
     * Two reads of this organisation's own state, after the report so
     * the answer is the one the report produced. It is the step the
     * build skill is about to be told to read instead of remembering to
     * move the tracker by hand, so it never claims a ticket is closed
     * everywhere when it is not: where the tracker is behind it names
     * the reason and what to do about it.
     */
    if (card) {
      const tracker = await readTracker(ticket.key, config).catch(() => ({ known: false }));
      const writeBack = tracker.connected
        ? await readWriteBack(config).catch(() => ({ known: false }))
        : { known: false };
      print(cardLine(ticket.key, card, tracker, writeBack));
    }
    print(open.phase
      ? `Phase ${open.phase.n} is ${open.phase.state}; ready: ${open.tickets.map((t) => t.key).join(', ') || 'nothing'}.`
      : 'Every phase is done.');
    return 0;
  }

  if (sub === 'show') {
    const named = find(state, rest.filter((a) => !a.startsWith('--'))[0]) || target;
    print(render(named, state));
    return 0;
  }

  throw new Error(`Unknown workflow command: ${sub}\n\n${USAGE}`);
}

export default main;

// --- the plan ----------------------------------------------------------
//
// Selection, dependency discovery and phase levelling (MACLEOD-543).
//
// The split between what the model decides and what code decides runs
// straight through the middle of this section. Reading two tickets and
// judging that one needs the other is a judgment call and belongs to
// the model, which calls `depends` with what it concluded. Turning a
// set of edges into phases is a topological sort, which is arithmetic
// and belongs here, where it can be tested and cannot be talked into a
// different answer.

/**
 * The pool, levelled into phases.
 *
 * A phase is every ticket whose dependencies are all already placed.
 * Rank order is preserved inside a phase, so a phase that fans out to
 * several teams still starts with the most important ticket.
 *
 * Two edges are deliberately not gates.
 *
 * An edge pointing outside the pool is recorded and shown, never
 * levelled on. The pool is what the run works from; a dependency on
 * something the filter did not select is information for a person --
 * it is what the manual add exists to resolve -- and treating it as a
 * gate would freeze a run with no way to unfreeze it from inside.
 *
 * A cycle cannot be levelled at all, so the tickets in it go into one
 * final blocked phase rather than looping here forever. A run that
 * reaches a blocked phase has something for a person to untangle.
 */
export function levelPhases(tickets = [], dependencies = []) {
  const pool = new Set(tickets.map((t) => t.key));
  const waits = new Map(tickets.map((t) => [t.key, new Set()]));
  for (const edge of dependencies) {
    if (pool.has(edge.from) && pool.has(edge.on) && edge.from !== edge.on) {
      waits.get(edge.from).add(edge.on);
    }
  }
  const placed = new Set();
  const phases = [];
  let left = tickets.map((t) => t.key);
  while (left.length) {
    const now = left.filter((key) => [...waits.get(key)].every((on) => placed.has(on)));
    if (!now.length) {
      phases.push({ n: phases.length + 1, state: 'blocked', tickets: left.slice() });
      break;
    }
    phases.push({ n: phases.length + 1, state: 'waiting', tickets: now });
    for (const key of now) placed.add(key);
    left = left.filter((key) => !placed.has(key));
  }
  return phases;
}

/** A phase is where its tickets are, so re-levelling never loses a run. */
export function phaseState(phase, tickets = []) {
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const states = (phase.tickets || []).map((k) => byKey.get(k)?.state || 'waiting');
  if (!states.length) return 'waiting';
  if (states.every((s) => s === 'done' || s === 'skipped')) return 'done';
  if (states.includes('running')) return 'running';
  if (states.includes('blocked')) return 'blocked';
  return 'waiting';
}

/**
 * Re-level the workflow in place.
 *
 * Called after every change to the pool or the edges, because an edge a
 * team found mid-build moves tickets between phases and a plan that
 * only levelled once would be wrong from that moment on.
 */
export function relevel(workflow) {
  const tickets = workflow.tickets || [];
  const phases = levelPhases(tickets, workflow.dependencies || []);
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  for (const phase of phases) {
    phase.state = phaseState(phase, tickets);
    for (const key of phase.tickets) {
      const ticket = byKey.get(key);
      if (ticket) ticket.phase = phase.n;
    }
  }
  workflow.phases = phases;
  workflow.updatedAt = new Date().toISOString();
  return phases;
}

/**
 * What a run may start now: the current phase's unfinished tickets.
 *
 * The current phase is the first that is not done. Nothing later starts
 * early, which is the whole point of phases, and a blocked or already
 * running ticket is not offered again.
 */
export function ready(workflow) {
  const tickets = workflow.tickets || [];
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const phase = (workflow.phases || []).find((p) => phaseState(p, tickets) !== 'done');
  if (!phase) return { phase: null, tickets: [] };
  const open = phase.tickets
    .map((k) => byKey.get(k))
    .filter((t) => t && (t.state === 'waiting' || t.state === 'rework'));
  return { phase, tickets: open };
}

/** Put the selected tickets in the pool, in the order they were given. */
export function seed(workflow, keys = []) {
  const already = new Set((workflow.tickets || []).map((t) => t.key));
  const at = new Date().toISOString();
  let rank = (workflow.tickets || []).length;
  for (const raw of keys) {
    const key = String(raw || '').trim();
    if (!key || already.has(key)) continue;
    already.add(key);
    rank += 1;
    workflow.tickets.push({ key, rank, state: 'waiting', addedBy: 'filter', updatedAt: at });
  }
  relevel(workflow);
  return workflow.tickets;
}

/**
 * Record one edge, without re-levelling.
 *
 * A node id is a string and nothing more. Today every one of them is a
 * tracker key because that is all the pool can hold, but ad hoc work
 * (MACLEOD-556) is a subject with no key and has to be able to be a node
 * here without widening anything. The one place that assumes otherwise is
 * the `_key` check in `adapters/teamflow/schema.py`, which is deliberately
 * left as it is: widening the service's allowlist before the ad hoc subject
 * exists would accept ids nothing can draw.
 */
function recordEdge(workflow, from, on, { reason, found = 'planning' } = {}) {
  const a = String(from || '').trim();
  const b = String(on || '').trim();
  if (!a || !b) throw new Error('Usage: teamflow workflow depends <KEY> --on <KEY>');
  if (a === b) throw new Error(`${a} cannot wait on itself`);
  if (!['planning', 'build'].includes(found)) {
    throw new Error('--found must be planning or build');
  }
  const edges = workflow.dependencies || [];
  const existing = edges.find((d) => d.from === a && d.on === b);
  const edge = existing || { from: a, on: b, found };
  if (reason) edge.reason = String(reason).slice(0, 180);
  edge.found = found;
  if (!existing) edges.push(edge);
  workflow.dependencies = edges;
  return edge;
}

/** Record that one ticket waits on another. */
export function depends(workflow, from, on, options = {}) {
  const edge = recordEdge(workflow, from, on, options);
  relevel(workflow);
  return edge;
}

/**
 * Record the whole graph in one call.
 *
 * `depends` is the single edge a team found mid-build. This is planning's
 * shape: the model reads the pool, decides every edge in it, and records
 * them together. A sixty-ticket pool has a couple of hundred edges, and one
 * subprocess each would be a couple of hundred process starts, two hundred
 * topological sorts and two hundred reports of a document that was wrong in
 * between. Here it is one of each.
 *
 * All or nothing. A half-applied graph is a plan that levels into phases
 * nobody decided, so a malformed entry refuses the batch and names its
 * index rather than leaving the pool in a state the caller did not ask for.
 */
export function dependsBatch(workflow, entries, { found } = {}) {
  const list = Array.isArray(entries) ? entries
    : Array.isArray(entries?.dependencies) ? entries.dependencies
      : null;
  if (!list) {
    throw new Error('A batch is a JSON array of edges, or an object with a "dependencies" array.');
  }
  const already = (workflow.dependencies || []).length;
  if (already + list.length > CAPS.dependencies) {
    // The service caps this list and `published` truncates to the same
    // number. Refusing is the honest answer: a silently trimmed graph
    // levels into phases that are missing gates nobody can see are gone.
    throw new Error(`A workflow holds at most ${CAPS.dependencies} dependencies; `
      + `this batch would make ${already + list.length}.`);
  }
  // Validated in full before anything is written.
  const wanted = list.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Edge ${index + 1} is not an object.`);
    }
    const from = String(entry.from ?? '').trim();
    const on = String(entry.on ?? '').trim();
    if (!from || !on) throw new Error(`Edge ${index + 1} needs both "from" and "on".`);
    if (from === on) throw new Error(`Edge ${index + 1}: ${from} cannot wait on itself.`);
    const where = entry.found ?? found ?? 'planning';
    if (!['planning', 'build'].includes(where)) {
      throw new Error(`Edge ${index + 1}: found must be planning or build.`);
    }
    return { from, on, reason: entry.reason, found: where };
  });
  const edges = wanted.map((edge) => recordEdge(workflow, edge.from, edge.on, edge));
  relevel(workflow);
  return edges;
}
