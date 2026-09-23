// What a lead asks the plugin to do, and what the plugin does about it
// (MACLEOD-639, owner ruling 10).
//
// The plugin is a harness and is as autonomous as it can be. A lead
// watching the board sees a gate fail, stall, or an agent error out,
// and acts from the dashboard; the service holds that as a named
// intent for the machine that holds the ticket, and the plugin on that
// machine asks for its actions on every async hook round (`Stop`) and
// in `teamflow status`, performs each one it can, and reports what
// came of it. Five kinds, and nothing else is an action:
//
//   fix          guidance from a named person, shown to the agent as a
//                sentence in that person's name. Never executed.
//   bump         restart the retry policy for the stalled gate on that
//                key now, rather than at its deadline.
//   rerun_gate   run the gate again, when this machine knows how: a
//                command the USER configured for it, run through
//                `teamflow ci run` with the retry policy, in the
//                background. Never an external gate.
//   resume_plan  the run picks up its next ready phase.
//   skip_gate    the gate is passed over by a person: it reads `idle`,
//                "skipped by <who>: <reason>", and the run records who.
//                Only ever from the service, after its own authority
//                check.
//
// Four rules decide the shape of this.
//
// **Actions are named intents, never text run as a command.** The
// service says `rerun_gate` and this machine's own configuration says
// what that gate's command is -- the user's own file, never a file in a
// clone (`delivery` is an UNTRUSTED_PROJECT_KEY); nothing that arrives
// here is passed to a shell. A `fix` is the one action that carries
// text and it is shown, in the lead's name, as guidance -- never
// treated as authority over the rules a session already has.
//
// **What goes back is an outcome and the plugin's own sentence.**
// `done`, `refused` or `failed`, and a reason of at most 120 characters
// in this module's words ("deploy runs only from the main session").
// Never the action's text.
//
// **Once, even across a crash.** Every action has an id; it is written
// to this machine's ledger as taken BEFORE it is performed, so a hook
// killed halfway never runs a re-run twice, and the service is told the
// outcome afterwards, which is the delivery mark. An action for a key
// no session here holds waits, and the next session bound to that key
// is shown it first -- from the ledger, without a network call.
//
// **Bounded, and never in the way.** Every network call in a round
// shares one budget; a service that does not answer costs the round
// its budget once and is a round with nothing to do, never a hook that
// hangs. A session start makes no network call at all.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  accountName, credential, dataDir, globalConfigPath, isWorktree, machineId, readJson, reportScope,
  sendReport, serviceUrl, writeJson,
} from './core.mjs';
import {
  GATE_SLOTS, gateDeadlinesOf, gateReports, gateSaid, hygieneRow, load, move, publish, ready, restall, save,
} from './workflow.mjs';
import { bounded, budgetUntil, remainingMs, settle } from './selfheal.mjs';

/** The most of a `fix` the notice will carry. */
export const TEXT_MAX = 500;
/** The most of the plugin's own sentence about an outcome. */
export const REASON_MAX = 120;
/** How many actions one round performs; the rest wait for the next. */
export const BATCH = 8;
export const KINDS = new Set(['fix', 'bump', 'rerun_gate', 'resume_plan', 'skip_gate']);

// --- the developer's say ------------------------------------------------

/**
 * The user's own `delivery` block, from the user's own file and nowhere
 * else. What the plugin RUNS (`gate_commands`) and when it gives up
 * (`gate_deadlines`, `retry`) may not come from a file inside a clone:
 * `loadConfig` strips `delivery` from a project's `.teamflow.json`
 * (UNTRUSTED_PROJECT_KEYS), and this reads past `loadConfig` entirely
 * so a future merge order cannot hand a clone's block back in.
 */
export function userDelivery() {
  const delivery = readJson(globalConfigPath(), {})?.delivery;
  return delivery && typeof delivery === 'object' ? delivery : {};
}

/**
 * Whether this machine takes actions at all. On unless the developer
 * turned it off (`teamflow config set intake off`). Off, the machine
 * still answers each action -- `refused: intake off` -- so the lead
 * learns why nothing happened, and performs none of them.
 */
