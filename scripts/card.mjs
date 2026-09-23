#!/usr/bin/env node
// The ticket's own card, published from the run's verdict about it.
//
// MACLEOD-601. `teamflow workflow ticket KEY --state done --cycle
// verified` recorded the run's verdict and wrote the gate sidecars
// (MACLEOD-593), and never moved the card's own stage. The merge and
// the deploy happen in the orchestrator's session, bound to some other
// key, so nothing attributed them to the tickets they shipped: 31 cards
// on one live tenant carried a stale last stage, eleven of them saying
// `LOCAL_DEV / running` about agents that had finished sixteen hours
// earlier. Only the tracker's Done stamp hid them, and where the
// tracker was behind, they showed.
//
// A run's verdict on a ticket is a fact, and a fact is written once and
// read everywhere. So the transition publishes the card too.
//
// Three boundaries decide what is in here.
//
// **The stage is a table, not a judgement.** One mapping from (state,
// cycle) to the stage the board draws, tested against the same contract
// the classifier is tested against. A second place that decides a stage
// by reasoning about a ticket is a second classifier, and two
// classifiers drift.
//
// **The plugin holds no tracker credential.** Linear, GitHub and Jira
// are moved by the service's own write-back, from the report this
// publishes, with credentials the connection holds. What the CLI does
// is read back what the tracker now says and print it -- so a ticket
// the tracker is behind on is a sentence somebody can act on rather
// than a silence.
//
// **Never on the hook path.** Everything here does network reads with
// nothing queued behind them. A hook that waits on one is a hook
// standing between a ticket and its own report.

import crypto from 'node:crypto';
import {
  actor,
  fetchState,
  issueProject,
  issueUrl,
  reportScope,
  sendReport,
  tenantId,
  trackerOf,
} from './core.mjs';

// --- the table -------------------------------------------------------

/**
 * The stage the board draws for a ticket standing at each cycle.
 *
 * `status` is the run's own word for "I am about to move the tracker's
 * ticket", which on the board is the merge: the code is going in. It is
 * the one row whose name does not read like its stage, and it is named
 * for the step in the build skill rather than for the column.
 *
 * `rework` as a CYCLE (rather than as a state) is a ticket whose team
 * is writing code again, so it draws where writing code draws.
 */
export const CYCLE_STAGE = {
  build: 'LOCAL_DEV',
  test: 'LOCAL_TEST',
  audit: 'LOCAL_AUDIT',
  status: 'MERGE',
  deploy: 'DEPLOY_DEV',
  verified: 'DEV_VERIFIED',
  rework: 'LOCAL_DEV',
};

/** The gates a rework falls back from on this machine, not on dev. */
const LOCAL_GATES = new Set(['build', 'test', 'audit', 'status', 'rework']);

/** What each cycle is called in a sentence. Mirrors GATES in workflow.mjs. */
const CYCLE_WORDS = {
  build: 'build',
  test: 'test check',
  audit: 'audit check',
  status: 'merge',
  deploy: 'deploy',
  verified: 'verification',
  rework: 'rework',
};

/**
 * What the board should draw for this ticket, or nothing.
 *
 * One table, (state, cycle) -> stage, and the whole of section A rests
 * on it being a table: the run already decided everything this needs,
 * and re-deriving a stage by reasoning about the ticket would be a
 * second classifier beside `classifyTool`.
 *
 * `skipped` is the one pair that publishes nothing, and deliberately.
 * A run that skipped a ticket did no work on it, so it has nothing to
 * say about the code; writing a stage would move a card on the strength
 * of a decision not to touch it. The ticket stays wherever it was.
 *
 * `done` is past every gate whatever cycle it stopped at, which is the
 * same rule `gateStatuses` applies to the gate chips: a ticket cannot
 * be finished with a gate still to pass.
 */
