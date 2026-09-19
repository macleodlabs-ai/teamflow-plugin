import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import * as auth from './auth.mjs';
import { TOOL_CAPABILITIES } from './tools.mjs';

// Jira and Linear share this key shape; the configured tracker decides how it is labelled and linked.
// The upper bound is adapters/teamflow/schema.py's `_JIRA_KEY`, so a key the
// service accepts is a key the plugin can bind. It was 12 characters here and
// 20 there, which is a key that reports fine and cannot be named by hand.
const ISSUE_RE = /\b([A-Z][A-Z0-9]{1,19}-\d+)\b/i;
// The same, scanned. `detectIssueRef` takes the first key it may believe rather
// than the first key, so a refused one cannot hide a real one behind it.
//
// `matchAll` ONLY. This is a module-level regex with the `g` flag: `matchAll`
// clones it and is safe, while `.test()` and `.exec()` advance `lastIndex` on
// the shared object, so every other call would answer from halfway through the
// previous string. The symptom would be a key resolving on odd-numbered calls
// and not on even ones, which reads as a flaky hook rather than as a bug here.
// Use ISSUE_RE, which has no `g`, for a one-shot question.
const ISSUE_ALL_RE = new RegExp(ISSUE_RE.source, 'gi');
const JIRA_URL_RE = /\/browse\/([A-Z][A-Z0-9]{1,19}-\d+)\b/i;
const LINEAR_URL_RE = /linear\.app\/([\w.-]+)\/issue\/([A-Z][A-Z0-9]{1,19}-\d+)/i;
// The whole argument, for `teamflow bind` and `teamflow report --issue`.
const BARE_KEY_RE = /^[A-Z][A-Z0-9]{1,19}-\d+$/i;
const GITHUB_URL_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\b/i;
// The lookbehind keeps a deeper path such as src/lib/dataSource.ts#42 from reading as owner/repo#n.
const GITHUB_REF_RE = /(?<![\w.\-/])([\w.-]+)\/([\w.-]+)#(\d+)\b/;
const GITHUB_NUMBER_RE = /#(\d+)\b/;
const GITHUB_BRANCH_RE = /^(?:.*\/)?(?:issue[-_]|gh[-_])?(\d+)(?:[-_].*)?$/i;
const GITHUB_REMOTE_RE = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;
const GH_ISSUE_RE = /\bgh\s+issue\s+(?:view|create)\b/i;
const GH_ISSUE_NUMBER_RE = /\bgh\s+issue\s+(?:view|create)\s+(?:-{1,2}[\w-]+(?:[=\s]+(?:"[^"]*"|'[^']*'|\S+))?\s+)*#?(\d+)\b/i;
const GH_REPO_FLAG_RE = /--repo[=\s]+([\w.-]+\/[\w.-]+)/i;
const GH_ISSUE_FIELD_RE = /"issue_?[nN]umber"\s*:\s*"?(\d+)"?/;
const GH_OWNER_FIELD_RE = /"owner"\s*:\s*"([\w.-]+)"/;
const GH_REPO_FIELD_RE = /"repo(?:sitory)?"\s*:\s*"([\w.-]+)"/;
/*
 * An ad hoc key (MACLEOD-556). TeamFlow minted it, so TeamFlow is the
 * system of record for it and it is never read as the configured
 * tracker's key: a repository configured for Jira that reported
 * ADHOC-3 as a Jira issue would draw a link to a Jira issue that does
 * not exist. Its shape is inside `_JIRA_KEY` in
 * adapters/teamflow/schema.py, so nothing widens to accept it.
 */
const ADHOC_KEY_RE = /^ADHOC-\d{1,9}$/i;

/** True for a key TeamFlow minted itself rather than read off a tracker. */
export function isAdHocKey(value) {
  return ADHOC_KEY_RE.test(String(value ?? '').trim());
}

// The trackers an install can be configured to use. `teamflow` is not
// one of them: it is a key's provenance, never a setting, so it is
// absent here and present in `Tracker` (src/types.ts) and `TRACKERS`
// (adapters/teamflow/schema.py), which are vocabularies of what a key
// can say about itself.
const TRACKERS = new Set(['jira', 'linear', 'github']);
const TEST_RE = /(?:^|\s)(?:npm|pnpm|yarn|bun)?\s*(?:run\s+)?(?:test|vitest|jest|pytest|playwright|cypress)(?:\s|$)|\bgo test\b|\bcargo test\b|\bmvn(?:w)?\s+test\b|\bgradle(?:w)?\s+test\b/i;
const DEV_TEST_RE = /\b(?:smoke|acceptance|e2e|integration)[-_: ]?(?:dev|staging)|\b(?:dev|staging)[-_: ]?(?:smoke|acceptance|e2e|integration)\b/i;
const MERGE_RE = /\bgh\s+pr\s+merge\b|\bgit\s+merge\b/i;
const PR_MERGE_RE = /\bgh\s+pr\s+merge\b/i;
const GIT_MERGE_RE = /\bgit\s+merge\b/i;
// `--abort`, `--quit` and `--continue` are the three that operate on a
// merge already in progress. An abort moves nothing by definition, and
// neither of the others is the moment the gate is passed.
const GIT_MERGE_HOUSEKEEPING_RE = /\bgit\s+merge\b[^;&|]*?--(?:abort|quit|continue)\b/i;
const PR_RE = /\bgh\s+pr\s+(?:create|ready)\b/i;
const DEPLOY_RE = /\b(?:cdk|terraform)\s+(?:deploy|apply)\b|\baws\s+(?:cloudformation\s+deploy|ecs\s+update-service)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?deploy(?::|-)?dev\b/i;
const BUILD_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\btsc\s+-b\b/i;
const LOCAL_AUDIT_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?audit(?:[-_:]local)?\b|\b(?:make|just)\s+audit\b/i;
const DEV_AUDIT_RE = /\baudit[-_: ]?(?:dev|staging)\b|\b(?:dev|staging)[-_: ]?audit\b/i;

/*
 * The columns, in delivery order. This is the emitting side's copy of STAGES in
 * src/lib/stageMachine.ts: the plugin needs the order to answer one question a
 * transition cannot answer on its own — has the gate that sent this ticket back
 * been passed again? Rework stages are not in it, because they are not columns.
 */
const STAGE_ORDER = [
  'JIRA', 'LOCAL_DEV', 'LOCAL_TEST', 'LOCAL_AUDIT', 'MERGE', 'CI_BUILD',
  'DEPLOY_DEV', 'DEV_TEST', 'DEV_AUDIT', 'DEV_VERIFIED', 'READY_PROD',
];

/** What the dashboard calls the step at a gate, so the rework arrow can name it. */
const GATE_LABELS = {
  LOCAL_TEST: 'Run tests',
  LOCAL_AUDIT: 'Local audit',
  MERGE: 'Merge',
  DEPLOY_DEV: 'Deploy to dev',
  DEV_TEST: 'Dev tests',
  DEV_AUDIT: 'Dev audit',
};

/** The execution kind a gate's own run is, for the lane the dashboard draws it in. */
const GATE_KINDS = {
  LOCAL_TEST: 'test',
  LOCAL_AUDIT: 'audit',
  MERGE: 'ci',
  DEPLOY_DEV: 'deploy',
  DEV_TEST: 'test',
  DEV_AUDIT: 'audit',
};

const stageRank = (stage) => STAGE_ORDER.indexOf(stage);

export function extractJiraKey(value) {
  if (!value) return undefined;
  const match = String(value).match(ISSUE_RE);
  return match?.[1]?.toUpperCase();
}

export function trackerOf(config = {}) {
  const raw = String(config.tracker || 'jira').trim().toLowerCase();
  return TRACKERS.has(raw) ? raw : 'jira';
}

// Jira/Linear keys are upper case; a GitHub key is "<repo>#<n>" and keeps the repo's own shape.
export function normalizeIssueKey(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  return raw.includes('#') ? raw : raw.toUpperCase();
}

export function parseGithubRemote(remote) {
  const text = String(remote ?? '').trim();
  if (!text) return undefined;
  const url = text.match(GITHUB_REMOTE_RE);
  if (url) return `${url[1]}/${url[2]}`;
  const plain = text.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  return plain ? `${plain[1]}/${plain[2]}` : undefined;
}

export function resolveGithubRepo(config = {}, info = {}) {
  return parseGithubRemote(config.githubRepo) || parseGithubRemote(info.remote) || parseGithubRemote(info.repository);
}

function githubRef(repo, number) {
  if (!repo || !number) return undefined;
  return { key: `${repo.split('/')[1].toLowerCase()}#${number}`, tracker: 'github', repo };
}

/*
 * The prefixes this install knows are real (MACLEOD-536).
 *
 * `next-15`, `patch-1`, `release-2024`, `v2-1`,
 * `dependabot/npm_and_yarn/express-6.9.21`: ordinary branch names that
 * match the tracker-key grammar exactly. Read as keys they open cards
 * for work that does not exist, which is what they did on the live
 * board through the GitHub connector's copy of this grammar.
 *
 * So a BARE key (`WORD-123`) read out of a branch or a commit message
 * is believed only when WORD is a prefix this install has some reason
 * to think is real. A URL and an `owner/repo#n` are exempt wherever
 * they appear: nobody writes one by accident.
 *
 * The plugin has no store to ask, so the prefixes come from what is on
 * the machine, cheapest first:
 *
 *   * `issuePrefixes` (or `issuePrefix`) in `.teamflow.json` -- the
 *     tracker project or projects this repository is about. An array,
 *     or one string, or a comma-separated list. This is the answer for
 *     a machine that has never reported anything: `ABC-12-fix-thing`
 *     works on the first run when the config says ABC.
 *   * the key `teamflow bind` / `work-on` / `next` wrote, and the one
 *     this session is already bound to. An explicit bind is always
 *     believed -- it never passes through this rule -- and it teaches
 *     the rule its own prefix on the way past.
 *   * the keys of the tickets in the workflows this machine holds.
 *
 * Nothing known at all is "there is nobody to ask", which believes
 * everything, exactly as this did before the rule existed. It is the
 * GitHub connector's `believable(key, known)` with None spelled
 * `undefined`, and the shared cases in
 * tests/fixtures/issue-key-grammar.json are run against both.
 */
export function knownPrefixes(config = {}, keys = []) {
  const out = new Set();
  const configured = config.issuePrefixes ?? config.issuePrefix ?? [];
  const listed = Array.isArray(configured) ? configured : String(configured).split(/[\s,]+/);
  for (const one of listed) {
    const word = String(one ?? '').trim().toUpperCase();
    if (/^[A-Z][A-Z0-9]{1,19}$/.test(word)) out.add(word);
  }
  for (const one of keys) {
    const key = String(one ?? '').trim();
    if (BARE_KEY_RE.test(key)) out.add(key.split('-')[0].toUpperCase());
  }
  return out.size ? out : undefined;
}

/**
 * May this bare key be taken at its word? See knownPrefixes above.
 *
 * `ADHOC-3` always may: TeamFlow minted it, so it is not a package version and
 * not a release branch, and no prefix set could ever be expected to hold it.
 * `believable` in adapters/teamflow/connectors/github.py exempts it by the same
 * rule and the shared fixture has the case, because the two answering
 * differently is the drift this pair of functions exists to prevent.
 */
export function believable(key, known) {
  const text = String(key ?? '');
  if (!known || !text || text.includes('#') || isAdHocKey(text)) return true;
  return known.has(text.split('-')[0].toUpperCase());
}

// Returns { key, tracker, repo?, workspace? }. Issue URLs and owner/repo#n name their own
// tracker; the bare forms (#123, a shared-shape key) are read as the configured tracker.
//
// `known` is the prefix set a bare key is checked against, or undefined for "believe it".
// Only the sources that were not written to name a ticket pass one -- the branch and the
// commit message. A prompt, a bind argument and a tracker tool's own payload are somebody
// saying which ticket they mean, and are believed whatever prefix they use.
export function detectIssueRef(value, config = {}, info = {}, known = undefined) {
  const text = String(value ?? '');
  if (!text) return undefined;

  const linearUrl = text.match(LINEAR_URL_RE);
  if (linearUrl) return { key: linearUrl[2].toUpperCase(), tracker: 'linear', workspace: linearUrl[1] };

  const githubUrl = text.match(GITHUB_URL_RE);
  if (githubUrl) return githubRef(`${githubUrl[1]}/${githubUrl[2]}`, githubUrl[3]);

  const jiraUrl = text.match(JIRA_URL_RE);
  if (jiraUrl) return { key: jiraUrl[1].toUpperCase(), tracker: 'jira' };

  const githubRefMatch = text.match(GITHUB_REF_RE);
  if (githubRefMatch) return githubRef(`${githubRefMatch[1]}/${githubRefMatch[2]}`, githubRefMatch[3]);

  if (trackerOf(config) === 'github') {
    const number = text.match(GITHUB_NUMBER_RE);
    return number ? githubRef(resolveGithubRepo(config, info), number[1]) : undefined;
  }
  // Every bare key in the text, not just the first: a reference the reader may
  // not believe must not hide one it may. "chore: bump next-15 for CORE-217" is
  // an ordinary commit message, and this reads commit messages -- stopping at
  // NEXT-15 traded a wrong ticket for no ticket, which is the ticket that
  // silently stops advancing. `_named_refs` in the connector scans for the same
  // reason, and the shared fixture has the case.
  for (const found of text.matchAll(ISSUE_ALL_RE)) {
    const key = found[1].toUpperCase();
    if (believable(key, known)) {
      return { key, tracker: isAdHocKey(key) ? 'teamflow' : trackerOf(config) };
    }
  }
  return undefined;
}

// 123-fix-hot-reload, issue-123, gh-123, feature/123-fix-hot-reload
export function detectGithubBranch(branch, config = {}, info = {}) {
  const match = String(branch ?? '').match(GITHUB_BRANCH_RE);
  return match ? githubRef(resolveGithubRepo(config, info), match[1]) : undefined;
}

export function detectGithubCommand(command, config = {}, info = {}) {
  const text = String(command ?? '');
  if (!GH_ISSUE_RE.test(text)) return undefined;
  const scoped = { ...config, tracker: 'github', githubRepo: text.match(GH_REPO_FLAG_RE)?.[1] || config.githubRepo };
  const ref = detectIssueRef(text, scoped, info);
  if (ref) return ref;
  const number = text.match(GH_ISSUE_NUMBER_RE);
  return number ? githubRef(resolveGithubRepo(scoped, info), number[1]) : undefined;
}

function toolRef(payload, tracker, config, info) {
  const json = JSON.stringify(payload ?? {});
  const ref = detectIssueRef(json, { ...config, tracker }, info);
  if (ref) return ref;
  if (tracker !== 'github') return undefined;
  const number = json.match(GH_ISSUE_FIELD_RE);
  if (!number) return undefined;
  const owner = json.match(GH_OWNER_FIELD_RE)?.[1];
  const name = json.match(GH_REPO_FIELD_RE)?.[1];
  return githubRef(owner && name ? `${owner}/${name}` : resolveGithubRepo(config, info), number[1]);
}

/**
 * The bind grammar: a key, a bare number, owner/repo#n, or an issue URL.
 *
 * An organisation runs several trackers at once (MACLEOD-477), so the form of
 * the argument names the provider and the configured tracker is only the
 * default for the two forms that cannot name one themselves — a bare `#123`,
 * which is GitHub, and a bare `TEAM-123`, which is Jira or Linear. Gating the
 * shared-shape key on the configured tracker is what made `teamflow bind
 * MACLEOD-507` answer the usage error in a repository configured for GitHub.
 */
export function parseBindArgument(value, config = {}, info = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  // An explicit bind of "#123" means GitHub even when the configured tracker is not.
  const bare = raw.match(/^#?(\d+)$/);
  if (bare) return githubRef(resolveGithubRepo(config, info), bare[1]);
  const detected = detectIssueRef(raw, config, info);
  if (detected) return detected;
  if (!BARE_KEY_RE.test(raw)) return undefined;
  // Reaching here means the configured tracker is GitHub, because a Jira or
  // Linear install already answered above. The key is not a GitHub key —
  // those are <repo>#<n> — so it belongs to whichever other tracker this
  // install has coordinates for, and Jira last, as trackerOf defaults there.
  if (isAdHocKey(raw)) return { key: raw.toUpperCase(), tracker: 'teamflow' };
  return { key: raw.toUpperCase(), tracker: config.linearWorkspace ? 'linear' : 'jira' };
}

export function safeExec(command, args = [], options = {}) {
  try {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      input: options.input,
      encoding: 'utf8',
      timeout: options.timeout ?? 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    return {
      ok: result.status === 0 && !result.error,
      stdout: (result.stdout ?? '').trim(),
      stderr: (result.stderr ?? '').trim(),
      status: result.status,
    };
  } catch (error) {
    return { ok: false, stdout: '', stderr: String(error), status: null };
  }
}

export function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Later layers win, but only where they actually say something.
 *
 * `Object.assign` cannot be used here: the environment layer is built by
 * reading a dozen variables, and every one that is unset arrives as
 * `undefined`. Assigned over the file layer that would erase the value the
 * file had, which is how `.teamflow.json` came to contribute nothing on a
 * machine with a clean environment. An unset override is silence, not an
 * instruction to forget; an empty string is the same silence, because that
 * is what an exported-but-blank variable looks like.
 */
function mergeConfig(...configs) {
  const merged = {};
  for (const config of configs) {
    if (!config) continue;
    for (const [key, value] of Object.entries(config)) {
      if (value === undefined || value === '') continue;
      merged[key] = value;
    }
  }
  return merged;
}

export function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA ||
    path.join(os.homedir(), '.local', 'share', 'teamflow');
}

export function projectId(cwd) {
  return crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

// One binding per repository, not one per directory somebody happened
// to be standing in. `teamflow bind` run in a package and a hook event
// fired from that package's directory have to name the same file as the
// root does, or the binding is written where nothing will look for it.
export function projectBindingPath(cwd, config = {}) {
  return path.join(dataDir(), 'bindings', tenantId(config), `${projectId(repositoryRoot(cwd))}.json`);
}

// The other place a binding may live: inside the repository itself.
//
// An agent sandboxed to its worktree cannot write to the user data
// directory, so `teamflow bind` there wrote nothing a hook could find
// and the agent's work reported unbound or under whatever key the last
// person to bind this machine had left behind. `teamflow bind --local`
// writes here instead, one file per repository root, and the plugin's
// own `.teamflow/.gitignore` keeps it out of the commit.
export function localBindingPath(cwd) {
  return path.join(repositoryRoot(cwd), '.teamflow', 'binding.json');
}

// Whether `teamflow bind` can write where it normally writes. A sandbox
// that denies the user data directory is the ordinary case this asks
// about, not an error, so it answers false rather than throwing.
export function dataDirWritable() {
  const dir = path.join(dataDir(), 'bindings');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which of the two binding files speaks for this repository.
 *
 * The newer `boundAt` wins, because both files are somebody saying
 * "this ticket now" and the later word is the current one. A tie — or
 * a file written before `boundAt` existed — goes to the local one: it
 * is the more specific of the two, written into this working copy
 * rather than onto this machine.
 */
export function preferBinding(local, user) {
  if (!local?.jiraKey) return user;
  if (!user?.jiraKey) return local;
  return (user.boundAt || '') > (local.boundAt || '') ? user : local;
}

/**
 * Write the local binding, and keep it out of the repository's history.
 *
 * The ignore rule names `binding.json` rather than the whole directory
 * because `.teamflow/hooks/` is committed on purpose — those shims are
 * what a teammate's checkout runs. An existing `.gitignore` is appended
 * to, never replaced: it is the repository's file, not ours.
 */
export function writeLocalBinding(cwd, value) {
  const file = localBindingPath(cwd);
  writeJson(file, value);
  const ignore = path.join(path.dirname(file), '.gitignore');
  const current = (() => {
    try { return fs.readFileSync(ignore, 'utf8'); } catch { return undefined; }
  })();
  if (current === undefined) fs.writeFileSync(ignore, 'binding.json\n');
  else if (!current.split(/\r?\n/).includes('binding.json')) {
    fs.writeFileSync(ignore, `${current.endsWith('\n') || !current ? current : `${current}\n`}binding.json\n`);
  }
  return file;
}

// --- the workflows this machine knows about (MACLEOD-540) -----------
//
// The file lives here rather than in workflow.mjs because a hook has to
// read it -- every report says which run it belongs to -- and core.mjs
// is what a hook already imports. workflow.mjs owns deciding what goes
// in it; this owns where it is and how it is keyed.
//
// Keyed by tenant: a member can hold seats in several organisations and
// switches between them per session, so one org's runs must not appear
// in another's, and must never be published to it.

export function workflowsPath() {
  return path.join(dataDir(), 'workflows.json');
}

export function workflowScope(config = {}) {
  return tenantId(config) || 'unknown';
}

export function readWorkflows(config = {}) {
  const all = readJson(workflowsPath(), {}) || {};
  const mine = all[workflowScope(config)] || {};
  return { current: mine.current || null, workflows: mine.workflows || {} };
}

export function writeWorkflows(state, config = {}) {
  const all = readJson(workflowsPath(), {}) || {};
  all[workflowScope(config)] = { current: state.current, workflows: state.workflows };
  fs.mkdirSync(path.dirname(workflowsPath()), { recursive: true });
  writeJson(workflowsPath(), all);
}

/**
 * Which run a ticket is in, for the report about to be sent.
 *
 * Two fields and no more. The event itself is already an execution on
 * the issue document, which is where every event has always gone; what
 * was missing was the run it happened inside, so a dashboard could show
 * a workflow's activity from the reports it already receives rather
 * than from a second log nobody else writes to.
 *
 * An unfinished run wins over a finished one when two hold the ticket,
 * for the same reason the dashboard prefers it: showing the run that is
 * actually working on it beats showing whichever came first.
 */
export function workflowRef(key, config = {}) {
  if (!key) return undefined;
  const { workflows } = readWorkflows(config);
  const holding = Object.values(workflows)
    .filter((w) => (w.tickets || []).some((t) => t.key === key));
  if (!holding.length) return undefined;
  const live = (w) => (w.status === 'done' || w.status === 'cancelled' ? 1 : 0);
  const chosen = [...holding].sort((a, b) => live(a) - live(b)
    || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
  const ticket = chosen.tickets.find((t) => t.key === key);
  const ref = { id: chosen.id };
  if (ticket && ticket.phase !== undefined) ref.phase = ticket.phase;
  return ref;
}

// --- one state per actor, not per session (MACLEOD-574) -------------
//
// A subagent's hook events carry the *parent's* `session_id`, so for as
// long as state was keyed by session alone the main session and every
// team in every worktree shared one file: whoever fired last decided
// the ticket and the stage for everybody. An actor is (session, agent).
//
// The agent key is the `agent_id` Claude Code puts on an event fired
// inside a subagent; where there is none — an older Claude Code, and
// all seven other tools — it is the repository root when that root is
// not the session's own, which is what a worktree is. A session with
// neither is the main actor and keeps the file name it has always had,
// so an install that upgrades mid-session reads its own state back.

/** A short stable digest. The one place a path becomes an identifier. */
export function digest(value, length = 12) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

/**
 * A file name, and part of an execution id, for an agent key.
 *
 * A hash and nothing else. It carried a readable tail of the key until
 * the audit of MACLEOD-574 found what that means when the key is a
 * worktree root: `claude-<session>-private-tmp-claude-501-Users-steve-…`
 * on the wire, which is the machine's username, the client directory and
 * the repository name. A path is not derived state and never leaves the
 * machine; the hash tells two actors apart, which is the whole job.
 */
export function actorSlug(agentKey) {
  return digest(agentKey, 12);
}

export function sessionPath(sessionId, agentKey = undefined) {
  const name = agentKey ? `${sessionId}--${actorSlug(agentKey)}.json` : `${sessionId}.json`;
  return path.join(dataDir(), 'sessions', name);
}

/**
 * Every actor of one session: the main one first, then its agents.
 *
 * `SessionEnd` has to end all of them — a session that stopped stopped
 * its teams too — and `teamflow status` wants to see them. Reading a
 * directory is the whole of it, because the file name carries the
 * session id.
 */
export function sessionActors(sessionId) {
  const dir = path.join(dataDir(), 'sessions');
  if (!fs.existsSync(dir)) return [];
  const mine = fs.readdirSync(dir)
    .filter((name) => name === `${sessionId}.json` || name.startsWith(`${sessionId}--`))
    .filter((name) => name.endsWith('.json'));
  return mine
    .map((name) => readJson(path.join(dir, name)))
    .filter(Boolean)
    .sort((a, b) => (a.agentKey ? 1 : 0) - (b.agentKey ? 1 : 0));
}

// --- what does this tool actually send? (MACLEOD-573) ---------------
//
// The whole of MACLEOD-574's agent design rests on one undocumented
// fact: whether Claude Code puts `agent_id` on a subagent's own
// `PreToolUse`/`PostToolUse`, or only on `SubagentStart`/`SubagentStop`.
// The plugin is built to work either way, and nothing on this machine
// can tell us which is true, because a synthetic test payload proves
// only what the test put in it.
//
// So: an opt-in, local, names-only trace. `TEAMFLOW_HOOK_TRACE=1` and
// one line per event, holding KEY NAMES and booleans and nothing else.
// Not a value, not a path, not a prompt, not an id — a reader of this
// file learns which fields exist and nothing whatever about the work.
// It is never sent anywhere, it stops at 2,000 lines, and it fails open
// like every other thing a hook does.

/*
 * A key name is written only if it is one we already know (MACLEOD-573).
 *
 * This was a shape test — an identifier, with a lowercase letter in it —
 * and the audit showed what that is worth: the lowercase clause screens
 * `AKIAIOSFODNN7EXAMPLE` and nothing else, because every other common
 * token prefix is already lowercase. `ghp_…`, `sk_live_…`, `xoxb_…`,
 * `glpat_…`, `AIzaSy…` and `npm_…` are all valid identifiers with a
 * lowercase letter in them, and all six were written out verbatim.
 *
 * So the rule is an ALLOWLIST rather than a shape. This file exists to
 * answer one question — which fields actually arrive on a hook event —
 * and that set is closed, short and already written down: the hook
 * payload's documented fields, and the tool-input fields the classifier
 * and the agent-launch capture read. A key that is not one of them is
 * counted into `otherKeys` and never written.
 *
 * The cost is real and worth naming: a field Claude Code adds tomorrow
 * will be a number here rather than a name, which is exactly what this
 * file was built to notice. The count is still the signal — "three keys
 * arrived that I do not know" sends a reader to the release notes — and
 * a trace that can print a customer's access token to answer that
 * question faster is not a trade worth making.
 */

/** The hook payload's own fields, from the hooks reference and adapters.mjs. */
const HOOK_FIELDS = new Set([
  // Common to every event.
  'session_id', 'prompt_id', 'transcript_path', 'cwd', 'scratchpad_dir',
  'permission_mode', 'effort', 'hook_event_name',
  // Fired inside a subagent.
  'agent_id', 'agent_type',
  // Tool events.
  'tool_name', 'tool_input', 'tool_response', 'tool_use_id', 'error', 'matcher',
  // The rest of the documented event shapes.
  'prompt', 'message', 'source', 'reason', 'stop_hook_active', 'trigger',
  'custom_instructions', 'last_assistant_message', 'timeout',
  // Agent teams.
  'task_id', 'task_subject', 'teammate',
  // The plugin's own: hook-cli.mjs sets it from `--for`.
  'reporter_tool',
]);

/**
 * The `tool_input` fields the tools this plugin reads actually carry.
 *
 * Claude Code's built-ins, and the two the plugin itself reads —
 * `command` for the classifier and `name`/`description`/`subagent_type`
 * for the agent-launch capture. `prompt` is on the list because knowing
 * THAT a prompt field arrived is the whole point; its value has never
 * been read here and is not written.
 */
const TOOL_INPUT_FIELDS = new Set([
  'command', 'description', 'timeout', 'run_in_background',
  'file_path', 'file_paths', 'offset', 'limit', 'pages', 'content',
  'old_string', 'new_string', 'replace_all', 'edits',
  'notebook_path', 'cell_id', 'cell_type', 'new_source', 'edit_mode',
  'pattern', 'path', 'glob', 'output_mode', 'head_limit', 'multiline', 'type',
  'prompt', 'subagent_type', 'name', 'model', 'isolation', 'team_name', 'mode',
  'todos', 'url', 'urls', 'query', 'max_results', 'allowed_domains', 'blocked_domains',
  'skill', 'args', 'to', 'summary', 'notify_when_idle', 'action', 'title', 'plan',
]);

/*
 * The caps. A key name that IS on the list is still bounded, because a
 * list is not a promise about length, and the file is bounded in BYTES
 * and asked with `statSync` rather than by reading it: a line cap bounds
 * nothing when one line can be eight kilobytes, and reading the whole
 * file to count its lines was the same read-modify-write shape as the
 * launch registry's old race, so concurrent hooks could overshoot it.
 * One `appendFileSync` of one finished line is atomic enough: the write
 * is a single syscall on an O_APPEND handle.
 */
const TRACE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const TRACE_MAX_KEYS = 40;
const TRACE_MAX_LINE = 2 * 1024;
const TRACE_MAX_BYTES = 2 * 1024 * 1024;

export function tracePath() {
  return path.join(dataDir(), 'hook-trace.jsonl');
}

export function traceEnabled(env = process.env) {
  return env.TEAMFLOW_HOOK_TRACE === '1';
}

/**
 * The known key names of one object, and a count of everything else.
 *
 * `{ names, other }`: `other` is a number and never a list, so a key
 * that was not on the list leaves behind the fact that it existed and
 * nothing whatever of what it said.
 */
function traceKeys(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { names: [], other: 0 };
  const keys = Object.keys(value);
  const names = keys.filter((key) => allowed.has(key)).sort();
  return {
    names: names.slice(0, TRACE_MAX_KEYS),
    other: (keys.length - names.length) + Math.max(0, names.length - TRACE_MAX_KEYS),
  };
}

/** The line, as an object, so a test can assert on it without parsing. */
export function traceLine(input = {}, { sameRoot = undefined } = {}) {
  const top = traceKeys(input, HOOK_FIELDS);
  const toolInput = traceKeys(input?.tool_input, TOOL_INPUT_FIELDS);
  /*
   * `event` and `tool` are VALUES rather than key names, and both are
   * vocabularies: `PreToolUse`, `Bash`, `mcp__linear__get_issue`. They
   * are shape-checked rather than allowlisted, because the set of MCP
   * tool names is open by design and which one ran is worth knowing.
   */
  const tool = String(input?.tool_name || '');
  return {
    at: new Date().toISOString(),
    event: TRACE_NAME.test(String(input?.hook_event_name || '')) ? input.hook_event_name : 'Unknown',
    tool: TRACE_NAME.test(tool) ? tool : undefined,
    keys: top.names,
    otherKeys: top.other || undefined,
    toolInputKeys: toolInput.names,
    otherToolInputKeys: toolInput.other || undefined,
    hasAgentId: typeof input?.agent_id === 'string' && input.agent_id.length > 0,
    hasAgentType: typeof input?.agent_type === 'string' && input.agent_type.length > 0,
    // Whether this event came from the session's own root, which is the
    // other half of the question. A boolean, never the directory.
    sameRoot,
  };
}

/** Append one line, or do nothing at all. Never throws. */
export function trace(input, options = {}, env = process.env) {
  if (!traceEnabled(env)) return false;
  try {
    const file = tracePath();
    let bytes = 0;
    try { bytes = fs.statSync(file).size; } catch { bytes = 0; }
    if (bytes >= TRACE_MAX_BYTES) return false;
    let line = JSON.stringify(traceLine(input, options));
    if (line.length > TRACE_MAX_LINE) {
      // Truncating JSON would write half an object, so the oversized
      // line is replaced by one that says it happened.
      const smaller = traceLine({ hook_event_name: input?.hook_event_name }, options);
      line = JSON.stringify({ ...smaller, oversize: true });
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Actors whose end has not reached the wire (MACLEOD-574).
 *
 * `SessionEnd` marks them and cannot publish them; whichever hook runs
 * next picks them up. Oldest first, so a backlog drains in the order it
 * accumulated rather than by whatever `readdir` happens to return.
 */
export function pendingEndActors(sessionId = undefined, scope = undefined) {
  const dir = path.join(dataDir(), 'sessions');
  if (!fs.existsSync(dir)) return [];
  const all = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(dir, name)))
    .filter((actor) => actor?.pendingEnd && actor.binding?.key)
    .sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')));
  /*
   * This session's own first, and beyond that only what this
   * configuration could legitimately have written (MACLEOD-574, audit
   * finding B, ruling 3).
   *
   * The directory is one per machine, not one per repository or per
   * client, so an unscoped sweep reaches other people's work. The sweep
   * still has to exist -- the whole point of the flag is that a session
   * which was KILLED needs somebody else to publish its ends -- but a
   * foreign actor is only a candidate when the tenant and the service it
   * recorded are the ones this hook is already talking to. Anything else
   * stays pending for a hook that belongs to it.
   *
   * `scope` filters unconditionally, and a caller that names no session
   * gets same-account actors or nothing. There used to be an early
   * `if (!sessionId) return all` above this, which was unreachable --
   * the one caller always passes one -- and which would have handed the
   * whole machine to the second caller anybody wrote. A `doctor --flush`
   * or a CLI sweep would have reinstated the cross-tenant leak in one
   * line, silently. A list this function cannot produce cannot be asked
   * for by accident.
   */
  const mine = (actor) => Boolean(sessionId) && actor.sessionId === sessionId;
  const sameAccount = (actor) => Boolean(scope)
    && actor.tenantId === scope.tenantId
    && (actor.serviceUrl ?? scope.serviceUrl) === scope.serviceUrl;
  return [...all.filter(mine), ...all.filter((actor) => !mine(actor) && sameAccount(actor))];
}

/**
 * Which actor an event belongs to, or `undefined` for the session itself.
 *
 * Defensive about every field, because only a recent Claude Code sends
 * any of them: Cursor, Copilot, Windsurf, Cline, Codex CLI, Gemini CLI
 * and Junie send none, and a payload with no `agent_id` must behave
 * exactly as it did before this existed.
 *
 * The root fallback is a **digest** of the directory and never the
 * directory. The key is only ever compared for equality and used as a
 * file name, so a digest serves every use it has — and the path itself
 * is an OS username, a client's name and a repository's name, none of
 * which is derived state and all of which reached the wire through this
 * one `return` until the audit of MACLEOD-574 caught it.
 */
export function agentKeyOf(input = {}, cwd = undefined, sessionCwd = undefined) {
  const id = typeof input.agent_id === 'string' ? input.agent_id.trim() : '';
  if (id) return id.slice(0, 80);
  if (cwd && sessionCwd && cwd !== sessionCwd) return `root:${digest(cwd)}`;
  return undefined;
}

/**
 * The actor an event belongs to, including the one it belongs to because
 * an earlier event said so (MACLEOD-574, audit finding 4).
 *
 * `agent_id` is documented on `SubagentStart` and `SubagentStop` and on
 * tool events fired inside a subagent; a tool that sends it on some
 * events and not others would otherwise split one agent into two
 * actors — `agent-one` for the events that carry it and `root:<digest>`
 * for the ones that do not — which is two executions on one ticket, one
 * named and one "Agent". So a keyless event inside a directory some
 * agent has already claimed resolves to that agent.
 */
export function resolveActorKey(input = {}, cwd = undefined, main = undefined, sessionId = undefined) {
  const id = typeof input.agent_id === 'string' ? input.agent_id.trim() : '';
  if (id) return id.slice(0, 80);
  if (!cwd || !main?.cwd || cwd === main.cwd) return undefined;
  const others = sessionId ? sessionActors(sessionId).filter((one) => one.agentKey) : [];

  // This directory is already somebody's — following the pointer an
  // absorbed actor leaves behind when its agent finally named itself.
  const here = others.filter((actor) => actor.cwd === cwd);
  const settled = here.find((actor) => !actor.absorbedInto) ?? here[0];
  if (settled) return settled.absorbedInto || settled.agentKey;

  /*
   * An agent that started and has not shown a directory of its own yet.
   *
   * `SubagentStart` fires before an `isolation: "worktree"` agent's
   * worktree exists, so its first event carries the parent's `cwd` and
   * the agent looks, for a moment, like it is working where the session
   * is. The first event from a new root after such a start is that
   * agent arriving, not a second actor: minting one here would give the
   * board a named agent that never moves beside an unnamed one doing
   * all the work.
   *
   * ONE candidate, or none of them. With two or more there is nothing in
   * the payload that says which is which, and guessing does not fail
   * randomly — it fails backwards: the newest-first order adopted the
   * LAST agent to start for the FIRST worktree to report, so two agents
   * came out reliably swapped and five came out scrambled. A name on the
   * wrong ticket is worse than the bug this ticket was filed for, because
   * a blank is obviously wrong and `wf-beta` on `wf-alpha`'s work reads
   * as authoritative. With two or more, the actor is separated correctly
   * and left unnamed until an event carrying its own `agent_id` settles
   * it: a missing name is recoverable and a wrong one is not.
   */
  const unsettled = others
    .filter((actor) => actor.agent && !actor.agent.endedAt && actor.cwd === main.cwd);
  if (unsettled.length === 1) return unsettled[0].agentKey;

  return `root:${digest(cwd)}`;
}

/**
 * The unnamed actor a directory was keyed under, now that its agent has
 * named itself (MACLEOD-574, audit blocker A).
 *
 * Two or more agents starting before any of them shows a worktree cannot
 * be told apart by directory, so each one's worktree gets an actor of its
 * own keyed by `root:<digest>` and no name at all. That is the right
 * answer at the time and the wrong one for ever: the first event from
 * that directory carrying an `agent_id` says exactly which agent has been
 * working there, and the two records are one actor's.
 *
 * So they are merged. The work — the ticket, the stage, the summary, the
 * loop, the rework — moves to the named actor, and the unnamed one is
 * ended and left behind as a pointer so nothing keys to it again. Its
 * execution is published once more as idle rather than abandoned mid-air:
 * the execution id changes when the key does, and a row left saying
 * `running` for ever is the bug this ticket is already about.
 */
export function absorbRootActor(sessionId, agentKey, cwd) {
  if (!sessionId || !agentKey || !cwd || agentKey.startsWith('root:')) return undefined;
  const rootKey = `root:${digest(cwd)}`;
  const orphan = readJson(sessionPath(sessionId, rootKey));
  if (!orphan || orphan.absorbedInto || orphan.cwd !== cwd) return undefined;
  const at = new Date().toISOString();
  saveSession({
    ...orphan,
    absorbedInto: agentKey,
    ended: true,
    status: 'idle',
    summary: orphan.summary,
    // Published once by the flush, under this repository's own config,
    // so the board sees the old execution finish rather than hang.
    pendingEnd: Boolean(orphan.binding?.key),
    updatedAt: at,
  });
  return orphan;
}


// --- who the agent is (MACLEOD-574) ---------------------------------
//
// The only place an agent's human-readable name and its one-line task
// exist is the `Agent` (formerly `Task`) tool's PreToolUse in the
// parent, which carries `tool_input.name`, `.description` and
// `.subagent_type`. The agent's own events carry `agent_id` and
// `agent_type` and no name at all, so the two have to be matched.
//
// The prompt is in that same `tool_input` and is never read. What is
// written here is a name, a one-line task and a type — the same class
// of short model-written label as a workflow's name, and capped the
// same way.

/*
 * The registry is a DIRECTORY, and that is the whole of its concurrency
 * story (MACLEOD-574, audit finding 2).
 *
 * It was one `launches.json` that all three functions below read,
 * modified and wrote back. `writeJson` is atomic per write — temp file
 * then rename — but atomic-write is not compare-and-swap, and a hook is
 * a separate process: the orchestrator launches five agents in one
 * message, five `PreToolUse` hooks run at once, all five read the same
 * file and three of the five launches survived. On the read side it was
 * worse: five concurrent `matchLaunch` calls all claimed the same entry,
 * so four of five agents came out named `alpha`, which is the symptom
 * the ticket was filed about wearing a different hat.
 *
 * So nothing here shares a mutable file. One launch is one file that
 * only its writer ever writes, the directory listing is the registry,
 * and a launch is claimed by RENAMING it — a rename either succeeds for
 * exactly one process or fails with ENOENT for the losers, which is the
 * retry loop rather than a lost update.
 */
const LAUNCHES_MAX = 50;
const CLAIMED = '.claimed-';

export function launchesPath(sessionId) {
  return path.join(dataDir(), 'sessions', `${sessionId}.launches`);
}

/** Every launch file, oldest first, with its path. FIFO is this order. */
function launchFiles(sessionId) {
  const dir = launchesPath(sessionId);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const file = path.join(dir, name);
      const held = readJson(file);
      return held ? { file, name, launch: held } : undefined;
    })
    .filter(Boolean)
    .sort((a, b) => String(a.launch.at).localeCompare(String(b.launch.at))
      || a.name.localeCompare(b.name));
}

const isClaimed = (name) => name.includes(CLAIMED);

/**
 * Claim one launch file for `agentId` by renaming it.
 *
 * The rename is the lock. Two processes racing for the same file: one
 * rename succeeds, the other throws ENOENT and the caller moves on to
 * the next candidate. Nothing is read-modify-written, so nothing is lost.
 */
function claimFile(entry, agentId) {
  const claimed = entry.file.replace(/\.json$/, `${CLAIMED}${digest(agentId, 16)}.json`);
  try {
    fs.renameSync(entry.file, claimed);
  } catch {
    return undefined;                       // somebody else got it first
  }
  const launch = { ...entry.launch, agentId };
  try { writeJson(claimed, launch); } catch { /* the name is the claim */ }
  return launch;
}

/** A model-written label, capped and stripped of anything but one line. */
export function agentLabel(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, max) : undefined;
}

/** True for the tool that launches an agent, under either of its names. */
export function isAgentTool(tool) {
  return tool === 'Agent' || tool === 'Task';
}

/**
 * Record one launch. Never the prompt: `tool_input.prompt` is the whole
 * brief, model- and user-written, and `docs/REPORTING_CONTRACT.md` has
 * always said a prompt stays on the machine.
 */
export function recordLaunch(sessionId, toolInput = {}) {
  const name = agentLabel(toolInput.name, 64);
  const task = agentLabel(toolInput.description, 80);
  const type = agentLabel(toolInput.subagent_type, 40);
  if (!name && !task && !type) return undefined;
  const launch = { name, task, type, at: new Date().toISOString() };
  // A file nobody else writes, named for nothing but chance, so five of
  // these at once are five files rather than four lost updates.
  writeJson(path.join(launchesPath(sessionId), `${crypto.randomUUID()}.json`), launch);
  pruneLaunches(sessionId);
  return launch;
}

/**
 * Keep the registry from growing without bound.
 *
 * Deleting the oldest beyond the cap, and only ever files this process
 * has just listed: an unlink that loses a race is an unlink of something
 * already gone, which is the outcome either way.
 */
function pruneLaunches(sessionId) {
  const files = launchFiles(sessionId);
  if (files.length <= LAUNCHES_MAX) return;
  for (const entry of files.slice(0, files.length - LAUNCHES_MAX)) {
    try { fs.unlinkSync(entry.file); } catch { /* already gone */ }
  }
}

/**
 * A background agent's id, where the tool result happens to carry one.
 *
 * PostToolUse has no documented agent-id field; in practice the text a
 * background `Agent` answers with holds a line `agentId: <id>`. Parsed
 * when it is there and never depended on — the FIFO match below is what
 * actually has to work.
 */
export function parseAgentId(response) {
  const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');
  return /(?:^|[^A-Za-z])agentId:\s*([A-Za-z0-9_-]{1,80})/.exec(text)?.[1];
}

/** Attach an id to the newest launch that has none, so a Start can find it by id. */
export function claimLaunch(sessionId, agentId, type = undefined) {
  if (!agentId) return undefined;
  const candidates = launchFiles(sessionId)
    .filter((entry) => !isClaimed(entry.name))
    .filter((entry) => !type || !entry.launch.type || entry.launch.type === type)
    .reverse();                              // newest first: this is the one just started
  for (const entry of candidates) {
    const won = claimFile(entry, agentId);
    if (won) return won;
  }
  return undefined;
}

/**
 * The launch this agent came from: by id where one was claimed, else the
 * oldest unmatched launch of the same type, FIFO.
 *
 * FIFO is a guess and is only as good as the order the tool starts the
 * agents in. Two agents of the same type launched together and started
 * out of order would swap names; nothing in the payload can tell them
 * apart, so the alternative is no name at all for either. An agent that
 * matches nothing is named for its type, which is honest.
 */
export function matchLaunch(sessionId, agentId, agentType) {
  const files = launchFiles(sessionId);
  // Claimed by id already, by this agent's own PostToolUse. The name says
  // so, so no read is needed to rule the rest out.
  const mine = agentId
    ? files.find((entry) => entry.name.includes(`${CLAIMED}${digest(agentId, 16)}`))
    : undefined;
  if (mine) return mine.launch;
  const candidates = files
    .filter((entry) => !isClaimed(entry.name))
    .filter((entry) => !agentType || !entry.launch.type || entry.launch.type === agentType);
  for (const entry of candidates) {           // oldest first: FIFO
    const won = claimFile(entry, agentId || entry.name);
    if (won) return won;
  }
  return undefined;
}

/**
 * Three layers, least specific first: the global file, the project's own
 * `.teamflow.json`, then the environment. `mergeConfig` keeps that order and
 * skips the layers that are silent, so an unset variable leaves the file's
 * answer standing and a set one replaces it.
 */
export function loadConfig(cwd) {
  const globalConfig = readJson(path.join(os.homedir(), '.config', 'teamflow', 'config.json'), {});
  const projectConfig = readJson(path.join(cwd, '.teamflow.json'), {});
  return mergeConfig(globalConfig, projectConfig, {
    serviceUrl: process.env.TEAMFLOW_SERVICE_URL || undefined,
    apiKey: process.env.TEAMFLOW_API_KEY || undefined,
    authIssuer: process.env.TEAMFLOW_AUTH_ISSUER || undefined,
    authClientId: process.env.TEAMFLOW_AUTH_CLIENT_ID || undefined,
    dataUri: process.env.TEAMFLOW_DATA_URI || undefined,
    tenantId: process.env.TEAMFLOW_TENANT_ID || undefined,
    actorId: process.env.TEAMFLOW_ACTOR_ID || undefined,
    actorName: process.env.TEAMFLOW_ACTOR_NAME || undefined,
    jiraBaseUrl: process.env.TEAMFLOW_JIRA_BASE_URL || undefined,
    tracker: process.env.TEAMFLOW_TRACKER || undefined,
    linearWorkspace: process.env.TEAMFLOW_LINEAR_WORKSPACE || undefined,
    githubRepo: process.env.TEAMFLOW_GITHUB_REPO || undefined,
    awsProfile: process.env.TEAMFLOW_AWS_PROFILE || undefined,
    // For a machine that has no browser and cannot be detected as
    // such: a container with a display variable set by its base
    // image, a remote shell, an agent's sandbox. Set it once there
    // instead of remembering `--no-browser` on every sign-in.
    noBrowser: process.env.TEAMFLOW_NO_BROWSER === '1' || undefined,
  });
}

export function tenantId(config) {
  const raw = String(config.tenantId || 'default').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(raw)) {
    throw new Error('TEAMFLOW_TENANT_ID must match [a-z0-9][a-z0-9._-]{0,63}');
  }
  return raw;
}

export function tenantPath(config, relativePath) {
  return `tenants/${tenantId(config)}/${String(relativePath).replace(/^\/+/, '')}`;
}

// TEAMFLOW_GIT_BIN is the test seam, beside TEAMFLOW_CLAUDE_BIN and
// TEAMFLOW_GH_BIN: a stub can answer "three ahead, two behind, dirty"
// without a test having to build a repository in that state.
function git(cwd, args) {
  return safeExec(process.env.TEAMFLOW_GIT_BIN || 'git', ['-C', cwd, ...args], { cwd, timeout: 2000 });
}

// Where the work actually lives, whatever directory an event names.
//
// `projectId` hashes a path, so a subdirectory is a different project:
// a different binding, and a ticket that stops moving with nothing in
// any log to say why. Several events cannot avoid naming one — Cursor's
// afterFileEdit and Copilot's carry the file's directory, and Claude
// Code's own carry a subfolder whenever the session was started in one
// — so every identity derived from a path goes through this first.
//
// Cached per directory for the life of the process, because one hook
// run asks more than once and a hook has milliseconds. Outside a
// repository, and on a machine with no git, the directory is its own
// answer: both are ordinary, neither is an error, and a reporter that
// threw on either would be a reporter that failed closed.
const REPOSITORY_ROOTS = new Map();

export function repositoryRoot(cwd) {
  const start = path.resolve(cwd || process.cwd());
  const cached = REPOSITORY_ROOTS.get(start);
  if (cached) return cached;
  let root = start;
  try {
    const found = git(start, ['rev-parse', '--show-toplevel']);
    if (found.ok && found.stdout) root = path.resolve(found.stdout);
  } catch {
    // safeExec does not throw, and nothing here may depend on that.
  }
  REPOSITORY_ROOTS.set(start, root);
  return root;
}

// Whether this repository root is a worktree rather than the checkout
// git's own metadata lives in. A worktree's `.git` is a file pointing at
// the main checkout's `.git/worktrees/<name>`, not a directory, and its
// `--git-dir` and `--git-common-dir` differ for the same reason. Either
// signal alone answers it; both are checked because a repository with no
// `git` binary on PATH still has the file.
export function isWorktree(cwd) {
  const root = repositoryRoot(cwd);
  let gitEntryIsFile = false;
  try { gitEntryIsFile = fs.statSync(path.join(root, '.git')).isFile(); } catch {
    // No `.git` entry at all — fall through to the git-dir comparison.
  }
  const gitDir = git(root, ['rev-parse', '--git-dir']);
  const commonDir = git(root, ['rev-parse', '--git-common-dir']);
  const dirsDiffer = gitDir.ok && commonDir.ok
    && path.resolve(root, gitDir.stdout) !== path.resolve(root, commonDir.stdout);
  return gitEntryIsFile || dirsDiffer;
}

export function gitInfo(cwd) {
  const branch = git(cwd, ['branch', '--show-current']).stdout || undefined;
  const remote = git(cwd, ['remote', 'get-url', 'origin']).stdout || undefined;
  const commit = git(cwd, ['rev-parse', '--short=12', 'HEAD']).stdout || undefined;
  const lastMessage = git(cwd, ['log', '-1', '--pretty=%B']).stdout || undefined;
  const name = git(cwd, ['config', 'user.name']).stdout || undefined;
  const email = git(cwd, ['config', 'user.email']).stdout || undefined;
  let repository;
  if (remote) {
    repository = remote
      .replace(/^git@github\.com:/, '')
      .replace(/^https?:\/\/github\.com\//, '')
      .replace(/\.git$/, '');
  }
  return { branch, remote, repository, commit, lastMessage, name, email };
}

// --- where the branch is, and what its PR is doing -------------------
//
// MACLEOD-510. The card dialog wants the two things a person checks
// before asking "is it in yet": where the branch stands against the
// default branch, and what the pull request is doing. Both are derived
// state and stay inside docs/REPORTING_CONTRACT.md: counts, flags, a
// number, a link, four enumerated verdicts. Never a diff, never a
// commit body, never a file list — the head commit's subject line is
// the one piece of text, because a card that cannot say what the last
// commit was is a card nobody reads.

function defaultBranchName(cwd, config = {}) {
  if (config.defaultBranch) return String(config.defaultBranch);
  const head = git(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).stdout;
  return head.match(/^refs\/remotes\/origin\/(.+)$/)?.[1] || 'main';
}

/*
 * The branches a repository calls its trunk. Read as a set rather than
 * as one answer, because `defaultBranchName` can only guess: it returns
 * `main` whenever `refs/remotes/origin/HEAD` is unset, which is the
 * normal state after `git init` plus `git remote add` — only `git clone`
 * writes that ref. Guessing `main` on a `master` repository used to mean
 * a real `git merge feature` on `master` was silently not the gate.
 */
const TRUNK_NAMES = ['main', 'master', 'develop', 'trunk'];

/** The refs a `git merge` was asked to merge IN, flags and their values removed. */
export function mergeSources(command) {
  const found = /\bgit\s+merge\b([^;&|]*)/i.exec(String(command));
  if (!found) return [];
  const takesValue = new Set(['-m', '-s', '-X', '-S', '-F',
    '--strategy', '--strategy-option', '--message', '--file', '--gpg-sign', '--into-name']);
  const tokens = found[1].trim().split(/\s+/).filter(Boolean);
  const sources = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--') continue;
    if (token.startsWith('-')) {
      if (takesValue.has(token)) i += 1;     // `-m "a message"` is not a ref
      continue;
    }
    sources.push(token);
  }
  return sources;
}

/**
 * Whether a merge command is the MERGE gate (MACLEOD-574).
 *
 * `gh pr merge` always is: a pull request merging is the gate, whoever
 * ran it.
 *
 * `git merge` is decided by what it was asked to merge IN, not by the
 * branch it is standing on. Every team's first command in a worktree is
 * `git merge main --no-edit`, which is a sync — it brings the branch up
 * to date before any work is done — and reading it as the gate moved six
 * tickets to Merge/success seconds after their teams started, before an
 * edit had been made. A merge whose sources are all the trunk, or
 * `origin/<trunk>`, is that sync; anything else is the gate.
 *
 * The argument is the right thing to read and not merely the cheap one.
 * It needs no `git branch --show-current`, so a detached HEAD is not a
 * false MERGE and a repository whose trunk is `master` is not a silent
 * non-report; and where `defaultBranchName` guesses wrong the worst it
 * can do is mislabel `git merge main` in a repository where nobody types
 * that. A merge with no ref at all — `git merge` alone, or `FETCH_HEAD` —
 * cannot be shown to be a sync, so it stays the gate.
 */
export function isMergeGate(command, cwd = undefined, config = {}) {
  if (PR_MERGE_RE.test(command)) return true;
  if (!GIT_MERGE_RE.test(command)) return false;
  if (GIT_MERGE_HOUSEKEEPING_RE.test(command)) return false;
  const sources = mergeSources(command);
  if (!sources.length) return true;
  const trunks = new Set(TRUNK_NAMES);
  if (config.defaultBranch) trunks.add(String(config.defaultBranch));
  // Only asked when a merge command has actually been seen, which is
  // rare, and only ever of the local repository.
  if (cwd) trunks.add(defaultBranchName(cwd, config));
  return !sources.every((ref) => isTrunkRef(ref, trunks));
}

/** The remotes whose `<remote>/main` means the same branch as `main`. */
const REMOTE_NAMES = ['origin', 'upstream'];

/**
 * `main`, `origin/main`, `refs/remotes/origin/main` — the same branch.
 *
 * Only a leading segment that is actually a remote's name is stripped,
 * so a work branch called `feature/main` stays a work branch rather than
 * becoming a sync nobody reports.
 */
function isTrunkRef(ref, trunks) {
  let name = String(ref).replace(/^refs\/(?:heads|remotes)\//, '');
  const slash = name.indexOf('/');
  if (slash > 0 && REMOTE_NAMES.includes(name.slice(0, slash))) name = name.slice(slash + 1);
  return trunks.has(name);
}

/**
 * { branch, head, commitsSinceMain, ahead, behind, pushed, dirty }, or
 * undefined outside a repository. Local git only, so it is cheap enough
 * to refresh on every report.
 */
export function gitSnapshot(cwd, info = {}, config = {}) {
  const branch = info.branch || git(cwd, ['branch', '--show-current']).stdout || undefined;
  const sha = info.commit || git(cwd, ['rev-parse', '--short=12', 'HEAD']).stdout || undefined;
  if (!branch && !sha) return undefined;

  const base = defaultBranchName(cwd, config);
  // The default branch as the remote has it, falling back to the local
  // one in a clone that has never fetched.
  const counted = [`origin/${base}`, base]
    .map((ref) => git(cwd, ['rev-list', '--count', `${ref}..HEAD`]))
    .find((result) => result.ok && /^\d+$/.test(result.stdout));
  // `--left-right` counts the upstream side first, so behind comes
  // before ahead. A branch with no upstream has neither, and is not
  // pushed by definition.
  const tracking = git(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
  const [behind, ahead] = tracking.ok && /^\d+\s+\d+$/.test(tracking.stdout)
    ? tracking.stdout.split(/\s+/).map(Number)
    : [undefined, undefined];
  const subject = git(cwd, ['log', '-1', '--pretty=%s']).stdout || undefined;

  return {
    branch,
    head: sha ? { sha, subject: subject?.slice(0, 120) } : undefined,
    commitsSinceMain: counted ? Number(counted.stdout) : undefined,
    ahead,
    behind,
    pushed: ahead === undefined ? false : ahead === 0,
    dirty: Boolean(git(cwd, ['status', '--porcelain']).stdout),
  };
}

// gh's CheckRun reports `conclusion` once `status` is COMPLETED; its
// StatusContext reports `state` and has no status at all. Anything
// still running, queued or unrecognised counts as pending, because a
// check nobody can classify has not passed.
const CHECK_PASSING = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const CHECK_FAILING = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);

function checkCounts(rollup) {
  const counts = { passing: 0, failing: 0, pending: 0 };
  for (const run of Array.isArray(rollup) ? rollup : []) {
    const verdict = String(run?.conclusion || run?.state || '').toUpperCase();
    const status = String(run?.status || '').toUpperCase();
    if (status && status !== 'COMPLETED') counts.pending += 1;
    else if (CHECK_FAILING.has(verdict)) counts.failing += 1;
    else if (CHECK_PASSING.has(verdict)) counts.passing += 1;
    else counts.pending += 1;
  }
  return counts;
}

function prState(pr) {
  const state = String(pr.state || '').toUpperCase();
  if (state === 'MERGED') return 'merged';
  if (state === 'CLOSED') return 'closed';
  return pr.isDraft ? 'draft' : 'open';
}

// `mergeable` is the API's own three-way answer; `mergeStateStatus`
// DIRTY is the same news arriving by a different route, and either one
// is enough to say the branch conflicts.
function prMergeable(pr) {
  const mergeable = String(pr.mergeable || '').toUpperCase();
  if (mergeable === 'CONFLICTING' || String(pr.mergeStateStatus || '').toUpperCase() === 'DIRTY') return 'conflicting';
  return mergeable === 'MERGEABLE' ? 'clean' : 'unknown';
}

function prReview(decision) {
  const value = String(decision || '').toUpperCase();
  if (value === 'APPROVED') return 'approved';
  if (value === 'CHANGES_REQUESTED') return 'changes_requested';
  return value === 'REVIEW_REQUIRED' ? 'pending' : 'none';
}

const PR_FIELDS = 'number,url,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision';

/**
 * { number, url, state, mergeable, checks, review } for the branch's
 * pull request, or undefined.
 *
 * Undefined covers every way there is not one to report: no `gh`, `gh`
 * not authenticated, no PR for this branch, not a GitHub remote, not a
 * repository. None of them is a problem a report should carry, and none
 * of them may interrupt a hook, so the failure is silent.
 */
export function prSnapshot(cwd, config = {}) {
  const result = safeExec(process.env.TEAMFLOW_GH_BIN || 'gh',
    ['pr', 'view', '--json', PR_FIELDS],
    { cwd, timeout: Number(config.lookupTimeoutMs || 5000) });
  if (!result.ok) return undefined;
  let pr;
  try { pr = JSON.parse(result.stdout); } catch { return undefined; }
  if (!pr || typeof pr !== 'object' || !Number.isInteger(Number(pr.number))) return undefined;
  return {
    number: Number(pr.number),
    url: /^https?:\/\//i.test(pr.url || '') ? pr.url : undefined,
    state: prState(pr),
    mergeable: prMergeable(pr),
    checks: checkCounts(pr.statusCheckRollup),
    review: prReview(pr.reviewDecision),
  };
}

/**
 * Put both blocks on the session before the report is built.
 *
 * The git half is local and refreshed every time. The PR half is a
 * round trip to GitHub, and a hook fires on every tool call, so it is
 * refreshed at most every `prRefreshMs` — unless the caller forces it,
 * which `publishState` does on Stop and on `/teamflow:sync`. That is
 * what moves a PR from "checks pending" to "approved" on the board
 * without anybody editing a file.
 */
export function refreshDelivery(state, config = {}, info = {}, { force = false, skipGit = false } = {}) {
  /*
   * `skipGit` is for flushing somebody else's actor (MACLEOD-574, audit
   * finding B, ruling 4): a `Stop` hook may not run git against a
   * directory the current session has nothing to do with, so the flush
   * reports what that actor last recorded rather than looking again.
   */
  if (skipGit) return state;
  const cwd = state.cwd || process.cwd();
  state.git = gitSnapshot(cwd, info, config);
  const ttl = Number(config.prRefreshMs ?? 30000);
  if (!force && state.prCheckedAt && Date.now() - state.prCheckedAt < ttl) return state;
  state.prCheckedAt = Date.now();
  state.pr = prSnapshot(cwd, config);
  return state;
}

export function actor(config, info) {
  const fallback = info.email?.split('@')[0] || info.name || os.userInfo().username;
  const id = String(config.actorId || fallback || 'unknown').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return { id, displayName: String(config.actorName || info.name || fallback || id) };
}

export function candidate(key, confidence, source, ref = {}) {
  const normalized = normalizeIssueKey(key);
  if (!normalized) return undefined;
  const out = { key: normalized, confidence, source, tracker: ref.tracker || 'jira' };
  if (ref.boundAt) out.boundAt = ref.boundAt;
  if (ref.repo) out.repo = ref.repo;
  if (ref.workspace) out.workspace = ref.workspace;
  return out;
}

// Pure half of detectCandidates: git and disk stay in the caller so detection is testable.
// `known` is the prefix set the branch and the commit message are checked against
// (knownPrefixes); the caller builds it because two of its three sources are on disk.
export function issueCandidates(input = {}, info = {}, manual = undefined, config = {}, known = undefined) {
  const tracker = trackerOf(config);
  const tool = input.tool_name || '';
  const command = commandOf(input);
  const candidates = [];
  const add = (ref, confidence, source) => {
    const item = ref?.key ? candidate(ref.key, confidence, source, ref) : undefined;
    if (item) candidates.push(item);
  };

  // `manual` is either one binding file or the pair [local, user]. Both
  // are the same kind of statement, so they are resolved to one before
  // becoming a candidate: two manual candidates would make confidence
  // decide between them, and confidence knows nothing about which was
  // written last.
  const bound = Array.isArray(manual) ? preferBinding(manual[0], manual[1]) : manual;
  if (bound?.jiraKey) {
    // boundAt travels with the candidate: it is how a `teamflow bind` run
    // after this session started outranks the sticky binding the session
    // already holds (see chooseBinding).
    add({ key: bound.jiraKey, tracker: bound.tracker || tracker, repo: bound.repo, workspace: bound.workspace, boundAt: bound.boundAt }, 1000, 'manual');
  }
  add(detectIssueRef(input.prompt, config, info), 100, 'prompt');
  add(detectIssueRef(input.task_subject, config, info), 98, 'task');
  // The two sources nobody wrote to name a ticket, and the two the prefix rule
  // guards: a dependency bump's branch and its commit message say `express-6.9.21`
  // and mean a package version (MACLEOD-536).
  add(
    detectIssueRef(info.branch, config, info, known) || (tracker === 'github' ? detectGithubBranch(info.branch, config, info) : undefined),
    95,
    'branch',
  );
  add(detectIssueRef(info.lastMessage, config, info, known), 80, 'commit');

  if (/atlassian|jira/i.test(tool)) {
    add(toolRef(input.tool_input, 'jira', config, info), 110, 'atlassian-tool');
    add(toolRef(input.tool_response, 'jira', config, info), 110, 'atlassian-result');
  }
  if (/linear/i.test(tool)) {
    add(toolRef(input.tool_input, 'linear', config, info), 110, 'linear-tool');
    add(toolRef(input.tool_response, 'linear', config, info), 110, 'linear-result');
  }
  if (/github/i.test(tool)) {
    add(toolRef(input.tool_input, 'github', config, info), 110, 'github-tool');
    add(toolRef(input.tool_response, 'github', config, info), 110, 'github-result');
  }
  if (tool === 'Bash') add(detectGithubCommand(command, config, info), 110, 'gh-command');
  return candidates;
}

export function detectCandidates(input, cwd, state = {}, config = {}) {
  const info = gitInfo(cwd);
  const manual = [readJson(localBindingPath(cwd)), readJson(projectBindingPath(cwd, config))];
  // The disk half of the prefix rule: what has been bound, here and in this
  // session, and the tickets of the runs this machine holds. One file read each,
  // beside the two binding reads above.
  const seen = [state.binding?.key, ...manual.map((one) => one?.jiraKey)];
  try {
    for (const workflow of Object.values(readWorkflows(config).workflows)) {
      for (const ticket of workflow.tickets || []) seen.push(ticket.key);
    }
  } catch { /* a workflows file that cannot be read teaches nothing, and breaks nothing */ }
  const candidates = issueCandidates(input, info, manual, config, knownPrefixes(config, seen));
  if (state.binding?.key) {
    const session = candidate(state.binding.key, state.binding.confidence || 1, state.binding.source || 'session', state.binding);
    if (session) candidates.push(session);
  }
  return { candidates, info };
}

export function chooseBinding(state, candidates) {
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const best = sorted[0];
  if (!best) return state.binding;
  if (!state.binding) return { ...best, sticky: false };
  if (state.binding.key === best.key) {
    return { ...state.binding, confidence: Math.max(state.binding.confidence || 0, best.confidence), source: best.confidence > (state.binding.confidence || 0) ? best.source : state.binding.source };
  }
  // An explicit `teamflow bind` made after this session's binding was
  // chosen is the newest word from a person, and it wins over a sticky
  // binding of equal confidence. Without this a session bound at start
  // kept its first ticket all day while every later bind landed only in
  // the project file: a day of work reported under one stale key.
  if (best.source === 'manual' && (best.boundAt || '') > (state.binding.boundAt || '')) {
    return { ...best, sticky: true };
  }
  if (state.binding.sticky && best.confidence < 1000) return state.binding;
  if (best.confidence > (state.binding.confidence || 0)) return { ...best, sticky: false };
  return state.binding;
}

// --- title and status from a tool result -----------------------------
//
// A bound ticket should not need a hand-written report to get its name
// onto the board. The agent has usually just looked the issue up —
// through the Atlassian MCP, the Linear MCP, a GitHub MCP tool or
// `gh issue view` — and that result already carries the two fields the
// board wants.
//
// The three trackers agree on nothing: Jira says `summary` and wraps
// status in an object, Linear says `title` and wraps state in a
// different object, GitHub says `title` and a bare `state`, and `gh`
// prints tab-separated fields. So there is one seam,
// `enrichFromToolResult(tracker, result)`, and one small parser behind
// it per tracker. A fourth tracker is a fourth parser and nothing else.
//
// docs/REPORTING_CONTRACT.md is the hard limit: the issue key, its
// link, a short title and a short status. No parser reads a body, a
// description or a comment, and the `gh` text parser stops at the `--`
// separator for exactly that reason.

function stringField(obj, names) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const name of names) {
    if (typeof obj[name] === 'string' && obj[name].trim()) return obj[name].trim();
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = stringField(value, names);
      if (found) return found;
    }
  }
  return undefined;
}