export function intakeEnabled(config = {}) {
  if (config.intake === false || config.intake === 'off') return false;
  const global = readJson(globalConfigPath(), {});
  return !(global?.intake === false || global?.intake === 'off');
}

/** `teamflow config set intake off|on`, on this machine's own config. */
export function setIntake(value) {
  const on = value === 'on' || value === true;
  const off = value === 'off' || value === false;
  if (!on && !off) throw new Error('Usage: teamflow config set intake on|off');
  const file = globalConfigPath();
  const next = { ...(readJson(file, {}) || {}) };
  if (on) delete next.intake; else next.intake = 'off';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, next);
  return on;
}

// --- what this machine has answered, and what waits ------------------------

function ledgerPath(account) {
  const safe = String(account || 'default').replace(/[^A-Za-z0-9._-]+/g, '-');
  return path.join(dataDir(), 'intake', `${safe}.json`);
}

/**
 * `handled`: ids taken, whether or not the service has heard the
 * outcome yet. `pending`: actions held for a session bound to their
 * key. `owed`: outcomes decided offline (a session start showing a held
 * fix) that the next round tells the service.
 */
export function readLedger(account) {
  const doc = readJson(ledgerPath(account), {}) || {};
  return {
    handled: Array.isArray(doc.handled) ? doc.handled.map(String) : [],
    pending: Array.isArray(doc.pending) ? doc.pending.filter((a) => a && a.id) : [],
    owed: Array.isArray(doc.owed) ? doc.owed.filter((o) => o && o.id) : [],
  };
}

function writeLedger(account, ledger) {
  const file = ledgerPath(account);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Bounded every way: no list here may grow for ever.
  writeJson(file, {
    handled: ledger.handled.slice(-500), pending: ledger.pending.slice(-32), owed: (ledger.owed || []).slice(-32),
  });
}

// --- words ------------------------------------------------------------------------

/**
 * One line, whitespace collapsed, capped, and no control character at
 * all: a fix is shown in a terminal, and an escape sequence in it would
 * be a lead's text writing on the reader's screen.
 */
export function oneLine(text, max = TEXT_MAX) {
  return String(text ?? '')
    .replace(/[\r\n\t\v\f\u2028\u2029]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max);
}

function clock(at) {
  const t = Date.parse(at || '');
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * The sentence the agent reads for a `fix`: `Fix from Steve, 10:12:
 * re-run the tests; the flaky one is fixed on main`, or `Fix from Steve
 * for the failed test gate, 10:12: ...` when the action names the gate.
 * A person's name and a time, so it reads as a message from someone.
 */
export function noticeFor(action = {}) {
  const by = oneLine(action.by, 80) || 'a lead';
  const gate = oneLine(action.args?.gate, 40);
  const failure = gate ? ` for the failed ${gate} gate` : '';
  const when = clock(action.at);
  const text = oneLine(action.args?.text);
  if (!text) return undefined;
  return `Fix from ${by}${failure}${when ? `, ${when}` : ''}: ${text}`;
}

const said = (outcome, reason) => ({ outcome, reason: oneLine(reason, REASON_MAX) });

// --- the service ------------------------------------------------------------------

/**
 * `GET /v1/members/actions?for=<machineId>` with the machine's own
 * credential: `{actions: [{id, kind, key, by, at, args}]}`, the shape
 * `ServedAction` in src/types.ts declares. Bounded; every failure is
 * `ok: false`.
 */
export async function fetchActions(config = {}, { timeoutMs = 5000 } = {}) {
  const id = machineId();
  if (!id) return { ok: false, reason: 'this machine has no id to be asked for', actions: [] };
  const cred = await credential(config);
  if (!cred) return { ok: false, reason: 'no service credential available', actions: [] };
  try {
    const response = await fetch(
      `${serviceUrl(config)}/v1/members/actions?for=${encodeURIComponent(id)}`,
      { headers: { [cred.header]: cred.value }, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, timeoutMs)) },
    );
    if (response.status === 404) return { ok: true, actions: [] };
    if (!response.ok) return { ok: false, reason: `service returned ${response.status}`, actions: [] };
    const body = await response.json().catch(() => ({}));
    const list = Array.isArray(body?.actions) ? body.actions : [];
    return { ok: true, actions: list.filter((a) => a && typeof a === 'object' && a.id && a.kind && a.key) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), actions: [] };
  }
}

