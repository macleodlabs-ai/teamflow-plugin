// What the hooks learned about one ticket's work (MACLEOD-968).
//
// Two derived facts a saved process needs, kept on this machine:
// - `testFirst`: `proved` once a test run failed after only test files
//   changed and a later run passed after a code change; `red` while the
//   failing first run is the latest word; `none` before either.
// - `risk`: which of RISK_AREAS the ticket's work touched, judged from
//   the paths edited while bound to it. The paths never leave the machine;
//   only the area names do.
//
// This is the interface workflow.mjs reads. The hooks fill it in.
//
// The owner, 2026-10-03: "Let's simplify the default sdlc ... as opus only
// needs occasional audits. But still needs tdd." Test-first is proved by
// the hooks, not claimed by the agent; audits follow risky changes.
//
// The record is one small file per ticket under the plugin's data
// directory (`ticket-facts/<key>.json`). It holds counters, times, two
// flags and area names. No path, command, test name or output is kept,
// not even locally: each edit is judged as it happens and only the
// verdict is written down.
//
// Every entry point fails open. The hook wraps the call in try/catch and
// keeps the classifier's own transition when anything here throws.

import path from 'node:path';

import { dataDir, readJson, writeJson } from './core.mjs';
import { RISK_AREAS } from './process.mjs';

