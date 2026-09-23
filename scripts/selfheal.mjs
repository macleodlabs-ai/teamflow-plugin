// Self-healing gates (MACLEOD-639, WS-H).
//
// The owner's ruling: it is up to the plugin to fix and re-run a gate;
// a person is only told that there is a delay, and why. Before this the
// plugin's answer to a failed or silent gate was to queue a request for
// somebody's next session and print it in their terminal. That is gone.
// The policy here is the plugin's own, it runs on the machine that owns
// the run, and what leaves is derived state: `retry {attempt, of,
// nextAt, status, reason}` on the gate's sidecar, `stalled` on the run
// when the attempts are spent, and a `hygiene[]` row when the run
// resumes by itself.
//
// One pure function decides -- `decide()` -- and everything else only
// applies what it said. That is what makes the policy a table in a test
// rather than a story about a live board.

import fs from 'node:fs';
import path from 'node:path';
import { dataDir, fetchState, readJson, reportScope, sendReport, writeJson } from './core.mjs';
import {
  GATE_SLOTS, gateDeadlineMs, gateDeadlinesOf, gateReports, gateSaid, hygieneRow, load, move, publish, ready,
  restall, save,
} from './workflow.mjs';

/** The most sidecars one tick reads: a session start is not the place to walk a tenant. */
export const READS = 8;

/** Three attempts, and a rework loop is over at sixteen entries. */
export const DEFAULT_POLICY = Object.freeze({ attempts: 3, reworkCap: 16 });

/**
 * The policy in force: the bundle's `adapter.delivery.retry` when the
 * caller has read it, else the plugin config's `delivery.retry`, else
 * the default. Only the numbers named here are read; a value that is
 * not a positive integer is ignored, because no policy is the bug.
 */
export function policyOf(config = {}, served = undefined) {
  const given = served?.retry ?? config?.delivery?.retry ?? {};
  const attempts = Number(given.attempts);
  const reworkCap = Number(given.reworkCap ?? given.rework_cap);
  return {
    attempts: Number.isInteger(attempts) && attempts > 0 ? Math.min(attempts, 20) : DEFAULT_POLICY.attempts,
    reworkCap: Number.isInteger(reworkCap) && reworkCap > 0 ? reworkCap : DEFAULT_POLICY.reworkCap,
  };
}

/** `ci` is the test check in a sentence; the rest read as they are spelled (MACLEOD-646). */
const WORDS = { ci: 'test', 'audit-local': 'audit', 'audit-dev': 'dev audit', 'dev-test': 'dev test' };
const words = (slot) => `${WORDS[slot] || String(slot || 'deploy')} check`;
const minutes = (ms) => `${Math.max(1, Math.round(ms / 60000))} min`;
const iso = (ms) => new Date(ms).toISOString();
const asMs = (t) => (typeof t === 'number' ? t : Date.parse(String(t || '')));

/**
 * What to do about one gate, as it stands now.
 *
 * `gate` is the sidecar's shape: `slot`, `status`, `startedAt`,
 * `retry` (the block as last written). `rework` is how many loops the
 * ticket has had this cycle. Returns one of:
 *
 *   { kind: 'retry', attempt, of, nextAt, reason }  re-run it, now or at nextAt
 *   { kind: 'delay', reason }                       attempts spent; say so
 *   { kind: 'none' }                                nothing to do
 *
 * A failed gate is re-run at once -- the agent fixes and tries again --
 * up to `attempts` and while the rework loop is under its cap. A gate
 * with no verdict is given 1x its deadline, then 2x, then 4x: each
 * attempt's window doubles, and a gate that has already been closed as
 * `idle` counts as a window that has run out. After the last window the
 * answer is a delay with the reason, and nothing here retries again.
 */
