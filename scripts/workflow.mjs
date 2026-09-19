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
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, readJson, resolveGithubRepo, sendReport, tenantId, trackerOf, writeJson } from './core.mjs';

// Mirrors adapters/teamflow/schema.py. The service is the enforcement;
// these exist so a typo is a message here rather than a 400 there.
export const ORDERS = ['priority', 'rank', 'age'];
export const TRACKERS = ['jira', 'linear', 'github'];
export const STATUSES = ['planning', 'running', 'blocked', 'done', 'cancelled'];
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
      the filter missed; the pool is what a run works from.

  teamflow workflow show [<name>]
      The plan: phases, tickets and what waits on what.

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

  teamflow workflow ready [--to <name>]
      What the current phase has open. This is what a run starts next.

  teamflow workflow ticket <KEY> [--state <s>] [--cycle <c>] [--to <name>]
      Move one ticket through the cycle. States: waiting, running, done,
      blocked, skipped, rework. Cycle: build, test, audit, status,
      deploy, verified, rework.`;

// A hyphen, not the underscore the wf_ shape suggests: the id becomes a
// path segment and adapters/teamflow/store.py allows no underscore in
// one. Getting this wrong is a 400 at the far end, so it is asserted.
export const ID = /^wf-[0-9a-f]{8,32}$/;

export function newId() {
  return `wf-${crypto.randomBytes(4).toString('hex')}`;
}

export function statePath() {
  return path.join(dataDir(), 'workflows.json');
}

// Keyed by tenant. A member can hold seats in several organisations and
// switches between them per session; workflows in one must not appear
// in another's `show`, and must never be published to it.
function scope(config) {
  return tenantId(config) || 'unknown';
}

export function load(config) {
  const all = readJson(statePath(), {}) || {};
  const mine = all[scope(config)] || {};
  return { current: mine.current || null, workflows: mine.workflows || {} };
}

export function save(state, config) {
  const all = readJson(statePath(), {}) || {};
  all[scope(config)] = { current: state.current, workflows: state.workflows };
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  writeJson(statePath(), all);
}

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
  const filter = pick(workflow.filter, ['tracker', 'project', 'state', 'label', 'order']);
  if (Object.keys(filter).length) out.filter = filter;
  if (workflow.scope) out.scope = pick(workflow.scope, ['deploy']);
  return out;
}

export async function publish(workflow, config) {
  return sendReport('workflow', null, published(workflow), config);
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

export function create(name, args, state) {
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
  const others = Object.values(state.workflows).filter((w) => w.id !== workflow.id);
  if (others.length) {
    out.push(`  other workflows: ${others.map((w) => w.name).join(', ')}`);
  }
  return out.join('\n');
}

// --- the command -----------------------------------------------------

export async function main(args, { config = {}, info = {}, print = (s) => process.stdout.write(`${s}\n`) } = {}) {
  const [sub = 'show', ...rest] = args;
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    print(USAGE);
    return 0;
  }

  const state = load(config);

  if (sub === 'create') {
    const name = rest.filter((a) => !a.startsWith('--'))[0];
    const workflow = create(name, rest, state);
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

  const target = find(state, flag(rest, 'to'));
  if (!target) {
    print(Object.keys(state.workflows).length
      ? 'No workflow chosen. Name one with --to, or `teamflow workflow show <name>`.'
      : 'No workflow yet. Start one with `teamflow workflow create <name>`.');
    return 0;
  }

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
    save(state, config);
    await publish(target, config);
    print(`TeamFlow put ${target.tickets.length - before} tickets in "${target.name}" `
      + `across ${target.phases.length} phase${target.phases.length === 1 ? '' : 's'}.`);
    print(render(target, state));
    return 0;
  }

  if (sub === 'depends') {
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
    save(state, config);
    await publish(target, config);
    const open = ready(target);
    print(`${ticket.key} is ${ticket.state}${ticket.cycle ? ` at ${ticket.cycle}` : ''}.`);
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

/** Record that one ticket waits on another. */
export function depends(workflow, from, on, { reason, found = 'planning' } = {}) {
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
  relevel(workflow);
  return edge;
}
