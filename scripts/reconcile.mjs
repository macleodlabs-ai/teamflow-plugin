#!/usr/bin/env node
// Continuous reconciliation: the plugin keeps the board clean without
// being asked (MACLEOD-601, section B).
//
// Everything the plugin writes is written once, from an event, and
// nothing revisits it. MACLEOD-593 fixed that for a gate chip by
// deriving the verdict from the ticket's CURRENT state on every publish
// and repairing the whole pool, bounded, on any command. This widens
// that one mechanism to the four other places the same staleness was
// found on one live tenant in one morning: 31 cards carrying a stage
// from a session that ended sixteen hours earlier, ten executions
// saying `running` about agents nobody was running, 144 empty planning
// runs nothing would ever have retired, and one run left `running` with
// every ticket closed.
//
// A repair that runs unasked has to be safe in a way a command a person
// typed does not, and the audit of the first cut found the three places
// it was not. What follows is those three rules, each of which is the
// reason for a piece of this file:
//
// **The newest run holding a key is the only one that speaks for it.**
// A key lives in several runs — somebody sweeping the backlog and
// somebody else working a named set — and the first cut walked
// `Object.values`, so which run spoke was file order. A run that
// stalled last week holding a ticket at `waiting` would publish
// `BACKLOG` over work a team is doing now.
//
// **A card at a write-back trigger stage needs the tracker's
// agreement.** `DEV_VERIFIED` and `DONE` are the two stages the
// service's write-back fires on, so republishing one does not just
// redraw a card: it moves a real issue in a customer's Linear. A run
// that finished MACLEOD-587 last week is not evidence about an issue a
// person reopened this morning. This is a rule about the STAGE and not
// about whether a person typed the command — somebody running
// `teamflow tidy` at 9am knows no better than the `Stop` hook which of
// 31 tickets was reopened overnight.
//
// **Absence of a hint is not permission.** Every run written before
// this version has no `card` on its tickets, and reading that as "the
// board needs telling" would drip a customer's entire history onto the
// wire two reports at a time on the first day. It means "we do not know
// what the board has been told", so a finished run's tickets are
// backfilled silently on first read and `teamflow tidy` is the explicit
// way to say "no, actually publish it".
//
// And two rules about how a pass behaves rather than what it repairs:
//
// **One bad repair never blocks the rest.** A refusal that cannot
// succeed on a retry quarantines that one repair with its reason and
// the pass carries on; nothing here stops a pass early. A send the
// service could not take because it was not answering never reaches
// that code at all -- `sendReport` queues it and the outbox owns the
// retry -- so a backoff here would be a second clock over one fact.
//
// **Never between a ticket and its own report.** The hook path runs a
// slice of this, inside `failOpen`, after the publish the hook was
// going to make anyway. A throw here is swallowed and exits 0, so a bug
// in reconciliation shows up as tickets that silently stop advancing —
// which means it must never be able to stop one.

import fs from 'node:fs';
import path from 'node:path';

import {
  TRIGGER_STAGES, cardFor, publishCard, readTracker, readWriteBack, trackerAskLines,
} from './card.mjs';
import {
  dataDir, fitsRun, isOver, organisationScope, readJson, readWorkflows, saveSession, sessionPath,
  writeJson, writeWorkflows,
} from './core.mjs';
import { projectFor, projectsCachePath } from './project.mjs';
import {
  autoCreate, cardOwed, cardSaid, homeRun, moveNode, openTickets, publish,
} from './workflow.mjs';

/**
 * How long a run may say nothing before it is drawn as ended.
 *
 * `src/lib/freshness.ts`'s last band: 30 minutes with no event at all
 * is `idle` on the dashboard already, so this is the plugin agreeing
 * with what the board has been drawing rather than a second threshold.
 */
export const IDLE_MS = 30 * 60 * 1000;

/**
 * The one idle clock (MACLEOD-639). The service serves the organisation's
 * `idle_after` in the bundle as `idleAfter` (minutes), and the sweep, the
 * board's freshness band and this pass must all read the same number or
 * a run is ended by one and drawn live by another. A caller that has read
 * the bundle passes it as `served`; a plugin config may spell it under
 * `delivery.idle_after`; otherwise `IDLE_MS` stands. A value that is not
 * a positive number is ignored, because "no idle clock" is the bug.
 */
export function idleClock({ served, config } = {}) {
  const minutes = [served?.idleAfter, served?.idle_after, config?.delivery?.idle_after, config?.delivery?.idleAfter]
    .map(Number).find((n) => Number.isFinite(n) && n > 0);
  return minutes ? minutes * 60 * 1000 : IDLE_MS;
}

