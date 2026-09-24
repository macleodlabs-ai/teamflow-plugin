/**
 * The one writer for words a person reads (MACLEOD-646), the plugin's copy.
 *
 * `adapters/teamflow/words.py` is the service's copy and `src/lib/words.ts`
 * the dashboard's; tests/fixtures/words-vectors.json pins all three to the
 * same answers. The plugin uses it for the title of an agent's card, its
 * context lines and the CLI output a person reads.
 *
 *   sentence(parts)  one fact as one sentence: at most 20 words, internal
 *                    words swapped for plain ones, a capital and a stop.
 *   bullets(facts)   several facts as a short list, one "- " line each.
 *   title(raw)       a plain card title from free text such as an agent's
 *                    name and description, 60 characters at most.
 *   candidates(raw)  every title `title` could have chosen, best first.
 *   about(raw)       one plain sentence saying what the work is, or "".
 *   check(text)      the problems in a text: { rule, sentence, found, plain }.
 *   step(gate, from) the step a check or stage id names, as a person says it:
 *                    "Local tests". A rework stage is the step that failed.
 *   GLOSSARY         internal word -> plain word.
 *
 * Deterministic and cheap: no model, no network, no file.
 */

export const MAX_WORDS = 20;
export const TITLE_MAX = 60;
export const BULLETS_MAX = 8;

export const GLOSSARY = {
  'gate verdicts': 'check results',
  'gate verdict': 'check result',
  sidecars: 'reports',
  sidecar: 'report',
  hygiene: 'tidy-up',
  accounting: 'count',
  verdicts: 'results',
  verdict: 'result',
  gates: 'checks',
  gate: 'check',
  heartbeats: 'check-ins',
  heartbeat: 'check-in',
  liveness: 'activity',
  worktrees: 'separate copies',
  worktree: 'separate copy',
  subagents: 'agents',
  subagent: 'agent',
  e2e: 'end-to-end',
  deps: 'dependencies',
  repos: 'repositories',
  repo: 'repository',
  config: 'settings',
  impl: 'build',
  no_verdict: 'no result',
  rerun_gate: 're-run of the check',
  skip_gate: 'skip of the check',
  resume_plan: 'plan restart',
  LOCAL_DEV: 'Local Dev',
  LOCAL_TEST: 'Local Test',
  LOCAL_AUDIT: 'Local Audit',
  LOCAL_REWORK: 'Local Rework',
  CI_BUILD: 'CI/CD',
  DEPLOY_DEV: 'CI/CD',
  DEV_TEST: 'Test Dev',
  DEV_AUDIT: 'Dev Audit',
  DEV_REWORK: 'Dev Rework',
  DEV_VERIFIED: 'Deployed',
  READY_PROD: 'Done',
  // A name only TeamFlow's own people know (MACLEOD-646 follow-up).
  Laya: 'the classifier',
};

export const BANNED = ['sidecar', 'sidecars', 'hygiene', 'accounting', 'gate verdict',
  'gate verdicts', 'heartbeat', 'heartbeats', 'liveness', 'verdict', 'verdicts', 'gate',
  'gates', 'no_verdict', 'LOCAL_DEV', 'LOCAL_TEST', 'LOCAL_AUDIT', 'LOCAL_REWORK',
  'CI_BUILD', 'DEPLOY_DEV', 'DEV_TEST', 'DEV_AUDIT', 'DEV_REWORK', 'DEV_VERIFIED',
  'READY_PROD', 'rerun_gate', 'skip_gate', 'resume_plan'];

export const JARGON = ['idempotent', 'payload', 'enum', 'stdout', 'stderr', 'subagent',
  'subagents', 'worktree', 'worktrees', 'e2e', 'repo', 'repos', 'deps', 'config', 'impl', 'wf'];

const IRREGULAR = ['done', 'made', 'written', 'seen', 'taken', 'given', 'sent', 'built',
  'found', 'kept', 'left', 'lost', 'held', 'shown', 'known', 'told', 'broken', 'chosen',
  'driven', 'drawn', 'hidden', 'begun', 'run', 'set', 'put', 'cut', 'read'];