/** `POST /v1/members/actions/{id}/outcome {outcome, reason}`: the delivery mark. */
export async function reportOutcome(config = {}, id, { outcome, reason }, { timeoutMs = 5000 } = {}) {
  const cred = await credential(config);
  if (!cred) return { ok: false, reason: 'no service credential available' };
  try {
    const response = await fetch(
      `${serviceUrl(config)}/v1/members/actions/${encodeURIComponent(String(id))}/outcome`,
      {
        method: 'POST',
        headers: { [cred.header]: cred.value, 'content-type': 'application/json' },
        body: JSON.stringify({ outcome, reason: oneLine(reason, REASON_MAX) }),
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
      },
    );
    return response.ok ? { ok: true } : { ok: false, reason: `service returned ${response.status}` };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// --- the gates a run holds -------------------------------------------------------

/**
 * Which cycle a gate id names in a run, and only the ids a run holds:
 * `test` (also `ci`, `build`), `audit` (also `audit-local`), `deploy`.
 * Anything else -- `sonarqube`, `smoke-eu`, a slot another pipeline
 * reserved -- is not this run's gate and is never guessed at.
 */
export function cycleFor(gate) {
  const id = String(gate || '').toLowerCase();
  if (['test', 'ci', 'build'].includes(id)) return 'test';
  if (['audit', 'audit-local'].includes(id)) return 'audit';
  if (id === 'deploy') return 'deploy';
  return undefined;
}

const NEXT_CYCLE = { test: 'audit', audit: 'status', deploy: 'verified' };

/** The run on this machine that holds the key, if one does. */
function runHolding(state, key) {
  return Object.values(state.workflows || {})
    .filter((wf) => ['running', 'stalled', 'blocked', 'planning'].includes(wf.status))
    .find((wf) => (wf.tickets || []).some((t) => t.key === key));
}

/** Say the gates, as `teamflow workflow ticket` does after a move. Under the budget. */
async function sayGates(workflow, ticket, config, { at, deadlines, budget }) {
  const verdicts = gateReports(workflow, ticket, { at, deadlines });
  for (const verdict of verdicts) {
    if (remainingMs(budget) <= 0) break;
    const sent = await sendReport('runtime', verdict.slot, verdict.payload, bounded(config, budget),
      { account: reportScope(config) }).catch(() => ({ ok: false }));
    if (sent.ok || sent.queued) gateSaid(ticket, verdict);
  }
  return verdicts;
}

/**
 * The command this machine has for a gate: `delivery.gate_commands` in
 * the USER's file, by the gate's own id or by the cycle it names, as an
 * argv array or one string split on whitespace. No family guessing: a
 * gate this run does not hold has no command here, whatever it is
 * called.
 */
export function gateCommand(gate, delivery = userDelivery()) {
  const table = delivery?.gate_commands ?? delivery?.gateCommands ?? {};
  if (!table || typeof table !== 'object') return undefined;
  const id = String(gate || '').toLowerCase();
  const cycle = cycleFor(id);
  const found = table[id] ?? (cycle ? table[cycle] : undefined);
  if (Array.isArray(found)) return found.map(String).filter(Boolean);
  if (typeof found === 'string' && found.trim()) return found.trim().split(/\s+/);
  return undefined;
}

/**
 * Start a gate run in the background and answer once it HAS started:
 * `spawn` is the event that says the process exists, `error` the one
 * that says it never will, and neither is known when `spawn()` returns.
 * A second's grace for either; a child that says nothing in that time
 * is reported as not started.
 */
function spawnDetached(argv, { cwd, env, graceMs = 1000 }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    try {
      const child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: 'ignore', shell: false });
      child.once('spawn', () => { child.unref(); done(resolve, child.pid); });
      child.once('error', (error) => done(reject, error));
      setTimeout(() => done(reject, new Error('the gate did not start within a second')), graceMs).unref();
    } catch (error) {
      done(reject, error);
    }
  });
}