export function cardFor(ticket = {}) {
  const state = ticket.state;
  const cycle = ticket.cycle;
  if (state === 'skipped') return undefined;

  const at = CYCLE_STAGE[cycle];
  const where = CYCLE_WORDS[cycle];

  if (state === 'done') {
    // Verified is the run's last word, and the stage the service's
    // write-back fires on. Every earlier cycle is a step the ticket
    // finished, drawn where that step happens.
    const stage = cycle && cycle !== 'verified' && at ? at : 'DEV_VERIFIED';
    return {
      stage,
      status: 'success',
      summary: stage === 'DEV_VERIFIED'
        ? 'Done in the plan'
        : `Past the ${where}`,
    };
  }

  if (state === 'rework') {
    const from = at || 'LOCAL_DEV';
    return {
      stage: LOCAL_GATES.has(cycle || 'rework') ? 'LOCAL_REWORK' : 'DEV_REWORK',
      status: 'failed',
      reworkFrom: from,
      summary: `Sent back from the ${where || 'run'}`,
    };
  }

  if (state === 'running') {
    return {
      stage: at || 'LOCAL_DEV',
      status: 'running',
      summary: at ? `At the ${where}` : 'Running',
    };
  }

  if (state === 'blocked') {
    return {
      stage: at || 'BACKLOG',
      status: 'blocked',
      summary: at ? `Blocked at the ${where}` : 'Blocked',
    };
  }

  // `waiting`, and anything a newer plugin version writes that this one
  // has never heard of: the run is holding the ticket and has not
  // started it. A cycle it is waiting AT still says where it is queued.
  return {
    stage: at || 'BACKLOG',
    status: 'waiting',
    summary: at ? `Waiting at the ${where}` : 'Waiting in the run',
  };
}

// --- the report ------------------------------------------------------

/**
 * The plan's own session block, on every row the plan writes.
 *
 * A run is not a person, and the board had been drawing one as an
 * agent named after the plan (MACLEOD-639). `session.id` on the wire is
 * a hex digest, so the workflow id travels without its `wf-` prefix --
 * the reader puts it back -- and `tool` says what wrote it in words.
 * `teamflow workflow`'s gate verdicts carry the same block.
 */
export function planSession(workflow) {
  const id = String(workflow?.id || '');
  const hex = /^wf-([0-9a-f]{8,32})$/.exec(id);
  return {
    id: hex ? hex[1] : crypto.createHash('sha256').update(id).digest('hex').slice(0, 12),
    tool: 'teamflow workflow',
    label: String(workflow?.name || 'Workflow').slice(0, 80),
  };
}

/**
 * One execution id per run per ticket.
 *
 * The run's own row on the card, so a later pass rewrites it rather
 * than adding a second. Capped where the service caps an execution id.
 */