export const TEST_FIRST = Object.freeze(['proved', 'red', 'not_needed', 'none']);
export const EDIT_TOOLS = Object.freeze(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const RED_SUMMARY = 'Wrote the tests first. They fail as expected.';

/**
 * Which edited files are tests. One table for every language the plugin
 * meets; a path is matched with forward slashes, case-insensitive.
 */
export const TEST_FILE_PATTERNS = Object.freeze([
  /\.(?:test|spec)\.[a-z0-9]+$/i, // JS/TS and friends: foo.test.ts, foo.spec.js
  /(?:^|\/)__tests__\//i, // Jest's folder
  /(?:^|\/)test_[^/]*\.py$/i, // pytest: test_foo.py
  /_test\.py$/i, // pytest: foo_test.py
  /(?:^|\/)tests?\//i, // a tests/ or test/ folder (Python, Node, Rust)
  /_test\.go$/i, // Go
  /(?:^|\/)src\/test\//i, // Java and Kotlin (Maven, Gradle)
  /_spec\.rb$/i, // RSpec
]);

/**
 * What makes a change risky (process.mjs RISK_AREAS). Each area is a list
 * of words matched against the words of a path: split at separators and
 * camelCase, lower-cased, with two neighbouring words also tried joined
 * (`signIn` is `signin`). A word matches a listed word, or that word plus
 * a common ending (`tokens`, `deployment`, `reporter`). A word is never
 * matched inside another word, so `import` is not `port` and `tokenizer`
 * is not `token`. `paths` are whole-path patterns for what words miss.
 */
export const RISK_PATTERNS = Object.freeze({
  auth: Object.freeze({
    words: ['auth', 'authn', 'authz', 'authentication', 'authenticate', 'authorization', 'authorize', 'login', 'signin',
      'session', 'token', 'secret', 'credential', 'oauth', 'passkey', 'iam', 'permission'],
    paths: [],
  }),
  money: Object.freeze({
    words: ['billing', 'payment', 'stripe', 'invoice', 'price', 'pricing', 'refund', 'checkout', 'subscription'],
    paths: [],
  }),
  reporting: Object.freeze({
    words: ['report', 'redact', 'redaction', 'privacy', 'telemetry', 'analytics', 'export', 'gdpr'],
    paths: [],
  }),
  infra: Object.freeze({
    words: ['infra', 'terraform', 'cloudformation', 'deploy', 'k8s', 'helm', 'dockerfile'],
    paths: [/(?:^|\/)template\.ya?ml$/i, /(?:^|\/)dockerfile[^/]*$/i, /(?:^|\/)\.github\/workflows\//i, /\.tf$/i],
  }),
});
const ENDINGS = ['', 's', 'es', 'ed', 'er', 'ers', 'ing', 'ings', 'ment', 'ments'];

const slashes = (file) => String(file || '').replace(/\\/g, '/');

/**
 * Files that are not code (owner, 2026-10-03: a ticket that changes no code
 * skips Write test). Docs, plain text, images and lock files. Matched on
 * the file name, case-insensitive.
 */
export const NOT_CODE_PATTERNS = Object.freeze([
  /\.(?:md|mdx|markdown|txt|rst|adoc|org)$/i,
  /\.(?:png|jpe?g|gif|svg|webp|ico|bmp|pdf)$/i,
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|Cargo\.lock|Gemfile\.lock|go\.sum|composer\.lock|[^/]+\.lock)$/i,
  /(?:^|\/)(?:LICEN[CS]E|NOTICE|AUTHORS|CODEOWNERS)(?:\.[a-z]+)?$/i,
]);

/** True when `file` is not code by NOT_CODE_PATTERNS. */
export function isNotCode(file) {
  const p = slashes(file);
  return Boolean(p) && NOT_CODE_PATTERNS.some((re) => re.test(p));
}

/** True when `file` is a test file by TEST_FILE_PATTERNS. */
export function isTestFile(file) {
  const p = slashes(file);
  return Boolean(p) && TEST_FILE_PATTERNS.some((re) => re.test(p));
}

function pathWords(file) {
  const words = slashes(file)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const joined = words.slice(1).map((w, i) => words[i] + w);
  return [...words, ...joined];
}

/** The risk areas `file` belongs to, in RISK_AREAS order. Never a path. */
export function riskAreasOf(file) {
  const p = slashes(file);
  if (!p) return [];
  const words = new Set(pathWords(p));
  return RISK_AREAS.filter((area) => {
    const { words: listed = [], paths = [] } = RISK_PATTERNS[area] || {};
    if (paths.some((re) => re.test(p))) return true;
    return listed.some((w) => ENDINGS.some((end) => words.has(w + end)));
  });
}

// --- the record ------------------------------------------------------

const safeName = (key) => String(key).replace(/[^A-Za-z0-9_.-]/g, '_');

/** Where `key`'s record lives on this machine. */
export function recordPath(key, options = {}) {
  return path.join(options.dir || path.join(dataDir(), 'ticket-facts'), `${safeName(key)}.json`);
}

function readRecord(key, options) {
  const held = readJson(recordPath(key, options));
  return held && typeof held === 'object' && !Array.isArray(held) ? held : { seq: 0 };
}

function stamp(record, options) {
  const seq = (Number(record.seq) || 0) + 1;
  return { seq, at: new Date(options.now ?? Date.now()).toISOString() };
}

/** Note one edit of `file` on `key`'s record: test or code, and its risk areas. */
export function noteEdit(key, file, options = {}) {
  if (!key || !file) return undefined;
  const record = readRecord(key, options);
  const { seq, at } = stamp(record, options);
  const next = { ...record, seq, edited: true };
  if (isTestFile(file)) next.testEdit = { seq, at };
  else if (isNotCode(file)) next.otherEdit = { seq, at };
  else {
    next.code = true;
    next.codeEdit = { seq, at };
    // Code written after the expected red run: the second half of the proof.
    if (next.red && !next.red.codeAfter) next.red = { ...next.red, codeAfter: true };
  }
  const risk = new Set([...(Array.isArray(record.risk) ? record.risk : []), ...riskAreasOf(file)]);
  next.risk = RISK_AREAS.filter((area) => risk.has(area));
  writeJson(recordPath(key, options), next);
  return next;
}

/**
 * Whether a failing run now is the expected first step of test-first:
 * test files changed since the last test run, and no code changed since
 * the last passing run. The newest edits are tests.
 */
export function redExpected(record) {
  const lastRun = record.lastRun?.seq || 0;
  const lastGreen = record.lastGreen?.seq || 0;
  return (record.testEdit?.seq || 0) > lastRun && (record.codeEdit?.seq || 0) <= lastGreen;
}

/** Note one test run on `key`'s record. Returns whether a failing run was the expected red. */
export function noteTestRun(key, passed, options = {}) {
  if (!key) return { expected: false };
  const record = readRecord(key, options);
  const expected = !passed && redExpected(record);
  const { seq, at } = stamp(record, options);
  const next = { ...record, seq, lastRun: { seq, at, result: passed ? 'green' : 'red' } };
  if (passed) {
    next.lastGreen = { seq, at };
    if (next.red?.codeAfter) next.proved = { at };
    delete next.red;
  } else if (expected) {
    next.red = { seq, at, codeAfter: false };
  }
  writeJson(recordPath(key, options), next);
  return { expected };
}

/** The facts for `key`. Never throws; an unknown ticket has none. */
export function readTicketFacts(key, options = {}) {
  try {
    if (!key) return { testFirst: 'none', risk: [] };
    const record = readJson(recordPath(key, options));
    if (!record || typeof record !== 'object') return { testFirst: 'none', risk: [] };
    // Work that edited only files that are not code (docs, text, images,
    // lock files) has nothing to test first. A test edit counts as code here.
    const testFirst = record.proved ? 'proved' : record.red ? 'red'
      : record.edited && !record.code && !record.testEdit ? 'not_needed' : 'none';
    const risk = RISK_AREAS.filter((area) => Array.isArray(record.risk) && record.risk.includes(area));
    return { testFirst, risk };
  } catch {
    return { testFirst: 'none', risk: [] };
  }
}

// --- on the hook -----------------------------------------------------

// The path inside the working copy, so a folder above it (a home
// directory called `deploy`, a checkout under `test/`) judges nothing.
function editedFile(input) {
  const tool = input.tool_input || {};
  const file = tool.file_path || tool.notebook_path || tool.path;
  if (typeof file !== 'string' || !file) return undefined;
  const cwd = typeof input.cwd === 'string' ? input.cwd : '';
  if (!cwd || !path.isAbsolute(file)) return file;
  const inside = path.relative(cwd, file);
  return inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? inside : file;
}

/**
 * The hook's one call (hook-core.mjs). Notes this event on the bound
 * ticket's record and returns the transition to apply: the classifier's
 * own, except that an expected red run is a step of Local Test, not
 * rework. May throw; the caller keeps `transition` when it does.
 */
export function noteTicketWork(state, input, transition, options = {}) {
  const key = state?.binding?.key;
  const event = input?.hook_event_name;
  if (!key || (event !== 'PostToolUse' && event !== 'PostToolUseFailure')) return transition;
  if (EDIT_TOOLS.includes(input.tool_name) && event === 'PostToolUse') {
    const file = editedFile(input);
    if (file) noteEdit(key, file, options);
    return transition;
  }
  if (!transition?.localTestRun) return transition;
  const passed = transition.status !== 'failed';
  const { expected } = noteTestRun(key, passed, options);
  if (!expected) return transition;
  // No loop, no rework mark, no failure points: failing is the point.
  return { stage: 'LOCAL_TEST', status: 'running', summary: RED_SUMMARY, sticky: true };
}