// --- performing one action ----------------------------------------------------

/**
 * Do one action, or say why not. Pure apart from the doers handed in:
 * `state` is the workflow file as loaded, `bound` the key this session
 * holds, and the result says what to record and what to show. `hold`
 * means "not here, not now": the action waits for the session on its
 * key.
 */
export async function perform(action, {
  config = {}, state, bound, cwd = process.cwd(), at = new Date().toISOString(), budget,
  spawnGate = spawnDetached, publishRun = publish, inWorktree = isWorktree, delivery = userDelivery(),
  deadlines = gateDeadlinesOf({ delivery }), env = process.env,
} = {}) {
  const kind = String(action.kind || '');
  const key = String(action.key || '');
  const by = oneLine(action.by, 80) || 'a lead';
  if (!KINDS.has(kind)) return { ...said('refused', `unknown action kind ${kind}`) };

  if (kind === 'fix') {
    if (bound !== key) return { hold: true };
    const notice = noticeFor(action);
    if (!notice) return { ...said('refused', 'a fix with no text') };
    return { ...said('done', `shown to the session on ${key}`), notice };
  }

  const workflow = state ? runHolding(state, key) : undefined;
  if (!workflow) {
    // No run here holds the key and no session here is on it: wait for
    // the session that will be. A bound session with no run is an answer.
    if (bound !== key) return { hold: true };
    return { ...said('refused', `no run on this machine holds ${key}`) };
  }
  const ticket = workflow.tickets.find((t) => t.key === key);
  const settleAndPublish = async () => {
    settle(workflow, { now: at, deadlines });
    save(state, config);
    if (remainingMs(budget) > 0) await publishRun(workflow, bounded(config, budget)).catch(() => ({ ok: false }));
  };

  if (kind === 'bump') {
    const idle = Object.entries(ticket.gates || {}).find(([c, status]) => status === 'idle' && !ticket.skipped?.[c])?.[0];
    const stalledHere = workflow.status === 'stalled' && workflow.stalledOn?.key === key;
    const cycle = idle || (stalledHere ? cycleFor(workflow.stalledOn?.gate) : undefined);
    if (!cycle) return { ...said('refused', `no stalled gate on ${key}`) };
    move(workflow, key, { state: 'running', cycle });
    if (ticket.gateRetry) delete ticket.gateRetry[cycle];
    await sayGates(workflow, ticket, config, { at, deadlines, budget });
    await settleAndPublish();
    return { ...said('done', `${cycle} gate restarted on ${key} by ${by}`) };
  }

  if (kind === 'skip_gate') {
    const reason = oneLine(action.args?.reason, REASON_MAX);
    const gate = String(action.args?.gate || '');
    if (!gate) return { ...said('refused', 'skip_gate names no gate') };
    if (!reason) return { ...said('refused', 'skip_gate needs a reason') };
    const cycle = cycleFor(gate);
    if (!cycle) return { ...said('refused', `${gate} is not a gate this run holds`) };
    if (ticket.cycle !== cycle) return { ...said('refused', `${key} is not at the ${cycle} gate`) };
    // The gate reads `idle` with the person's words from now on -- never
    // `success`, which only a run earns -- and the run records who.
    ticket.skipped = { ...(ticket.skipped || {}), [cycle]: { by, reason, at } };
    if (ticket.gateRetry) delete ticket.gateRetry[cycle];
    move(workflow, key, { state: 'running', cycle: NEXT_CYCLE[cycle] });
    hygieneRow(workflow, 'skipped', by, `${cycle} gate on ${key} skipped: ${reason}`, at);
    await sayGates(workflow, ticket, config, { at, deadlines, budget });
    await settleAndPublish();
    return { ...said('done', `${cycle} gate on ${key} skipped by ${by}: ${reason}`) };
  }

  if (kind === 'resume_plan') {
    if (['done', 'archived', 'cancelled'].includes(workflow.status)) {
      return { ...said('refused', `"${workflow.name}" is ${workflow.status}`) };
    }
    workflow.status = 'running';
    delete workflow.stalledOn;
    delete workflow.stalledAt;
    workflow.updatedAt = at;
    const open = ready(workflow);
    save(state, config);
    if (remainingMs(budget) > 0) await publishRun(workflow, bounded(config, budget)).catch(() => ({ ok: false }));
    if (!open.phase || !open.tickets.length) return { ...said('refused', `nothing is ready in "${workflow.name}"`) };
    const keys = open.tickets.map((t) => t.key).join(', ');
    return {
      ...said('done', `phase ${open.phase.n} ready: ${keys}`),
      notice: `Resume plan "${workflow.name}" (asked by ${by}): phase ${open.phase.n} is ready: ${keys}. Continue with the next ready ticket.`,
    };
  }

  // rerun_gate: this machine runs the gate only when it is on the ticket,
  // the gate is one of its own, it knows the command, and it is allowed to.
  const gate = String(action.args?.gate || '');
  if (!gate) return { ...said('refused', 'rerun_gate names no gate') };
  if (bound !== key) return { hold: true };
  const cycle = cycleFor(gate);
  if (!cycle) return { ...said('refused', `${gate} is an external gate; the plugin never retries what it did not run`) };
  if (cycle === 'deploy' && inWorktree(cwd)) {
    return { ...said('refused', 'deploy runs only from the main session') };
  }
  const command = gateCommand(gate, delivery);
  if (!command) {
    return { ...said('refused', `no command configured for the ${gate} gate on this machine (delivery.gate_commands in your own config)`) };
  }
  try {
    const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
    await spawnGate([process.execPath, cli, 'ci', 'run', gate, '--jira', key, '--', ...command], { cwd, env });
  } catch (error) {
    return { ...said('failed', `could not start the ${gate} gate: ${error?.message || error}`) };
  }
  return { ...said('done', `${gate} gate started on ${key} by ${by}; the sidecar carries each try`) };
}