/**
 * How long an empty planning run waits before `teamflow tidy` offers to
 * retire it.
 *
 * A week, not a night. Nothing here can tell "abandoned" from "created
 * on Friday evening and meant for Monday", and 24 hours called the
 * second one the first. Retiring is reversible — `find()` still
 * resolves an archived run by name and `workflow status running`
 * restores it — but a picker that quietly loses somebody's draft over a
 * weekend is a tool they stop trusting.
 */
export const EMPTY_RUN_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The bound on a pass nobody asked for: the gate repair's, for the same
 * reasons. A repair is never urgent — the next command does the rest —
 * and a command that sits through forty timeouts because the service is
 * unreachable has turned a quiet correction into the slowest thing on
 * the machine.
 */
export const LIMIT = 12;

/**
 * The bound on a pass somebody typed.
 *
 * `teamflow tidy` is somebody asking for the tenant to be tidy, and
 * finishing a twelfth of the job would be answering a different
 * question. It still stops at the first service that is not answering,
 * and the ceiling is a runaway guard rather than a policy.
 */
export const FULL = 2000;

/** What the last pass did, so `status` and `doctor` can say so. */
export function reportPath() {
  return path.join(dataDir(), 'reconcile.json');
}

export function lastPass() {
  return readJson(reportPath());
}

export function notePass(pass) {
  try { writeJson(reportPath(), pass); } catch { /* a cache, not a promise */ }
}

/** One line about the last pass, or nothing. Read by status and doctor. */
export function reconcileLine(pass = lastPass()) {
  if (!pass?.at) return undefined;
  const quarantined = Object.values(pass.quarantined || {});
  const parts = [];
  parts.push(pass.done?.length
    ? pass.done.map((one) => one.what).join('; ')
    : 'nothing to repair');
  if (pass.owed) parts.push(`${pass.owed} still owed`);
  /*
   * Named, with the reason, because a quarantined repair is the one
   * that will not fix itself: the service refused it and re-sending the
   * same thing cannot change the answer. It is how "the service does
   * not know the word `archived` yet" reaches a person instead of
   * becoming one refused POST per `Stop` for ever.
   */
  if (quarantined.length) {
    parts.push(`${quarantined.length} quarantined (${quarantined[0].reason}`
      + `${quarantined.length > 1 ? ', and others' : ''}) — \`teamflow tidy\` retries them`);
  }
  return `last tidy ${pass.at}: ${parts.join('; ')}`;
}

// --- what is owed -----------------------------------------------------

const age = (when, now) => now - new Date(when || 0).getTime();

/**
 * Every ticket this organisation's runs hold, by key, newest run first.
 *
 * The one place that decides which run speaks for a key, and every
 * repair goes through it. A key in two runs used to be answered by
 * whichever `Object.values` happened to yield first, which is file
 * order — so a run that stalled last week could out-shout the run that
 * is working the ticket now.
 */
function ticketsByKey(workflows) {
  const out = new Map();
  const runs = Object.values(workflows)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  for (const workflow of runs) {
    for (const ticket of workflow.tickets || []) {
      if (!out.has(ticket.key)) out.set(ticket.key, { workflow, ticket });
    }
  }
  return out;
}

/**
 * What the board has been told, for a run written before this version.
 *
 * Absence of `ticket.card` means "we do not know", not "the board needs
 * telling", and reading it the second way would put a customer's whole
 * history on the wire — a report and a credit apiece — the first time
 * the new plugin ran a hook. So a run that is not `running` has its
 * tickets' hints filled in from their own verdicts, silently, and the
 * upgrade costs nothing.
 *
 * A `running` run is left alone on purpose: it is the live one, its
 * cards genuinely may be behind, and repairing them is the thing this
 * whole module exists for. `teamflow tidy` is how somebody says
 * "publish the finished ones too" — it clears no hint, but the hints it
 * wrote here are the honest record of what was never sent, and a person
 * who wants those cards on the board moves the ticket again.
 *
 * Returns how many it filled, and mutates the state the caller saves.
 */