const PASSIVE_OK = ['based', 'supposed', 'used', 'finished', 'done', 'interested', 'tired',
  'red', 'need', 'seed', 'speed', 'bed', 'shed', 'feed', 'weed'];

const PROPER = ['Claude', 'Code', 'TeamFlow', 'GitHub', 'Linear', 'Jira', 'SonarQube',
  'Playwright', 'Stripe', 'Google', 'Cognito', 'AWS', 'Resend', 'Slack', 'Cursor',
  'Copilot', 'Windsurf', 'Cline', 'Codex', 'Gemini', 'Junie', 'Dev', 'Delivery', 'Home',
  'Attention', 'History', 'Test', 'Audit', 'Rework', 'Deployed', 'Local', 'Done', 'CI/CD',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

const NOISE = ['claude-code', 'claude code', 'general-purpose', 'wf'];

const TAIL = ['a', 'an', 'and', 'the', 'to', 'of', 'for', 'with', 'in', 'on', 'or', 'at',
  'by', 'from', 'until', 'but'];

const KEY = /\b[A-Z][A-Z0-9]*-\d+\b:?/g;
const AGENT_ID = /\b(?:worktree-)?agent-[0-9a-f]{6,}\b/gi;
const HEX = /^(?=[0-9a-f]*\d)[0-9a-f]{7,}$/i;
const CUT = /\S*(?:…|\.\.\.)$/;
const MAJOR = /\s+·\s+|\s+—\s+|\s+-\s+/;
const COLON = /:\s+/;
// An agent's code name says who, not what: ws-d, *-opus, WS-K3.
const CODENAME = /^ws-|-(?:opus|sonnet|haiku|fable)(?:-\d+)?$/i;
const CODEWORD = /^[a-z]+\d[a-z\d]*$/i;
const BRACKETS = /\([\s,;&]*\)|\[[\s,;&]*\]/g;
// Where a long title may stop: after a clause, never inside one.
const CLAUSE = /[,;.](?=\s)|\s—(?=\s)/g;
const AREA_MAX = 3;
const ABOUT_MIN = 3;
// Where an about line stops: its first sentence or clause.
const FIRST = /(?<=[.;!?])\s/;
const SENTENCES = /(?<=[.!?])\s+|\n+|\s+·\s+/;
const CODE = /`[^`]*`/g;
const WORD = /[A-Za-z0-9']/;
const PASSIVE = /\b(?:was|were|been)\s+([A-Za-z]+)\b/gi;

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One pattern for a word list, longest first, whole words only. */
function any(terms) {
  const sorted = [...terms].sort((a, b) => b.length - a.length).map(escape).join('|');
  return new RegExp(`(?<![\\w-])(${sorted})(?![\\w-])`, 'gi');
}

const LOOKUP = Object.fromEntries(Object.entries(GLOSSARY).map(([k, v]) => [k.toLowerCase(), v]));
const ORIGINAL = Object.fromEntries(Object.keys(GLOSSARY).map((k) => [k.toLowerCase(), k]));
// Plain words the glossary writes with a hyphen: words, never a slug.
const HYPHENED = Object.values(GLOSSARY).filter((v) => v.includes('-')).map((v) => v.toLowerCase());
const GLOSS = any(Object.keys(GLOSSARY));
const GLOSS_WHOLE = new RegExp(`^(?:${GLOSS.source})$`, 'i');
const BANNED_RE = any(BANNED);
const JARGON_RE = any(JARGON);

const isUpper = (c) => c !== c.toLowerCase();
const upperFirst = (s) => s[0].toUpperCase() + s.slice(1);

function strip(text, chars, left = true) {
  let start = 0;
  let end = text.length;
  while (left && start < end && chars.includes(text[start])) start += 1;
  while (end > start && chars.includes(text[end - 1])) end -= 1;
  return text.slice(start, end);
}

/** Every glossary word in `text` swapped for its plain word. */
export function plainer(text) {
  return text.replace(GLOSS, (found, _g, at) => {
    const plain = LOOKUP[found.toLowerCase()];
    // A capital at the start of a sentence carries over; a name's own
    // capital ("Laya") and a capital mid-sentence ("the Sidecar") do not.
    const original = ORIGINAL[found.toLowerCase()];
    const before = text.slice(0, at).trimEnd();
    const first = !before || '.!?'.includes(before[before.length - 1]);
    return isUpper(found[0]) && original === original.toLowerCase() && first ? upperFirst(plain) : plain;
  });
}

const squash = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const counted = (text) => text.split(' ').filter((w) => WORD.test(w));

/** One fact as one sentence of at most 20 words. */
export function sentence(parts) {
  const list = typeof parts === 'string' ? [parts] : (parts || []);
  let text = squash(list.map(squash).filter(Boolean).join(' '));
  text = strip(plainer(text), ' .;:,', false);
  if (!text) return '';
  const words = text.split(' ');
  const at = words.flatMap((w, i) => (WORD.test(w) ? [i] : []));
  if (at.length > MAX_WORDS) {
    const kept = words.slice(0, at[MAX_WORDS - 1] + 1);
    while (kept.length > 1 && TAIL.includes(strip(kept[kept.length - 1].toLowerCase(), ',;:'))) kept.pop();
    text = strip(kept.join(' '), ' .;:,', false);
  }
  text = upperFirst(text);
  return '?!'.includes(text[text.length - 1]) ? text : `${text}.`;
}

/*
 * The step a check or stage id names (MACLEOD-726). A rework stage is
 * never a step: it names the step that sent the card back (`from`), or
 * the side it happened on when nothing says which.
 */
export const STEPS = {
  LOCAL_DEV: 'Local dev', LOCAL_TEST: 'Local tests', LOCAL_AUDIT: 'Local audit', MERGE: 'Merge',
  CI_BUILD: 'CI/CD', DEPLOY_DEV: 'Deploy to dev', DEV_TEST: 'Dev tests', DEV_AUDIT: 'Dev audit',
  DEV_VERIFIED: 'Deployed', DONE: 'Done', LOCAL_REWORK: 'Local checks', DEV_REWORK: 'Dev checks',
  test: 'Tests', ci: 'CI', build: 'Build', audit: 'Audit', 'audit-local': 'Local audit',
  deploy: 'Deploy', sonarqube: 'SonarQube',
};
const REWORK = ['LOCAL_REWORK', 'DEV_REWORK'];

/** The step `gate` names, in words: `step('LOCAL_REWORK', 'LOCAL_TEST')` is "Local tests". */
export function step(gate, from) {
  const id = String(gate ?? '').trim();
  if (REWORK.includes(id) && from && !REWORK.includes(String(from))) return step(from);
  if (Object.hasOwn(STEPS, id)) return STEPS[id];
  const plain = squash(plainer(id.replace(/_/g, ' '))).slice(0, 40);
  return plain ? upperFirst(plain) : 'The check';
}

/** Several facts as a short list, one "- " line each. */
export function bullets(facts) {
  let lines = [];
  for (const fact of facts || []) {
    const said = sentence(fact);
    if (said && !lines.includes(said)) lines.push(said);
  }
  if (lines.length > BULLETS_MAX) {
    const more = lines.length - (BULLETS_MAX - 1);
    lines = [...lines.slice(0, BULLETS_MAX - 1), `And ${more} more.`];
  }
  return lines.map((line) => `- ${line}`).join('\n');
}

/** A branch-like token: alone in its segment, or shaped like one. */
function slug(token, alone) {
  if ((!token.includes('-') && !token.includes('_')) || HYPHENED.includes(token.toLowerCase())) return false;
  return alone || token.includes('_') || token.split('-').length > 2
    || token.toLowerCase().startsWith('wf-') || /-\d+$/.test(token);
}

/** An agent's code name, or a lone letters-and-digits handle. */
function code(token, alone) {
  if (GLOSS_WHOLE.test(token)) return false;
  return CODENAME.test(token) || (alone && CODEWORD.test(token));
}

/** One segment of a raw title as words, and whether it was prose. */
function cleanSegment(segment) {
  const raw = segment.split(' ').map((t) => (t.startsWith('--') ? t.slice(2) : t));
  const tokens = raw.filter((t) => !NOISE.includes(t.toLowerCase()) && !code(t, raw.length === 1));
  const words = [];
  let prose = 0;
  let slugs = 0;
  for (const token of tokens) {
    if (HEX.test(token)) continue;
    if (!slug(token, tokens.length === 1) || GLOSS_WHOLE.test(token)) {
      words.push(token);
      prose += 1;
      continue;
    }
    slugs += 1;
    const parts = token.split(/[-_]+/).filter(Boolean);
    while (parts.length && /^\d+$/.test(parts[parts.length - 1])) parts.pop();
    words.push(...parts.filter((p) => !NOISE.includes(p.toLowerCase())));
  }
  return [words.join(' '), prose > 0 && !slugs];
}

/** A word that keeps its capital: a name, an acronym, a camel case. */
function isName(word) {
  const bare = strip(word, '()[],;.');
  return PROPER.includes(bare) || bare.slice(1) !== bare.slice(1).toLowerCase();
}

/**
 * Sentence case. A Title Cased Line loses its capitals; a sentence keeps
 * the ones it has, which are names ("Cloud Map", "Fargate").
 */
function sentenceCase(text) {
  const words = text.split(' ');
  const rest = words.slice(1).map((w) => strip(w, '()[],;.')).filter((w) => /^[A-Za-z]/.test(w));
  const titled = rest.length > 0 && 2 * rest.filter((w) => isUpper(w[0])).length >= rest.length;
  return words.map((word, i) => {
    const bare = strip(word, '()[],;.');
    const keep = PROPER.includes(bare) || !(bare && isUpper(bare[0]) && bare.slice(1) === bare.slice(1).toLowerCase());
    if (i === 0) return upperFirst(word);
    return titled && !keep ? word.toLowerCase() : word;
  }).join(' ');
}

/**
 * At most 60 characters. A long title stops after a clause, else at a
 * word, and never ends on "and", "until" or "the".
 */
function cap(text) {
  if (text.length > TITLE_MAX) {
    const cuts = [...text.matchAll(CLAUSE)].map((m) => m.index)
      .filter((at) => at <= TITLE_MAX && text.slice(0, at).split(/\s+/).filter(Boolean).length > 1);
    if (cuts.length) text = text.slice(0, cuts[cuts.length - 1]);
  }
  let words = text.split(' ');
  while (words.length > 1 && words.join(' ').length > TITLE_MAX) words.pop();
  words = strip(words.join(' '), ' .;:,-', false).split(' ');
  while (words.length > 1 && TAIL.includes(words[words.length - 1].toLowerCase())) {
    words = strip(words.slice(0, -1).join(' '), ' .;:,-', false).split(' ');
  }
  return words.join(' ').slice(0, TITLE_MAX);
}

/**
 * [rank, -words, order, text] for one part of a raw title. An "Area:
 * detail" description keeps both halves when the area is short and
 * written by a person; a commit's "area: text" keeps the text.
 */
function segments(group, at) {
  const parts = [];
  for (const part of group.split(COLON)) {
    const [cleaned, prose] = cleanSegment(squash(part));
    const words = strip(squash(plainer(cleaned)), ' .;:,-');
    if (words && words.toLowerCase() !== 'agent') parts.push([words, prose, part.trim()]);
  }
  const out = [];
  if (parts.length === 2 && parts[0][1] && parts[1][1] && isUpper(parts[0][2][0])
      && parts[0][0].split(' ').length <= AREA_MAX) {
    const [first, ...rest] = parts[1][0].split(' ');
    const detail = [isName(first) ? first : first.toLowerCase(), ...rest].join(' ');
    const joined = `${parts[0][0]}: ${detail}`;
    if (joined.length <= TITLE_MAX) out.push([0, -joined.split(' ').length, at, joined]);
  }
  parts.forEach(([words, prose], n) => out.push([prose ? 1 : 2, -words.split(' ').length, at + n + 1, words]));
  return out;
}

/** Free text without a cut last word, agent ids, keys or the empty brackets the keys leave. */
function prepare(raw) {
  const text = strip(squash(raw).replace(CUT, ''), ' ·:—-');
  return squash(text.replace(AGENT_ID, ' ').replace(KEY, ' ').replace(BRACKETS, ' '));
}

const bag = (words) => new Set(words.toLowerCase().match(/[\w'$/-]+/g));

/**
 * Every plain title the raw text offers, best first: a short area with
 * its detail, then prose, then slugs, longer before shorter, none
 * contained in a better one and none of a single word.
 */
export function candidates(raw) {
  const text = prepare(raw);
  const found = [];
  for (const group of text.split(MAJOR)) found.push(...segments(group, found.length * 10));
  found.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]));
  const out = [];
  for (const [, , , words] of found) {
    const mine = bag(words);
    if (out.some((o) => { const theirs = bag(o); return [...mine].every((w) => theirs.has(w)); })) continue;
    out.push(words);
  }
  const titled = out.map((words) => cap(sentenceCase(words))).filter((t) => t.split(' ').length > 1);
  return titled.length ? titled : ['Agent work'];
}

/**
 * A plain card title from free text, 60 characters at most. See the TODO
 * on `title` in adapters/teamflow/words.py for the classifier's pick.
 */
export function title(raw) {
  return candidates(raw)[0];
}

/**
 * One plain sentence saying what the work is, for under a card's title:
 * the first sentence or clause of free text such as an agent's task or a
 * commit subject, with keys and code names gone. "" when it says too
 * little (fewer than ABOUT_MIN words).
 */
export function about(raw) {
  let text = prepare(raw).split(FIRST)[0];
  // A commit's own "area: " prefix is a code area, not the work.
  const colon = text.indexOf(': ');
  const area = colon > 0 ? text.slice(0, colon) : '';
  if (area && text.slice(colon + 2) && /^[a-z]/.test(area) && area.split(' ').length <= AREA_MAX) text = text.slice(colon + 2);
  // A clause cut inside brackets leaves one open: it goes.
  const open = text.lastIndexOf('(');
  if (open >= 0 && !text.slice(open).includes(')')) text = text.slice(0, open);
  const kept = text.split(' ').filter((w) => !NOISE.includes(w.toLowerCase()) && !CODENAME.test(strip(w, ':', false)));
  const said = sentence(strip(kept.join(' '), ' :·—-'));
  return counted(said).length >= ABOUT_MIN ? said : '';
}

function sentences(text) {
  return String(text ?? '').replace(CODE, '').split(SENTENCES)
    .map((line) => strip(line.trim(), '-*• ').trim())
    .filter((line) => WORD.test(line));
}

function participle(word) {
  const w = word.toLowerCase();
  if (PASSIVE_OK.includes(w)) return false;
  return IRREGULAR.includes(w) || (w.length > 3 && w.endsWith('ed'));
}

/** The problems a text has, in order. Empty when it reads plain. */
export function check(text) {
  const problems = [];
  const add = (rule, said, found, plain = '') => problems.push({ rule, sentence: said, found, plain });
  for (const said of sentences(text)) {
    const count = counted(said).length;
    if (count > MAX_WORDS) add('long', said, `${count} words`);
    for (const m of said.matchAll(BANNED_RE)) add('banned', said, m[0], LOOKUP[m[0].toLowerCase()]);
    for (const m of said.matchAll(PASSIVE)) if (participle(m[1])) add('passive', said, m[0]);
    for (const m of said.matchAll(JARGON_RE)) add('jargon', said, m[0], LOOKUP[m[0].toLowerCase()] ?? '');
  }
  return problems;
}

// --- a card's plain line (MACLEOD-770) --------------------------------------
//
// One line about what a PERSON gets from a piece of work, written by the
// model doing it (`teamflow card say KEY "..."`). Checked here before it
// leaves the machine and again by the service with the same rules:
// `adapters/teamflow/words.py::say_check` is the twin, and
// tests/fixtures/say-vectors.json pins both to the same answers.

export const SAY_MAX = 180;
export const SAY_SENTENCES = 2;
const SAY_SPLIT = /(?<=[.!?])\s+/;
const SAY_URL = /\b(?:https?|ftp|ssh|file):\/\/\S*|\bwww\.\S+/i;
const SAY_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
const SAY_SECRET = /\b(?:sk|pk|rk|dk|ghp|gho|ghs|github_pat|xox[abpr])[-_][A-Za-z0-9_-]{8,}|\b(?:AKIA|ASIA)[A-Z0-9]{12,}|-----BEGIN|\b[A-Za-z0-9+/_-]{32,}/;
const SAY_PATH = /(?:^|[\s("'])(?:~|\.{1,2})?\/\w|\b[\w.-]+\/[\w.-]+\/[\w./-]*|\b[\w-]+\.(?:mjs|cjs|js|jsx|ts|tsx|py|json|md|ya?ml|sh|css|html|toml|lock|sql|txt|env)\b/i;
const SAY_CODE = /`|[{}<>;=|\\[\]]|\w\(|\b[a-z]+_[a-z0-9_]+\b|\b[a-z]+[A-Z]\w*|(?:^|\s)--?[a-z]/;
const everywhere = (re) => new RegExp(re.source, `${re.flags}g`);

/** The problems a card's plain line has, in order. Empty when it may be stored. */
export function sayCheck(text) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return [{ rule: 'empty', found: '' }];
  const out = [];
  if (line.length > SAY_MAX) out.push({ rule: 'too_long', found: `${line.length} characters` });
  const count = line.split(SAY_SPLIT).filter((s) => WORD.test(s)).length;
  if (count > SAY_SENTENCES) out.push({ rule: 'sentences', found: `${count} sentences` });
  for (const [rule, re] of [['url', SAY_URL], ['email', SAY_EMAIL], ['secret', SAY_SECRET]]) {
    const m = line.match(re);
    if (m) out.push({ rule, found: m[0].trim().slice(0, 40) });
  }
  const rest = line.replace(everywhere(SAY_URL), ' ').replace(everywhere(SAY_EMAIL), ' ');
  const path = rest.match(SAY_PATH);
  if (path) out.push({ rule: 'path', found: path[0].trim().slice(0, 40) });
  const code = rest.replace(everywhere(SAY_PATH), ' ').match(SAY_CODE);
  if (code) out.push({ rule: 'code', found: code[0].trim().slice(0, 40) });
  for (const p of check(line)) out.push({ rule: p.rule, found: p.found });
  return out;
}

/** What each rule asks the writer to change, in plain words. */
export const SAY_WORDS = {
  empty: 'Write one line about what a person gets.',
  too_long: 'Keep it to 180 characters.',
  sentences: 'Use one or two sentences.',
  code: 'Leave out code. Say what a person gets.',
  path: 'Leave out file names and paths.',
  url: 'Leave out links.',
  email: 'Leave out email addresses.',
  secret: 'Leave out keys and tokens.',
  long: 'Keep each sentence to 20 words.',
  banned: "Use plain words, not the tool's own words.",
  passive: 'Say who does what.',
  jargon: 'Use common words.',
};

/** One short sentence per distinct problem, in order. */
export function sayWords(problems = []) {
  const seen = [];
  for (const p of problems) {
    const said = SAY_WORDS[p?.rule] || '';
    if (said && !seen.includes(said)) seen.push(said);
  }
  return seen.join(' ');
}
