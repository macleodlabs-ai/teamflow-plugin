// Needs you: what an agent needs from a named person (MACLEOD-894).
//
// The owner, 2026-09-26: "Anything for me should always be in my needs
// you list from now on." So an agent asks for it here, in plain words,
// and it waits in that person's Needs you until they answer in the app:
//
//   teamflow card ask <KEY> --for <person|owner|admins> \
//       --kind check|decision|approval "<one plain sentence>" [--options "A|B|C"]
//   teamflow card ask <KEY> --clear <id>      take it back
//   teamflow needs                            what waits for you, and answers
//                                             to what you asked
//
// The question goes through the words checker here (`sayCheck`, at most
// 200 characters) before anything is sent, and again on the service.
// Who may see and answer an item is the service's rule
// (adapters/teamflow/needs.py); nothing here decides it.
//
// The answer comes back to the asking session in `teamflow status` and
// `teamflow needs`, once each (`needs/seen.json` remembers which).
// Nothing in an answer is ever run.

import path from 'node:path';

import * as core from './core.mjs';
import { serviceUrl } from './core.mjs';
import { sayCheck, SAY_WORDS } from './words.mjs';

export const ASK_USAGE = 'Usage: teamflow card ask <KEY> --for <person|owner|admins> --kind check|decision|approval "<one plain sentence>" [--options "A|B|C"], or teamflow card ask <KEY> --clear <id>';
export const TEXT_MAX = 200;
const KEY = /^(?:[A-Za-z][A-Za-z0-9]{0,19}-\d{1,9}|[\w.-]{1,80}\/[\w.-]{1,80}#\d{1,9}|#\d{1,9})$/;
const KINDS = ['check', 'decision', 'approval'];
const ID = /^need_[0-9a-f]{16}$/;
const SEEN_MAX = 200;
const KIND_WORDS = { check: 'a check', decision: 'a decision', approval: 'an approval' };

const seenPath = () => path.join(core.dataDir(), 'needs', 'seen.json');

/** The problems a question has, in plain words, or []. */
export function askProblems(text) {
  return [...new Set(sayCheck(text, TEXT_MAX).map((p) => (p.rule === 'too_long'
    ? `Keep it to ${TEXT_MAX} characters.`
    : p.rule === 'empty' ? 'Write one plain sentence.' : SAY_WORDS[p.rule] || 'Use plain words.')))];
}

/** Parse `card ask` arguments. Returns `{ body }`, `{ clear }` or `{ error }`. */
export function parseAsk(args = []) {
  const [verb, rawKey, ...rest] = args;
  if (verb !== 'ask') return { error: ASK_USAGE };
  const key = String(rawKey || '').trim();
  if (!KEY.test(key)) return { error: ASK_USAGE };
  const flags = {};
  const words = [];
  for (let i = 0; i < rest.length; i += 1) {
    const m = /^--(for|kind|options|clear)$/.exec(rest[i]);
    if (m) {
      if (rest[i + 1] === undefined) return { error: ASK_USAGE };
      flags[m[1]] = rest[i + 1];
      i += 1;
    } else {
      words.push(rest[i]);
    }
  }
  if (flags.clear !== undefined) {
    return ID.test(flags.clear) ? { key, clear: flags.clear } : { error: 'Name the item by its id, as teamflow needs prints it.' };
  }
  if (!flags.for) return { error: ASK_USAGE };
  if (!KINDS.includes(flags.kind)) return { error: 'Choose check, decision or approval with --kind.' };
  const text = words.join(' ').replace(/\s+/g, ' ').trim();
  const problems = askProblems(text);
  if (problems.length) return { error: `TeamFlow did not send it. ${problems.join(' ')}` };
  const body = { key, for: flags.for, kind: flags.kind, text };
  if (flags.options !== undefined) {
    if (flags.kind !== 'decision') return { error: 'Only a decision has options.' };
    const options = flags.options.split('|').map((o) => o.trim()).filter(Boolean);
    if (options.length < 2 || options.length > 5) return { error: 'A decision has two to five short options.' };
    body.options = options;
  }
  return { body };
}

/** One call to the service's `/v1/members/needs` routes. */
export async function request(method, route, body, config = {}) {
  const cred = await core.credential(config);
  if (!cred) return { ok: false, reason: 'no service credential available' };
  try {
    const response = await fetch(`${serviceUrl(config)}/v1/members/needs${route}`, {
      method,
      headers: { [cred.header]: cred.value, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 5000)),
    });
    let parsed;
    try { parsed = await response.json(); } catch { parsed = undefined; }
    if (!response.ok) return { ok: false, status: response.status, reason: parsed?.message || `service returned ${response.status}` };
    return { ok: true, status: response.status, body: parsed };
  } catch (error) {
    return { ok: false, reason: core.unreachableReason(error, config) };
  }
}

