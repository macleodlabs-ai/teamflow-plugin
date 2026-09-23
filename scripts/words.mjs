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
 *   check(text)      the problems in a text: { rule, sentence, found, plain }.
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
  'Playwright', 'Stripe', 'Google', 'Cognito', 'AWS', 'Laya', 'Resend', 'Slack', 'Cursor',
  'Copilot', 'Windsurf', 'Cline', 'Codex', 'Gemini', 'Junie', 'Dev', 'Delivery', 'Home',
  'Attention', 'History', 'Test', 'Audit', 'Rework', 'Deployed', 'Local', 'Done', 'CI/CD',
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];

const NOISE = ['claude-code', 'claude code', 'general-purpose', 'wf'];

const TAIL = ['a', 'an', 'and', 'the', 'to', 'of', 'for', 'with', 'in', 'on', 'or', 'at',
  'by', 'from'];

const KEY = /\b[A-Z][A-Z0-9]*-\d+\b:?/g;
const AGENT_ID = /\b(?:worktree-)?agent-[0-9a-f]{6,}\b/gi;
const HEX = /^(?=[0-9a-f]*\d)[0-9a-f]{7,}$/i;
const CUT = /\S*(?:…|\.\.\.)$/;
const SPLIT = /\s+·\s+|:\s+|\s+—\s+|\s+-\s+/;
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
  return text.replace(GLOSS, (found) => {
    const plain = LOOKUP[found.toLowerCase()];
    return isUpper(found[0]) ? upperFirst(plain) : plain;
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
  if (at.length > MAX_WORDS) text = strip(words.slice(0, at[MAX_WORDS - 1] + 1).join(' '), ' .;:,', false);
  text = upperFirst(text);
  return '?!'.includes(text[text.length - 1]) ? text : `${text}.`;
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

/** One segment of a raw title as words, and whether it was prose. */
function cleanSegment(segment) {
  const tokens = segment.split(' ').filter((t) => !NOISE.includes(t.toLowerCase()));
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

function sentenceCase(text) {
  return text.split(' ').map((word, i) => {
    const bare = strip(word, '()[],;.');
    const keep = PROPER.includes(bare) || !(bare && isUpper(bare[0]) && bare.slice(1) === bare.slice(1).toLowerCase());
    if (i === 0) return upperFirst(word);
    return keep ? word : word.toLowerCase();
  }).join(' ');
}

/** At most 60 characters, cut at a word, never ending on "and". */
function cap(text) {
  const words = text.split(' ');
  while (words.length > 1 && words.join(' ').length > TITLE_MAX) words.pop();
  while (words.length > 1 && TAIL.includes(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(' ').slice(0, TITLE_MAX);
}

/** Every plain title the raw text offers, best first. */
export function candidates(raw) {
  let text = squash(raw);
  text = strip(text.replace(CUT, ''), ' ·:—-');
  text = squash(text.replace(AGENT_ID, ' ').replace(KEY, ' ').replace(/\(\s*\)|\[\s*\]/g, ' '));
  const found = [];
  text.split(SPLIT).forEach((segment, i) => {
    const [cleaned, prose] = cleanSegment(squash(segment));
    const words = strip(squash(plainer(cleaned)), ' .;:,-');
    if (words) found.push({ slug: !prose, n: -words.split(' ').length, i, words });
  });
  found.sort((a, b) => (Number(a.slug) - Number(b.slug)) || (a.n - b.n) || (a.i - b.i));
  const out = [];
  for (const { words } of found) {
    const mine = words.toLowerCase().split(' ');
    if (out.some((o) => { const theirs = o.toLowerCase().split(' '); return mine.every((w) => theirs.includes(w)); })) continue;
    out.push(words);
  }
  const titled = out.map((words) => strip(cap(sentenceCase(words)), ' .;:,-', false))
    .filter((t) => t.toLowerCase() !== 'agent');
  return titled.length ? titled : ['Agent work'];
}

/**
 * A plain card title from free text, 60 characters at most. See the TODO
 * on `title` in adapters/teamflow/words.py for the classifier's pick.
 */
export function title(raw) {
  return candidates(raw)[0];
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