export function decide(gate = {}, { now = Date.now(), policy = DEFAULT_POLICY, deadlines, rework = 0 } = {}) {
  const of = policy.attempts;
  const attempt = Math.max(1, Number(gate.retry?.attempt) || 1);
  const slot = gate.slot || 'ci';
  const at = asMs(now);
  if (gate.retry?.status === 'delayed' || gate.retry?.status === 'given_up') return { kind: 'none' };

  if (gate.status === 'failed') {
    const why = gate.reason || `${words(slot)} failed`;
    if (attempt >= of) return { kind: 'delay', reason: `${why} · ${attempt} attempts`.slice(0, 120) };
    if (rework >= policy.reworkCap) return { kind: 'delay', reason: `${why} · rework loop at ${rework}`.slice(0, 120) };
    return { kind: 'retry', attempt: attempt + 1, of, nextAt: iso(at), reason: why.slice(0, 120) };
  }

  if (gate.status === 'running' || gate.status === 'idle') {
    const started = asMs(gate.startedAt);
    const deadline = gateDeadlineMs(slot, deadlines);
    const window = deadline * 2 ** (attempt - 1);
    const elapsed = Number.isFinite(started) ? at - started : (gate.status === 'idle' ? window : 0);
    if (gate.status !== 'idle' && elapsed < window) return { kind: 'none' };
    const why = `no result from the ${words(slot)} after ${minutes(Math.max(elapsed, window))}`;
    if (attempt >= of) return { kind: 'delay', reason: `no result from the ${words(slot)} · ${attempt} attempts`.slice(0, 120) };
    return { kind: 'retry', attempt: attempt + 1, of, nextAt: iso(at), reason: why.slice(0, 120) };
  }
  return { kind: 'none' };
}

// --- applying it to a run ------------------------------------------------

/** The gate a ticket stands at, as the sidecar would describe it. */
function standing(ticket, { now, deadlines }) {
  const cycle = ticket.cycle;
  const slot = GATE_SLOTS[cycle];
  if (!slot) return undefined;
  const clock = ticket.gateClock?.[cycle] || {};
  const retry = ticket.gateRetry?.[cycle];
  // A gate a person skipped is nobody's to retry.
  if (ticket.skipped?.[cycle]) return undefined;
  if (ticket.state === 'rework') {
    // One decision per failure. The policy is consulted on every command
    // that touches the run, and a failed gate already answered -- the
    // re-run planned, not yet made -- must not be answered again, or three
    // unrelated commands would spend the attempts on their own.
    if (retry?.status === 'retrying' && retry.failure === (ticket.failures || 0)) return undefined;
    return { cycle, slot, status: 'failed', retry, reason: ticket.lastFailure };
  }
  if (ticket.state !== 'running') return undefined;
  const started = clock.startedAt;
  const over = started && (asMs(now) - asMs(started)) > 2 * gateDeadlineMs(slot, deadlines);
  return { cycle, slot, status: over || ticket.gates?.[cycle] === 'idle' ? 'idle' : 'running', startedAt: started, retry };
}

/**
 * Apply the policy to every ticket of a run, in memory.
 *
 * Returns the lines to print -- the plugin's own state, in its own words
 * -- and the tickets whose gates now want saying. The caller sends the
 * gate reports and publishes; this decides and records.
 *
 *   retry on a failed gate    the ticket stays in rework; the retry block
 *                             says which attempt the re-run will be, and
 *                             the running verdict the re-run writes
 *                             carries it
 *   retry on a silent gate    the gate's clock is dropped, so the next
 *                             report starts it again with the attempt
 *   delay                     the ticket is put in rework at the gate --
 *                             the derivation then says `failed` -- with
 *                             `retry.status: delayed`, the reason and
 *                             `notifiedAt`; the run stalls there
 */
