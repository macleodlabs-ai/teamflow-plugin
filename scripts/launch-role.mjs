// What an agent is launched FOR (MACLEOD-722).
//
// MACLEOD-714 made an agent a reviewer when its session's ticket stood
// at a check step. That is timing only, and it goes wrong the moment a
// review finds problems: the supervisor sends a fix agent while the
// ticket still stands at the audit, and the fix agent was counted as a
// fourth reviewer. The owner: reviewers "should [be known] by the
// supervisor agent, not just timing".
//
// `launchRole(launch, session)` answers `reviewer | worker | adhoc`
// from signals read ON THIS MACHINE, strongest first:
//
//   1. an explicit mark: a description that starts "Review:" or
//      "Reviewer:" (reviewer), "Fix:" or "Build:" (worker), or
//      `teamflow review start --lens <name>` run just before the launch;
//   2. Claude Code's own word for the agent: an agent-team task whose
//      subject says review or build, for the teammate the launch names
//      (a `TaskCreated` or `TaskCompleted` hook carries `task_subject`
//      and `teammate_name`), which decides just below a mark; else the
//      `subagent_type` names a definition (`.claude/agents/<name>.md`,
//      the user's, a plugin's) whose name, description and tool list
//      say what it is for -- a definition that may not edit files is a
//      reviewer's;
//   3. the batch: agents one parent launched together form a team, and
//      a team at a check step leans reviewer. Launches under one user
//      prompt (`prompt_id`) within a few seconds are one batch;
//   4. intent, read locally from `subagent_type`, the description and
//      the prompt's opening lines by a small fixed word rule;
//   5. position, today's rule, as one signal among the others. Right
//      after a round that found problems, one agent alone leans worker:
//      that is the fix.
//
// A mark decides. Otherwise strong, agreeing signals decide here. When
// they disagree, or are weak, the rules' answer is used at once AND the
// agent's `role` block carries `ask: true`, which queues one
// `launch_role` question on the service's decision path (watch-only).
//
// THE PROMPT NEVER LEAVES THE MACHINE. Its opening lines are read here,
// in memory, scored, and dropped. What is kept -- and what may be sent --
// is the enum `intent`, a number `confidence` and the fixed features in
// ROLE_FEATURES. Nothing here throws: a launch whose role cannot be read
// is decided by position, as before.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ROLES = ['reviewer', 'worker', 'adhoc'];
export const INTENTS = ['review', 'build', 'research', 'other'];
/** How a role was decided, strongest first. `moved`: corrected after the agent changed files. */
export const ROLE_BY = ['mark', 'claude', 'batch', 'intent', 'position', 'rules', 'moved'];
/** Under this, a local answer is used but the classifier is asked too. */
export const ASK_BELOW = 0.6;
/** Launches this close together, with no prompt between them, are one batch. */
export const BATCH_MS = 5000;
/** How long `teamflow review start` waits for its launch. */
export const REVIEW_NEXT_MS = 10 * 60 * 1000;
/** The prompt's opening: this many lines, this many characters. Never kept. */
const PROMPT_LINES = 3;
const PROMPT_CHARS = 400;

// The steps a reviewer can review; a copy of review.mjs's, which imports this file.
const CHECK_STEPS = ['LOCAL_TEST', 'LOCAL_AUDIT', 'DEV_TEST', 'DEV_AUDIT'];
/** Where a review team started outside a check step reports: the local audit. */
export const DEFAULT_REVIEW_STEP = 'LOCAL_AUDIT';

// --- 1. the explicit mark -------------------------------------------

const REVIEW_MARK = /^\s*review(?:er)?\s*:/i;
const WORK_MARK = /^\s*(?:fix|build)\s*:/i;

/** `reviewer`, `worker` or undefined, from the description's first word. */
export function markOf(description) {
  const said = typeof description === 'string' ? description : '';
  if (REVIEW_MARK.test(said)) return 'reviewer';
  if (WORK_MARK.test(said)) return 'worker';
  return undefined;
}

/** The description without its mark, so "Review: Security" is the lens "Security". */
export function stripMark(description) {
  return typeof description === 'string' ? description.replace(REVIEW_MARK, '').replace(WORK_MARK, '').trim() : description;
}