// --- the round ---------------------------------------------------------------------

const row = (action, result, at) => ({
  id: String(action.id).slice(0, 80), kind: String(action.kind), by: oneLine(action.by, 80) || undefined,
  at, outcome: result.outcome, reason: result.reason || undefined, key: String(action.key),
});

/**
 * One round: fetch, perform what can be performed here, answer the
 * service, and say what the agent should hear. Never throws; every
 * network call shares `budget`.
 *
 * `performed[]` is what the ticket's report records (`CardAction`);
 * `notices[]` is what the session is shown, fixes first; `held` is how
 * many wait for a session bound to their key.
 */
export async function intakePass(config = {}, {
  key: bound, cwd, timeoutMs = 5000, now = new Date().toISOString(), budget = budgetUntil(timeoutMs), doers = {},
} = {}) {
  const none = { notices: [], performed: [], held: 0 };
  let release;
  try {
    const enabled = intakeEnabled(config);
    const account = await accountName(config).catch(() => undefined);
    // One round at a time on this machine: a hook and a session's
    // heartbeat (MACLEOD-641) both run rounds, and the ledger is read,
    // then written. The second one waits for the next round.
    release = takeLock(account);
    if (!release) return none;
    const ledger = readLedger(account);
    // Outcomes decided offline first: they are already taken and owed.
    for (const owed of [...ledger.owed]) {
      if (remainingMs(budget) <= 0) break;
      const told = await reportOutcome(config, owed.id, owed, { timeoutMs: remainingMs(budget) });
      if (told.ok) ledger.owed = ledger.owed.filter((o) => o.id !== owed.id);
    }
    const got = remainingMs(budget) > 0
      ? await fetchActions(config, { timeoutMs: remainingMs(budget) })
      : { ok: false, reason: 'no time left in this round', actions: [] };
    const seen = new Set(ledger.handled);
    const pendingIds = new Set(ledger.pending.map((a) => String(a.id)));
    const fresh = got.actions.filter((a) => !seen.has(String(a.id)) && !pendingIds.has(String(a.id)));
    const queue = [...ledger.pending, ...fresh]
      .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
    if (!queue.length) {
      writeLedger(account, ledger);
      return got.ok ? none : { ...none, reason: got.reason };
    }

    const state = load(config);
    const notices = [];
    const performed = [];
    const still = [];
    let done = 0;
    for (let i = 0; i < queue.length; i += 1) {
      const action = queue[i];
      if (done >= BATCH) { still.push(action); continue; }
      const id = String(action.id);
      let result;
      if (!enabled) {
        result = said('refused', 'intake off on this machine');
        ledger.handled.push(id);
      } else {
        /*
         * Taken BEFORE it is performed. A hook killed between this write
         * and the outcome leaves an action nobody answered -- and one
         * nobody will run twice, which is the promise that matters for a
         * re-run or a bump. The ones this round has not reached yet that
         * were already held stay held.
         */
        ledger.handled.push(id);
        const unreached = queue.slice(i + 1).filter((a) => pendingIds.has(String(a.id)));
        writeLedger(account, { handled: ledger.handled, pending: [...still, ...unreached], owed: ledger.owed });
        try {
          result = await perform(action, { config, state, bound, cwd, at: now, budget, ...doers });
        } catch (error) {
          result = said('failed', `the plugin could not perform it: ${error?.message || error}`);
        }
        if (result.hold) {
          // Not here, not now: taken back out, and kept for the session
          // on its key.
          ledger.handled = ledger.handled.filter((one) => one !== id);
          still.push(action);
          continue;
        }
      }
      done += 1;
      performed.push(row(action, result, now));
      if (result.notice) notices.push(result.notice);
      const told = remainingMs(budget) > 0
        ? await reportOutcome(config, action.id, result, { timeoutMs: remainingMs(budget) })
        : { ok: false };
      if (!told.ok) ledger.owed.push({ id, outcome: result.outcome, reason: result.reason });
    }
    writeLedger(account, { handled: ledger.handled, pending: still, owed: ledger.owed });
    // Fixes first: a person's words before anything the tool says.
    notices.sort((a, b) => (b.startsWith('Fix from ') ? 1 : 0) - (a.startsWith('Fix from ') ? 1 : 0));
    return { notices, performed, held: still.length };
  } catch {
    return none;
  } finally {
    release?.();
  }
}