export function healRun(workflow, { now = Date.now(), policy = DEFAULT_POLICY, deadlines } = {}) {
  const lines = [];
  const touched = [];
  const at = iso(asMs(now));
  for (const ticket of workflow.tickets || []) {
    const gate = standing(ticket, { now, deadlines });
    if (!gate) continue;
    const rework = Array.isArray(ticket.rework) ? ticket.rework.length : (ticket.loopCount || 0);
    const verdict = decide(gate, { now, policy, deadlines, rework });
    if (verdict.kind === 'none') continue;
    ticket.gateRetry = { ...(ticket.gateRetry || {}) };
    if (verdict.kind === 'retry') {
      ticket.gateRetry[gate.cycle] = {
        attempt: verdict.attempt, of: verdict.of, nextAt: verdict.nextAt, status: 'retrying', reason: verdict.reason,
        // Local only: which failure this answers. Never published.
        ...(gate.status === 'failed' ? { failure: ticket.failures || 0 } : {}),
      };
      if (gate.status !== 'failed') {
        // A silent gate is started again: no clock, no hint, so the next
        // report writes `running` with a fresh `startedAt`.
        if (ticket.gates) delete ticket.gates[gate.cycle];
        if (ticket.gateClock) delete ticket.gateClock[gate.cycle];
        ticket.updatedAt = at;
        lines.push(`re-running the ${words(gate.slot)} on ${ticket.key} (attempt ${verdict.attempt} of ${verdict.of}): ${verdict.reason}`);
      } else {
        lines.push(`fix and re-run the ${words(gate.slot)} on ${ticket.key} (attempt ${verdict.attempt} of ${verdict.of})`);
      }
      touched.push(ticket);
      continue;
    }
    // delay
    ticket.gateRetry[gate.cycle] = {
      attempt: Math.max(1, Number(gate.retry?.attempt) || 1), of: policy.attempts,
      status: 'delayed', reason: verdict.reason, notifiedAt: at,
    };
    if (ticket.state !== 'rework') {
      ticket.state = 'rework';
      ticket.failures = (ticket.failures || 0) + 1;
      ticket.updatedAt = at;
    }
    ticket.lastFailure = verdict.reason;
    lines.push(`${words(gate.slot)} on ${ticket.key} delayed · ${ticket.gateRetry[gate.cycle].attempt} attempts · ${verdict.reason}`);
    touched.push(ticket);
  }
  return { lines, touched };
}

/**
 * A verdict somebody else wrote on the gate this run is standing at:
 * the CI runner (`teamflow ci run`), a reporter, the sweep. Adopted as
 * the gate's own state when it is newer than what this run last said.
 *
 *   success      the ticket is past the gate; the run resumes
 *   failed       the ticket is in rework at the gate, with the sidecar's
 *                retry block if it carries one (a runner that spent its
 *                attempts stalls the run here)
 *   idle         closed with no verdict: the policy decides next
 */
export function adoptVerdict(workflow, ticket, sidecar, { now = Date.now() } = {}) {
  const cycle = ticket.cycle;
  const slot = GATE_SLOTS[cycle];
  if (!slot || !sidecar || ticket.state !== 'running') return undefined;
  const said = ticket.gateClock?.[cycle]?.saidAt;
  const theirs = asMs(sidecar.updatedAt);
  if (!Number.isFinite(theirs) || (said && asMs(said) >= theirs)) return undefined;
  const at = iso(asMs(now));
  if (sidecar.status === 'success') {
    move(workflow, ticket.key, { state: 'running', cycle: NEXT[cycle] });
    if (ticket.gateRetry) delete ticket.gateRetry[cycle];
    return { resumed: true, reason: `resumed after the ${words(slot)} passed` };
  }
  if (sidecar.status === 'failed') {
    if (ticket.state !== 'rework') ticket.failures = (ticket.failures || 0) + 1;
    ticket.state = 'rework';
    ticket.updatedAt = at;
    ticket.lastFailure = String(sidecar.retry?.reason || sidecar.summary || `${words(slot)} failed`).slice(0, 120);
    if (sidecar.retry) ticket.gateRetry = { ...(ticket.gateRetry || {}), [cycle]: { ...sidecar.retry } };
    return { failed: true, reason: ticket.lastFailure };
  }
  return undefined;
}