const LENS_ARG = /(?:^|[\s;&|(/])(?:teamflow|cli\.mjs"?)\s+review\s+start\b([^;&|\n]*)/;

/**
 * `teamflow review start --lens <name>`, from a shell command the
 * session ran: `{ lens }` or `{}` for a start with no lens; undefined
 * when the command is not one. The lens is capped, one line.
 */
export function reviewStartOf(command) {
  if (typeof command !== 'string') return undefined;
  const m = command.match(LENS_ARG);
  if (!m) return undefined;
  const words = m[1].trim().split(/\s+/).filter(Boolean);
  const at = words.indexOf('--lens');
  const lens = at >= 0 ? words.slice(at + 1).filter((w) => !w.startsWith('--')).join(' ').replace(/^["']|["']$/g, '') : '';
  return lens ? { lens: lens.slice(0, 80) } : {};
}

// --- 2. Claude Code's own word: the agent definition ------------------

// Tools that change files. A definition allowed none of them is read-only.
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function listOf(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return value.replace(/^\[|\]$/g, '').split(',').map((t) => t.trim().replace(/^["']|["']$/g, '').replace(/\(.*$/, '')).filter(Boolean);
}

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** The definition files a `subagent_type` could name, nearest first. Plugins are found by a bounded walk. */
export function definitionFiles(type, cwd) {
  if (typeof type !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(type)) return [];
  const [plugin, agent] = type.includes(':') ? type.split(':', 2) : [undefined, type];
  const files = [];
  if (!plugin) {
    if (cwd) files.push(path.join(cwd, '.claude', 'agents', `${agent}.md`));
    files.push(path.join(configDir(), 'agents', `${agent}.md`));
    return files;
  }
  // A plugin's agents: <plugins>/.../<plugin>/.../agents/<agent>.md, at most five levels down.
  const walk = (dir, depth, inside) => {
    if (depth > 5 || files.length) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const next = path.join(dir, e.name);
      const within = inside || e.name === plugin;
      if (within && e.name === 'agents') {
        const file = path.join(next, `${agent}.md`);
        if (fs.existsSync(file)) { files.push(file); return; }
      }
      walk(next, depth + 1, within);
    }
  };
  walk(path.join(configDir(), 'plugins'), 0, false);
  return files;
}

/**
 * What the agent definition a launch names says it is for:
 * `{ lean: 'reviewer'|'worker'|undefined, readOnly, intent, confidence }`,
 * or undefined when there is no definition to read. The definition's
 * text is read here and dropped; only the lean goes on.
 */
export function definitionRole(type, cwd) {
  try {
    for (const file of definitionFiles(type, cwd)) {
      let text;
      try { text = fs.readFileSync(file, 'utf8').slice(0, 8000); } catch { continue; }
      const fm = frontmatter(text);
      const tools = listOf(fm.tools);
      const denied = listOf(fm.disallowedTools) || [];
      const readOnly = Boolean((tools && !tools.some((t) => EDIT_TOOLS.includes(t)))
        || EDIT_TOOLS.every((t) => denied.includes(t)));
      const said = scoreIntent([[fm.name || type, 2], [fm.description, 2]]);
      let lean;
      if (said.intent === 'review' || (readOnly && said.intent !== 'build')) lean = 'reviewer';
      else if (said.intent === 'build' && !readOnly) lean = 'worker';
      return { lean, readOnly, intent: said.intent, confidence: said.confidence };
    }
  } catch { /* no definition read: no signal */ }
  return undefined;
}

/**
 * What an agent-team task's subject says its teammate is for:
 * `reviewer`, `worker` or undefined. A mark decides; else a clear lean
 * of the word rule. The subject is read here and dropped.
 */
export function teamLeanOf(subject) {
  const marked = markOf(subject);
  if (marked) return marked;
  const said = scoreIntent([[typeof subject === 'string' ? subject.slice(0, 200) : '', 2]]);
  if (said.confidence < ASK_BELOW) return undefined;
  if (said.intent === 'review') return 'reviewer';
  return said.intent === 'build' ? 'worker' : undefined;
}

// --- 4. intent, by a small fixed rule ---------------------------------

const REVIEW_VERBS = /\b(review(?:s|ing|er|ers)?|audit(?:s|ing|or)?|verif(?:y|ies|ying)|check(?:s|ing)?|assess(?:es|ing|ment)?|inspect(?:s|ing|ion)?)\b/gi;
const LENS_WORDS = /\b(security|correctness|evidence|performance|accessibility|compliance)\b/gi;
const BUILD_VERBS = /\b(fix(?:es|ing)?|implement(?:s|ing)?|build(?:s|ing)?|write|writes|writing|refactor(?:s|ing)?|add(?:s|ing)?|change(?:s|ing)?)\b/gi;
const RESEARCH_VERBS = /\b(research(?:es|ing)?|explore|exploring|investigate|investigating|find|search(?:es|ing)?|survey|summari[sz]e)\b/gi;

const hits = (re, text) => (text.match(re) || []).length;

/**
 * `{ intent, confidence }` from weighted texts. Review verbs count 1,
 * lens names 0.5 (a fix of security findings says "security" too),
 * build and research verbs 1. Confidence is the winner's margin over
 * the rest, damped until there are two words of evidence.
 */
export function scoreIntent(parts = []) {
  const score = { review: 0, build: 0, research: 0 };
  for (const [raw, weight] of parts) {
    const text = typeof raw === 'string' ? raw.replace(/[-_]/g, ' ') : '';
    if (!text) continue;
    score.review += weight * (hits(REVIEW_VERBS, text) + 0.5 * hits(LENS_WORDS, text));
    score.build += weight * hits(BUILD_VERBS, text);
    score.research += weight * hits(RESEARCH_VERBS, text);
  }
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  const [[top, best], [, next]] = ranked;
  if (best <= 0) return { intent: 'other', confidence: 0 };
  if (best === next) return { intent: 'other', confidence: 0 };
  const confidence = ((best - next) / best) * Math.min(1, best / 2);
  return { intent: top, confidence: Math.round(confidence * 100) / 100 };
}

/** The prompt's opening lines, for scoring only. Returned to the caller's memory, never stored. */
export function promptOpening(prompt) {
  if (typeof prompt !== 'string') return '';
  return prompt.slice(0, PROMPT_CHARS * 2).split(/\r?\n/).filter((l) => l.trim()).slice(0, PROMPT_LINES).join(' ').slice(0, PROMPT_CHARS);
}

/** Intent from what the launch says: the type and description count double, the prompt's opening once. */
export function intentOf({ type, description, prompt } = {}) {
  return scoreIntent([[type, 2], [description, 2], [promptOpening(prompt), 1]]);
}

// --- the answer -------------------------------------------------------

/**
 * The features a launch's role is judged on. The prompt is an input and
 * is not in the answer: only enums, counts and one number are.
 *
 * `launch`: `{ type, description, prompt, isolated }` (the Agent tool's own
 * fields). `session`: `{ key, stage, batch, reviewNext, afterFindings, cwd }`.
 */
export function launchFeatures(launch = {}, session = {}) {
  const step = CHECK_STEPS.includes(session.stage) ? session.stage : undefined;
  const { intent, confidence } = intentOf(launch);
  const claude = definitionRole(launch.type, session.cwd);
  // An agent-team task names its teammate; the launch names it too.
  const team = typeof launch.name === 'string' ? session.teamTasks?.[launch.name] : undefined;
  return {
    mark: session.reviewNext ? 'reviewer' : markOf(launch.description),
    ...(session.reviewNext?.lens ? { lens: session.reviewNext.lens } : {}),
    ...(ROLES.includes(team) ? { team } : {}),
    claude: (ROLES.includes(team) && team) || claude?.lean || 'none',
    intent,
    confidence,
    batch: Math.max(1, Number(session.batch) || 1),
    bound: Boolean(session.key),
    position: step ? 'check_step' : 'other',
    step: step || session.stage,
    afterFindings: Boolean(session.afterFindings),
    isolated: Boolean(launch.isolated),
  };
}

/** Not a reviewer: a worker under the session's ticket, or an agent with a card of its own. */
const notReviewer = (f) => (f.bound && !f.isolated ? 'worker' : 'adhoc');

/**
 * The role from the features: `{ as, by, confidence, ask }`.
 *
 * Each signal leans reviewer (+) or not (−) with a weight; a mark decides
 * outright. Claude Code's definition weighs most, then intent by its own
 * confidence, then the batch and position. `ask` is set when the signals
 * disagree or the sum is under ASK_BELOW: the local answer is used and
 * the classifier is asked as well.
 */
export function decideRole(f) {
  if (f.mark === 'reviewer') return { as: f.bound ? 'reviewer' : 'adhoc', by: 'mark', confidence: 1, ask: false };
  if (f.mark === 'worker') return { as: notReviewer(f), by: 'mark', confidence: 1, ask: false };
  // Claude Code's own task list says what the teammate is for: just below a mark.
  if (f.team === 'reviewer') return { as: f.bound ? 'reviewer' : 'adhoc', by: 'claude', confidence: 0.9, ask: false };
  if (f.team === 'worker') return { as: notReviewer(f), by: 'claude', confidence: 0.9, ask: false };
  const atCheck = f.position === 'check_step';
  const signals = [];
  if (f.claude === 'reviewer') signals.push(['claude', 0.6]);
  if (f.claude === 'worker') signals.push(['claude', -0.6]);
  if (f.intent === 'review') signals.push(['intent', f.confidence]);
  if (f.intent === 'build' || f.intent === 'research') signals.push(['intent', -f.confidence]);
  if (atCheck && f.batch >= 2) signals.push(['batch', 0.25]);
  if (atCheck) signals.push(['position', f.afterFindings && f.batch < 2 ? -0.3 : 0.3]);
  const sum = signals.reduce((s, [, w]) => s + w, 0);
  const leans = signals.filter(([, w]) => w !== 0).map(([, w]) => Math.sign(w));
  const agree = leans.every((s) => s === leans[0]);
  const strongest = [...signals].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
  const confidence = Math.round(Math.min(1, Math.abs(sum)) * 100) / 100;
  // Away from a check step only a clear lean makes a reviewer: nothing
  // there is waiting to be reviewed unless the launch says so plainly.
  const reviewer = f.bound && sum > 0 && (atCheck || sum >= ASK_BELOW);
  return {
    as: reviewer ? 'reviewer' : notReviewer(f),
    by: strongest && agree ? strongest[0] : 'rules',
    confidence,
    ask: !agree || confidence < ASK_BELOW,
  };
}

/**
 * `launchRole(launch, session)` → `{ as, by, confidence, ask, features, step? }`.
 * `step` is the step a reviewer reviews: the check step the ticket
 * stands at, else the local audit. Never throws: an unreadable launch
 * is decided by position.
 */
export function launchRole(launch = {}, session = {}) {
  try {
    const features = launchFeatures(launch, session);
    const role = decideRole(features);
    const out = { ...role, features };
    if (role.as === 'reviewer') out.step = features.position === 'check_step' ? features.step : DEFAULT_REVIEW_STEP;
    return out;
  } catch {
    const step = CHECK_STEPS.includes(session?.stage) && session?.key ? session.stage : undefined;
    return step ? { as: 'reviewer', by: 'position', confidence: 0.3, ask: true, step, features: {} }
      : { as: session?.key ? 'worker' : 'adhoc', by: 'position', confidence: 0, ask: false, features: {} };
  }
}

/**
 * The `role` block an agent carries on its reports: the answer and the
 * fixed features the classifier may be asked about. Enums, one count,
 * one number and flags. Nothing any agent or person wrote.
 */
export function roleBlock(role = {}) {
  const f = role.features || {};
  const block = { as: role.as, by: role.by };
  if (INTENTS.includes(f.intent)) block.intent = f.intent;
  if (typeof f.confidence === 'number') block.confidence = Math.max(0, Math.min(1, f.confidence));
  if (f.batch) block.batch = Math.max(1, Math.min(50, f.batch));
  if (typeof f.bound === 'boolean') block.bound = f.bound;
  if (f.position) block.position = f.position;
  if (f.claude) block.claude = f.claude;
  if (CHECK_STEPS.includes(role.step || f.step)) block.step = role.step || f.step;
  if (role.ask) block.ask = true;
  return block;
}

// --- the batch --------------------------------------------------------

/**
 * How many launches, this one included, the same parent made in this
 * burst: recorded since the later of `BATCH_MS` ago and the last prompt,
 * with the same `launchedBy`. When the hook payload carries `prompt_id`
 * (Claude Code 2.1.196 and later), a launch under another prompt is
 * never in the batch, whatever the clock says. No documented payload
 * names the assistant message itself, so the window stays. Local files only.
 */
export function batchSize(launches = [], { launchedBy, promptAt, promptId, now = Date.now() } = {}) {
  const since = Math.max(now - BATCH_MS, Date.parse(promptAt || '') || 0);
  return 1 + launches.filter((l) => (l.launchedBy || undefined) === (launchedBy || undefined)
    && Date.parse(l.at) >= since
    && !(promptId && l.promptId && l.promptId !== promptId)).length;
}

// --- correcting a mistaken reviewer ------------------------------------

/**
 * True when this event is the agent doing work, not reviewing: an edit
 * to a file in its repository, or a commit. Read from the tool's name,
 * the file path and the shape of a command; nothing is kept.
 */
export function changesFiles(input = {}, cwd = undefined) {
  const tool = input.tool_name || '';
  if (EDIT_TOOLS.includes(tool)) {
    const file = input.tool_input?.file_path || input.tool_input?.notebook_path;
    if (!cwd || typeof file !== 'string') return true;
    const rel = path.relative(cwd, path.resolve(cwd, file));
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  }
  if (tool === 'Bash') return /(?:^|[\s;&|(])git\s+(?:-C\s+\S+\s+)?commit\b/.test(String(input.tool_input?.command || ''));
  return false;
}
