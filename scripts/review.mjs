// Reviewers belong to the card (MACLEOD-714).
//
// An audit often runs as a team: three agents, one lens each --
// correctness, security, evidence -- named anything the person likes.
// Each one used to reach the board as a new ad hoc card, and the card
// under audit said nothing about them. Now an agent started from a
// session bound to a ticket, while that ticket stands at a check step,
// is a reviewer of that step. Decided by POSITION -- where the ticket
// is -- never by the agent's name, because a name can be anything.
//
// Each reviewer is one runtime sidecar on the card, `review-<n>`, with
// a `review` block: the lens (the agent's own one-line description), a
// fixed result `running | pass | findings | failed` and counts. The
// result is derived HERE, on the machine, from the agent's last message
// by a small deterministic parser, or stated exactly by the agent with
// `teamflow review done`. Only the enum and the counts leave the
// machine; the message is read and dropped.
//
// Everything here fails open: a reviewer that cannot be recorded is an
// agent reporting under the ticket, as before.

import path from 'node:path';

import { agentBlock, agentLabel, dataDir, readJson, reportScope, sendReport, tenantId, transportOf, putReport, tenantPath, writeJson } from './core.mjs';
import { acquireLock } from './dispatch.mjs';
import { reviewStartOf } from './launch-role.mjs';
import { title } from './words.mjs';

/** The steps a ticket can stand at for its agents to be its reviewers. */
export const REVIEW_STAGES = ['LOCAL_TEST', 'LOCAL_AUDIT', 'DEV_TEST', 'DEV_AUDIT'];
export const REVIEW_RESULTS = ['running', 'pass', 'findings', 'failed', 'withdrawn'];
/** Reviewers one step may hold at once; one more reports under the ticket as any agent does. */
export const REVIEW_SLOTS_MAX = 8;
export const SEVERITIES = ['high', 'medium', 'low'];
const COUNT_MAX = 999;

/** The step this session's ticket stands at, when it is a check step. */
export function checkStep(state = {}) {
  return state.binding?.key && REVIEW_STAGES.includes(state.stage) ? state.stage : undefined;
}

/**
 * The lens: the agent's own description through the writer, shown as
 * given when the writer finds too little to say ("Security" is one
 * word, and one word is the whole lens).
 */
export function lensOf(task, name) {
  for (const raw of [task, name]) {
    const said = title(raw);
    if (said && said !== 'Agent work') return agentLabel(said, 80);
    const given = agentLabel(raw, 80);
    if (given) return given.charAt(0).toUpperCase() + given.slice(1);
  }
  return 'Review';
}

const clampCount = (n) => Math.max(0, Math.min(COUNT_MAX, Number.parseInt(n, 10) || 0));

/**
 * The result a reviewer's last message states, and its counts. Local
 * and deterministic: symbols and a handful of words, never a model.
 * Returns `{ result, findings?, high?, medium?, low? }`; the text itself
 * is not in the answer.
 *
 * Order matters: counts first ("❌ 2 medium" is findings, not a failure),
 * then an explicit failure, then an explicit pass, then "running". A
 * message that says none of these is `failed`: a review with no clear
 * answer is not a pass.
 */
export function parseReview(text) {
  const said = typeof text === 'string' ? text.slice(0, 20_000) : '';
  const counts = { high: 0, medium: 0, low: 0 };
  const add = (severity, n) => {
    const key = severity.toLowerCase() === 'critical' ? 'high' : severity.toLowerCase();
    counts[key] = clampCount(counts[key] + clampCount(n));
  };
  for (const m of said.matchAll(/\b(\d{1,3})[ \t]*(?:x[ \t]*)?(critical|high|medium|low)s?\b/gi)) add(m[2], m[1]);
  for (const m of said.matchAll(/\b(critical|high|medium|low)s?[ \t]*[:=][ \t]*(\d{1,3})\b/gi)) add(m[1], m[2]);
  let findings = counts.high + counts.medium + counts.low;
  const stated = [...said.matchAll(/\b(\d{1,3})[ \t]+(?:findings?|issues?|problems?)\b/gi)].map((m) => clampCount(m[1]));
  if (stated.length) findings = Math.max(findings, ...stated);
  const withCounts = (result) => {
    const out = { result };
    if (findings) out.findings = clampCount(findings);
    for (const s of SEVERITIES) if (counts[s]) out[s] = counts[s];
    return out;
  };
  if (findings > 0) return withCounts('findings');
  if (/❌|✗|\bFAIL(?:ED|S|URE)?\b/i.test(said.replace(/\b0\s+fail(?:ed|s|ures?)?\b/gi, ''))) return { result: 'failed' };
  if (/✅|✔|\bPASS(?:ED|ES)?\b|\bLGTM\b|\bno (?:issues|findings|problems)\b/i.test(said)) return { result: 'pass' };
  if (stated.length) return { result: 'pass' };
  if (/○|\b(?:running|in progress|still working)\b/i.test(said)) return { result: 'running' };
  return { result: 'failed' };
}