const NEXT = { test: 'audit', audit: 'status', deploy: 'verified' };

/**
 * Whether the run's gates leave it stalled: a delayed retry block on a
 * ticket in rework counts as a stalled gate, beside the idle-past-2x
 * rule `restall` already applies.
 */
export function delayedGate(workflow) {
  for (const ticket of workflow.tickets || []) {
    for (const [cycle, retry] of Object.entries(ticket.gateRetry || {})) {
      if (retry?.status === 'delayed' && ticket.state === 'rework' && ticket.cycle === cycle) {
        return { key: ticket.key, gate: GATE_SLOTS[cycle] };
      }
    }
  }
  return undefined;
}

/** Stall or unstall the run from both rules, one place. */
export function settle(workflow, { now = Date.now(), deadlines } = {}) {
  const at = iso(asMs(now));
  const delayed = ['running', 'stalled'].includes(workflow.status) ? delayedGate(workflow) : undefined;
  if (delayed) {
    const same = workflow.status === 'stalled' && workflow.stalledOn?.key === delayed.key && workflow.stalledOn?.gate === delayed.gate;
    if (!same) Object.assign(workflow, { status: 'stalled', stalledOn: delayed, stalledAt: at, updatedAt: at });
    return !same;
  }
  return restall(workflow, { now, deadlines });
}


// --- one budget for everything that touches the network --------------------
//
// A hook has a few seconds and the tool is waiting on it. Every read and
// every send in a round shares ONE deadline: each call's timeout is what
// is left of it, and a call with nothing left is not made. So a service
// that has gone quiet costs a round its budget once, never once per call.

/** A deadline: `ms` from `now`, or an absolute time already given. */
export function budgetUntil(ms, now = Date.now()) {
  return { until: now + ms };
}

/** What is left of a budget in milliseconds; 0 when it is spent. */
export function remainingMs(budget, now = Date.now()) {
  if (!budget?.until) return 5000;
  return Math.max(0, budget.until - now);
}

/** The config a bounded call is made with: its timeout is what is left. */
export function bounded(config, budget) {
  return { ...config, serviceTimeoutMs: Math.max(1, remainingMs(budget)) };
}

/** Say a ticket's gates and record what landed, as `workflow ticket` does. */
async function sayGates(workflow, ticket, config, { at, deadlines, budget }) {
  let said = 0;
  for (const verdict of gateReports(workflow, ticket, { at, deadlines })) {
    if (remainingMs(budget) <= 0) break;
    const sent = await sendReport('runtime', verdict.slot, verdict.payload, bounded(config, budget),
      { account: reportScope(config) }).catch(() => ({ ok: false }));
    if (sent.ok || sent.queued) { gateSaid(ticket, verdict); said += 1; }
  }
  return said;
}

// --- what the last pass said, kept for a session start ----------------------
//
// A session start does no network (spec R-189): the tool is waiting on
// it. What it prints about self-healing is what the last round -- a
// `Stop`, a `teamflow status` -- found, kept here and shown once.

function passPath() {
  return path.join(dataDir(), 'selfheal.json');
}

function notePass(lines, at) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    writeJson(passPath(), { at, lines: lines.slice(0, 8), shown: false });
  } catch { /* a data dir that cannot be written is a pass nobody hears of */ }
}

/**
 * The last pass's lines, once. Read locally, never fetched: this is
 * what a session start says about the plugin's own retries and delays.
 * Nothing after they have been shown, and nothing older than a day.
 */
