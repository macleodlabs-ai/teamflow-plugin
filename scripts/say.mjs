// A card's plain line (MACLEOD-770, MACLEOD-766 spec point 3).
//
// The owner: a card must say what a person gets from the piece, not just
// its key. The model doing the work knows that best, and it runs in the
// user's own session, so asking it costs nothing extra:
//
//   teamflow card say <KEY> "<one or two plain sentences>" [--by model|person]
//
// Three boundaries decide the shape of this.
//
// **Code is the referee.** The line goes through the words checker here
// (`sayCheck`, the twin of the service's) before anything is sent, and
// again on the service. A line with code, a path, a link, an email, a
// secret, more than two sentences or 180 characters is refused here in
// plain words, and nothing leaves the machine.
//
// **The hooks ask; they never block.** At dispatch, merge and deploy the
// hook adds one short instruction to what the session's Claude reads,
// and only for a card with no line, or one whose line predates the work
// now under way (`needsLine`). Every helper here fails open.
//
// **Local memory only.** Whether a card has a line, and when its work
// started, is this machine's own record (`say/lines.json`): the hook
// path makes no network call to find out.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as core from './core.mjs';
import { sayCheck, sayWords } from './words.mjs';

export const SAY_USAGE = 'Usage: teamflow card say <KEY> "<one or two plain sentences about what a person gets>" [--by model|person]';
const KEY = /^(?:[A-Za-z][A-Za-z0-9]{0,19}-\d{1,9}|[\w.-]{1,80}\/[\w.-]{1,80}#\d{1,9}|#\d{1,9})$/;
const LINES_MAX = 500;
const OWED_MAX = 20;
// Keys named in one dispatch that get a prompt; more is noise.
const PROMPT_KEYS_MAX = 3;

const linesPath = () => path.join(core.dataDir(), 'say', 'lines.json');
const owedPath = () => path.join(core.dataDir(), 'say', 'owed.json');

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  core.writeJson(file, value);
}

/** `{ KEY: { at, by, startedAt } }`: this machine's record of lines and work. */
export function readLines() {
  const held = core.readJson(linesPath(), {});
  return held && typeof held === 'object' && !Array.isArray(held) ? held : {};
}

function keep(held) {
  const keys = Object.keys(held);
  return Object.fromEntries(keys.slice(Math.max(0, keys.length - LINES_MAX)).map((k) => [k, held[k]]));
}

/** The line this machine sent for `key`: remembered, so the hooks can tell. */
export function noteLine(key, { at, by }) {
  const held = readLines();
  held[key] = { ...(held[key] || {}), at, by };
  write(linesPath(), keep(held));
}

/** Work on `key` started now (a dispatch): a line older than this is about earlier work. */
export function noteWork(key, at = new Date().toISOString()) {
  const held = readLines();
  held[key] = { ...(held[key] || {}), startedAt: at };
  write(linesPath(), keep(held));
}

/**
 * Whether the hooks should ask for a line on `key`: it has none on this
 * machine, or its line predates the work now under way.
 */
export function needsLine(key, lines = readLines()) {
  const held = lines[key];
  if (!held?.at) return true;
  const started = Date.parse(held.startedAt || '');
  return Number.isFinite(started) && Date.parse(held.at) < started;
}

/** The command the session runs, with this plugin's own path. */
export function sayCommand() {
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
  return `node "${cli}" card say`;
}

/**
 * The one short instruction the hook adds, or undefined. Only for the
 * keys that need a line. Words for the model, and still plain.
 */
export function sayPrompt(keys = [], lead = '', lines = readLines()) {
  const want = [...new Set(keys)].filter((k) => KEY.test(k) && needsLine(k, lines)).slice(0, PROMPT_KEYS_MAX);
  if (!want.length) return undefined;
  const cards = want.length === 1 ? `card ${want[0]}` : `cards ${want.join(', ')}`;
  return `TeamFlow: ${lead ? `${lead} ` : ''}Write one plain line for ${cards}: what a person gets from it. `
    + `Run \`${sayCommand()} <KEY> "<one or two short sentences>"\` for each. No code, paths or links.`;
}

// --- merges seen by the background pass -------------------------------------
//
// The merged-cards pass runs in the heartbeat, where nothing speaks to a
// session. It leaves the keys here; the next prompt of a session on this
// machine says them once.

export function oweLines(keys = [], why = 'merge', at = new Date().toISOString()) {
  const lines = readLines();
  const want = keys.filter((k) => KEY.test(k) && needsLine(k, lines));
  if (!want.length) return 0;
  const held = core.readJson(owedPath(), []);
  const list = (Array.isArray(held) ? held : []).filter((o) => !want.includes(o?.key));
  write(owedPath(), [...list, ...want.map((key) => ({ key, why, at }))].slice(-OWED_MAX));
  return want.length;
}

/** The prompt for what the background pass left, once; the file is emptied. */
export function takeOwed() {
  const held = core.readJson(owedPath(), []);
  if (!Array.isArray(held) || !held.length) return undefined;
  write(owedPath(), []);
  return sayPrompt(held.map((o) => o?.key).filter(Boolean), 'The work is merged.');
}

// --- the command -------------------------------------------------------------

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Who wrote it: the model inside a Claude Code session, else a person. */
export function authorOf(given, env = process.env) {
  if (given === 'model' || given === 'person') return given;
  if (given !== undefined) throw new Error('--by must be model or person');
  return env.CLAUDECODE === '1' ? 'model' : 'person';
}

/**
 * `teamflow card say <KEY> "<line>"`. Returns the exit code: 0 sent or
 * queued, 1 not sent, 2 a bad argument or a line that is not plain.
 */
export async function main(args = [], ctx = {}) {
  const print = ctx.print || ((line) => process.stdout.write(`${line}\n`));
  const fail = ctx.fail || ((line) => process.stderr.write(`${line}\n`));
  const send = ctx.send || core.sendSay;
  const config = ctx.config || {};
  const env = ctx.env || process.env;
  const at = ctx.now || new Date().toISOString();
  const [verb, rawKey, ...rest] = args;
  if (verb !== 'say') { fail(SAY_USAGE); return 2; }
  const words = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--by') { i += 1; continue; }
    words.push(rest[i]);
  }
  const key = String(rawKey || '').trim();
  if (!KEY.test(key)) { fail(SAY_USAGE); return 2; }
  let by;
  try { by = authorOf(flag(rest, 'by'), env); } catch (error) { fail(error.message); return 2; }
  const line = words.join(' ').replace(/\s+/g, ' ').trim();
  const problems = sayCheck(line);
  if (problems.length) {
    fail(`TeamFlow did not send the line. ${sayWords(problems)}`);
    return 2;
  }
  const out = await send({ jiraKey: key, line, by, at }, config);
  if (out?.ok) {
    noteLine(key, { at, by });
    if (out.said === 'no_card') {
      print(`TeamFlow has no card for ${key} yet. Say it again after the card shows on the board.`);
      return 1;
    }
    print(`TeamFlow put the line on ${key}.`);
    return 0;
  }
  if (out?.queued) {
    noteLine(key, { at, by });
    print(`TeamFlow will send the line for ${key} when the service answers.`);
    return 0;
  }
  fail(`TeamFlow could not send the line for ${key}: ${out?.reason || 'no answer'}.`);
  return 1;
}

export default main;