export function cardExecutionId(workflowId, key) {
  return `wf-card-${workflowId}-${key}`.replace(/[^A-Za-z0-9._#-]+/g, '-').slice(0, 80);
}

/**
 * The card, as the service takes it.
 *
 * Deliberately the same shape `issuePayload` and `report-cli`'s
 * `buildPayload` produce, because a card the run published and a card a
 * hook published must be indistinguishable on the board. Derived state
 * only: a stage, a status, a short sentence about the verdict and two
 * clocks.
 *
 * `endedAt` is set on every row that is not running, which is what
 * closes an execution still claiming to be going (MACLEOD-601). A board
 * that says somebody is working now on the strength of a sixteen-hour
 * old event is the thing this field exists to stop.
 */
export function cardPayload(key, card, { workflow, config = {}, info = {}, at } = {}) {
  const when = at || new Date().toISOString();
  const tracker = trackerOf(config);
  const act = actor(config, info);
  const summary = String(card.summary || card.stage).slice(0, 180);
  const url = issueUrl(key, tracker, config, info, {});
  const payload = {
    tenantId: tenantId(config),
    tracker,
    jiraKey: key,
    project: issueProject(key, tracker),
    actor: String(act.displayName).slice(0, 80),
    stage: card.stage,
    status: card.status,
    summary,
    updatedAt: when,
    executions: [{
      id: cardExecutionId(workflow?.id || 'run', key),
      at: when,
      source: 'plugin',
      /*
       * A plan, not a person (MACLEOD-639). This row was `kind: claude`,
       * and the board reads a claude row with no agent block as a
       * person's own work -- so every run was drawn as an agent named
       * after the plan. `plan` says what it is, and the session block
       * says which plan, so a reader never has to guess from the id.
       */
      kind: 'plan',
      session: planSession(workflow || { id: 'run', name: 'Workflow' }),
      // Named for the run rather than for whoever typed the command:
      // the fact being published is the RUN's verdict, and a board that
      // attributed it to the orchestrator's laptop would be answering a
      // question nobody asked.
      label: String(workflow?.name || 'Workflow').slice(0, 80),
      stage: card.stage,
      status: card.status,
      summary,
      ...(card.status === 'running' ? {} : { endedAt: when }),
    }],
  };
  if (url) payload.jiraUrl = url;
  if (card.reworkFrom) payload.reworkFrom = card.reworkFrom;
  if (workflow?.id) {
    const ticket = (workflow.tickets || []).find((one) => one.key === key);
    payload.workflow = ticket?.phase !== undefined
      ? { id: workflow.id, phase: ticket.phase }
      : { id: workflow.id };
  }
  /*
   * The gates' verdicts on THIS ticket (MACLEOD-639, ADHOC-19): every
   * audit pass and every round a gate sent it back, the orchestrator's own
   * words, on the card that was judged. Keyed by `key`, never by the
   * session's binding, so an orchestrator bound to a parent issue writes
   * the child's history and leaves its own card alone.
   */
  const judged = (workflow?.tickets || []).find((one) => one.key === key);
  const fields = (source, names) => Object.fromEntries(names
    .filter((name) => source[name] !== undefined && source[name] !== null)
    .map((name) => [name, source[name]]));
  if (Array.isArray(judged?.verdicts) && judged.verdicts.length) {
    payload.verdicts = judged.verdicts.slice(-20).map((one) => fields(one,
      ['round', 'gate', 'verdict', 'at', 'by', 'summary', 'raised', 'fixed', 'open', 'notAdded']));
  }
  // The failure points those rounds raised: the checklist the next team works from.
  if (Array.isArray(judged?.points) && judged.points.length) {
    payload.points = judged.points.slice(-50).map((one) => fields(one,
      ['id', 'gate', 'key', 'text', 'from', 'rounds', 'lastRound', 'state', 'at', 'by', 'doneAt', 'doneRound', 'doneBy']));
  }
  return payload;
}

/**
 * Publish one card, through the organisation check.
 *
 * `account` is named for the same reason every other publisher names
 * it (MACLEOD-586): the comparison at the send point is against the
 * credential the request will actually carry, and it is the only one a
 * session quietly falling back to an API key cannot fool. There is no
 * binding to read here — the key came from the run — so the
 * organisation is the one this machine is reporting for.
 */
export async function publishCard(key, card, options = {}) {
  const { config = {}, flush = true } = options;
  return sendReport('issue', undefined, cardPayload(key, card, options), config, {
    account: reportScope(config), flush,
  });
}

// --- what the tracker now says ----------------------------------------

/**
 * The two stages the service's write-back fires on.
 *
 * Mirrors `TRIGGERS` in adapters/teamflow/writeback.py. It is here
 * because publishing a card at one of these is not a redraw: it asks
 * the service to move a real issue in a customer's tracker, which is
 * why reconciliation treats such a card as a different kind of act
 * (MACLEOD-601 audit, finding 1).
 */
export const TRIGGER_STAGES = ['DEV_VERIFIED', 'DONE'];

/** The write-back stage whose history row proves TeamFlow asked. */
const WROTE_BACK = (stage) => `wrote_back-${stage}`;

/**
 * The tracker's own sidecar for this key, read back from the service.
 *
 * `issues/<KEY>/tracker.json` is written by `adapters/teamflow/tracker.py`
 * from a verified webhook and by nothing else, so it is the one honest
 * answer to "what does Linear say now". Absent for a key no tracker has
 * ever mentioned, which is a different thing from a tracker that is
 * behind and has to read differently.
 */
export async function readTracker(key, config = {}) {
  /*
   * One shape, always, including `wroteBack` (MACLEOD-601 audit,
   * finding 12). The two answers that used to omit it were only ever
   * reached through branches that return before touching it, so a field
   * added here would have been invisible to every test built from a
   * hand-written literal. The shape is the contract; the callers build
   * their fixtures from this function.
   */
  const none = { known: false, connected: false, wroteBack: () => false };
  const got = await fetchState(`issues/${encodeURIComponent(key)}/tracker.json`, config);
  if (!got.ok) return { ...none, reason: got.reason };
  if (got.missing || !got.document) return { ...none, known: true };
  const doc = got.document;
  const history = Array.isArray(doc.history) ? doc.history : [];
  return {
    known: true,
    connected: Boolean(doc.provider),
    provider: String(doc.provider || ''),
    event: String(doc.event || ''),
    status: String(doc.statusName || doc.detail?.status || ''),
    /*
     * When the TRACKER last spoke, which is how a verdict that is ahead
     * of a behind tracker is told from a verdict a person has since
     * contradicted. `occurredAt` is the tracker's own clock on the
     * delivery; `updatedAt` is when the service wrote the sidecar, and
     * is the fallback for one written before that field existed.
     */
    occurredAt: String(doc.occurredAt || doc.updatedAt || ''),
    wroteBack: (stage) => history.some((row) => row?.id === WROTE_BACK(stage)),
  };
}

/** Whether this organisation has turned write-back on, per provider. */
export async function readWriteBack(config = {}) {
  const got = await fetchState('settings/trackers.json', config);
  if (!got.ok) return { known: false };
  return { known: true, settings: got.document || {} };
}

// The tracker's own words for "a person has decided". Mirrors CLOSED in
// adapters/teamflow/writeback.py, which is where the rule lives.
const FINISHED = new Set(['done', 'cancelled', 'deleted']);

/**
 * One truthful sentence about what the card and the tracker now say.
 *
 * It must never claim a ticket is closed everywhere when it is not.
 * That is the whole point of the line: the build skill's step used to
 * be "move the tracker's own ticket with its MCP", a thing an agent has
 * to remember per ticket at 4am, and it was forgotten three times out
 * of nineteen. The step becomes reading this line — so the line has to
 * be worth reading, and it has to say what to do when it is bad news.
 *
 * Pure, so every branch of it is a test rather than a live tenant.
 */
export function cardLine(key, card, tracker, writeBack = {}) {
  const said = `${key}: card ${card.stage}`;
  if (!tracker?.known) {
    return `${said} · tracker not read back (${tracker?.reason || 'no answer from the service'}) — `
      + 'check it yourself before calling this ticket closed';
  }
  if (!tracker.connected) {
    return `${said} · no tracker has ever mentioned ${key}, so nothing there will move — `
      + 'move it yourself, or connect the tracker';
  }
  const where = tracker.provider || 'the tracker';
  const name = tracker.status || tracker.event || 'unknown';
  if (FINISHED.has(tracker.event)) {
    return `${said} · ${where} ${tracker.event}`;
  }
  // Not finished. Which of the three reasons is it, and what does the
  // reader do about it? Each answer is read off what the service
  // actually wrote, never guessed from the provider's name.
  if (card.stage !== 'DEV_VERIFIED' && card.stage !== 'DONE') {
    // Nothing asked it to move yet, because nothing should have:
    // write-back fires at DEV_VERIFIED and DONE and at no earlier stage.
    return `${said} · ${where} ${name}`;
  }
  if (typeof tracker.wroteBack === 'function' && tracker.wroteBack(card.stage)) {
    return `${said} · ${where} still says ${name}: TeamFlow has asked it to move and it has not `
      + 'said so back yet. Check it before calling this ticket closed';
  }
  /*
   * The fifth answer (MACLEOD-601 audit, finding 4). `readWriteBack`
   * says `known: false` for a 500 or a timeout, and falling through
   * that to the last line below asserted a fact about the connection's
   * credentials that nothing had read — the one thing the branches here
   * are supposed never to do. It is not harmful, because it still does
   * not claim the ticket is closed, but the build skill now makes this
   * line the evidence, and it would send an agent to the wrong remedy.
   * A 404 is a different answer and already right: `missing` reads as
   * `{settings: {}}`, which is write-back off.
   */
  if (!writeBack.known) {
    return `${said} · ${where} still says ${name}, and the tracker settings could not be read `
      + 'just now, so why is unknown. Try again, or check Organisation settings';
  }
  const settings = (writeBack.settings || {})[tracker.provider] || {};
  if (!settings.transitions) {
    return `${said} · ${where} still says ${name}: write-back is off for this organisation. `
      + 'Turn it on in Organisation settings, or move it yourself';
  }
  if (!((settings.states || {})[card.stage])) {
    return `${said} · ${where} still says ${name}: write-back has no state mapped for `
      + `${card.stage}. Map it in Organisation settings, or move it yourself`;
  }
  return `${said} · ${where} still says ${name}: TeamFlow could not move it — the connection `
    + 'holds no credential it can write with (a Jira connection and a hand-pasted GitHub '
    + 'webhook never do). Move it yourself';
}

/**
 * `cardLine`'s honesty, for a whole pass at once (MACLEOD-603).
 *
 * The pass-level sentence used to read "Closing in the tracker: <37
 * keys>" off the stage of the card and nothing else — the one fact
 * that says nothing about any tracker. On the organisation it was
 * found on, write-back was off and all 37 were already Done in Linear:
 * nothing was closed, nothing could have been, and the customer who
 * WANTS those issues closed is told they are being closed when they
 * are not.
 *
 * The distinction is drawn from what this side can actually read, and
 * from nothing else. Two documents answer: the key's `tracker.json`
 * sidecar says whether the tracker has already decided, and
 * `settings/trackers.json` says whether write-back is switched on.
 * Neither says the issue WILL move — whether the connection holds a
 * credential it can write with is the service's to know, and is
 * exactly `cardLine`'s last answer — so the line that goes out with
 * write-back on says what TeamFlow is ASKING FOR, never what it
 * predicts will result.
 *
 * `asking` is `{ key, tracker }` for every card at a trigger stage.
 * Pure, so every branch of it is a test rather than a live tenant.
 */
export function trackerAskLines(asking = [], writeBack = {}, { dryRun = false } = {}) {
  const buckets = new Map();
  const bucket = (kind, where, key) => {
    const id = `${kind}\u0000${where}`;
    if (!buckets.has(id)) buckets.set(id, { kind, where, keys: [] });
    buckets.get(id).keys.push(key);
  };
  for (const { key, tracker } of asking) {
    // Not read back: this side does not know, so it does not say.
    if (!tracker?.known) { bucket('unread', 'the tracker', key); continue; }
    /*
     * Already decided there, or never mentioned there. Either way this
     * key is not something about to be closed in a tracker, so it is
     * not named as though it were — which is the whole of the incident:
     * 35 of the 37 were in this branch.
     */
    if (!tracker.connected || FINISHED.has(tracker.event)) continue;
    const where = tracker.provider || 'the tracker';
    if (!writeBack.known) { bucket('unset', where, key); continue; }
    const settings = (writeBack.settings || {})[tracker.provider] || {};
    bucket(settings.transitions ? 'ask' : 'off', where, key);
  }
  const order = ['ask', 'off', 'unset', 'unread'];
  return [...buckets.values()]
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))
    .map(({ kind, where, keys }) => {
      const many = `${keys.length} ticket${keys.length === 1 ? '' : 's'}`;
      if (kind === 'ask') {
        // Named, because these are real issues in somebody's Linear.
        return `${dryRun ? 'About to ask' : 'Asking'} ${where} to close: ${keys.join(', ')}.`;
      }
      if (kind === 'off') {
        // Not named: the per-repair lines below already list them, and
        // nothing is happening to them in the tracker to list them for.
        return `Cards only for ${many}: write-back is off for this organisation, so nothing `
          + `moves in ${where}. Turn it on in Organisation settings, or move them yourself.`;
      }
      if (kind === 'unset') {
        return `${many} at a write-back stage, and the tracker settings could not be read just `
          + `now, so whether TeamFlow will ask ${where} to move them is unknown. Try again, or `
          + 'check Organisation settings.';
      }
      return `${many} whose tracker could not be read just now, so what TeamFlow will ask of it `
        + 'is unknown. Try again, or check them yourself.';
    });
}