export function lastPassLines({ now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  try {
    const pass = readJson(passPath(), undefined);
    if (!pass || pass.shown || !Array.isArray(pass.lines) || !pass.lines.length) return [];
    if (now - Date.parse(pass.at || '') > maxAgeMs) return [];
    writeJson(passPath(), { ...pass, shown: true });
    return pass.lines;
  } catch {
    return [];
  }
}

// --- the tick ------------------------------------------------------------

/**
 * One pass over every live run on this machine: resume what can resume,
 * re-run what the policy says, stall what has run out. The `Stop` hook,
 * `teamflow status`, and the phase tick call this; a session start only
 * reads what it last said (`lastPassLines`). Bounded: one sidecar read
 * per stalled or running ticket at most, every call under the one
 * budget, and nothing thrown.
 *
 * Returns the lines to print, in the plugin's own words: never a
 * person's request, never a command for somebody to run.
 */
export async function tick(config = {}, {
  now = Date.now(), timeoutMs = 5000, budget = budgetUntil(timeoutMs), served, read = fetchState, reads = READS,
  note = true,
} = {}) {
  const lines = [];
  try {
    const state = load(config);
    const deadlines = served?.deadlines ?? gateDeadlinesOf(config);
    const policy = policyOf(config, served);
    const at = iso(asMs(now));
    let left = reads;
    for (const workflow of Object.values(state.workflows || {})) {
      if (!['running', 'stalled'].includes(workflow.status)) continue;
      let changed = false;
      // 1. What others have written on the gates these tickets stand at.
      // The stalled run's blocking gate first: that is the read that
      // resumes a plan, and the budget must reach it.
      const standing = (workflow.tickets || [])
        .filter((t) => t.state === 'running' && GATE_SLOTS[t.cycle])
        .sort((a, b) => (b.key === workflow.stalledOn?.key) - (a.key === workflow.stalledOn?.key));
      for (const ticket of standing) {
        if (left <= 0 || remainingMs(budget) <= 0) break;
        left -= 1;
        const got = await read(`issues/${encodeURIComponent(ticket.key)}/${GATE_SLOTS[ticket.cycle]}.json`,
          bounded(config, budget)).catch(() => ({ ok: false }));
        if (!got?.ok || !got.document) continue;
        const adopted = adoptVerdict(workflow, ticket, got.document, { now });
        if (!adopted) continue;
        changed = true;
        if (adopted.resumed) {
          hygieneRow(workflow, 'resumed', 'plugin', adopted.reason, at);
          lines.push(`resumed plan ${workflow.name} after the ${words(GATE_SLOTS[ticket.cycle] || 'deploy')} passed on ${ticket.key}`);
        }
      }
      // 2. The policy, on what is left.
      const healed = healRun(workflow, { now, policy, deadlines });
      if (healed.touched.length) changed = true;
      lines.push(...healed.lines);
      // 3. The run's own word about itself, and the board's.
      if (settle(workflow, { now, deadlines })) changed = true;
      if (!changed) continue;
      // Saved before anything is sent: what the policy decided is the
      // record, and a send that does not land is retried by the next
      // pass from the same record rather than decided again.
      save(state, config);
      for (const ticket of healed.touched) await sayGates(workflow, ticket, config, { at, deadlines, budget });
      for (const ticket of workflow.tickets || []) {
        if (!healed.touched.includes(ticket)) await sayGates(workflow, ticket, config, { at, deadlines, budget });
      }
      save(state, config);
      if (remainingMs(budget) > 0) await publish(workflow, bounded(config, budget)).catch(() => ({ ok: false }));
      if (workflow.status === 'running' && ready(workflow).tickets?.length && workflow.hygiene?.at(-1)?.action === 'resumed') {
        lines.push(`phase ${ready(workflow).phase.n} of ${workflow.name} is ready: ${ready(workflow).tickets.map((t) => t.key).join(', ')}`);
      }
    }
  } catch {
    // Fail open: a hook round is not the place to find out.
  }
  const said = lines.map((line) => `TeamFlow: ${line}`);
  // Kept for the next session start, unless the caller printed it
  // itself (`teamflow status`), which is the reader seeing it once.
  if (said.length && note) notePass(said, iso(asMs(now)));
  return { lines: said };
}