// A status arrives either as a string ("In Progress", "OPEN") or as the
// object each of these APIs wraps it in ({ name: 'In Progress' }).
function labelField(obj, names) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const name of names) {
    const value = obj[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object') {
      const label = stringField(value, ['name', 'label', 'displayName', 'title']);
      if (label) return label;
    }
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = labelField(value, names);
      if (found) return found;
    }
  }
  return undefined;
}

function numberField(obj, names) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const name of names) {
    const value = obj[name];
    if (typeof value === 'number' && Number.isInteger(value)) return String(value);
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return value.trim();
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const found = numberField(value, names);
      if (found) return found;
    }
  }
  return undefined;
}

function parseJsonish(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// A tool result is an object from an MCP server, a JSON string, or the
// plain text a shell command printed — sometimes wrapped in `stdout`.
function payloads(result) {
  if (typeof result === 'string') return { object: parseJsonish(result), text: result };
  if (result && typeof result === 'object') {
    const stdout = typeof result.stdout === 'string' ? result.stdout : undefined;
    return { object: parseJsonish(stdout) || result, text: stdout };
  }
  return {};
}

function jiraIssue(result) {
  const { object } = payloads(result);
  if (!object) return undefined;
  return {
    key: extractJiraKey(JSON.stringify(object)),
    title: stringField(object, ['summary', 'title', 'name']),
    status: labelField(object, ['statusName', 'status', 'state']),
    url: stringField(object, ['browseUrl', 'webUrl', 'url']),
    parentKey: extractJiraKey(stringField(object, ['parentKey', 'parent']) || ''),
  };
}

function linearIssue(result) {
  const { object } = payloads(result);
  if (!object) return undefined;
  const text = JSON.stringify(object);
  const fromUrl = text.match(LINEAR_URL_RE);
  return {
    key: extractJiraKey(stringField(object, ['identifier', 'key']) || '')
      || (fromUrl ? fromUrl[2].toUpperCase() : extractJiraKey(text)),
    title: stringField(object, ['title', 'name']),
    status: labelField(object, ['state', 'status', 'stateName']),
    url: stringField(object, ['url', 'issueUrl', 'webUrl']),
  };
}

// `gh issue view <n>` with no --json prints tab-separated fields and
// then `--` and the body. Everything from the separator on is the
// issue description, which is not ours to read or to send.
function githubText(text) {
  const head = String(text).split(/^--$/m)[0];
  const field = (name) => head.match(new RegExp(`^${name}:\\t(.*)$`, 'mi'))?.[1]?.trim() || undefined;
  const title = field('title');
  const status = field('state');
  if (!title && !status) return undefined;
  return { title, status, number: field('number') };
}

function githubIssue(result) {
  const { object, text } = payloads(result);
  if (object) {
    const json = JSON.stringify(object);
    const fromUrl = json.match(GITHUB_URL_RE);
    const found = {
      key: fromUrl ? `${fromUrl[2].toLowerCase()}#${fromUrl[3]}` : undefined,
      number: fromUrl?.[3] || numberField(object, ['number', 'issueNumber', 'issue_number']),
      title: stringField(object, ['title']),
      status: labelField(object, ['state', 'status']),
      url: stringField(object, ['html_url', 'htmlUrl', 'url', 'webUrl']),
    };
    if (found.title || found.status) return found;
  }
  return text ? githubText(text) : undefined;
}

// One parser per tracker, and the seam every caller goes through.
export const TRACKER_PARSERS = { jira: jiraIssue, linear: linearIssue, github: githubIssue };

export function enrichFromToolResult(tracker, result) {
  const parse = TRACKER_PARSERS[tracker];
  if (!parse || result === undefined || result === null) return undefined;
  const found = parse(result);
  if (!found) return undefined;
  const fields = {
    key: found.key,
    number: found.number,
    title: found.title?.slice(0, 180),
    status: found.status?.slice(0, 80),
    url: /^https?:\/\//i.test(found.url || '') ? found.url : undefined,
    parentKeys: found.parentKey ? [found.parentKey] : undefined,
  };
  return fields.title || fields.status || fields.url ? fields : undefined;
}

// Which tracker just answered. The tool's own name says it, except for
// `gh issue view`, which arrives as a Bash command like any other.
export function toolTracker(input = {}) {
  const tool = input.tool_name || '';
  if (/atlassian|jira/i.test(tool)) return 'jira';
  if (/linear/i.test(tool)) return 'linear';
  if (/github/i.test(tool)) return 'github';
  if (tool === 'Bash' && GH_ISSUE_RE.test(commandOf(input))) return 'github';
  return undefined;
}

// Enrichment only ever describes the ticket already bound. A result
// about some other issue is somebody else's ticket and is dropped: a
// wrong title on the board is worse than no title.
function sameIssue(binding, fields) {
  if (!binding?.key) return false;
  if (fields.key) return fields.key === binding.key;
  // `gh` names the issue by number; the canonical key is <repo>#<n>.
  return Boolean(fields.number && binding.key.endsWith(`#${fields.number}`));
}

export function enrichBinding(state, input) {
  const tracker = toolTracker(input);
  if (!tracker) return state;
  const fields = enrichFromToolResult(tracker, input.tool_response);
  if (!fields || !sameIssue(state.binding, fields)) return state;
  const previous = state.jira || {};
  return {
    ...state,
    jira: {
      ...previous,
      key: state.binding.key,
      title: fields.title || previous.title,
      status: fields.status || previous.status,
      url: fields.url || previous.url,
      parentKeys: fields.parentKeys || previous.parentKeys,
    },
  };
}

// --- resolving a title the hooks never saw ---------------------------
//
// A card that says only "teamflow#17 · Local tests passed" is a card
// nobody recognises. The title usually arrives through
// enrichFromToolResult, from a tool result the hooks already see — but
// only if the agent happened to look the issue up. When it did not, one
// lookup fills the gap, and the answer is cached on the binding so no
// second report ever asks.
//
// GitHub is the only tracker asked directly, and with no credential of
// TeamFlow's own: `gh` when the developer has it (already authenticated,
// so private repositories work), otherwise the public REST endpoint,
// which answers for public repositories and is allowed to fail in
// silence for everything else. Jira and Linear have no such path —
// adding one would mean asking for an API token this plugin has never
// needed — so their titles keep coming from tool results.
//
// Two environment variables exist for the tests: TEAMFLOW_GH_BIN points
// `gh` at a stub and TEAMFLOW_GITHUB_API points the fallback somewhere
// that is not github.com. Nothing in a test may reach either.

function githubApiBase() {
  return String(process.env.TEAMFLOW_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
}

async function lookupGithubIssue(repo, number, config = {}) {
  const gh = safeExec(process.env.TEAMFLOW_GH_BIN || 'gh',
    ['issue', 'view', String(number), '--repo', repo, '--json', 'title,state'],
    { timeout: Number(config.lookupTimeoutMs || 5000) });
  if (gh.ok) {
    const found = enrichFromToolResult('github', gh.stdout);
    if (found?.title) return found;
  }
  try {
    const response = await fetch(`${githubApiBase()}/repos/${repo}/issues/${number}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'teamflow-plugin' },
      signal: AbortSignal.timeout(Number(config.lookupTimeoutMs || 5000)),
    });
    if (!response.ok) return undefined;
    return enrichFromToolResult('github', await response.json());
  } catch {
    // Offline, rate limited, private, or no such issue. A missing title
    // is a plain card; a thrown error would be a broken hook.
    return undefined;
  }
}

// { title, status, url } for the bound issue, or undefined. Never throws.
export async function resolveIssueTitle(binding = {}, config = {}, info = {}) {
  if (!binding.key) return undefined;
  const tracker = binding.tracker || trackerOf(config);
  if (tracker !== 'github') return undefined;
  const number = String(binding.key).split('#')[1];
  const repo = binding.repo || resolveGithubRepo(config, info);
  if (!number || !repo) return undefined;
  return lookupGithubIssue(repo, number, config);
}

/**
 * The binding file is the cache. `teamflow bind` fills it, a report
 * reads it, and a lookup that had to go out writes it back — including
 * when it found nothing, so a private repository is asked once and not
 * once per report.
 *
 * The file is only ever updated, never created: creating it here would
 * turn an automatically detected key into a manual, sticky binding that
 * nobody asked for.
 */
export async function cachedIssueTitle(ref, cwd, config = {}, info = {}) {
  // Two files can hold a binding; the cache is whichever one names this
  // key, local first, because a worktree's own binding is the one the
  // report is being written for.
  const files = [localBindingPath(cwd), projectBindingPath(cwd, config)];
  const file = files.find((candidateFile) => readJson(candidateFile)?.jiraKey === ref.key) || files[1];
  const cached = readJson(file);
  const isCache = cached?.jiraKey === ref.key;
  if (isCache && (cached.title || cached.titleLookedUp)) {
    return cached.title ? { title: cached.title, status: cached.status } : undefined;
  }
  const found = await resolveIssueTitle(ref, config, info);
  if (isCache) {
    writeJson(file, {
      ...cached,
      title: found?.title || cached.title,
      status: found?.status || cached.status,
      titleLookedUp: true,
    });
  }
  return found;
}

/**
 * Give `state.jira` a title before the report goes out, at most one
 * lookup per bound key per session. Mutates and returns whether it
 * changed anything, because publishState is the only caller and it
 * already owns saving the session.
 */
export async function ensureIssueTitle(state, config = {}, info = {}) {
  const key = state.binding?.key;
  if (!key) return false;
  if (state.jira?.key === key && state.jira.title) return false;
  if (state.titleLookedUpFor === key) return false;
  state.titleLookedUpFor = key;
  const found = await cachedIssueTitle(state.binding, state.cwd || process.cwd(), config, info);
  if (!found?.title && !found?.status) return false;
  state.jira = {
    ...(state.jira || {}),
    key,
    title: found.title || state.jira?.title,
    status: found.status || state.jira?.status,
  };
  return true;
}

export function extractTestEvidence(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  const evidence = [];
  const passed = text.match(/(\d+)\s+(?:passed|passing)\b/i);
  const failed = text.match(/(\d+)\s+(?:failed|failing)\b/i);
  if (passed) evidence.push({ label: 'passed', value: passed[1], status: 'success' });
  if (failed) evidence.push({ label: 'failed', value: failed[1], status: Number(failed[1]) > 0 ? 'failed' : 'success' });
  return evidence.slice(0, 4);
}

function commandOf(input) {
  return typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
}

export function classifyTool(input, state, config) {
  const event = input.hook_event_name;
  const tool = input.tool_name || '';
  const command = commandOf(input);
  const failed = event === 'PostToolUseFailure';
  const customDevTest = config.devTestPattern ? new RegExp(config.devTestPattern, 'i') : undefined;
  const customLocalAudit = config.localAuditPattern ? new RegExp(config.localAuditPattern, 'i') : undefined;
  const customDevAudit = config.devAuditPattern ? new RegExp(config.devAuditPattern, 'i') : undefined;
  const isDevAudit = DEV_AUDIT_RE.test(command) || Boolean(customDevAudit?.test(command));
  const isLocalAudit = !isDevAudit && (LOCAL_AUDIT_RE.test(command) || Boolean(customLocalAudit?.test(command)));
  const isDevTest = DEV_TEST_RE.test(command) || Boolean(customDevTest?.test(command));
  // A repository whose suite is not `npm test` or `pytest` names it in
  // `.teamflow.json` as `testCommand`. The git pre-push fallback runs
  // exactly that command, so matching it literally is what lets a
  // `make check` project report LOCAL_TEST at all.
  const isLocalTest = TEST_RE.test(command)
    || Boolean(config.testCommand && command.includes(String(config.testCommand).trim()));

  if (event === 'SubagentStart') return { summary: 'Subagent started', heartbeat: true };
  if (event === 'SubagentStop') return { summary: 'Subagent finished', heartbeat: true };
  if (event === 'TaskCompleted') return { summary: state.summary || 'Task completed', heartbeat: true };

  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    /*
     * No clearRework. Editing a file is where a ticket goes *because* a gate
     * failed, so clearing the attribution here wiped the reason within seconds
     * of the failure and left a card sitting back in Local Dev saying nothing
     * about why. The gate clears its own rework by passing again.
     */
    return {
      stage: 'LOCAL_DEV',
      status: failed ? 'failed' : 'running',
      summary: failed ? 'Code edit failed' : 'Implementing locally',
      sticky: true,
    };
  }

  if (/github/i.test(tool) && /merge/i.test(tool)) {
    return failed
      ? { stage: 'LOCAL_REWORK', status: 'failed', summary: 'Merge failed', incrementLoop: true, reworkFrom: 'MERGE', sticky: true }
      : { stage: 'MERGE', status: 'success', summary: 'Merged', sticky: true, clearRework: true };
  }

  if (tool !== 'Bash') return undefined;

  if (isDevAudit) {
    return failed
      ? { stage: 'DEV_REWORK', status: 'failed', summary: 'Dev audit failed', incrementLoop: true, reworkFrom: 'DEV_AUDIT', evidence: extractTestEvidence(input.tool_response || input.error), sticky: true }
      : { stage: 'DEV_VERIFIED', status: 'success', summary: 'Dev audit passed; verified', evidence: extractTestEvidence(input.tool_response), sticky: true, clearRework: true };
  }

  if (isLocalAudit) {
    return failed
      ? { stage: 'LOCAL_REWORK', status: 'failed', summary: 'Local audit failed', incrementLoop: true, reworkFrom: 'LOCAL_AUDIT', evidence: extractTestEvidence(input.tool_response || input.error), sticky: true }
      : { stage: 'LOCAL_AUDIT', status: 'success', summary: 'Local audit passed', evidence: extractTestEvidence(input.tool_response), sticky: true, clearRework: true };
  }

  if (isDevTest) {
    return failed
      ? { stage: 'DEV_REWORK', status: 'failed', summary: 'Dev tests failed', incrementLoop: true, reworkFrom: 'DEV_TEST', evidence: extractTestEvidence(input.tool_response || input.error), sticky: true }
      : { stage: 'DEV_TEST', status: 'success', summary: 'Dev tests passed; awaiting audit', evidence: extractTestEvidence(input.tool_response), sticky: true, clearRework: true };
  }

  if (DEPLOY_RE.test(command)) {
    return failed
      ? { stage: 'DEV_REWORK', status: 'failed', summary: 'Dev deployment failed', incrementLoop: true, reworkFrom: 'DEPLOY_DEV', sticky: true }
      : { stage: 'DEPLOY_DEV', status: 'success', summary: 'Deployed to dev', sticky: true, clearRework: true };
  }

  // MACLEOD-574. A merge command that is not the gate — `git merge main`
  // inside a work branch, `git merge --abort` — falls through rather
  // than returning: it is a sync, it is not sticky, and it moves nothing.
  if (MERGE_RE.test(command) && isMergeGate(command, input.cwd, config)) {
    return failed
      ? { stage: 'LOCAL_REWORK', status: 'failed', summary: 'Merge failed', incrementLoop: true, reworkFrom: 'MERGE', sticky: true }
      : { stage: 'MERGE', status: 'success', summary: 'Merged', sticky: true, clearRework: true };
  }

  if (PR_RE.test(command)) {
    return { stage: 'MERGE', status: failed ? 'failed' : 'waiting', summary: failed ? 'PR operation failed' : 'PR ready for merge', sticky: true, reworkFrom: failed ? 'MERGE' : undefined };
  }

  if (isLocalTest) {
    return failed
      ? { stage: 'LOCAL_REWORK', status: 'failed', summary: 'Local tests failed', incrementLoop: true, reworkFrom: 'LOCAL_TEST', evidence: extractTestEvidence(input.tool_response || input.error), sticky: true }
      : { stage: 'LOCAL_TEST', status: 'success', summary: 'Local tests passed; awaiting audit', evidence: extractTestEvidence(input.tool_response), sticky: true, clearRework: true };
  }

  if (BUILD_RE.test(command)) {
    return failed
      ? { stage: 'LOCAL_REWORK', status: 'failed', summary: 'Local build failed', incrementLoop: true, reworkFrom: 'LOCAL_TEST', sticky: true }
      : { stage: 'LOCAL_TEST', status: 'success', summary: 'Local build passed', sticky: true, clearRework: true };
  }
  return undefined;
}

/*
 * Whether this transition closes the loop the ticket is in.
 *
 * `clearRework` says a gate passed; it does not say *which*. A local test suite
 * going green tells nobody anything about the dev audit that sent the ticket
 * back, so a clear only counts from the failed gate onwards.
 */
function clearsRework(state, transition) {
  if (!transition.clearRework) return false;
  if (!state.reworkFrom) return true;
  return stageRank(transition.stage) >= stageRank(state.reworkFrom);
}

export function applyTransition(state, transition) {
  if (!transition) return state;
  const cleared = clearsRework(state, transition);
  const updatedAt = new Date().toISOString();
  const evidence = transition.evidence?.length ? transition.evidence : state.evidence;
  return {
    ...state,
    stage: transition.stage || state.stage,
    status: transition.status || state.status,
    summary: transition.summary || state.summary,
    loopCount: (state.loopCount || 0) + (transition.incrementLoop ? 1 : 0),
    evidence,
    reworkFrom: cleared ? undefined : (transition.reworkFrom || state.reworkFrom),
    /*
     * The gate's own run, remembered so the report can carry it. The dashboard
     * draws the arrow from this step and labels it with what the step said, and
     * a later report that only describes the editing would otherwise have lost it.
     */
    rework: cleared ? undefined : (transition.reworkFrom
      ? {
        stage: transition.reworkFrom,
        label: GATE_LABELS[transition.reworkFrom] || transition.reworkFrom,
        summary: transition.summary,
        evidence: transition.evidence || [],
        updatedAt,
      }
      : state.rework),
    binding: state.binding ? { ...state.binding, sticky: transition.sticky ? true : state.binding.sticky } : state.binding,
    updatedAt,
  };
}

// jiraKey / jiraUrl / jiraStatus keep their names for the dashboard and existing S3 objects.
export function issueUrl(key, tracker = 'jira', config = {}, info = {}, binding = {}) {
  // An ad hoc item has no tracker to link to, because TeamFlow is its
  // system of record: the link is its own card on the board.
  if (tracker === 'teamflow') return `${serviceUrl(config)}/app/#delivery?issue=${encodeURIComponent(key)}`;
  if (tracker === 'linear') {
    const workspace = binding.workspace || config.linearWorkspace;
    return workspace ? `https://linear.app/${workspace}/issue/${key}` : undefined;
  }
  if (tracker === 'github') {
    const [name, number] = String(key).split('#');
    if (!number) return undefined;
    let repo = binding.repo;
    if (!repo) {
      const resolved = resolveGithubRepo(config, info);
      repo = resolved ? `${resolved.split('/')[0]}/${name}` : undefined;
    }
    return repo ? `https://github.com/${repo}/issues/${number}` : undefined;
  }
  const jiraBase = String(config.jiraBaseUrl || '').replace(/\/$/, '');
  return jiraBase ? `${jiraBase}/browse/${key}` : undefined;
}

export function issueProject(key, tracker = 'jira') {
  return tracker === 'github' ? String(key).split('#')[0] : String(key).split('-')[0];
}

// --- what is reporting (MACLEOD-532) -------------------------------
//
// The dashboard's plugin pill used to be the words "Plugin connected",
// hardcoded, which was true of a tenant nothing had ever reported to.
// The report now says which tool sent it and which plugin version did,
// and the pill reads that back.
//
// Derived state, like everything else on a report: a tool's name from
// the capability table and this package's version. Nothing about the
// machine, the path or the person. `adapters/teamflow/schema.py`
// accepts exactly those two fields and drops anything else.

let cachedVersion;

/**
 * This plugin's version, read from the manifest beside these scripts.
 *
 * At runtime rather than stamped at build: the plugin is installed by
 * copying this directory, and a stamped constant would report whatever
 * the last publish said rather than what is actually running.
 * `undefined` when the manifest cannot be read, which is honest — the
 * dashboard draws "version unknown" rather than a guess.
 */
export function pluginVersion() {
  if (cachedVersion !== undefined) return cachedVersion || undefined;
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    const manifest = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
    cachedVersion = typeof manifest.version === 'string' ? manifest.version : '';
  } catch {
    cachedVersion = '';
  }
  return cachedVersion || undefined;
}

// --- is this the build that is installed? (MACLEOD-538) -------------
//
// Claude Code loads plugin code when a session starts. A session that
// began before an upgrade keeps running the old build all day, and the
// board keeps showing yesterday's behaviour with nothing saying why.
// That happened here on 2026-09-18: hooks reported every piece of work
// under the ticket the session opened with, while `teamflow status` in
// the same repository named the right one. Two fixes that would have
// corrected it were installed and not running.
//
// An install is a directory named for its version, so the other builds
// on this machine are this one's siblings. Nothing is fetched and no
// registry is asked; if the layout is not that -- a checkout, a copy
// somewhere else -- the answer is "cannot tell", which is honest.

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/;

export function compareVersions(a, b) {
  const left = SEMVER.exec(String(a));
  const right = SEMVER.exec(String(b));
  if (!left || !right) return 0;
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(left[i]) - Number(right[i]);
    if (diff) return diff < 0 ? -1 : 1;
  }
  // A prerelease sorts before the release of the same numbers, so an
  // installed 0.4.0 beats a running 0.4.0-rc1 and says so.
  const pre = (v) => (String(v).includes('-') ? 0 : 1);
  return pre(a) - pre(b);
}

export function newestInstalled(from = path.dirname(new URL(import.meta.url).pathname)) {
  try {
    const here = path.dirname(from);            // .../<version>/
    const mine = path.basename(here);
    if (!SEMVER.test(mine)) return undefined;   // a checkout, not an install
    const versions = fs.readdirSync(path.dirname(here))
      .filter((name) => SEMVER.test(name));
    if (!versions.length) return undefined;
    return versions.sort(compareVersions)[versions.length - 1];
  } catch {
    return undefined;
  }
}

/**
 * `{ running, newest }` when an older build is the one in memory.
 *
 * `undefined` means either that this is the newest build or that the
 * question cannot be answered, and those are deliberately the same
 * answer to a caller: a warning nobody can act on is noise, and this
 * one is printed into a hook's context where noise is expensive.
 */
export function staleBuild(running = pluginVersion(), newest = newestInstalled()) {
  if (!running || !newest) return undefined;
  return compareVersions(running, newest) < 0 ? { running, newest } : undefined;
}

/** The one sentence, or nothing. */
export function staleBuildNotice(stale = staleBuild()) {
  if (!stale) return undefined;
  return `TeamFlow ${stale.running} is running; ${stale.newest} is installed. `
    + 'Run /reload-plugins so this session reports what it should.';
}

// The one id that is not a tool. A repository whose editor has no hook
// system reports on commit, merge and push instead, and "git" on
// somebody's dashboard would read as a tracker rather than as the
// fallback it is.
const REPORTER_NAMES = { git: 'Git hooks' };

/**
 * `{ tool, version }` for the tool this hook is running in.
 *
 * The name comes from `tools.mjs`, which is already the one place
 * TeamFlow keeps a tool's display name, so a tool renamed there is
 * renamed on every board with no edit here. An id the table has never
 * heard of reports as itself: a wrong name is worse than an unfamiliar
 * one, and it makes the gap visible.
 */
export function reporterInfo(tool = 'claude-code') {
  const id = String(tool || 'claude-code');
  const known = TOOL_CAPABILITIES.find((entry) => entry.id === id);
  const name = known?.name || REPORTER_NAMES[id] || id;
  const version = pluginVersion();
  const reporter = { tool: name.slice(0, 80) };
  if (version) reporter.version = String(version).slice(0, 40);
  return reporter;
}

/**
 * The execution id for one actor. `claude-<session>` for the session
 * itself — unchanged, so a board that already holds it keeps one card —
 * and `claude-<session>-<agent>` for each agent under it.
 */
export function executionId(state = {}) {
  const base = `claude-${state.sessionId}`;
  return state.agentKey ? `${base}-${actorSlug(state.agentKey)}`.slice(0, 80) : base;
}

/**
 * Who the agent is, on the wire (MACLEOD-574).
 *
 * A name, a one-line task, a type and the session it belongs to: short
 * labels of exactly the class `docs/REPORTING_CONTRACT.md` already
 * allows for a workflow's name, capped the same way and sanitised
 * through the same helper. The prompt it was launched with, the
 * messages it wrote and its transcript are none of them here and never
 * leave the machine.
 */
export function agentBlock(state = {}) {
  const agent = state.agent || {};
  const block = {
    id: String(agent.id || state.agentKey || 'agent').slice(0, 80),
    name: agentLabel(agent.name, 64) || 'Agent',
  };
  const task = agentLabel(agent.task, 80);
  const type = agentLabel(agent.type, 40);
  if (task) block.task = task;
  if (type) block.type = type;
  /*
   * The session this agent runs under, as the same digest `session.id`
   * carries — so the board joins on one value, and so this field is not
   * the raw `session_id` sitting immediately beside a field that is
   * hashed precisely to avoid carrying it (audit finding 7).
   */
  if (agent.parent) block.parent = digest(agent.parent);
  if (agent.startedAt) block.startedAt = agent.startedAt;
  if (agent.endedAt) block.endedAt = agent.endedAt;
  return block;
}

/**
 * Which session a run happened in (MACLEOD-574).
 *
 * The board's rows are a person, then that person's sessions, then the
 * agents working inside each one. Nothing on a report said which session
 * a run belonged to, so a developer with two terminals open was one
 * undifferentiated row and their agents had nowhere to sit.
 *
 * `id` is a short digest of the session id rather than the id itself:
 * the dashboard only ever needs to tell two sessions apart, and a raw
 * `session_id` is a machine-local identifier with no business on a
 * report. `agent.parent` carries the same digest, so the two join.
 *
 * The one place the raw id still travels is the execution id
 * `claude-<session>`, which predates all of this and is what a tenant's
 * documents are already keyed by: changing it would split every card in
 * two on the day a plugin upgrades. It is named here rather than left
 * as a silent exception to the sentence above.
 *
 * `tool` is the capability table's name for whatever is reporting, and
 * `repository`/`branch` are the two the issue document already carries —
 * repeated here because they are what tells a reader which of their
 * sessions a row is, a worktree being the usual reason there is more
 * than one.
 */
export function sessionBlock(state = {}, info = {}) {
  const raw = String(state.sessionId || '');
  if (!raw) return undefined;
  const block = { id: digest(raw) };
  const tool = state.reporter?.tool;
  if (tool) block.tool = String(tool).slice(0, 80);
  if (state.startedAt) block.startedAt = state.startedAt;
  if (state.ended && state.updatedAt) block.endedAt = state.updatedAt;
  if (info.repository) block.repository = String(info.repository).slice(0, 200);
  if (info.branch) block.branch = String(info.branch).slice(0, 200);
  return block;
}

export function issuePayload(state, config, info) {
  if (!state.binding?.key) return undefined;
  const key = state.binding.key;
  const tracker = state.binding.tracker || trackerOf(config);
  const act = actor(config, info);
  const jiraUrl = state.jira?.url || issueUrl(key, tracker, config, info, state.binding);
  return {
    tenantId: tenantId(config),
    tracker,
    jiraKey: key,
    jiraUrl,
    title: state.jira?.title,
    jiraStatus: state.jira?.status,
    parentKeys: state.jira?.parentKeys,
    project: issueProject(key, tracker),
    actor: act.displayName,
    repository: info.repository,
    branch: info.branch,
    stage: state.stage || 'BACKLOG',
    status: state.status || 'running',
    summary: String(state.summary || 'Work detected').slice(0, 180),
    updatedAt: state.updatedAt || new Date().toISOString(),
    loopCount: state.loopCount || 0,
    reworkFrom: state.reworkFrom,
    // MACLEOD-510. Set by refreshDelivery, and absent rather than empty
    // outside a repository or when the branch has no pull request.
    git: state.git,
    pr: state.pr,
    // MACLEOD-532. Absent on a session that never named a tool, which is
    // what the dashboard reads as "connected, version unknown".
    reporter: state.reporter,
    // Filled here rather than by whoever is driving, so a report is
    // attributed whether it came from the build skill, a teammate or
    // somebody working the ticket by hand.
    workflow: workflowRef(key, config),
    evidence: (state.evidence || []).slice(0, 8),
    /*
     * The one event shape (MACLEOD-548): `at` and `source`, not
     * `updatedAt`. The tracker sidecar and the pull request sidecar
     * already write it, and this was the last writer that did not, which
     * is why `DetailEvent` in the dashboard still had a branch per shape.
     *
     * `source: 'plugin'` because a hook has no runtime slot of its own —
     * it writes the issue document. The service takes either shape here
     * while tenants still hold documents from before the change, so an
     * older plugin keeps reporting and its board keeps drawing.
     */
    executions: [
      {
        /*
         * One execution per actor (MACLEOD-574), so five teams under one
         * `session_id` are five rows on five tickets rather than one row
         * that whoever reported last had rewritten. The main session keeps
         * the id it has always had, so its card does not split in two on
         * the day a plugin upgrades mid-flight.
         */
        id: executionId(state),
        at: state.updatedAt || new Date().toISOString(),
        source: 'plugin',
        kind: 'claude',
        // The agent's own name, which is what the terminal shows. The
        // label used to be "Claude Code + N subagents": a count where a
        // board needed names, and it named the wrong ticket besides.
        label: state.agent?.name || 'Claude Code',
        stage: state.stage || 'BACKLOG',
        status: state.status || 'running',
        summary: String(state.summary || 'Work detected').slice(0, 180),
        evidence: (state.evidence || []).slice(0, 4),
        ...(state.agent ? { agent: agentBlock(state) } : {}),
        // On the session's own row and on every agent's, because the
        // board groups person → session → agent and had nothing to
        // group by (MACLEOD-574).
        ...(sessionBlock(state, info) ? { session: sessionBlock(state, info) } : {}),
      },
      /*
       * The gate that sent this ticket back, for as long as it has not passed
       * again. Without it a report is one node in the ticket's own column and
       * the dashboard has nothing to draw the loop from: `reworkFrom` says which
       * column, this says which step and what it found. Derived state only —
       * step name, stage, status, summary, evidence counts, timestamp.
       */
      ...(state.rework ? [{
        id: `gate-${state.rework.stage}`,
        at: state.rework.updatedAt,
        source: 'plugin',
        kind: GATE_KINDS[state.rework.stage] || 'ci',
        label: state.rework.label,
        stage: state.rework.stage,
        status: 'failed',
        summary: String(state.rework.summary || `${state.rework.label} failed`).slice(0, 180),
        evidence: (state.rework.evidence || []).slice(0, 4),
      }] : []),
    ],
  };
}

export function sanitizePayload(value) {
  const allowed = new Set([
    'tracker','jiraKey','jiraUrl','title','jiraStatus','parentKeys','project','actor','repository','branch',
    'tenantId','stage','status','summary','updatedAt','loopCount','reworkFrom','evidence','executions',
    'id','kind','label','value','displayName','active','recent','slot',
    // MACLEOD-510, and the same names adapters/teamflow/schema.py takes.
    'git','head','sha','subject','commitsSinceMain','ahead','behind','pushed','dirty',
    'pr','number','url','state','mergeable','checks','passing','failing','pending','review',
    // Tracker relations: "parent/related keys" in docs/REPORTING_CONTRACT.md. The
    // service's schema has always accepted them; this allowlist was silently
    // dropping them, which is why no dependency arrow ever drew on real data.
    'links','target','type',
    // MACLEOD-532: what reported. Two fields and no more — the point of the
    // allowlist is that a reporter talked into attaching a hostname or a path
    // cannot reach the service by hanging it off a field that is allowed.
    'reporter','tool','version',
    // MACLEOD-546: which run this report belongs to. Two fields, and
    // `id` is already allowed above. The event itself is still an
    // execution on the issue document -- this only says where it
    // happened, so a run's activity can be read from the reports the
    // service already receives instead of from a second log.
    'workflow','phase',
  ]);
  /*
   * MACLEOD-548: the one event shape. `at` is when the event happened and
   * `source` is who says so — the two fields that replace `updatedAt` on an
   * `executions[]` row.
   *
   * They are allowed inside `executions` and nowhere else, rather than being
   * added to the flat set above. `source` is also the name of the thing that
   * must never travel: an event's provenance is worth carrying, a field
   * called `source` hanging off the payload is exactly what this allowlist
   * exists to drop, and `plugin/tests/integration/report.test.mjs` asserts
   * the payload has none.
   */
  const eventOnly = new Set(['at', 'source', 'agent', 'session']);
  /*
   * MACLEOD-574. `agent` is its own scope rather than seven more names
   * on the flat set above, because six of those names — `name`, `task`,
   * `type`, `parent`, `startedAt`, `endedAt` — are exactly the words a
   * reporter talked into attaching a prompt or a transcript would reach
   * for. Inside the block they are a short label each; anywhere else on
   * the payload they are dropped, `prompt` and `last_assistant_message`
   * among them, because neither is in either set.
   */
  const agentOnly = new Set(['id', 'name', 'task', 'type', 'parent', 'startedAt', 'endedAt']);
  // Which session a run happened in. `repository` and `branch` are in the
  // flat set already; the rest are here and nowhere else, so a transcript
  // path or a raw session id has no field to arrive on.
  const sessionOnly = new Set(['id', 'tool', 'startedAt', 'endedAt', 'repository', 'branch']);
  const nested = { agent: agentOnly, session: sessionOnly };
  function walk(v, scope) {
    if (Array.isArray(v)) return v.slice(0, 50).map((item) => walk(item, scope));
    if (!v || typeof v !== 'object') {
      return typeof v === 'string' ? v.slice(0, 300) : v;
    }
    const out = {};
    for (const [key, item] of Object.entries(v)) {
      const ok = nested[scope]
        ? nested[scope].has(key)
        : allowed.has(key) || (scope === 'event' && eventOnly.has(key));
      if (!ok) continue;
      const next = nested[scope] ? scope
        : nested[key] ? key
          : key === 'executions' ? 'event' : scope;
      out[key] = walk(item, next);
    }
    return out;
  }
  return walk(value, 'root');
}

// --- transports ----------------------------------------------------
//
// Two ways out, chosen by which credential is configured. The service
// is the one that scales: the account behind the API key decides the
// tenant, so a reporter needs no AWS credentials and no bucket policy.
// The S3 path is unchanged for installs that predate the service.

const DEFAULT_SERVICE_URL = 'https://codercat.io';

export function serviceUrl(config = {}) {
  return String(config.serviceUrl || DEFAULT_SERVICE_URL).replace(/\/+$/, '');
}

// The hosted service, whatever this install is pointed at. The CI OIDC
// audience is tied to the real domain, not to the stack being reported
// to, so it cannot be moved by a serviceUrl override.
export function defaultServiceUrl() {
  return DEFAULT_SERVICE_URL;
}

// The one place that turns config into the header the service
// authenticates with. Ephemeral credentials come first and an API key
// is the fallback:
//
//   1. a signed-in session (/teamflow:login). auth.mjs refreshes the
//      access token before it expires; nothing is on disk but a
//      revocable refresh token.
//   2. `accessToken` handed in directly, which is how CI passes the
//      token it got by exchanging its GitHub Actions OIDC token.
//   3. `apiKey`, for non-interactive installs that cannot do either.
//
// Callers ask for a credential rather than reading `apiKey`, and the
// outbox stores none: a queued report resolves its credential when it
// is finally sent, which is the only way a one-hour token survives an
// hour of being offline.
export async function credential(config = {}) {
  if (auth.hasSession()) {
    const token = await auth.accessToken(config);
    if (token.ok) {
      return { kind: 'bearer', header: 'Authorization', value: `Bearer ${token.token}`, email: token.email };
    }
    // A session that will not refresh has expired or been revoked.
    // Fall through to a key if there is one rather than going dark,
    // and carry the reason so doctor can say what happened.
    if (config.apiKey) {
      return { kind: 'api_key', header: 'X-Api-Key', value: String(config.apiKey), degraded: token.reason };
    }
    return undefined;
  }
  if (config.accessToken) {
    return { kind: 'bearer', header: 'Authorization', value: `Bearer ${config.accessToken}` };
  }
  if (config.apiKey) {
    return { kind: 'api_key', header: 'X-Api-Key', value: String(config.apiKey) };
  }
  return undefined;
}

// What credential is available, decided without touching the network.
// transportOf and the CLI's status need an answer now; resolving a
// bearer can mean a refresh round trip, and neither should pay for one.
export function credentialKind(config = {}) {
  // Named apart from a bearer session, because the two behave
  // differently in the two places somebody looks: a device credential
  // has nothing to refresh, and it is revoked at the service rather
  // than by deleting a file.
  if (auth.isDeviceSession()) return 'device';
  if (auth.hasSession() || config.accessToken) return 'bearer';
  if (config.apiKey) return 'api_key';
  return undefined;
}

// The service wins when both are configured. An org that has a service
// credential has migrated, and writing both would bill one report and
// orphan the other.
export function transportOf(config = {}) {
  if (credentialKind(config)) return 'service';
  if (config.dataUri) return 's3';
  return 'none';
}

function s3Put(uri, payload, config) {
  const args = ['s3', 'cp', '-', uri, '--content-type', 'application/json', '--cache-control', 'no-cache, max-age=0'];
  if (config.awsProfile) args.push('--profile', config.awsProfile);
  const result = safeExec('aws', args, {
    input: JSON.stringify(payload, null, 2) + '\n',
    timeout: Number(config.awsTimeoutMs || 5000),
  });
  return result;
}

function outboxDir() {
  return path.join(dataDir(), 'outbox');
}

// Two item shapes share the directory: { uri, payload } is an S3 put and
// { endpoint, envelope, idempotencyKey } is a service report. flushOutbox
// only drains the shape the configured transport can deliver, so an
// install that switches over does not lose whatever the old one queued.
function queueOutbox(item) {
  fs.mkdirSync(outboxDir(), { recursive: true });
  const name = `${Date.now()}-${crypto.randomUUID()}.json`;
  writeJson(path.join(outboxDir(), name), item);
}

// The service drops unknown fields and reports them back, so sending
// these would put a line of noise in dropped_fields on every report.
// tenantId comes from the credential and slot from the envelope;
// neither is the reporter's to assert.
function serviceDocument(payload, kind) {
  // A workflow is a different document with a different shape, and
  // `sanitizePayload` is an issue report's allowlist: it is a flat set
  // of key names, so it knows none of the workflow's fields, and it
  // caps every array at fifty, which would quietly drop most of a
  // backlog sweep's pool. The workflow's own allowlist is `published`
  // in workflow.mjs, which is structural rather than flat -- a `reason`
  // is allowed inside a dependency and nowhere else -- and the
  // service's WORKFLOW tables are the second line as always.
  if (kind === 'workflow') return payload;
  const clean = sanitizePayload(payload);
  delete clean.tenantId;
  delete clean.slot;
  return clean;
}

// The same stable hash the publish dedupe uses. A report whose content
// has not changed is therefore the same request to the service, which
// replays the first answer instead of charging a second credit.
export function reportIdempotencyKey(kind, slot, document) {
  const stable = { kind, slot: slot || null, document: { ...document, updatedAt: undefined } };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

// 120 requests a minute is shared by a Claude session, its subagents
// and CI, so 429 is reachable in ordinary use. It is the one 4xx worth
// retrying: the same body posted later gets a different answer.
const OUTBOX_BASE_BACKOFF_MS = 15000;
const OUTBOX_MAX_BACKOFF_MS = 300000;

// Seconds or an HTTP-date, per RFC 9110. Undefined when absent or
// unparseable, so a malformed header falls back to the backoff rather
// than pinning a report at NaN.
export function parseRetryAfter(value, now = Date.now()) {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  const text = String(value).trim();
  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(text);
  return Number.isNaN(when) ? undefined : Math.max(0, when - now);
}

// How long a queued report waits before the next attempt. The service
// saying when it will listen again beats our guess, but is still
// capped: a reporter that sleeps for an hour on one header is a
// reporter that has stopped reporting.
//
// Zero for 5xx and network failures, which keeps their long-standing
// behaviour: they go out on the next flush, because whatever triggered
// that flush already proved the service is answering again.
export function retryDelayMs(attempts, { status, retryAfterMs } = {}) {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, OUTBOX_MAX_BACKOFF_MS);
  if (status !== 429) return 0;
  return Math.min(OUTBOX_BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), OUTBOX_MAX_BACKOFF_MS);
}

function scheduleRetry(item, result) {
  const attempts = (item.attempts || 0) + 1;
  return { ...item, attempts, notBefore: Date.now() + retryDelayMs(attempts, result) };
}

let paymentNoticeShown = false;

// 402 is a billing problem, not a developer's problem. Say it once and
// let the session carry on: reporting is observability, never a gate.
function notePaymentRequired(config, body) {
  if (paymentNoticeShown) return;
  paymentNoticeShown = true;
  const link = body?.payment?.payment_link || body?.payment?.checkout_url;
  const where = link ? `Top up: ${link}` : `Top up at ${serviceUrl(config)}.`;
  try {
    process.stderr.write(`TeamFlow: reporting paused, the account is out of credits. ${where}\n`);
  } catch {}
}

export function resetPaymentNotice() {
  paymentNoticeShown = false;
}

async function postEnvelope(endpoint, envelope, idempotencyKey, config) {
  const cred = await credential(config);
  if (!cred) return { ok: false, retry: false, reason: 'no service credential available' };
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [cred.header]: cred.value,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 5000)),
    });
  } catch (error) {
    // Offline, DNS, TLS, timeout. The report is still true, so keep it.
    return { ok: false, retry: true, reason: `service unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  const status = response.status;
  if (status === 402) {
    notePaymentRequired(config, body);
    return { ok: false, retry: false, status, paymentRequired: true, reason: body?.message || 'account is out of credits' };
  }
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  if (status === 429) {
    // The only retryable 4xx. Nothing about the report is wrong; the
    // caller simply arrived too fast, and the same body posted later
    // is accepted.
    return { ok: false, retry: true, status, retryAfterMs, reason: body?.message || 'rate limited' };
  }
  if (status >= 500) {
    return { ok: false, retry: true, status, retryAfterMs, reason: body?.message || `service returned ${status}` };
  }
  if (status >= 400) {
    // 400, 401, 403, 413. Re-posting the same body cannot change the
    // answer, and one refused report must never dam the outbox in
    // front of the good reports behind it.
    return { ok: false, retry: false, status, reason: body?.message || `service refused the report (${status})` };
  }
  return {
    ok: true,
    status,
    replay: Boolean(body?.replay),
    droppedFields: Array.isArray(body?.dropped_fields) ? body.dropped_fields : [],
  };
}

export async function flushOutbox(config, limit = 5) {
  const mode = transportOf(config);
  if (mode === 'none' || !fs.existsSync(outboxDir())) return { sent: 0, dropped: 0, deferred: 0, remaining: 0 };
  const files = fs.readdirSync(outboxDir()).filter((name) => name.endsWith('.json')).sort().slice(0, limit);
  let sent = 0;
  let dropped = 0;
  let deferred = 0;
  for (const file of files) {
    const full = path.join(outboxDir(), file);
    const item = readJson(full);
    if (item?.endpoint && item?.envelope) {
      if (mode !== 'service') continue;
      if (item.notBefore && Date.now() < item.notBefore) {
        deferred += 1;
        continue;
      }
      const result = await postEnvelope(item.endpoint, item.envelope, item.idempotencyKey, config);
      if (result.retry) {
        // Rewritten in place, not re-queued: a new file name would sort
        // to the back and let a stale full-state document overwrite a
        // fresher one.
        writeJson(full, scheduleRetry(item, result));
        break;
      }
      fs.unlinkSync(full);
      if (result.ok) sent += 1;
      else dropped += 1;
      continue;
    }
    if (item?.uri && item?.payload) {
      if (mode !== 's3') continue;
      if (!s3Put(item.uri, item.payload, config).ok) break;
      fs.unlinkSync(full);
      sent += 1;
      continue;
    }
    fs.unlinkSync(full);
    dropped += 1;
  }
  const remaining = fs.existsSync(outboxDir())
    ? fs.readdirSync(outboxDir()).filter((name) => name.endsWith('.json')).length
    : 0;
  return { sent, dropped, deferred, remaining };
}

// POST one report to the service. kind is the envelope kind
// ("issue" or "runtime"); slot is required for runtime and absent for
// an issue, because it is a path segment the service checks.
export async function sendReport(kind, slot, payload, config) {
  if (!credentialKind(config)) return { ok: false, skipped: true, reason: 'no service credential configured' };
  const document = serviceDocument(payload, kind);
  const envelope = slot ? { kind, slot, payload: document } : { kind, payload: document };
  const endpoint = `${serviceUrl(config)}/v1/report`;
  const idempotencyKey = reportIdempotencyKey(kind, slot, document);
  const result = await postEnvelope(endpoint, envelope, idempotencyKey, config);
  if (result.retry) {
    queueOutbox(scheduleRetry({ endpoint, envelope, idempotencyKey }, result));
    return { ok: false, queued: true, status: result.status, reason: result.reason };
  }
  if (result.ok) await flushOutbox(config);
  return result;
}

export async function fetchAccount(config) {
  const cred = await credential(config);
  if (!cred) return { ok: false, reason: 'no service credential available' };
  try {
    const response = await fetch(`${serviceUrl(config)}/v1/account`, {
      headers: { [cred.header]: cred.value },
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 5000)),
    });
    let body;
    try { body = await response.json(); } catch { body = undefined; }
    if (!response.ok) {
      return { ok: false, status: response.status, reason: body?.message || `service returned ${response.status}` };
    }
    return { ok: true, status: response.status, account: body, credential: cred.kind, email: cred.email, degraded: cred.degraded };
  } catch (error) {
    return { ok: false, reason: `service unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// Legacy: one object, one deterministic S3 key, aws CLI credentials.
export async function putReport(relativePath, payload, config) {
  if (!config.dataUri) return { ok: false, skipped: true, reason: 'TEAMFLOW_DATA_URI not configured' };
  const base = String(config.dataUri).replace(/\/$/, '');
  const uri = `${base}/${relativePath.replace(/^\//, '')}`;
  const clean = sanitizePayload(payload);
  const result = s3Put(uri, clean, config);
  if (!result.ok) {
    queueOutbox({ uri, payload: clean });
    return { ok: false, queued: true, reason: result.stderr || 'aws s3 cp failed' };
  }
  await flushOutbox(config);
  return { ok: true };
}

function payloadHash(payload) {
  const stable = { ...payload, updatedAt: undefined };
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function aggregateActor(config, info) {
  const act = actor(config, info);
  const tenant = tenantId(config);
  const dir = path.join(dataDir(), 'sessions');
  const active = new Set();
  const recent = new Set();
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.json'))) {
      const session = readJson(path.join(dir, file));
      const sessionTenant = session?.tenantId || tenant;
      if (sessionTenant !== tenant) continue;
      const key = session?.binding?.key;
      if (!key) continue;
      const terminal = ['DEV_VERIFIED', 'READY_PROD'].includes(session.stage) || session.ended;
      if (terminal) recent.add(key);
      else active.add(key);
    }
  }
  for (const key of active) recent.delete(key);
  return {
    tenantId: tenant,
    id: act.id,
    displayName: act.displayName,
    active: [...active].sort(),
    recent: [...recent].sort().slice(-30),
    updatedAt: new Date().toISOString(),
  };
}

export async function publishState(state, config, info, { force = false, keepTenant = false, skipGit = false } = {}) {
  /*
   * `keepTenant` is for flushing an end somebody else's session left
   * behind (MACLEOD-574, audit finding B, ruling 2). Overwriting the
   * tenant recorded on a state with the flusher's is how one client's
   * ticket ended up addressed to another client's account; on a flush
   * the state's own tenant is the only right answer, and the caller has
   * already refused to flush at all unless the two agree.
   */
  if (!keepTenant) state.tenantId = tenantId(config);
  // Before the envelope is built, not after: the board wants the ticket's
  // name on the first report, not on whichever later one happens to follow
  // the agent looking the issue up.
  await ensureIssueTitle(state, config, info);
  // Where the branch is and what its PR is doing, refreshed here so a
  // forced publish — Stop, or /teamflow:sync — always carries the
  // current answer (MACLEOD-510).
  refreshDelivery(state, config, info, { force, skipGit });
  const payload = issuePayload(state, config, info);
  if (!payload) return { ok: false, skipped: true, reason: 'No issue bound' };
  /*
   * Where this actor was, and which service it answered to. Local state
   * and never the wire (`sanitizePayload` knows none of these names):
   * it is what a later flush reports instead of running git against this
   * directory from another session's hook, and what scopes the flush
   * queue to actors this configuration could have written.
   */
  if (info.repository) state.reportedRepository = info.repository;
  if (info.branch) state.reportedBranch = info.branch;
  state.serviceUrl = serviceUrl(config);
  const now = Date.now();
  const hash = payloadHash(payload);
  const same = state.lastPublishHash === hash;
  const heartbeatMs = Number(config.heartbeatMs || 30000);
  if (!force && same && now - (state.lastPublishedAt || 0) < heartbeatMs) {
    return { ok: true, skipped: true, reason: 'Deduplicated' };
  }

  const transport = transportOf(config);
  let issueResult;
  let actorResult;
  if (transport === 'service') {
    issueResult = await sendReport('issue', undefined, payload, config);
    // No actor document is posted. The service allowlist knows two
    // kinds, issue and runtime, and the account already scopes the
    // tenant, so a locally aggregated actor rollup has nowhere to
    // land. Issue discovery on the service is the dashboard's job
    // via /v1/state, not this reporter's.
    actorResult = { ok: true, skipped: true, reason: 'Actor rollup is not part of the service contract' };
  } else {
    issueResult = await putReport(tenantPath(config, `issues/${payload.jiraKey}.json`), payload, config);
    const actorPayload = aggregateActor(config, info);
    actorResult = await putReport(tenantPath(config, `actors/${actorPayload.id}.json`), actorPayload, config);
  }

  state.lastPublishHash = hash;
  state.lastPublishedAt = now;
  state.lastTransport = transport;
  state.lastPublishResult = issueResult.ok
    ? 'ok'
    : issueResult.queued
      ? 'queued'
      : issueResult.paymentRequired
        ? 'payment_required'
        // Nothing was attempted, so nothing failed (MACLEOD-572, plugin
        // audit row 17). A machine with no credential and no data URI
        // used to record `failed` here, and `status` printed it three
        // lines above `identity: not signed in` — so the first thing a
        // lost customer read was that their report had been rejected,
        // which it had not: it was never sent. `skipped` is the flag
        // both transports set for exactly that, and only that; a
        // configured transport that could not deliver is `queued`.
        : issueResult.skipped
          ? 'not sent: this machine has nothing to send it with; run /teamflow:login'
          : 'failed';
  return { ok: Boolean(issueResult.ok && actorResult.ok), transport, issueResult, actorResult };
}

// Sessions record the repository root they were opened against, so the
// question is asked in those terms too: `teamflow status` run three
// directories down is still asking about the same session.
export function latestSessionForCwd(cwd) {
  cwd = repositoryRoot(cwd);
  const dir = path.join(dataDir(), 'sessions');
  if (!fs.existsSync(dir)) return undefined;
  const candidates = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(dir, name)))
    .filter((state) => state?.cwd === cwd)
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
  return candidates[0];
}

export function saveSession(state) {
  // `agentKey` is what makes this an actor rather than a session
  // (MACLEOD-574). Absent on the main actor, which keeps its file name.
  writeJson(sessionPath(state.sessionId, state.agentKey), state);
}