/**
 * `teamflow review done --result pass|findings|failed [--high N --medium N
 * --low N]`, from its words. The hook reads the agent's own Bash command
 * for this shape only; nothing else in the command is kept.
 */
export function parseReviewArgs(args = []) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    const value = args[i + 1];
    if (flag === '--result' && ['pass', 'findings', 'failed'].includes(value)) { out.result = value; i += 1; }
    else if (SEVERITIES.includes(String(flag).replace(/^--/, '')) && /^\d{1,3}$/.test(value ?? '')) {
      if (clampCount(value)) out[flag.replace(/^--/, '')] = clampCount(value);
      i += 1;
    }
  }
  if (!out.result) return undefined;
  const findings = SEVERITIES.reduce((sum, s) => sum + (out[s] || 0), 0);
  if (findings) out.findings = findings;
  return out;
}

// Findings already dealt with when a review re-reports after its fixes.
const SETTLED_OUTCOMES = ['fixed', 'no_change_needed'];

/**
 * The result of Claude Code's own `ReportFindings` call (MACLEOD-722):
 * `pass` for an empty list, else `findings` with their count. Its input
 * is `{ findings: [{ file, summary, failure_scenario, ... }] }`; a
 * finding has no severity field, so none is invented here. A finding a
 * re-report marks `fixed` or `no_change_needed` is not counted. Nothing
 * of a finding's text is in the answer. Undefined for any other shape.
 */
export function findingsOf(toolInput) {
  const list = toolInput?.findings;
  if (!Array.isArray(list)) return undefined;
  const open = clampCount(list.filter((f) => !SETTLED_OUTCOMES.includes(f?.outcome)).length);
  return open ? { result: 'findings', findings: open } : { result: 'pass' };
}

