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
//
// This machine answers for its own person (MACLEOD-954, the owner,
// 2026-10-02: "so that the mod etc can work"):
//
//   teamflow needs answer <need_id> --choice <n>|--done|--approve|--decline
//   teamflow needs answer <ask_id> --session <id> --choice <n>|--allow|--deny
//
// The service lets it answer only on its own person's cards and in its
// own person's sessions, never in the session it runs in, and History
// says "from Claude Code on <machine>". Every answer is one explicit
// choice on the command line: there is no default and no Allow by
// itself. The mod's buttons run exactly this, as an argument list.

import fs from 'node:fs';
import path from 'node:path';

import * as core from './core.mjs';
import { serviceUrl } from './core.mjs';
import { sayCheck, SAY_WORDS } from './words.mjs';

export const ASK_USAGE = 'Usage: teamflow card ask <KEY> --for <person|owner|admins> --kind check|decision|approval "<one plain sentence>" [--options "A|B|C"], or teamflow card ask <KEY> --clear <id>';
export const TEXT_MAX = 200;
// An option is a short label, checked on its own: the service's
// OPTION_MAX and ANSWER_RULES (adapters/teamflow/needs.py), so the two
// sides refuse the same labels (MACLEOD-914).
export const OPTION_MAX = 60;
const OPTION_RULES = new Set(['empty', 'too_long', 'url', 'email', 'secret', 'path', 'code']);
const KEY = /^(?:[A-Za-z][A-Za-z0-9]{0,19}-\d{1,9}|[\w.-]{1,80}\/[\w.-]{1,80}#\d{1,9}|#\d{1,9})$/;
const KINDS = ['check', 'decision', 'approval'];
const ID = /^need_[0-9a-f]{16}$/;
const ASK_ID = /^ask_[0-9a-f]{16,40}$/;
const SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const ANSWER_USAGE = 'Usage: teamflow needs answer <need_id> --choice <n>|--done|--approve|--decline, or teamflow needs answer <ask_id> --session <id> --choice <n>|--allow|--deny';
const SEEN_MAX = 200;
const KIND_WORDS = { check: 'a check', decision: 'a decision', approval: 'an approval' };

const seenPath = () => path.join(core.dataDir(), 'needs', 'seen.json');

/** The problems a question has, in plain words, or []. A path says
 *  what to write in its place (MACLEOD-914). */
export function askProblems(text) {
  return [...new Set(sayCheck(text, TEXT_MAX).map((p) => (p.rule === 'too_long'
    ? `Keep it to ${TEXT_MAX} characters.`
    : p.rule === 'empty' ? 'Write one plain sentence.'
      : p.rule === 'path' ? 'Leave out file names and paths. Name the thing in words, such as "the MCP list" for "/mcp".'
        : SAY_WORDS[p.rule] || 'Use plain words.')))];
}

/** The problems one option has, or []. A label, not a sentence. */
export function optionProblems(option) {
  return [...new Set(sayCheck(option, OPTION_MAX).filter((p) => OPTION_RULES.has(p.rule)).map((p) => (p.rule === 'too_long'
    ? `Keep each option to ${OPTION_MAX} characters.`
    : p.rule === 'path' ? 'Leave out file names and paths. Name the thing in words.'
      : SAY_WORDS[p.rule] || 'Use plain words.')))];
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
    // `--options=Yes|No` is the same flag as `--options "Yes|No"`: read
    // as words, it put the options into the sentence and failed the
    // words check as code (MACLEOD-914).
    const eq = /^--(for|kind|options|clear)=(.*)$/s.exec(rest[i]);
    const m = /^--(for|kind|options|clear)$/.exec(rest[i]);
    if (eq) {
      flags[eq[1]] = eq[2];
    } else if (m) {
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
    const bad = [...new Set(options.flatMap(optionProblems))];
    if (bad.length) return { error: `TeamFlow did not send it. ${bad.join(' ')}` };
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

/** One line per item waiting for this person. An item this person asked
 *  (its id is in `asked`) is "from you", not their own name (MACLEOD-914). */
export function forYouLines(items = [], asked = []) {
  const mine = new Set(asked.map((item) => item?.id).filter(Boolean));
  return items.map((item) => {
    const opts = item.options?.length ? ` Options: ${item.options.join(', ')}.` : '';
    const from = mine.has(item.id) ? 'you' : String(item.by || 'someone').split('@')[0];
    /* MACLEOD-931: TeamFlow's own decision states what happens with no answer. */
    const fallback = item.defaultWords ? ` ${item.defaultWords}` : '';
    return `${item.key} · ${KIND_WORDS[item.kind] || 'a request'} from ${from}: ${item.text}${opts}${fallback} (${item.id})`;
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
  /* MACLEOD-931, R3: an agent's question ends with its session, so the
     service is told which session asked. Never throws: no session, no field. */
  let session = ctx.session;
  if (session === undefined) {
    try { session = core.latestSessionForCwd(process.cwd(), config)?.sessionId; } catch { session = undefined; }
  }
  const body = session ? { ...parsed.body, session: String(session) } : parsed.body;
  const out = await send('POST', '', body, config);
  if (!out.ok) { fail(`TeamFlow did not send it: ${out.reason}`); return out.status === 400 ? 2 : 1; }
  const need = out.body?.need || {};
  /* MACLEOD-931, R3: a person has at most five open questions. The sixth
     waits, and the asker is told why in plain words. */
  if (need.status === 'held') {
    print(need.heldWords || `${whoWords(need)} already has 5 open questions. TeamFlow holds this one and shows it when one of them ends.`);
    print(`Id: ${need.id}.`);
    return 0;
  }
  // parseAsk returns `{ body }`: the key is `body.key`, and the service
  // echoes it on `need.key` (MACLEOD-914: this read `parsed.key`, undefined).
  print(`TeamFlow put ${KIND_WORDS[need.kind] || 'the item'} for ${whoWords(need)} on ${need.key || parsed.body.key}. It shows in their Needs you. Id: ${need.id}.`);
  return 0;
}

/**
 * `teamflow needs answer ...` as `{ route, body }`, or `{ error }`. Exactly
 * one answer flag: nothing here picks one for the person.
 */
export function parseAnswer(args = []) {
  const [verb, id, ...rest] = args;
  if (verb !== 'answer' || !id) return { error: ANSWER_USAGE };
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--choice' || flag === '--session') { flags[flag] = rest[i + 1]; i += 1; } else flags[flag] = true;
  }
  const given = ['--choice', '--done', '--approve', '--decline', '--allow', '--deny'].filter((f) => flags[f] !== undefined);
  if (given.length !== 1) return { error: ANSWER_USAGE };
  const choice = given[0] === '--choice' ? Number(flags['--choice']) : undefined;
  if (choice !== undefined && !(/^\d$/.test(String(flags['--choice'])) && Number.isInteger(choice))) return { error: ANSWER_USAGE };
  if (ID.test(id)) {
    const body = { '--choice': { choice }, '--done': { done: true }, '--approve': { approve: true }, '--decline': { approve: false } }[given[0]];
    if (!body || flags['--session'] !== undefined) return { error: ANSWER_USAGE };
    return { route: `/v1/members/needs/${id}/answer`, body };
  }
  if (ASK_ID.test(id) && SESSION.test(String(flags['--session'] || ''))) {
    const body = { '--choice': { choice }, '--allow': { approve: true }, '--deny': { approve: false } }[given[0]];
    if (!body) return { error: ANSWER_USAGE };
    return { route: `/v1/members/sessions/${flags['--session']}/answers`, body: { askId: id, ...body } };
  }
  return { error: ANSWER_USAGE };
}

/**
 * The session this command runs in, as the service names it, or undefined.
 * The plugin's SessionStart hook puts TEAMFLOW_SESSION_ID in the
 * environment of every command the session runs (exportSessionId).
 */
export function runningSession(env = process.env) {
  const raw = env.TEAMFLOW_SESSION_ID || env.CLAUDE_SESSION_ID || '';
  return raw ? core.digest(String(raw)) : undefined;
}

/**
 * SessionStart: name this session to the commands its agent runs, so a
 * session never answers its own question (MACLEOD-954). Claude Code reads
 * the file CLAUDE_ENV_FILE names. Never throws.
 */
export function exportSessionId(sessionId, env = process.env, append = fs.appendFileSync) {
  try {
    const file = env.CLAUDE_ENV_FILE;
    if (!file || !SESSION.test(String(sessionId || ''))) return false;
    append(file, `export TEAMFLOW_SESSION_ID=${sessionId}\n`);
    return true;
  } catch { return false; }
}

/** One answer from this machine: its credential, its machine id and the session it runs in. */
export async function sendAnswer(route, body, config = {}, env = process.env) {
  const cred = await core.credential(config);
  if (!cred) return { ok: false, reason: 'no service credential available; run `teamflow login`' };
  const machine = core.machineId();
  const session = runningSession(env);
  try {
    const response = await fetch(`${serviceUrl(config)}${route}`, {
      method: 'POST',
      headers: {
        [cred.header]: cred.value,
        'content-type': 'application/json',
        // Identifiers, not content: which machine answers, and which
        // session it answers from (docs/REPORTING_CONTRACT.md).
        ...(machine ? { 'X-Machine-Id': machine } : {}),
        ...(session ? { 'X-TeamFlow-Session': session } : {}),
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 20000)),
    });
    let parsed;
    try { parsed = await response.json(); } catch { parsed = undefined; }
    if (!response.ok) return { ok: false, status: response.status, reason: parsed?.message || `service returned ${response.status}` };
    return { ok: true, status: response.status, body: parsed };
  } catch (error) {
    return { ok: false, reason: core.unreachableReason(error, config) };
  }
}

/** The plain line a person reads after an answer from this machine. */
export function answeredLine(parsed, out) {
  const need = out?.body?.need;
  const machine = need?.answer?.machine || out?.body?.answer?.machine || 'this computer';
  if (need) return `TeamFlow took your answer: ${answerWords(need)}. History says it came from Claude Code on ${machine}.`;
  const said = parsed.body.approve === true ? 'Allowed' : parsed.body.approve === false ? 'Denied' : 'Answered';
  return `${said}. The agent gets it in a few seconds. History says it came from Claude Code on ${machine}.`;
}

/** `teamflow needs answer ...`. 0 sent, 1 not sent, 2 a bad argument or refused. */
export async function answerMain(args = [], ctx = {}) {
  const print = ctx.print || ((line) => process.stdout.write(`${line}\n`));
  const fail = ctx.fail || ((line) => process.stderr.write(`${line}\n`));
  const parsed = parseAnswer(args);
  if (parsed.error) { fail(parsed.error); return 2; }
  const out = await (ctx.send || sendAnswer)(parsed.route, parsed.body, ctx.config || {}, ctx.env || process.env);
  if (!out.ok) {
    fail(`TeamFlow did not take the answer: ${out.reason}`);
    return out.status >= 400 && out.status < 500 ? 2 : 1;
  }
  print(answeredLine(parsed, out));
  return 0;
}

/** `teamflow needs`: what waits for you, then answers to what you asked. */
export async function needsMain(_args = [], ctx = {}) {
  if (_args[0] === 'answer') return answerMain(_args, ctx);
  const print = ctx.print || ((line) => process.stdout.write(`${line}\n`));
  const fail = ctx.fail || ((line) => process.stderr.write(`${line}\n`));
  const config = ctx.config || {};
  const got = await (ctx.request || request)('GET', '', undefined, config);
  if (!got.ok) { fail(`TeamFlow could not read Needs you: ${got.reason}`); return 1; }
  const mine = forYouLines(got.body?.forYou, got.body?.asked || []);
  print(mine.length ? 'Waiting for you:' : 'Nothing waits for you.');
  for (const line of mine) print(`  ${line}`);
  const open = (got.body?.asked || []).filter((item) => item.status === 'open');
  if (open.length) print(`You asked ${open.length} ${open.length === 1 ? 'thing' : 'things'} that nobody has answered yet.`);
  for (const line of answerLines(got.body?.asked)) print(line);
  return 0;
}