export function backfillCards(state) {
  let touched = 0;
  for (const workflow of Object.values(state.workflows || {})) {
    /*
     * Once per run, ever. The stamp is what separates "this version has
     * never seen this run" from "this version has seen it and a repair
     * is outstanding" — and without it the two are the same absence.
     * A run whose card the tracker refused, and which then reached
     * `done`, would have that refusal quietly backfilled away on the
     * next pass, which is the divergence disappearing rather than being
     * repaired.
     *
     * Local and additive, like `gates` and `card`: `published()` names
     * neither, and a plugin that has never heard of it reads the
     * document exactly as it did (MACLEOD-583's rule).
     */
    if (workflow.cardsKnown) continue;
    workflow.cardsKnown = true;
    touched += 1;
    /*
     * A LIVE run is stamped but not filled: its cards genuinely may be
     * behind, and repairing them is what this whole module exists for.
     *
     * Live is `isOver`, from core.mjs, and not `status === 'running'`.
     * That asked a narrower question and answered it wrongly for a
     * `blocked` run, which is live by every other measure here --
     * `openTickets` counts a blocked ticket as open and `finishRun`
     * refuses to finish over one. Filling its hints at upgrade and
     * stamping it would silence its stale cards for ever: nothing would
     * ever owe them again, `tidy` included, and "somebody moves the
     * ticket again" is exactly what nobody does on a blocked run.
     */
    if (!isOver(workflow)) continue;
    for (const ticket of workflow.tickets || []) {
      if (ticket.card) continue;
      const card = cardFor(ticket);
      if (!card) continue;
      ticket.card = { stage: card.stage, status: card.status };
    }
  }
  return touched;
}

/** A stable name for one repair, so outcomes match by identity. */
function repairId(repair) {
  if (repair.kind === 'card') return `card:${repair.key}`;
  if (repair.kind === 'execution') return `execution:${repair.sessionId}:${repair.agentKey || ''}`;
  if (repair.kind === 'binding') return `binding:${repair.file}`;
  if (repair.kind === 'misfiled') return `misfiled:${repair.workflowId}:${repair.key}`;
  return `${repair.kind}:${repair.workflowId}`;
}

/**
 * Actors of this organisation that are claiming to run and are not.
 *
 * Split out from `planRepairs` because it is the whole of what the fast
 * path does, and the fast path must not walk 144 workflows to find out
 * it has nothing to do (audit finding 10).
 *
 * `exceptSession` is the session the event belongs to (audit finding
 * 11). A session being resumed has a row whose `updatedAt` is from
 * whenever it last did anything — yesterday, for a `--resume` — so
 * without this a `SessionStart` would publish an end for the agent that
 * is about to carry on working. It self-heals on the next publish, and
 * a board that flickers an agent to ended on every resume is still
 * wrong.
 */
export function planSilentActors(actors = [], { now = Date.now(), idleMs = IDLE_MS, finished, exceptSession } = {}) {
  const out = [];
  for (const actor of actors) {
    if (actor.status !== 'running') continue;
    if (exceptSession && actor.sessionId === exceptSession) continue;
    const key = actor.binding?.key;
    const over = finished ? finished(key) : false;
    const silent = age(actor.updatedAt, now) > idleMs;
    if (!over && !silent) continue;
    out.push({
      kind: 'execution',
      sessionId: actor.sessionId,
      agentKey: actor.agentKey,
      key,
      // Which of the two it was, because they are different facts and a
      // reader of `teamflow status` is entitled to know which.
      what: `${key || 'a run'} still open${over ? ' on a finished ticket' : ' and silent'}`,
    });
  }
  return out;
}

/**
 * The four divergences, as a list of repairs. Pure.
 *
 * Pure because the whole value of `--dry-run` is that it is the same
 * function: a preview built by a second code path is a preview of
 * something else. `reconcile` below takes this list and pays it.
 *
 * `deep` says whether the caller can ask the tracker. Two repairs need
 * that answer and neither is offered without it — a terminal card,
 * which can move a real issue, and retiring an empty run, which nothing
 * unasked should do.
 */