// A lock older than this was left by a round that died.
const LOCK_STALE_MS = 30_000;

/** The machine's intake lock, or undefined when another round holds it. Returns its release. */
export function takeLock(account, now = Date.now()) {
  const lock = `${ledgerPath(account)}.lock`;
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const take = () => { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); return () => fs.rmSync(lock, { force: true }); };
  try { return take(); } catch { /* held, or left behind */ }
  let age;
  try { age = now - fs.statSync(lock).mtimeMs; } catch { age = Infinity; }
  if (age < LOCK_STALE_MS) return undefined;
  fs.rmSync(lock, { force: true });
  try { return take(); } catch { return undefined; }
}

/**
 * A session start, without the network: the fixes held for the key this
 * session just bound, from the ledger, shown now and owed to the service
 * at the next round. Only `fix` is performed here -- it is the one kind
 * that needs a session to speak to and nothing else -- and only for the
 * bound key. Everything else waits for the `Stop` round.
 */
export async function intakeLocal(config = {}, { key: bound, now = new Date().toISOString() } = {}) {
  const none = { notices: [], performed: [] };
  try {
    if (!bound || !intakeEnabled(config)) return none;
    const account = await accountName(config).catch(() => undefined);
    const ledger = readLedger(account);
    const mine = ledger.pending.filter((a) => a.kind === 'fix' && String(a.key) === bound);
    if (!mine.length) return none;
    const notices = [];
    const performed = [];
    for (const action of mine) {
      const notice = noticeFor(action);
      const result = notice ? { ...said('done', `shown to the session on ${bound}`), notice } : said('refused', 'a fix with no text');
      ledger.handled.push(String(action.id));
      ledger.owed.push({ id: String(action.id), outcome: result.outcome, reason: result.reason });
      performed.push(row(action, result, now));
      if (notice) notices.push(notice);
    }
    writeLedger(account, { ...ledger, pending: ledger.pending.filter((a) => !mine.includes(a)) });
    return { notices, performed };
  } catch {
    return none;
  }
}
