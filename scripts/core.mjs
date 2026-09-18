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
const TRACKERS = new Set(['jira', 'linear', 'github']);
const TEST_RE = /(?:^|\s)(?:npm|pnpm|yarn|bun)?\s*(?:run\s+)?(?:test|vitest|jest|pytest|playwright|cypress)(?:\s|$)|\bgo test\b|\bcargo test\b|\bmvn(?:w)?\s+test\b|\bgradle(?:w)?\s+test\b/i;
const DEV_TEST_RE = /\b(?:smoke|acceptance|e2e|integration)[-_: ]?(?:dev|staging)|\b(?:dev|staging)[-_: ]?(?:smoke|acceptance|e2e|integration)\b/i;
const MERGE_RE = /\bgh\s+pr\s+merge\b|\bgit\s+merge\b/i;
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

// Returns { key, tracker, repo?, workspace? }. Issue URLs and owner/repo#n name their own
// tracker; the bare forms (#123, a shared-shape key) are read as the configured tracker.
export function detectIssueRef(value, config = {}, info = {}) {
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
  const key = extractJiraKey(text);
  return key ? { key, tracker: trackerOf(config) } : undefined;
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

export function sessionPath(sessionId) {
  return path.join(dataDir(), 'sessions', `${sessionId}.json`);
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
export function refreshDelivery(state, config = {}, info = {}, { force = false } = {}) {
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
export function issueCandidates(input = {}, info = {}, manual = undefined, config = {}) {
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
  add(
    detectIssueRef(info.branch, config, info) || (tracker === 'github' ? detectGithubBranch(info.branch, config, info) : undefined),
    95,
    'branch',
  );
  add(detectIssueRef(info.lastMessage, config, info), 80, 'commit');

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
  const candidates = issueCandidates(input, info, manual, config);
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

  if (MERGE_RE.test(command)) {
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
    evidence: (state.evidence || []).slice(0, 8),
    executions: [
      {
        id: `claude-${state.sessionId}`,
        kind: 'claude',
        label: state.subagentCount ? `Claude Code + ${state.subagentCount} subagent${state.subagentCount === 1 ? '' : 's'}` : 'Claude Code',
        stage: state.stage || 'BACKLOG',
        status: state.status || 'running',
        summary: String(state.summary || 'Work detected').slice(0, 180),
        evidence: (state.evidence || []).slice(0, 4),
        updatedAt: state.updatedAt || new Date().toISOString(),
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
        kind: GATE_KINDS[state.rework.stage] || 'ci',
        label: state.rework.label,
        stage: state.rework.stage,
        status: 'failed',
        summary: String(state.rework.summary || `${state.rework.label} failed`).slice(0, 180),
        evidence: (state.rework.evidence || []).slice(0, 4),
        updatedAt: state.rework.updatedAt,
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
  ]);
  function walk(v) {
    if (Array.isArray(v)) return v.slice(0, 50).map(walk);
    if (!v || typeof v !== 'object') {
      return typeof v === 'string' ? v.slice(0, 300) : v;
    }
    const out = {};
    for (const [key, item] of Object.entries(v)) {
      if (!allowed.has(key)) continue;
      out[key] = walk(item);
    }
    return out;
  }
  return walk(value);
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
function serviceDocument(payload) {
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
  const document = serviceDocument(payload);
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

export async function publishState(state, config, info, { force = false } = {}) {
  state.tenantId = tenantId(config);
  // Before the envelope is built, not after: the board wants the ticket's
  // name on the first report, not on whichever later one happens to follow
  // the agent looking the issue up.
  await ensureIssueTitle(state, config, info);
  // Where the branch is and what its PR is doing, refreshed here so a
  // forced publish — Stop, or /teamflow:sync — always carries the
  // current answer (MACLEOD-510).
  refreshDelivery(state, config, info, { force });
  const payload = issuePayload(state, config, info);
  if (!payload) return { ok: false, skipped: true, reason: 'No issue bound' };
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
  writeJson(sessionPath(state.sessionId), state);
}
