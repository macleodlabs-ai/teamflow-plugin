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
import {
  actor, actorsForKey, adoptWorkflow, fetchState, readWorkflows, reportScope, resolveGithubRepo, saveSession,
  sendReport, trackerOf, unclaimedWorkflows, workflowsPath, writeWorkflows,
} from './core.mjs';
import {
  POINT_TEXT_MAX, POINTS_MAX, POINTS_PER_ROUND_MAX, advance, pointLine,
} from './points.mjs';
import { cardFor, cardLine, planSession, publishCard, readTracker, readWriteBack } from './card.mjs';

// The plan's session block lives beside the card it is stamped on.
export { planSession };

// Mirrors adapters/teamflow/schema.py. The service is the enforcement;
// these exist so a typo is a message here rather than a 400 there.
export const ORDERS = ['priority', 'rank', 'age'];
export const TRACKERS = ['jira', 'linear', 'github'];
// `archived` is a run that is over and should stop being offered
// (MACLEOD-601): `teamflow tidy` writes it on an empty planning run
// nobody ever filled. Not `cancelled`, which says somebody decided
// against work they meant to do.
// `stalled` is a running run whose ticket stands at a gate that has had
// no verdict past twice its deadline (MACLEOD-639): the deploy gate on
// one live ticket said "running" for 41 hours because nothing ever aged
// it. The run is not blocked -- nobody decided anything -- and it is not
// done; it is waiting on a gate that will never answer by itself, and
// `stalledOn` names which. There is no `finished`: `done` is that.
export const STATUSES = ['planning', 'running', 'blocked', 'done', 'cancelled', 'archived', 'stalled'];
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
      Move the whole workflow. \`stalled\` is written by the plugin itself
      when a ticket's gate has had no verdict past twice its deadline,
      and cleared when that gate moves.

  teamflow workflow plan [--keys A,B,C] [--to <name>]
      Fill the pool. --keys is the selection in tracker priority order,
      which is what a session with the tracker's MCP passes in. Without
      it, and for a GitHub project, the selection is made here with the
      same call and the same ordering rule as \`teamflow next\`.

  teamflow workflow depends <KEY> --on <KEY> [--reason <why>]
                            [--found planning|build] [--to <name>]
      One ticket waits on another. Re-levels the phases, because an edge
      a team found mid-build moves tickets between them.

  teamflow workflow depends <KEY> --on <KEY> --remove [--reason <why>]
                            [--found planning|build] [--to <name>]
      Remove a wrong edge: <KEY> does not wait on the other ticket.
      Re-levels the phases the same way. If that edge is not in the
      workflow, TeamFlow says so and changes nothing. \`workflow show\`
      lists the edges you removed.

  teamflow workflow depends --batch [--found planning|build] [--to <name>]
      The whole graph at once, as JSON on stdin: an array of
      {"from","on","reason","found"}, or {"dependencies": [...]}. This is
      what planning uses — one call, one levelling, one report, instead of
      one subprocess per edge. Add "remove": true to an entry to remove
      that edge. A malformed entry, or a removal of an edge that is not
      there, refuses the batch.

  teamflow workflow ready [--to <name>]
      What the current phase has open. This is what a run starts next.

  teamflow workflow ticket <KEY> [--state <s>] [--cycle <c>] [--reason <why>] [--note <text>]
      [--findings <text>] [--finding <text>]... [--findings-file <path>] [--rechecked] [--done <ID>]... [--reopen <ID>]... [--to <name>]
      Move one ticket through the cycle. States: waiting, running, done,
      blocked, skipped, rework. Cycle: build, test, audit, status,
      deploy, verified, rework. Publishes the ticket's own card as well
      as the run's record, and prints what the card AND the tracker now
      say. --note is one sentence you wrote for the Status view (one
      line, at most 120 characters); --note "" clears it.
      Audit results go on the card for <KEY> and in its History. They
      never replace earlier ones.
      --findings is a short summary. With --state rework, it is a failed
      round. With another state and --cycle audit, it is a pass.
      --finding is one problem the audit found. Give it once for each
      problem, with --state rework. Each one becomes a failure point on
      the card (F1, F2, ...). The next build, test and audit work from
      these points.
      Nothing is marked fixed because it was left out. A report in two
      parts is two calls: the second adds its points to the same round.
      Points close in two ways only:
        --done F2 marks one point as fixed.
        --rechecked says the audit checked everything again. Then every
        open audit point it does not list is marked fixed. A pass with
        --rechecked marks them all fixed. A pass without it closes nothing.
      --findings-file reads one problem from each line of a file.
      --reopen F2 opens a fixed point again.
      A rework with no text still counts as a round. Each line is at
      most 280 characters. Write for a layman: short sentences, common
      words, no internal names. TeamFlow does not change your words.

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

/** The longest note `teamflow workflow ticket --note` keeps; `WORKFLOW_NOTE_MAX` in schema.py. */
export const NOTE_MAX = 120;

/**
 * A ticket's note (MACLEOD-639, ADHOC-14): the sentence the command line
 * passed and nothing else, as one line with every control character gone
 * and whitespace collapsed, capped like a rework summary. It is shown on
 * the Status view, so an escape sequence in it would be somebody's text
 * drawing on a reader's screen.
 */
export function noteLine(text, cap = NOTE_MAX) {
  return String(text ?? '')
    .replace(/[\r\n\t\v\f\u2028\u2029]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, cap)
    .trim();
}

/**
 * A gate's verdicts on the ticket it judged, and the failure points they
 * raise (MACLEOD-639, ADHOC-19).
 *
 * The owner, verbatim: "audit failures should add their summary to the
 * ticket when they send it back to be reworked each time"; "audit
 * summaries should get added to the card they audited. and add to its
 * history"; "if an audit fails - the reasons must get added to the card
 * history - as a list"; and "Each card that fails a gate ... should get
 * sent back with a reason and failure points. Each subsequent
 * rebuild/retest checks those points off in turn."
 *
 * So a verdict is appended per round and never rewritten, and each reason
 * a failed round gives becomes a point on the card (`F1`, `F2`, ... for a
 * point a person wrote), kept by points.mjs's one rule: a point failed
 * again stays open and counts another round, the next audit that lists its
 * findings checks off the rest, `--done` checks one off by hand and
 * `--reopen` opens it again. Points are never deleted. The caps mirror
 * schema.py.
 */
export const VERDICTS_MAX = 20;
export const VERDICT_SUMMARY_MAX = POINT_TEXT_MAX;
export const ITEMS_MAX = POINTS_MAX;

const who = (by) => (by ? String(by).slice(0, 64) : undefined);
const pointId = (id) => String(id ?? '').trim().toUpperCase();

/** The latest round recorded at a gate, or 0. */
function lastRound(ticket, gate) {
  return (ticket.verdicts || []).filter((v) => v.gate === gate)
    .reduce((most, v) => Math.max(most, Number(v.round) || 0), 0);
}

/**
 * Check points off by hand, or open them again. `doneRound` is the round
 * the fix answers: the latest round at the point's gate. An id the card
 * does not have is an error, never a silent no-op.
 */
export function markPoints(ticket, { done = [], reopen = [], by, at = new Date().toISOString() } = {}) {
  const points = ticket.points || [];
  const doneIds = new Set(done.map(pointId).filter(Boolean));
  const reopenIds = new Set(reopen.map(pointId).filter(Boolean));
  const unknown = [...doneIds, ...reopenIds].filter((id) => !points.some((point) => point.id === id));
  if (unknown.length) throw new Error(`${ticket.key} has no point ${unknown.join(', ')}`);
  for (const point of points) {
    if (doneIds.has(point.id) && point.state !== 'done') {
      point.state = 'done';
      point.doneAt = at;
      point.doneRound = lastRound(ticket, point.gate) || point.from;
      if (who(by)) point.doneBy = who(by);
    }
    if (reopenIds.has(point.id) && point.state === 'done') {
      point.state = 'open';
      delete point.doneAt;
      delete point.doneRound;
      delete point.doneBy;
    }
  }
}

const sameIds = (a = [], b = []) => a.length === b.length && a.every((id, i) => id === b[i]);

/** What the last recorded verdict said, for the command to print. Never saved. */
const verdictNotes = new WeakMap();

/** The sentence about the verdict this ticket's last move recorded, or nothing. */
export function verdictNote(ticket) {
  return verdictNotes.get(ticket);
}

const GATE_WORDS = { audit: 'Audit', test: 'Tests', deploy: 'Deploy', build: 'Build', status: 'Merge', verified: 'Check on dev', rework: 'Rework' };
const pointsWord = (n) => `${n} ${n === 1 ? 'point' : 'points'}`;

/**
 * Record the verdict this move makes, and the points it raises, or nothing.
 *
 * Nothing is ever closed by omission (the owner's dogfood, ADHOC-20: an
 * audit report that arrived in two parts marked the first part's points
 * fixed). So:
 *
 *  - a failed round with `--finding` only ADDS points; open points it does
 *    not list stay open;
 *  - a second call at the same gate with no new rework in between belongs
 *    to the same round: its findings are appended to that round;
 *  - points close only by `--done <ID>`, or when the audit says it checked
 *    everything again with `--rechecked` -- a failed re-audit, whose
 *    unlisted open points are fixed, or a pass, which fixes them all;
 *  - a pass without `--rechecked` closes nothing and says how many points
 *    are still open.
 *
 * The round is the attempt at that gate: the fails recorded there, plus
 * one for a new round. The same words said twice are one verdict.
 */
function recordVerdict(ticket, {
  entering, state, summaryText, findings = [], gate, by, at, rechecked = false,
}) {
  const failed = state === 'rework';
  if (!failed && summaryText === undefined && !rechecked) return undefined;
  if (!gate) return undefined;
  const verdict = failed ? 'fail' : 'pass';
  const summary = pointLine(summaryText, VERDICT_SUMMARY_MAX);
  const list = ticket.verdicts || [];
  const last = list[list.length - 1];
  const previous = [...list].reverse().find((one) => one.gate === gate);
  const points = ticket.points || [];
  const next = points.reduce((most, point) => Math.max(most, Number(/^F(\d+)$/.exec(point.id)?.[1]) || 0), 0) + 1;
  const run = (round) => advance(points, {
    gate,
    round,
    at,
    by: who(by),
    failing: failed ? findings.map((text) => ({ text })) : [],
    judgedAll: rechecked,
    idFor: (_point, i) => `F${next + i}`,
  });
  const fixedBy = (ran) => [...new Set([
    ...(previous?.open || []).filter((id) => ran.points.find((point) => point.id === id)?.state === 'done'),
    ...ran.fixed,
  ])];
  const unchanged = (ran) => ran.points.length === points.length
    && ran.points.every((point, i) => point.rounds === points[i]?.rounds && point.state === points[i]?.state);
  const name = GATE_WORDS[gate] || 'Check';

  // The same round, a second batch: appended, never a new round.
  if (failed && !entering && last && last.gate === gate && last.verdict === 'fail') {
    const ran = run(last.round);
    if (!ran.raised.length && unchanged(ran) && (!summary || summary === (last.summary || ''))) return undefined;
    ticket.points = ran.points;
    const into = { ...last };
    if (summary) into.summary = summary;
    if (ran.raised.length) into.raised = [...(last.raised || []), ...ran.raised];
    const fixed = [...new Set([...(last.fixed || []), ...fixedBy(ran)])];
    if (fixed.length) into.fixed = fixed;
    if (ran.open.length) into.open = ran.open;
    else delete into.open;
    if (ran.notAdded) into.notAdded = (last.notAdded || 0) + ran.notAdded;
    ticket.verdicts = [...list.slice(0, -1), into];
    verdictNotes.set(ticket, `Added ${pointsWord(ran.raised.length)} to round ${last.round}.`
      + (ran.fixed.length ? ` Marked ${pointsWord(ran.fixed.length)} fixed.` : ''));
    return into;
  }

  const fails = list.filter((one) => one.gate === gate && one.verdict === 'fail')
    .reduce((most, one) => Math.max(most, Number(one.round) || 0), 0);
  const round = fails + 1;
  // A pass said twice is one pass.
  if (!failed && last && last.gate === gate && last.verdict === 'pass' && (last.summary || '') === summary) {
    const replay = run(last.round);
    if (!replay.raised.length && unchanged(replay)) return undefined;
  }
  const ran = run(round);
  const fixed = fixedBy(ran);
  ticket.points = ran.points;
  const out = { gate, verdict, round, at };
  if (who(by)) out.by = who(by);
  if (summary) out.summary = summary;
  if (ran.raised.length) out.raised = ran.raised;
  if (fixed.length) out.fixed = fixed;
  if (ran.open.length) out.open = ran.open;
  // Failures not added because the card already holds 50 open points.
  if (ran.notAdded) out.notAdded = ran.notAdded;
  ticket.verdicts = [...list, out].slice(-VERDICTS_MAX);
  const still = ran.open.length;
  verdictNotes.set(ticket, failed
    ? `${name} sent ${ticket.key} back for rework (round ${round}). Added ${pointsWord(ran.raised.length)}.`
      + (ran.fixed.length ? ` Marked ${pointsWord(ran.fixed.length)} fixed.` : '')
    : `${name} passed.${still ? ` ${still === 1 ? '1 point is' : `${still} points are`} still open.` : ''}`
      + (ran.fixed.length ? ` Marked ${pointsWord(ran.fixed.length)} fixed.` : ''));
  return out;
}

/**
 * The open failure points on a card, in plain words, for whoever picks it
 * up (`teamflow status`, `teamflow workflow show <KEY>`). Empty when there
 * are none.
 */
export function pointLines(ticket) {
  const points = ticket?.points || [];
  if (!points.length) return [];
  const open = points.filter((point) => point.state === 'open');
  const done = points.length - open.length;
  if (!open.length) return [`${ticket.key}: all ${points.length} failure points are fixed.`];
  return [
    `${ticket.key}: ${open.length} failure ${open.length === 1 ? 'point is' : 'points are'} open. ${done} of ${points.length} fixed.`,
    ...open.map((point) => `  [ ] ${point.id} ${point.text}${point.rounds > 1 ? ` (failed ${point.rounds} times)` : ''}`),
    `When you fix one, mark it done: teamflow workflow ticket ${ticket.key} --done <ID>`,
  ];
}

/** The open points for a key, from every run this organisation holds on this machine. */
export function openPointLines(config, key) {
  const wanted = String(key || '').trim();
  if (!wanted) return [];
  const runs = Object.values(load(config).workflows || {});
  const ticket = runs.flatMap((run) => run.tickets || [])
    .filter((one) => one.key === wanted && (one.points || []).length)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
  return ticket ? pointLines(ticket) : [];
}

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
      (t) => pick(t, ['key', 'rank', 'phase', 'state', 'cycle', 'addedBy', 'updatedAt', 'note'])),
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
  // Which gate the run is waiting on, and since when (MACLEOD-639).
  // Only while stalled: a run that moved on has nothing to say here.
  if (workflow.status === 'stalled' && workflow.stalledOn?.key) {
    out.stalledAt = workflow.stalledAt;
    out.stalledOn = { key: workflow.stalledOn.key, gate: String(workflow.stalledOn.gate).slice(0, 40) };
  }
  // What the plugin did to the run by itself (WS-H): resumed, and why.
  if (Array.isArray(workflow.hygiene) && workflow.hygiene.length) {
    out.hygiene = workflow.hygiene.slice(-20).map((row) => pick(row, ['at', 'action', 'by', 'reason']));
  }
  // A run the plugin created because a session dispatched work without
  // one (MACLEOD-639). The board draws it as unplanned -- a run with
  // nodes and no edges -- rather than as a plan somebody wrote.
  if (workflow.origin === 'auto') out.origin = 'auto';
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

/** Every value of a flag that may be given more than once. */
function flags(args, name) {
  const out = [];
  args.forEach((arg, i) => {
    if (arg !== `--${name}`) return;
    const value = args[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    out.push(value);
  });
  return out;
}

/** One finding per non-empty line of a file, for a long list (ADHOC-19). */
function findingsFile(file) {
  if (file === undefined) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
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
  // A stalled run is a running run waiting on a gate; it is still live.
  if (workflow.status !== 'running' && workflow.status !== 'stalled') return workflow;
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
export function move(workflow, key, {
  state, cycle, note, findings, finding = [], done = [], reopen = [], by, rechecked = false,
} = {}) {
  const ticket = (workflow.tickets || []).find((t) => t.key === String(key || '').trim());
  if (!ticket) throw new Error(`${key} is not in "${workflow.name}"`);
  if (finding.length && state !== 'rework') {
    throw new Error('--finding goes with --state rework. Use --findings for a pass.');
  }
  // One round holds 20 findings. More is refused out loud, never cut.
  const given = new Set(finding.map((one) => pointLine(one)).filter(Boolean)).size;
  if (given > POINTS_PER_ROUND_MAX) {
    throw new Error(`You gave ${given} findings. One round holds ${POINTS_PER_ROUND_MAX}. Split them or merge some.`);
  }
  const entering = state === 'rework' && ticket.state !== 'rework';
  if (state !== undefined) {
    if (!TICKET_STATES.includes(state)) {
      throw new Error(`A ticket state is one of ${TICKET_STATES.join(', ')}`);
    }
    // Each time a ticket is sent back is one failure, counted so the
    // retry policy (selfheal.mjs) answers each failure once, however
    // many commands ask about it. Local; never published.
    if (state === 'rework' && ticket.state !== 'rework') ticket.failures = (ticket.failures || 0) + 1;
    ticket.state = state;
  }
  if (cycle !== undefined) {
    if (!CYCLES.includes(cycle)) {
      throw new Error(`A cycle step is one of ${CYCLES.join(', ')}`);
    }
    ticket.cycle = cycle;
  }
  // Only what `--note` passed. An empty note clears the old one.
  if (note !== undefined) {
    const line = noteLine(note);
    if (line) ticket.note = line;
    else delete ticket.note;
  }
  /*
   * The gate's verdict and its items, on this ticket and no other
   * (ADHOC-19). Items are checked off first, so a round recorded by the
   * same command already sees them done.
   */
  const at = new Date().toISOString();
  verdictNotes.delete(ticket);
  if (done.length || reopen.length) markPoints(ticket, { done, reopen, by, at });
  recordVerdict(ticket, {
    entering,
    state,
    summaryText: findings !== undefined ? findings : (state === 'rework' ? note : undefined),
    findings: finding,
    gate: ticket.cycle || (ticket.state === 'rework' ? 'rework' : undefined),
    by,
    at,
    rechecked,
  });
  /*
   * Naming a gate again restarts it (MACLEOD-639). A gate that was closed
   * as `idle` -- no verdict past twice its deadline -- is derived idle
   * for as long as the ticket stands there, so `--state running --cycle
   * deploy` on a ticket already running at deploy is the one way to say
   * "run it again": the old clock is dropped and the next report starts
   * a new one. Anything short of naming the gate leaves it closed.
   */
  if (state === 'running' && cycle !== undefined && (ticket.gates?.[cycle] === 'idle' || ticket.skipped?.[cycle])) {
    if (ticket.gates) delete ticket.gates[cycle];
    if (ticket.gateClock) delete ticket.gateClock[cycle];
    // A gate a person skipped is a gate again once somebody runs it.
    if (ticket.skipped) delete ticket.skipped[cycle];
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

/** Cycle → the sidecar slot its gate is written to. What selfheal.mjs reads. */
export const GATE_SLOTS = Object.freeze(Object.fromEntries(Object.entries(GATES).map(([cycle, gate]) => [cycle, gate.slot])));

/** Cycles in the order a ticket passes through them. */
const CYCLE_ORDER = ['build', 'test', 'audit', 'status', 'deploy', 'verified'];

// --- how long a gate may run before nobody believes it (MACLEOD-639) --
//
// The owner's rule 4, verbatim: a started gate with no finish past its
// deadline is "no verdict", never "running forever". The board draws a
// running gate as doubtful at 1x its deadline; this side, the writer,
// closes it at 2x, so a deploy that takes 45 minutes is amber at 30 and
// nothing is WRITTEN until 60. The two numbers are one table so the
// derivation and the revisit cannot disagree about when.
//
// Minutes, keyed by slot, with a family fallback so a gate id the
// pipeline invents (`sonar`, `smoke-eu`) still has a deadline: anything
// naming an audit or a security check is an audit, `deploy` is a
// deploy, and everything else is a build or a test. An organisation
// overrides any of them under `delivery.gate_deadlines`, which the
// service serves in the bundle and a plugin config may spell locally.

/** The defaults, in minutes: deploy 30, ci/test 2 h, audit 1 h. */
export const GATE_DEADLINE_MIN = Object.freeze({ deploy: 30, ci: 120, audit: 60 });

/**
 * The organisation's overrides, as the plugin config spells them:
 * `delivery.gate_deadlines`, minutes by slot or family. The same key the
 * service serves in the bundle as `deadlines`; a caller that has read
 * the bundle passes that object straight through instead.
 */
export function gateDeadlinesOf(config = {}) {
  const delivery = config?.delivery;
  const given = delivery?.gate_deadlines ?? delivery?.gateDeadlines;
  return given && typeof given === 'object' ? given : {};
}

/**
 * What the plugin, or a person through it, did to the run by itself
 * (MACLEOD-639): `resumed`, `skipped`. The same row shape the service's
 * hygiene sidecar keeps, on the run, capped, published with it.
 */
export function hygieneRow(workflow, action, by, reason, at = now()) {
  const row = { at, action: String(action).slice(0, 40), by: String(by || 'plugin').slice(0, 80), reason: String(reason).slice(0, 120) };
  workflow.hygiene = [...(workflow.hygiene || []), row].slice(-20);
  return row;
}

/** The retry policy as the plugin config spells it (`delivery.retry`); selfheal.mjs reads the numbers. */
function policyFor(config = {}) {
  const given = config?.delivery?.retry;
  const attempts = Number(given?.attempts);
  return {
    attempts: Number.isInteger(attempts) && attempts > 0 ? Math.min(attempts, 20) : 3,
    reworkCap: Number.isInteger(Number(given?.reworkCap)) && Number(given?.reworkCap) > 0 ? Number(given.reworkCap) : 16,
  };
}

/** Which default a gate id falls back to. Any string; nothing is enumerated. */
export function gateFamily(slot) {
  const id = String(slot || '').toLowerCase();
  if (id === 'deploy' || /\bdeploy/.test(id)) return 'deploy';
  if (/audit|security|scan|sonar/.test(id)) return 'audit';
  return 'ci';
}

/**
 * A gate's deadline in milliseconds: the org's number for this slot, or
 * for its family (`test` is read as `ci`, as the spec spells it), or the
 * default. A value that is not a positive number is ignored rather than
 * turned into "no deadline", because no deadline is the bug.
 */
export function gateDeadlineMs(slot, deadlines = {}) {
  const family = gateFamily(slot);
  const given = deadlines && typeof deadlines === 'object' ? deadlines : {};
  const candidates = [given[slot], given[family], family === 'ci' ? given.test : undefined];
  const minutes = candidates.map(Number).find((n) => Number.isFinite(n) && n > 0);
  return (minutes || GATE_DEADLINE_MIN[family]) * 60 * 1000;
}

/** How far past 2x a gate's clock has run: positive when it is overdue. */
function overdueMs(startedAt, slot, now, deadlines) {
  const started = Date.parse(startedAt || '');
  if (!Number.isFinite(started)) return -Infinity;
  const at = typeof now === 'string' ? Date.parse(now) : Number(now);
  if (!Number.isFinite(at)) return -Infinity;
  return (at - started) - 2 * gateDeadlineMs(slot, deadlines);
}

/** `41 h`, `3 d`, `50 min`: the age a summary prints. */
function ageWords(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

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
 *
 * With one clock (MACLEOD-639). "Running" is believed for twice the
 * gate's deadline from when it was first said, and after that the same
 * derivation answers `idle`: no verdict. The clock is the only local
 * thing read here, and losing it costs nothing worse than a restarted
 * clock -- which is conservative, never an aged one. The deadline sits
 * INSIDE the derivation rather than in a separate revisit so that the
 * two cannot flap: whatever asks, at whatever time, gets one answer.
 */
export function gateStatuses(ticket, { now = Date.now(), deadlines } = {}) {
  const at = CYCLE_ORDER.indexOf(ticket.cycle);
  const out = {};
  for (const cycle of Object.keys(GATES)) {
    const index = CYCLE_ORDER.indexOf(cycle);
    // A gate a person passed the ticket over (`skip_gate`, MACLEOD-639)
    // has no verdict and never gains one from the ticket moving on: it
    // reads `idle` with the person's reason, not `success`, for as long
    // as nobody runs it. Only once the ticket is at or past it.
    if (ticket.skipped?.[cycle] && (ticket.state === 'done' || (at >= 0 && at >= index))) out[cycle] = 'idle';
    // `done` is past every gate, whatever cycle it stopped at: a ticket
    // cannot be finished with a gate still to pass.
    else if (ticket.state === 'done' || (at >= 0 && at > index)) out[cycle] = 'success';
    else if (at === index && ticket.state === 'rework') out[cycle] = 'failed';
    else if (at === index && ticket.state === 'running') {
      const started = ticket.gateClock?.[cycle]?.startedAt;
      out[cycle] = overdueMs(started, GATES[cycle].slot, now, deadlines) > 0 ? 'idle' : 'running';
    }
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
 *
 * All or nothing (MACLEOD-639). When any verdict changes, every gate
 * that HAS a verdict is written in the same command, not only the one
 * that moved. One live ticket showed its test gate `running` under a
 * deploy gate that had passed, because the earlier write was lost and
 * the later one had no reason to say it again; three sidecars written
 * together cannot be produced in that order. A command that changes
 * nothing still writes nothing.
 */
export function gateReports(workflow, ticket, { reason, at = now(), deadlines } = {}) {
  const told = (ticket.gates && typeof ticket.gates === 'object') ? ticket.gates : {};
  const clocks = (ticket.gateClock && typeof ticket.gateClock === 'object') ? ticket.gateClock : {};
  const wanted = gateStatuses(ticket, { now: at, deadlines });
  if (!Object.entries(wanted).some(([cycle, status]) => told[cycle] !== status)) return [];
  const session = planSession(workflow);
  const out = [];

  for (const [cycle, status] of Object.entries(wanted)) {
    const gate = GATES[cycle];
    const was = told[cycle];
    const clock = clocks[cycle] || {};
    /*
     * The clock. A gate that is still the same run keeps the moment it
     * started, whatever `updatedAt` the rewrite carries; anything that
     * has ended keeps both ends. A gate starting now -- first time, or
     * again after a refusal or a close -- starts a new one.
     */
    const continuing = was === 'running' && clock.startedAt && !clock.endedAt;
    const startedAt = status === 'running' ? (continuing ? clock.startedAt : at) : clock.startedAt;
    const endedAt = status === 'running' ? undefined : (clock.endedAt || at);
    const summary = status === 'failed'
      ? (reason || ticket.lastFailure || `${gate.label} sent this back`)
      : status === 'running'
        ? (was === 'failed'
          ? `Back at the ${gate.label.toLowerCase()} after rework`
          : `${gate.label} running`)
        : status === 'idle'
          ? (ticket.skipped?.[cycle]
            ? `skipped by ${ticket.skipped[cycle].by}: ${ticket.skipped[cycle].reason}`
            : `No verdict from the ${gate.label.toLowerCase()} for ${ageWords(Date.parse(at) - Date.parse(startedAt || at))}`)
          : `${gate.label} passed${was === 'failed' ? ' on the way back' : ''}`;
    const payload = {
      jiraKey: ticket.key,
      slot: gate.slot,
      // One id per gate per workflow, so a pass replaces the refusal it
      // answers instead of sitting beside it. A sidecar lives at
      // `runtime/<key>/<slot>.json`, so two tickets sharing an id are
      // two separate files and neither stands on the other.
      id: `${workflow.id}-${gate.slot}`.slice(0, 120),
      kind: gate.kind,
      label: gate.label,
      // The plan's, not a person's: a gate verdict is the run's word.
      session,
      stage: gate.stage,
      status,
      summary: String(summary).slice(0, 180),
      updatedAt: at,
    };
    if (startedAt) payload.startedAt = startedAt;
    if (endedAt) payload.endedAt = endedAt;
    // The plugin's own retry policy on this gate (selfheal.mjs): which
    // attempt a re-run is, or that the attempts are spent and why. Not
    // on a pass: a gate that passed has nothing left to retry.
    const retry = ticket.gateRetry?.[cycle];
    if (retry && status !== 'success') {
      const { failure: _local, ...block } = retry;
      payload.retry = block;
    }
    out.push({ slot: gate.slot, cycle, payload });
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
  // And the clock the board was told, so the next rewrite carries it
  // forward instead of starting the gate again (MACLEOD-639).
  const clock = { saidAt: verdict.payload.updatedAt };
  if (verdict.payload.startedAt) clock.startedAt = verdict.payload.startedAt;
  if (verdict.payload.endedAt) clock.endedAt = verdict.payload.endedAt;
  ticket.gateClock = { ...(ticket.gateClock || {}), [verdict.cycle]: clock };
  // A pass ends the retry loop on that gate.
  if (verdict.payload.status === 'success' && ticket.gateRetry) delete ticket.gateRetry[verdict.cycle];
}

/**
 * The service closed a gate this plan still believes is running.
 *
 * The nightly sweep writes `idle` from its own clock, and a plugin whose
 * clock is younger -- restarted after a lost hint, say -- would write
 * `running` straight back over it, and the two would take turns for
 * ever (MACLEOD-639). So a service-written `idle` newer than anything
 * this plan said is taken as SAID: the hint records it, and the clock
 * takes the sidecar's own start, backdated past 2x when the sidecar
 * carries none, so the derivation agrees with the hint rather than
 * arguing with it. Naming the gate again (`move`) is what reopens it.
 *
 * Returns whether anything was adopted. Pure: the sidecar is passed in.
 */
export function toldByService(ticket, cycle, sidecar, { deadlines } = {}) {
  const gate = GATES[cycle];
  if (!gate || !sidecar || sidecar.status !== 'idle') return false;
  const said = ticket.gateClock?.[cycle]?.saidAt;
  const theirs = Date.parse(sidecar.updatedAt || '');
  if (!Number.isFinite(theirs)) return false;
  if (said && Date.parse(said) >= theirs) return false;
  const startedAt = sidecar.startedAt
    || new Date(theirs - 2 * gateDeadlineMs(gate.slot, deadlines) - 60 * 1000).toISOString();
  ticket.gates = { ...(ticket.gates || {}), [cycle]: 'idle' };
  ticket.gateClock = {
    ...(ticket.gateClock || {}),
    [cycle]: { startedAt, endedAt: sidecar.endedAt || sidecar.updatedAt, saidAt: sidecar.updatedAt },
  };
  return true;
}

// --- the run, waiting on a gate (MACLEOD-639) -------------------------

/**
 * Which ticket's gate, if any, has had no verdict past twice its
 * deadline. The first one in rank order; a run is stalled once.
 */
export function stalledGate(workflow, { now = Date.now(), deadlines } = {}) {
  for (const ticket of workflow.tickets || []) {
    if (ticket.state !== 'running') continue;
    for (const [cycle, status] of Object.entries(gateStatuses(ticket, { now, deadlines }))) {
      if (status === 'idle') return { key: ticket.key, gate: GATES[cycle].slot };
    }
  }
  return undefined;
}

/**
 * Move the run between `running` and `stalled` from what its gates say.
 *
 * Written by the plugin itself, on every command that touches the run,
 * because the orchestrator is the one thing that cannot be relied on to
 * notice: the deploy that stalled the live run happened in the main
 * session under another key. `stalledAt` is the first moment the run
 * was found stalled ON THIS GATE and is kept while it stays so; a run
 * stalled on a second gate later is stalled again, from then. Only a
 * running or stalled run is touched -- `blocked`, `cancelled`, `done`
 * are somebody's decision.
 */
export function restall(workflow, { now = Date.now(), deadlines } = {}) {
  if (!workflow || !['running', 'stalled'].includes(workflow.status)) return false;
  const at = new Date(typeof now === 'string' ? Date.parse(now) : now).toISOString();
  const on = stalledGate(workflow, { now, deadlines });
  if (on) {
    const same = workflow.status === 'stalled'
      && workflow.stalledOn?.key === on.key && workflow.stalledOn?.gate === on.gate;
    if (same) return false;
    workflow.status = 'stalled';
    workflow.stalledOn = on;
    workflow.stalledAt = at;
    workflow.updatedAt = at;
    return true;
  }
  if (workflow.status !== 'stalled') return false;
  workflow.status = 'running';
  delete workflow.stalledOn;
  delete workflow.stalledAt;
  workflow.updatedAt = at;
  return true;
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
  const how = ticket.addedBy === 'dispatch' ? '  (dispatched)' : '';
  return `    ${String(ticket.rank).padStart(3)}. ${ticket.key}  ${where}${on}${how}`;
}

export function render(workflow, state) {
  const out = [];
  const pool = workflow.tickets || [];
  const filter = Object.entries(workflow.filter || {})
    .map(([k, v]) => `${k}=${v}`).join(' ') || 'none';
  out.push(`${workflow.name} (${workflow.id}) — ${workflow.status}`);
  if (workflow.origin === 'auto') {
    out.push('  created by TeamFlow when this session dispatched work without a run.'
      + ' Its edges are unknown: `teamflow workflow depends` draws the phases.');
  }
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
  for (const [where, label] of [['planning', 'planning'], ['build', 'building']]) {
    const gone = (workflow.removed || []).filter((d) => d.found === where);
    if (!gone.length) continue;
    out.push(`  removed while ${label}:`);
    for (const d of gone) {
      out.push(`    ${d.from} does not wait on ${d.on}${d.reason ? ` — ${d.reason}` : ''}`);
    }
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
      const gone = edges.filter((e) => e.removed).length;
      const added = edges.length - gone;
      print(`TeamFlow recorded ${added} dependenc${added === 1 ? 'y' : 'ies'}`
        + `${gone ? ` and removed ${gone}` : ''} `
        + `in "${target.name}", now ${target.phases.length} phase`
        + `${target.phases.length === 1 ? '' : 's'}.`);
      print(render(target, state));
      return 0;
    }
    const positional = rest.filter((a) => !a.startsWith('--'));
    if (rest.includes('--remove')) {
      const edge = undepend(target, positional[0], flag(rest, 'on'), {
        reason: flag(rest, 'reason'),
        found: flag(rest, 'found') || 'planning',
      });
      save(state, config);
      await publish(target, config);
      print(`${edge.from} no longer waits on ${edge.on}.`);
      print(`"${target.name}" is now ${target.phases.length} phase`
        + `${target.phases.length === 1 ? '' : 's'}.`);
      return 0;
    }
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
      state: flag(rest, 'state'), cycle: flag(rest, 'cycle'), note: flag(rest, 'note'),
      findings: flag(rest, 'findings'),
      finding: [...flags(rest, 'finding'), ...findingsFile(flag(rest, 'findings-file'))],
      done: flags(rest, 'done'),
      reopen: flags(rest, 'reopen'),
      // Only an audit that checked everything again closes what it omits.
      rechecked: rest.includes('--rechecked'),
      // The orchestrating person, as a report names them (`actor`).
      by: actor(config, info).displayName,
    });
    if (verdictNote(ticket)) print(verdictNote(ticket));
    const deadlines = gateDeadlinesOf(config);
    const at = now();
    /*
     * What the service already closed (MACLEOD-639). One read, for the
     * one gate this ticket stands at, before deciding what to say about
     * it: a sweep that wrote `idle` over a gate this plan still believes
     * is running is taken as said, not argued with. Never fatal, and
     * skipped for a ticket standing at no gate.
     */
    const standing = Object.entries(gateStatuses(ticket, { now: at, deadlines }))
      .find(([, status]) => status === 'running');
    if (standing) {
      const [cycle] = standing;
      const read = await fetchState(`issues/${encodeURIComponent(ticket.key)}/${GATES[cycle].slot}.json`, config)
        .catch(() => ({ ok: false }));
      if (read.ok && read.document) toldByService(ticket, cycle, read.document, { deadlines });
    }
    /*
     * The one place the orchestrator consults the retry policy (WS-H):
     * after the move and before the gates are said, so the verdicts
     * written below carry the attempt they are, or the delay they have
     * become. What it prints is the plugin's own state.
     */
    const { healRun, settle } = await import('./selfheal.mjs');
    const healed = healRun(target, { now: at, deadlines, policy: policyFor(config) });
    for (const line of healed.lines) print(`TeamFlow: ${line}`);
    const said = gateReports(target, ticket, { reason: flag(rest, 'reason'), at, deadlines });
    /*
     * And every OTHER ticket in the pool (MACLEOD-593). This is the
     * revisiting: a gate chip is only ever as true as the last write,
     * and the ticket it is on may never move again, so any command
     * puts the whole pool's gates right rather than only the one just
     * touched. It is cheap because `gateReports` writes nothing where
     * the board already says what the ticket says -- in the ordinary
     * case this loop sends nothing at all -- and it is what repairs a
     * board after a marker was lost, without anybody noticing it was.
     * Including, now, a gate that has run past twice its deadline on a
     * ticket this command did not touch: that is the one that stalled
     * the live run for 41 hours (MACLEOD-639).
     */
    const repaired = (target.tickets || [])
      .filter((t) => t !== ticket)
      .flatMap((t) => gateReports(target, t, { at, deadlines }).map((verdict) => ({ on: t, verdict })));
    // The run's own word about itself: stalled on a gate, or not.
    settle(target, { now: at, deadlines });
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
    const wanted = rest.filter((a) => !a.startsWith('--'))[0];
    // A card's key, not a run's name: that card and its failure points (ADHOC-19).
    const card = !find(state, wanted) && wanted
      ? (target.tickets || []).find((t) => t.key === String(wanted).trim())
      : undefined;
    if (card) {
      print(`${card.key} is ${card.state}${card.cycle ? ` at ${card.cycle}` : ''}.`);
      const lines = pointLines(card);
      print(lines.length ? lines.join('\n') : `${card.key} has no failure points.`);
      if (lines.length) {
        print('A point closes only when you mark it done, or when an audit checks everything again '
          + `and says so: teamflow workflow ticket ${card.key} --cycle audit --rechecked.`);
      }
      return 0;
    }
    const named = find(state, wanted) || target;
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
  // An edge put back is no longer a removal.
  if (workflow.removed) {
    workflow.removed = workflow.removed.filter((d) => !(d.from === a && d.on === b));
  }
  return edge;
}

/**
 * Remove one edge, without re-levelling. The removal is kept on this
 * machine in `workflow.removed` (never published: the board draws the
 * edges that are there) so `workflow show` can say what was taken out.
 * An edge that is not there is refused: removing nothing is a typo.
 */
function removeEdge(workflow, from, on, { reason, found = 'planning' } = {}) {
  const a = String(from || '').trim();
  const b = String(on || '').trim();
  if (!a || !b) throw new Error('Usage: teamflow workflow depends <KEY> --on <KEY> --remove');
  if (!['planning', 'build'].includes(found)) {
    throw new Error('--found must be planning or build');
  }
  const edges = workflow.dependencies || [];
  const index = edges.findIndex((d) => d.from === a && d.on === b);
  if (index < 0) {
    throw new Error(`${a} does not wait on ${b} in "${workflow.name}". Nothing was removed.`);
  }
  edges.splice(index, 1);
  workflow.dependencies = edges;
  const gone = { from: a, on: b, found };
  if (reason) gone.reason = String(reason).slice(0, 180);
  workflow.removed = (workflow.removed || [])
    .filter((d) => !(d.from === a && d.on === b))
    .concat(gone)
    .slice(-CAPS.dependencies);
  return { ...gone, removed: true };
}

/** Record that one ticket no longer waits on another. */
export function undepend(workflow, from, on, options = {}) {
  const edge = removeEdge(workflow, from, on, options);
  relevel(workflow);
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
  const adding = list.filter((e) => !(e && e.remove === true)).length;
  if (already + adding > CAPS.dependencies) {
    // The service caps this list and `published` truncates to the same
    // number. Refusing is the honest answer: a silently trimmed graph
    // levels into phases that are missing gates nobody can see are gone.
    throw new Error(`A workflow holds at most ${CAPS.dependencies} dependencies; `
      + `this batch would make ${already + adding}.`);
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
    return { from, on, reason: entry.reason, found: where, remove: entry.remove === true };
  });
  // A removal must name an edge that is there when its turn comes, in
  // the order given. Checked before anything is written.
  const present = new Set((workflow.dependencies || []).map((d) => `${d.from}\u0000${d.on}`));
  wanted.forEach((edge, index) => {
    const id = `${edge.from}\u0000${edge.on}`;
    if (!edge.remove) { present.add(id); return; }
    if (!present.has(id)) {
      throw new Error(`Edge ${index + 1}: ${edge.from} does not wait on ${edge.on}. `
        + 'Nothing was changed.');
    }
    present.delete(id);
  });
  const edges = wanted.map((edge) => (edge.remove
    ? removeEdge(workflow, edge.from, edge.on, edge)
    : recordEdge(workflow, edge.from, edge.on, edge)));
  relevel(workflow);
  return edges;
}

// --- a run the plugin makes for itself (MACLEOD-639, ADHOC-13) --------
//
// Every plan and every dispatched agent is a node on the board, and the
// tool guarantees it rather than the orchestrator remembering. These
// three are what dispatch.mjs calls from a hook: they touch the state
// in place, and the caller saves and publishes once.

/**
 * The run a dispatch joins: the current one when it is live, else the
 * newest live one. Live is anything not over -- `planning`, `running`,
 * `blocked` and `stalled` -- because a plan somebody is still writing is
 * still the plan this work belongs to.
 */
export function liveRun(state = {}) {
  const live = (w) => w && !['done', 'cancelled', 'archived'].includes(w.status);
  const current = state.workflows?.[state.current];
  if (live(current)) return current;
  return Object.values(state.workflows || {})
    .filter(live)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
}

/**
 * A run nobody asked for, created because work was dispatched and there
 * was none. `origin: auto` is what the board reads as "unplanned"; the
 * name is derived from the bound ticket or the date, never from a
 * prompt, and there is no `--order-text` because nothing was asked.
 * Running from the start: the agents it holds are working now.
 */
export function autoCreate(state, name, owner) {
  let clean = String(name || '').trim().slice(0, NAME_MAX) || 'Unplanned run';
  if (find(state, clean)) clean = `${clean} ${new Date().toISOString().slice(11, 16)}`.slice(0, NAME_MAX);
  const workflow = create(clean, [], state, owner);
  workflow.origin = 'auto';
  workflow.status = 'running';
  return workflow;
}

/**
 * A node the plugin put in the pool because an agent was sent to work
 * on it. `addedBy: dispatch` is the difference from `manual`: nobody
 * chose it, the hooks saw it. Running at build from its first hook,
 * because the agent is already working; levelled so the run has phases
 * -- one, until edges are drawn.
 */
export function addDispatched(workflow, key) {
  const ticket = add(workflow, key);
  ticket.addedBy = 'dispatch';
  ticket.state = 'running';
  ticket.cycle = 'build';
  relevel(workflow);
  return ticket;
}