export function planRepairs({
  workflows = {}, actors = [], bindings = [], now = Date.now(),
  idleMs = IDLE_MS, emptyMs = EMPTY_RUN_MS, deep = false, exceptSession,
  repos = {}, homes = new Map(),
} = {}) {
  const repairs = [];
  const held = ticketsByKey(workflows);

  // 1. A card whose run verdict is ahead of its published stage —
  //    from the newest run holding the key, and from no other.
  for (const [key, { workflow, ticket }] of held) {
    const card = cardOwed(ticket);
    if (!card) continue;
    /*
     * A card at a stage the service's write-back fires on is not a
     * redraw: it moves a real issue in a customer's tracker. It is
     * offered only where the tracker can be asked, and `pay` then
     * refuses it unless the tracker agrees. Non-terminal stages cannot
     * move anything and need no read — which is also what keeps the
     * hook path free of one.
     */
    const terminal = TRIGGER_STAGES.includes(card.stage);
    if (terminal && !deep) continue;
    repairs.push({
      kind: 'card',
      key,
      workflowId: workflow.id,
      card,
      confirm: terminal,
      what: `${key} → ${card.stage}`,
    });
  }

  // 2. An execution still claiming to be running that is not.
  repairs.push(...planSilentActors(actors, {
    now,
    idleMs,
    exceptSession,
    finished: (key) => Boolean(key) && held.get(key)?.ticket.state === 'done',
  }));

  // 3. A run that is over, and a run that never started.
  for (const workflow of Object.values(workflows)) {
    if (workflow.status === 'running' && (workflow.tickets || []).length
        && !openTickets(workflow).length) {
      repairs.push({
        kind: 'run-done',
        workflowId: workflow.id,
        what: `"${workflow.name}" has nothing open`,
      });
      continue;
    }
    /*
     * Retiring somebody's empty run is not something an unprompted pass
     * does (audit finding 8). Nothing here can tell "abandoned" from
     * "the laptop was shut", and a `Stop` hook that quietly takes a
     * draft out of the pickers over a weekend is a tool people stop
     * trusting. `teamflow tidy` lists it and does it.
     */
    if (deep && workflow.status === 'planning' && !(workflow.tickets || []).length
        && age(workflow.updatedAt || workflow.createdAt, now) > emptyMs) {
      repairs.push({
        kind: 'run-archived',
        workflowId: workflow.id,
        what: `"${workflow.name}" is empty and a week old`,
      });
    }
  }

  // 4. A binding on a ticket the run has finished. Only a CANDIDATE
  //    here: whether the tracker agrees is a network read, and this
  //    function does none. `reconcile` confirms it before releasing.
  for (const binding of bindings) {
    const key = binding.key;
    if (!key || held.get(key)?.ticket.state !== 'done') continue;
    repairs.push({
      kind: 'binding',
      key,
      file: binding.file,
      what: `the binding on ${key}, whose run is finished`,
    });
  }

  // 5. A node in a run of another project (MACLEOD-761): an agent of one
  //    repository that joined the run another session made. Only a node
  //    whose home is known, and only an open one.
  repairs.push(...planMisfiled({ workflows, repos, homes }));

  return repairs.map((repair) => ({ ...repair, id: repairId(repair) }));
}

const LIVE = (w) => Boolean(w) && !['done', 'cancelled', 'archived'].includes(w.status);

/**
 * Where each open node's work comes from: the repository and project
 * stamped on it when it was dispatched, else the one repository every
 * actor reporting under its key is in. Unknown when they disagree.
 */
export function ticketHomes(workflows = {}, actors = [], projects = []) {
  const homes = new Map();
  const seen = new Map();
  for (const actor of actors) {
    const key = actor?.binding?.key;
    const repo = String(actor?.reportedRepository || '').trim().toLowerCase();
    if (!key || !repo) continue;
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(repo);
  }
  const projectOf = (repo) => {
    try { return projectFor(repo, projects)?.name; } catch { return undefined; }
  };
  for (const workflow of Object.values(workflows)) {
    for (const ticket of workflow.tickets || []) {
      if (homes.has(ticket.key)) continue;
      if (ticket.repo || ticket.project) {
        homes.set(ticket.key, { repo: ticket.repo, project: ticket.project || projectOf(ticket.repo) });
        continue;
      }
      const repos = seen.get(ticket.key);
      if (repos?.size !== 1) continue;
      const [repo] = repos;
      homes.set(ticket.key, { repo, project: projectOf(repo) });
    }
  }
  return homes;
}

/** Each open node whose home does not fit its run, and the run it goes to. */
export function planMisfiled({ workflows = {}, repos = {}, homes = new Map() } = {}) {
  const out = [];
  for (const run of Object.values(workflows)) {
    if (!LIVE(run)) continue;
    for (const ticket of run.tickets || []) {
      if (['done', 'skipped'].includes(ticket.state)) continue;
      const home = homes.get(ticket.key);
      if (!home || fitsRun(run, home)) continue;
      const holding = Object.values(workflows).find((w) => w.id !== run.id && LIVE(w)
        && fitsRun(w, home) && (w.tickets || []).some((t) => t.key === ticket.key));
      const to = holding || homeRun({ workflows, repos }, home, { except: run.id });
      const where = home.project || home.repo;
      out.push({
        kind: 'misfiled',
        key: ticket.key,
        workflowId: run.id,
        toId: to?.id,
        home,
        what: to ? `${ticket.key} goes from "${run.name}" to "${to.name}"`
          : `${ticket.key} goes from "${run.name}" to a new run for ${where}`,
      });
    }
  }
  return out;
}

// --- reading what this organisation holds ------------------------------