/** The same, from a shell command the agent ran; undefined when it is not one. */
export function reviewCommandOf(command) {
  if (typeof command !== 'string') return undefined;
  const m = command.match(/(?:^|[\s;&|(/])(?:teamflow|cli\.mjs"?)\s+review\s+done\b([^;&|\n]*)/);
  return m ? parseReviewArgs(m[1].trim().split(/\s+/).filter(Boolean)) : undefined;
}

/** "Security found 2 medium problems." In plain words, from the enum and counts only. */
export function reviewSentence(lens, review = {}) {
  const who = lens || 'Review';
  if (review.result === 'running') return `${who} is reviewing.`;
  if (review.result === 'pass') return `${who} passed.`;
  if (review.result === 'failed') return `${who} failed.`;
  if (review.result === 'withdrawn') return `${who} changed files, so it counts as work, not a review.`;
  const parts = SEVERITIES.filter((s) => review[s]).map((s) => `${review[s]} ${s}`);
  const total = review.findings || 0;
  const noun = total === 1 ? 'problem' : 'problems';
  if (parts.length === 1) return `${who} found ${parts[0]} ${noun}.`;
  if (parts.length > 1) return `${who} found ${total} ${noun}: ${parts.join(', ')}.`;
  return total ? `${who} found ${total} ${noun}.` : `${who} found problems.`;
}

// --- the slots, on this machine -------------------------------------

function reviewsPath(sessionId, key) {
  return path.join(dataDir(), 'sessions', `${sessionId}.reviews`, `${String(key).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
}

/**
 * Claim a reviewer's slot on the ticket's step: the lowest free
 * `review-<n>` of this round. A new round starts when the step changed
 * or every reviewer of the last round has answered, so the next audit
 * after a rework is judged on its own reviewers. Under a lock, because
 * a team of three starts at once. Undefined when the lock was not had
 * or every slot is taken. Idempotent per agent.
 */
export function claimReview(sessionId, { key, step, lens, agentId }, { now = new Date().toISOString() } = {}) {
  const file = reviewsPath(sessionId, key);
  const release = acquireLock(`${file}.lock`, { waitMs: 3000 });
  if (!release) return undefined;
  try {
    let held = readJson(file, undefined);
    const slots = held?.slots || {};
    const mine = Object.entries(slots).find(([, s]) => s.agentId === agentId);
    if (mine && held.step === step) return { n: Number(mine[0]), round: held.round };
    const open = Object.values(slots).some((s) => s.result === 'running');
    if (!held || held.step !== step || !open) held = { step, round: now, slots: {} };
    let n = 1;
    while (held.slots[n] && n <= REVIEW_SLOTS_MAX) n += 1;
    if (n > REVIEW_SLOTS_MAX) return undefined;
    held.slots[n] = { lens, agentId, result: 'running' };
    writeJson(file, held);
    return { n, round: held.round };
  } finally {
    release();
  }
}

/**
 * True when the step's newest round is over and found problems: the
 * next agent sent alone is most likely the fix (MACLEOD-722).
 */
export function afterFindings(sessionId, key, step) {
  // readJson answers undefined for a missing or broken file; it never throws.
  const held = key ? readJson(reviewsPath(sessionId, key), undefined) : undefined;
  const slots = Object.values(held?.slots || {});
  return Boolean(held?.step === step && slots.length && !slots.some((s) => s.result === 'running')
    && slots.some((s) => s.result === 'findings' || s.result === 'failed'));
}

/** Mark a slot answered, so the next reviewer after this round opens a new one. */
export function settleReview(sessionId, key, n, result) {
  try {
    const file = reviewsPath(sessionId, key);
    const held = readJson(file, undefined);
    if (!held?.slots?.[n]) return;
    held.slots[n].result = result;
    writeJson(file, held);
  } catch { /* the next round starts when the step changes */ }
}

/**
 * The sidecar for one reviewer: its step, its lens, the enum and the
 * counts. The kind follows the step, so an audit reviewer is an audit
 * run. No text a reviewer wrote is an input to this function.
 */
export function reviewPayload(review, verdict, state = {}, now = new Date().toISOString()) {
  const result = REVIEW_RESULTS.includes(verdict?.result) ? verdict.result : 'failed';
  const block = { lens: review.lens, result, round: review.round };
  for (const field of ['findings', ...SEVERITIES]) {
    if (verdict?.[field]) block[field] = clampCount(verdict[field]);
  }
  if (verdict?.stated) block.stated = true;
  // A withdrawn reviewer (MACLEOD-722) is no longer a verdict either way.
  const status = result === 'running' ? 'running' : result === 'pass' ? 'success' : result === 'withdrawn' ? 'idle' : 'failed';
  return {
    jiraKey: review.key,
    slot: `review-${review.n}`,
    id: `review-${review.n}-${review.key}`.slice(0, 80),
    kind: review.step.endsWith('AUDIT') ? 'audit' : 'test',
    label: review.lens,
    stage: review.step,
    status,
    summary: reviewSentence(review.lens, block),
    agent: agentBlock(state),
    startedAt: review.startedAt || now,
    ...(result === 'running' ? {} : { endedAt: now }),
    updatedAt: now,
    review: block,
  };
}

/** Send one reviewer's sidecar. Never throws. */
export async function reportReview(document, config) {
  try {
    const sent = { ...document, tenantId: tenantId(config) };
    return transportOf(config) === 'service'
      ? await sendReport('runtime', sent.slot, sent, config, { account: reportScope(config) })
      : await putReport(tenantPath(config, `runtime/${sent.jiraKey}/${sent.slot}.json`), sent, config);
  } catch {
    return undefined;
  }
}

export const REVIEW_USAGE = 'Usage: teamflow review start --lens <name> | teamflow review done --result pass|findings|failed [--high N] [--medium N] [--low N]';

/**
 * `teamflow review done`: a reviewer states its result exactly. The
 * hook of the agent that ran it reads the same words from its own shell
 * command and sends them; this only checks them and says what goes on
 * the card. Exit 2 on words it cannot read.
 */
export function main(args = [], { print = (line) => process.stdout.write(`${line}\n`), fail = (line) => process.stderr.write(`${line}\n`) } = {}) {
  // `review start` (MACLEOD-722): the session's hook reads the same words
  // from this shell command and marks the NEXT agent it launches a
  // reviewer. This only checks them and says so.
  if (args[0] === 'start') {
    const start = reviewStartOf(`teamflow review ${args.join(' ')}`);
    print(start.lens ? `The next agent you start reviews ${start.lens}.` : 'The next agent you start is a reviewer.');
    return 0;
  }
  const stated = args[0] === 'done' ? parseReviewArgs(args.slice(1)) : undefined;
  if (!stated) {
    fail(REVIEW_USAGE);
    return 2;
  }
  print(`TeamFlow will show this on the card: ${reviewSentence('Your review', stated)}`);
  return 0;
}