function readSeen() {
  const held = core.readJson(seenPath(), []);
  return Array.isArray(held) ? held : [];
}

function markSeen(ids) {
  if (!ids.length) return;
  const held = [...new Set([...readSeen(), ...ids])].slice(-SEEN_MAX);
  try {
    core.writeJson(seenPath(), held);
  } catch {
    /* no data directory: the answer is printed again next time */
  }
}

/** The answer in words: Done, Approved, Declined, the option or the short answer. */
export function answerWords(item) {
  const answer = item?.answer || {};
  if (item?.kind === 'check') return 'Done';
  if (item?.kind === 'approval') return answer.approve ? 'Approved' : 'Declined';
  if (Number.isInteger(answer.choice)) return item.options?.[answer.choice] ?? 'an option';
  return answer.other || '';
}

function whoWords(item) {
  if (item.for === 'owner') return 'the owner';
  if (item.for === 'admins') return 'the owner or an admin';
  return String(item.to || 'a person').split('@')[0];
}

/** One line per item waiting for this person. */
export function forYouLines(items = []) {
  return items.map((item) => {
    const opts = item.options?.length ? ` Options: ${item.options.join(', ')}.` : '';
    return `${item.key} · ${KIND_WORDS[item.kind] || 'a request'} from ${String(item.by || 'someone').split('@')[0]}: ${item.text}${opts} (${item.id})`;
  });
}

/** One line per answer to what this person asked, not shown before. Marks them shown. */
export function answerLines(asked = [], { mark = true } = {}) {
  const seen = new Set(readSeen());
  const fresh = asked.filter((item) => item.status === 'answered' && !seen.has(item.id));
  if (mark) markSeen(fresh.map((item) => item.id));
  return fresh.map((item) => {
    const by = String(item.answer?.by || whoWords(item)).split('@')[0];
    return `${by} answered your ${item.kind} on ${item.key}: ${answerWords(item)}.`;
  });
}

/** What `teamflow status` prints: answers first, then how many wait for you. Never throws. */
export async function statusLines(config = {}, ctx = {}) {
  if (!core.credentialKind(config)) return [];
  const got = await (ctx.request || request)('GET', '', undefined, config);
  if (!got.ok) return [];
  const lines = answerLines(got.body?.asked).map((line) => `TeamFlow: ${line}`);
  const open = got.body?.forYou?.length || 0;
  if (open) lines.push(`TeamFlow: ${open === 1 ? '1 item waits' : `${open} items wait`} for you in Needs you.`);
  return lines;
}

/** `teamflow card ask ...`. 0 sent, 1 not sent, 2 a bad argument or words that are not plain. */
export async function askMain(args = [], ctx = {}) {
  const print = ctx.print || ((line) => process.stdout.write(`${line}\n`));
  const fail = ctx.fail || ((line) => process.stderr.write(`${line}\n`));
  const send = ctx.request || request;
  const config = ctx.config || {};
  const parsed = parseAsk(args);
  if (parsed.error) { fail(parsed.error); return 2; }
  if (parsed.clear) {
    const out = await send('POST', `/${parsed.clear}/withdraw`, undefined, config);
    if (!out.ok) { fail(`TeamFlow could not take it back: ${out.reason}`); return 1; }
    print(`TeamFlow took back the item on ${parsed.key}.`);
    return 0;
  }
  const out = await send('POST', '', parsed.body, config);
  if (!out.ok) { fail(`TeamFlow did not send it: ${out.reason}`); return out.status === 400 ? 2 : 1; }
  const need = out.body?.need || {};
  print(`TeamFlow put ${KIND_WORDS[need.kind] || 'the item'} for ${whoWords(need)} on ${parsed.key}. It shows in their Needs you. Id: ${need.id}.`);
  return 0;
}

/** `teamflow needs`: what waits for you, then answers to what you asked. */
export async function needsMain(_args = [], ctx = {}) {
  const print = ctx.print || ((line) => process.stdout.write(`${line}\n`));
  const fail = ctx.fail || ((line) => process.stderr.write(`${line}\n`));
  const config = ctx.config || {};
  const got = await (ctx.request || request)('GET', '', undefined, config);
  if (!got.ok) { fail(`TeamFlow could not read Needs you: ${got.reason}`); return 1; }
  const mine = forYouLines(got.body?.forYou);
  print(mine.length ? 'Waiting for you:' : 'Nothing waits for you.');
  for (const line of mine) print(`  ${line}`);
  const open = (got.body?.asked || []).filter((item) => item.status === 'open');
  if (open.length) print(`You asked ${open.length} ${open.length === 1 ? 'thing' : 'things'} that nobody has answered yet.`);
  for (const line of answerLines(got.body?.asked)) print(line);
  return 0;
}