/** Every actor state this organisation wrote on this machine. */
export function ownActors(config = {}) {
  const dir = path.join(dataDir(), 'sessions');
  if (!fs.existsSync(dir)) return [];
  const mine = organisationScope(config);
  if (!mine) return [];
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson(path.join(dir, name)))
      .filter((state) => state && state.account === mine);
  } catch {
    return [];
  }
}

/** Every user binding this organisation holds, with the file it is in. */
export function ownBindings(config = {}) {
  const scope = organisationScope(config);
  if (!scope) return [];
  const dir = path.join(dataDir(), 'bindings', scope);
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const file = path.join(dir, name);
        const held = readJson(file);
        return held?.jiraKey ? { file, key: held.jiraKey, tracker: held.tracker } : undefined;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// --- paying them -------------------------------------------------------

// The tracker's own words for "a person has decided". Mirrors CLOSED in
// adapters/teamflow/writeback.py.
const FINISHED = new Set(['done', 'cancelled', 'deleted']);

/**
 * Whether the tracker agrees that this ticket may be closed.
 *
 * The whole of audit finding 1. A run that verified MACLEOD-587 last
 * week is not evidence about an issue a person reopened this morning,
 * and republishing `DEV_VERIFIED` would ask the service's write-back to
 * move the live issue to Done — unprompted, from a hook, with nobody
 * having said anything.
 *
 * Four answers, in the order they are cheap:
 *
 *  - cannot be read: NO. Uncertainty is not permission; the repair
 *    stays owed and is listed.
 *  - no tracker has ever mentioned the key: yes. There is nothing to
 *    move, so the card is only a card.
 *  - the tracker says done, cancelled or deleted: yes. The card is
 *    catching up with what the tracker already decided.
 *  - anything else: yes only if the tracker has not spoken SINCE the
 *    run's verdict. A tracker that said "In Progress" before the run
 *    verified the ticket is simply behind, which is the case write-back
 *    exists for. One that spoke afterwards — a reopen, a person moving
 *    it back — is contradicting the verdict, and the run loses.
 */
export function trackerAgrees(tracker, ticket) {
  if (!tracker?.known) return { ok: false, why: 'the tracker could not be read' };
  if (!tracker.connected) return { ok: true };
  if (FINISHED.has(tracker.event)) return { ok: true };
  if (tracker.event === 'reopened') {
    return { ok: false, why: `${tracker.provider || 'the tracker'} says somebody reopened it` };
  }
  /*
   * Parsed, never compared as text. `occurredAt` comes through the
   * kit's `iso()`, which writes `+00:00`; `ticket.updatedAt` is JS
   * `toISOString()`, which writes `.000Z`. Lexicographically `+` sorts
   * below `Z`, so two instants that agree to the millisecond compare
   * the wrong way round and a later tracker event reads as not-later.
   * One millisecond wide, and the `reopened` test above is the real
   * guard -- but parsing costs nothing and retires the whole class.
   */
  const spoke = Date.parse(tracker.occurredAt || tracker.updatedAt || '');
  const verdict = Date.parse(ticket?.updatedAt || '');
  if (Number.isFinite(spoke) && Number.isFinite(verdict) && spoke > verdict) {
    return {
      ok: false,
      why: `${tracker.provider || 'the tracker'} has said something about it since the run's result`,
    };
  }
  return { ok: true };
}

/**
 * Run a pass. Bounded, idempotent, and it says what it did.
 *
 * `deep` is what separates a `teamflow tidy` from the slice a hook
 * runs: three things need the tracker's own answer or a person's
 * intent, and a hook asks for none of them.
 *
 * `announce` is called once, before anything is paid, with the lines
 * saying what this pass is about to ask of somebody's tracker. A pass
 * that may move real issues says so first — and says only what the
 * sidecars and the organisation's write-back settings actually support
 * (MACLEOD-603), never what it merely hopes will result.
 *
 * `dryRun` pays nothing and changes nothing, including the record of
 * the pass — printing a plan is not doing it.
 */
export async function reconcile(config = {}, {
  limit = LIMIT, now = Date.now(), dryRun = false, deep = false, exceptSession,
  at = new Date().toISOString(), announce, served, idleMs = idleClock({ served, config }),
} = {}) {
  const state = readWorkflows(config);
  /*
   * Before anything is planned, and never on a dry run: a run written
   * before this version has no hint on its tickets, and absence means
   * "we do not know what the board has been told" rather than "tell it".
   */
  const touched = backfillCards(state);
  // In memory either way, on disk only for a real pass. A dry run has
  // to show what a real pass would do — listing a finished run's whole
  // history as owed would be a preview of something that never happens
  // — and it still changes nothing anybody can observe afterwards.
  if (touched && !dryRun) writeWorkflows(state, config);

  const held = lastPass() || {};
  /*
   * A pass somebody typed retries what a pass nobody asked for gave up
   * on. The quarantine exists so a repair the service refuses is not
   * re-sent on every `Stop` for ever; a person asking again is exactly
   * the event that might have changed the answer — they deployed.
   */
  const carried = deep ? {} : (held.quarantined || {});

  const actors = ownActors(config);
  let projects = [];
  try { projects = readJson(projectsCachePath(config))?.projects || []; } catch { /* no cache: homes by stamp only */ }
  const all = planRepairs({
    workflows: state.workflows,
    actors,
    repos: state.repos,
    homes: ticketHomes(state.workflows, actors, projects),
    bindings: deep ? ownBindings(config) : [],
    now,
    idleMs,
    deep,
    exceptSession,
  });
  /*
   * Pruned to what is actually in the plan, every pass. Inheriting the
   * map wholesale kept entries for repairs nothing can plan any more --
   * 144 `run-archived` ids that only a `deep` pass produces, held for
   * ever by every shallow pass that re-saved them -- so `reconcile.json`
   * grew between tidies and `teamflow status` stayed noisy about work
   * that no longer exists. An entry survives exactly as long as its
   * repair does.
   */
  const quarantined = Object.fromEntries(
    all.filter((repair) => carried[repair.id]).map((repair) => [repair.id, carried[repair.id]]));
  const repairs = all.map((repair) => ({
    ...repair,
    quarantined: quarantined[repair.id]?.reason,
  }));
  // Each repair counted once: quarantined is a state of its own, and
  // adding it to `owed` as well reported the same repair twice.
  const owedOf = (done) => repairs.length - done - Object.keys(quarantined).length;

  /*
   * What this pass may honestly say about the tracker (MACLEOD-603),
   * read once from the two documents `cardLine` reads. Only a card at a
   * trigger stage can move a real issue and `planRepairs` offers none
   * of those unless `deep`, so the hook path adds no reads at all.
   *
   * The sidecars are kept on the repairs because `pay` needs the same
   * answer a moment later: reading the same document twice in one pass
   * is only a chance for the two answers to disagree.
   */
  const terminal = repairs.filter((one) => one.confirm && !one.quarantined);
  let trackerLines = [];
  if (terminal.length) {
    const writeBack = await readWriteBack(config).catch(() => ({ known: false }));
    for (const repair of terminal) {
      repair.tracker = await readTracker(repair.key, config).catch(() => ({ known: false }));
    }
    trackerLines = trackerAskLines(
      terminal.map((one) => ({ key: one.key, tracker: one.tracker })), writeBack, { dryRun },
    );
  }

  if (dryRun) {
    return { repairs, done: [], owed: owedOf(0), at, dryRun: true, quarantined, trackerLines };
  }

  const payable = repairs.filter((one) => !one.quarantined);
  if (announce && trackerLines.length) announce(trackerLines);

  const done = [];
  for (const repair of payable) {
    if (done.length >= limit) break;
    let result;
    try {
      result = await pay(repair, state, config, { at, deep });
    } catch {
      // Fail open, exactly like every other path a hook can reach. A
      // repair that throws is a repair still owed.
      result = { landed: false };
    }
    if (result.landed) {
      done.push({ id: repair.id, kind: repair.kind, what: repair.what });
      delete quarantined[repair.id];
      continue;
    }
    if (result.refused) {
      /*
       * Re-posting the same body cannot change the answer (audit
       * finding 2). Live example: a plugin merged ahead of its deploy
       * asks a service that has never heard of `archived` to store one,
       * is refused 400, and without this retries it on every `Stop` for
       * ever — one refused request each time, each of which may cost
       * the customer a credit, with every repair behind it blocked. The
       * reason is kept and surfaced; `teamflow tidy` is how somebody
       * says "I have deployed, try again".
       */
      quarantined[repair.id] = {
        what: repair.what, reason: result.reason || 'the service refused it', status: result.status, at,
      };
    }
    /*
     * Everything else — a tracker that could not confirm, a binding
     * waiting on somebody, a machine with no credential — is skipped
     * and stays owed. Nothing stops the pass: one unreadable sidecar
     * must not halt every repair behind it, on every pass, for ever.
     *
     * There is deliberately no backoff here, and no second retry
     * schedule. A send that failed because the service was not
     * answering does not reach this code at all: `sendReport` queues it
     * and answers `queued`, which counts as landed, and the outbox owns
     * the backoff from there (`scheduleRetry`, `retryDelayMs`). A timer
     * here would be a second clock over the same fact.
     */
  }
  if (done.length) writeWorkflows(state, config);
  const pass = {
    at,
    done,
    owed: owedOf(done.length),
    ...(Object.keys(quarantined).length ? { quarantined } : {}),
  };
  notePass(pass);
  return { ...pass, repairs };
}

/**
 * One repair. Says whether it landed and, if not, which kind of not.
 *
 * `{ retry: true }` is a service that is not answering; `{ refused:
 * true }` is one that answered no and will answer no again; neither is
 * a repair that was simply not confirmed. The local record moves only
 * after the wire says the report landed — a queued report counts,
 * because the outbox will deliver it — so a pass that could not reach
 * the service leaves every repair exactly as owed as it found it.
 *
 * `flush: false` on every send. This is itself a bounded background
 * pass, and a flush is up to five more requests behind each one.
 */
/**
 * Why a send did not land, and whether it is worth trying again.
 *
 * Only a real refusal FROM THE SERVICE is quarantined — a status of 400
 * or more, which is the service having read the report and said no. Two
 * other answers reach here and neither is that:
 *
 *  - `skipped`: this machine has no credential, so nothing was sent.
 *  - `refused` with no status: the organisation check at the send point
 *    stopped it, because the credential in hand belongs to somebody
 *    else. Nothing was sent then either.
 *
 * Quarantining those was live on a real machine (MACLEOD-601 audit,
 * round two): a session that died left a `Stop` hook signed out, every
 * repair it touched was quarantined as though the service had rejected
 * it, and signing back in did not release them — only an explicit
 * `tidy` would. Both are skip-and-stay-owed, which is what the
 * catch-all in `reconcile` always said they were.
 */
function notLanded(sent) {
  const status = Number(sent?.status);
  if (Number.isFinite(status) && status >= 400) {
    return { refused: true, reason: sent.reason, status };
  }
  return { reason: sent?.reason };
}

async function pay(repair, state, config, { at, deep }) {
  const workflow = state.workflows[repair.workflowId];

  if (repair.kind === 'card') {
    const ticket = (workflow?.tickets || []).find((one) => one.key === repair.key);
    if (!ticket) return { landed: false };
    if (repair.confirm) {
      if (!deep) return { landed: false };
      // Read once for the whole pass, by `reconcile`, so the sentence it
      // printed before paying and the gate here are the same answer.
      const tracker = repair.tracker || await readTracker(repair.key, config);
      const agrees = trackerAgrees(tracker, ticket);
      if (!agrees.ok) return { landed: false, why: agrees.why };
    }
    const sent = await publishCard(repair.key, repair.card, { workflow, config, at, flush: false });
    if (!sent.ok && !sent.queued) {
      return { landed: false, ...notLanded(sent) };
    }
    cardSaid(ticket, repair.card);
    return { landed: true };
  }

  if (repair.kind === 'execution') {
    // No publish of its own: the flag is what MACLEOD-574's bounded,
    // fail-open flusher already delivers, and it already leaves an
    // undelivered end owed.
    const actor = readJson(sessionPath(repair.sessionId, repair.agentKey));
    if (!actor || actor.status !== 'running') return { landed: false };
    saveSession({
      ...actor,
      ended: true,
      status: 'idle',
      agent: actor.agent ? { ...actor.agent, endedAt: actor.agent.endedAt || at } : actor.agent,
      pendingEnd: Boolean(actor.binding?.key),
      updatedAt: at,
    });
    return { landed: true };
  }

  if (repair.kind === 'run-done' || repair.kind === 'run-archived') {
    if (!workflow) return { landed: false };
    const was = workflow.status;
    workflow.status = repair.kind === 'run-done' ? 'done' : 'archived';
    workflow.updatedAt = at;
    const sent = await publish(workflow, config, { flush: false });
    if (sent.ok || sent.queued) return { landed: true };
    // Rolled back, so the next pass owes it again rather than believing
    // it has already been done.
    workflow.status = was;
    return { landed: false, ...notLanded(sent) };
  }

  if (repair.kind === 'misfiled') {
    if (!workflow || !(workflow.tickets || []).some((t) => t.key === repair.key)) return { landed: false };
    let to = state.workflows[repair.toId];
    if (!to) {
      // A run of its own for that repository, made by the plugin; the
      // machine's old `current` is left where it was.
      const was = state.current;
      to = autoCreate(state, `${repair.home?.project || 'Unplanned'} run`, workflow.actor);
      state.current = was;
      if (repair.home?.repo) to.repo = repair.home.repo;
      if (repair.home?.project) to.project = repair.home.project;
      repair.toId = to.id;
    }
    moveNode(workflow, to, repair.key, { at });
    // The move is made on this machine; a publish that does not land is
    // sent again with the run's next change.
    for (const run of [workflow, to]) { try { await publish(run, config, { flush: false }); } catch { /* saved here */ } }
    return { landed: true };
  }

  if (repair.kind === 'binding') {
    // The run saying a ticket is done is the skill's word; releasing the
    // binding hands the next edit in that repository to whatever it is
    // actually about, and doing that while the tracker still has the
    // issue open would be the tool overruling the person who holds it.
    if (!deep) return { landed: false };
    const tracker = await readTracker(repair.key, config);
    if (!tracker.known || !tracker.connected || !FINISHED.has(tracker.event)) {
      return { landed: false };
    }
    try { fs.unlinkSync(repair.file); } catch { return { landed: false }; }
    return { landed: true };
  }

  return { landed: false };
}

/**
 * The slice a hook runs, after the publish it was going to make anyway.
 *
 * Two repairs, no tracker reads and no outbox flush behind them, so the
 * marginal cost on `Stop` is two requests rather than two plus ten.
 * `SessionStart` is on the fast path, where the tool is waiting: it
 * reads `sessions/` and nothing else — never the workflow store, which
 * on the tenant this ticket describes is 146 documents to conclude
 * there is nothing to do — and posts nothing at all.
 *
 * Never throws. The caller is inside `failOpen`, which would swallow it
 * and exit 0, so a bug here would show up as tickets that silently stop
 * advancing rather than as an error anybody sees.
 */
export async function reconcileOnHook(config = {}, { network = true, limit = 2, sessionId } = {}) {
  try {
    if (!network) {
      const dir = path.join(dataDir(), 'sessions');
      if (!fs.existsSync(dir)) return 0;
      const now = Date.now();
      const at = new Date().toISOString();
      const repairs = planSilentActors(ownActors(config), { now, idleMs: idleClock({ config }), exceptSession: sessionId })
        .slice(0, limit)
        .map((one) => ({ ...one, id: `execution:${one.sessionId}:${one.agentKey || ''}` }));
      if (!repairs.length) return 0;
      const state = readWorkflows(config);
      for (const repair of repairs) await pay(repair, state, config, { at, deep: false });
      return repairs.length;
    }
    const pass = await reconcile(config, { limit, deep: false, exceptSession: sessionId });
    return pass.done.length;
  } catch {
    return 0;
  }
}

/** `teamflow tidy [--dry-run]`, and `teamflow workflow reconcile`. */
export function renderPass(pass) {
  const out = [];
  if (!pass.repairs.length) {
    out.push('Nothing to reconcile: the runs, the cards, the executions and the bindings agree.');
    return out.join('\n');
  }
  // What it costs, on the dry run, because every repair but an
  // execution's is a report and a report is a credit. Somebody about to
  // retire 144 leaked runs is entitled to know that before they do it.
  const reports = pass.repairs.filter((one) => one.kind !== 'execution').length;
  out.push(pass.dryRun
    ? `${pass.repairs.length} divergence${pass.repairs.length === 1 ? '' : 's'}, `
      + `${reports} report${reports === 1 ? '' : 's'} to send, and TeamFlow changed nothing:`
    : `${pass.repairs.length} divergence${pass.repairs.length === 1 ? '' : 's'}:`);
  /*
   * Matched by id and never by the sentence (audit finding 6). Two
   * repairs can print the same words, and this is the list the build
   * skill gates a phase on: one landing and one not must not both read
   * as repaired.
   */
  const paid = new Set(pass.done.map((one) => one.id));
  /*
   * What the tracker is actually being asked for, and nothing this side
   * cannot know (MACLEOD-603). `reconcile` built these lines from the
   * sidecars and the organisation's write-back settings; a real pass
   * says the same ones through `announce`, before it pays.
   */
  if (pass.dryRun) for (const line of pass.trackerLines || []) out.push(`  ${line}`);
  for (const repair of pass.repairs) {
    const how = paid.has(repair.id) ? 'repaired'
      : repair.quarantined ? `refused  (${repair.quarantined})`
        : 'owed';
    out.push(`  ${how}  ${repair.what}`);
  }
  if (!pass.dryRun && pass.owed) {
    out.push(`${pass.owed} still owed. A repair is never urgent; the next command does the rest. `
      + 'Run this again until it says nothing to reconcile.');
  }
  return out.join('\n');
}
