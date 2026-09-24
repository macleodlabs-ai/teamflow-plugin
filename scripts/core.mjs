import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import * as auth from './auth.mjs';
import { refusalOf } from './refusal.mjs';
import { TOOL_CAPABILITIES } from './tools.mjs';
import { checkNameFor, checkNames, readChecks } from './checks.mjs';
import { advance as advancePoints, stableId } from './points.mjs';
import { about as aboutLine, title as plainTitle } from './words.mjs';
import {
  countedByFile, pointFamily, readFailingTests, runnerFamily, testFile, testScope, withFamily,
} from './failing-tests.mjs';

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
// Every command that actually puts a change somewhere. `mcpkit deploy` and the
// `sam deploy` it wraps were missing, which is why an mcp-service-kit service —
// TeamFlow among them — reported no deploy at all (MACLEOD-594).
const DEPLOY_RE = /\b(?:cdk|terraform)\s+(?:deploy|apply)\b|\b(?:mcpkit|sam)\s+deploy\b|\baws\s+(?:cloudformation\s+deploy|ecs\s+update-service)\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?deploy(?::|-)?dev\b/i;
// A build a developer runs on their own machine is a local gate, not a
// pipeline, so this feeds LOCAL_TEST. CI/CD is reported by a background
// reporter or by one of the deploy commands above, and by nothing a developer
// runs to compile.
const BUILD_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b|\btsc\s+-b\b/i;
// Never a bare `npm audit` / `npm audit fix` (MACLEOD-639): that is a
// dependency vulnerability scan a package manager runs, not the local
// audit gate, and matching it moved tickets into LOCAL_AUDIT that no
// audit had been run on. The gate is the repository's own script —
// `npm run audit:local`, `make audit` — or the command `.teamflow.json`
// names as `localAuditPattern`.
const LOCAL_AUDIT_RE = /\b(?:npm|pnpm|yarn|bun)\s+run\s+audit(?:[-_:]local)?\b|\b(?:make|just)\s+audit\b/i;
// A push of the branch being worked. `git push origin main` after a
// merge is not one, and neither is a push of somebody else's branch.
const GIT_PUSH_RE = /\bgit\s+push\b/i;
// The stages a push or a pull request opening moves out of. A ticket
// already in review or beyond is not sent back to review by a second push.
const PRE_REVIEW_STAGES = new Set(['LOCAL_DEV', 'LOCAL_TEST', 'LOCAL_AUDIT']);
const DEV_AUDIT_RE = /\baudit[-_: ]?(?:dev|staging)\b|\b(?:dev|staging)[-_: ]?audit\b/i;

/*
 * The stages, in delivery order. This is the emitting side of the contract
 * STAGES in src/lib/stageMachine.ts draws: the plugin needs the order to answer
 * one question a transition cannot answer on its own — has the gate that sent
 * this ticket back been passed again? Rework stages are not in it, because a
 * ticket never ranks at one.
 *
 * It is longer than the dashboard's column list by one, and deliberately:
 * CI_BUILD and DEPLOY_DEV are two gates a ticket passes in order but one CI/CD
 * column to a reader (MACLEOD-594). Rank is about order, so both are here.
 */
export const STAGE_ORDER = [
  'JIRA', 'LOCAL_DEV', 'LOCAL_TEST', 'LOCAL_AUDIT', 'MERGE', 'CI_BUILD',
  'DEPLOY_DEV', 'DEV_TEST', 'DEV_AUDIT', 'DEV_VERIFIED', 'DONE',
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
      ...(options.maxBuffer ? { maxBuffer: options.maxBuffer } : {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env || process.env,
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
  return process.env.CLAUDE_PLUGIN_DATA
    || (process.env.TEAMFLOW_TEST_SANDBOX ? undefined : claudePluginData(process.env))
    || path.join(userHome(), '.local', 'share', 'teamflow');
}

let pluginDataSeen = {};

/**
 * The directory Claude Code gives this plugin's hooks, for a process
 * Claude Code started without telling it (MACLEOD-640).
 *
 * Claude Code sets CLAUDE_PLUGIN_DATA for a plugin's hooks and not for
 * its Bash tool, so `node cli.mjs status` run by the session that
 * dispatched three agents read ~/.local/share/teamflow while the hooks
 * had recorded the launches under <config>/plugins/data/teamflow-*: it
 * said "0 agents dispatched", and the lead's `workflow create` went into
 * one file while the dispatched agents went into an older auto run in
 * the other. Only inside Claude Code (CLAUDECODE=1), so another tool's
 * hooks keep the directory they always had; the newest such directory
 * when a person has installed the plugin from two marketplaces.
 * Never inside the test sandbox, where CLAUDE_CONFIG_DIR is the real one.
 */
export function claudePluginData(env = {}) {
  if (env.CLAUDECODE !== '1') return undefined;
  const root = path.join(env.CLAUDE_CONFIG_DIR || path.join(userHome(), '.claude'), 'plugins', 'data');
  // Asked on every path this process builds, so answered once per root.
  if (pluginDataSeen.root === root) return pluginDataSeen.dir;
  let dir;
  try {
    dir = fs.readdirSync(root)
      .filter((name) => /^teamflow-[\w.-]+$/.test(name))
      .map((name) => ({ dir: path.join(root, name), at: fs.statSync(path.join(root, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at)[0]?.dir;
  } catch { /* no plugin data here: the old directory answers */ }
  pluginDataSeen = { root, dir };
  if (dir) adoptOldData(path.join(userHome(), '.local', 'share', 'teamflow'), dir);
  return dir;
}

const ADOPTED = '.adopted-local-share';

/**
 * Once, bring what the CLI wrote to the old directory into the plugin's
 * (MACLEOD-640). Before the fix above, commands run from Claude Code's Bash
 * tool wrote runs and bindings to ~/.local/share/teamflow while the hooks
 * used the plugin directory; reading only the plugin's now would lose those
 * runs. Files the plugin directory lacks are copied; the two run files are
 * merged by run id, the newer copy of a run winning, and each organisation's
 * current run is the one a person made over one the plugin made, else the
 * one touched last. Nothing already in
 * the plugin directory is overwritten otherwise. A marker makes it once.
 * Never throws: at worst the old runs stay where they were.
 */
export function adoptOldData(oldDir, newDir) {
  try {
    if (!oldDir || !newDir || path.resolve(oldDir) === path.resolve(newDir)) return false;
    if (fs.existsSync(path.join(newDir, ADOPTED)) || !fs.existsSync(oldDir)) return false;
    const walk = (rel) => {
      for (const entry of fs.readdirSync(path.join(oldDir, rel), { withFileTypes: true })) {
        const from = path.join(oldDir, rel, entry.name);
        const to = path.join(newDir, rel, entry.name);
        if (entry.isDirectory()) { walk(path.join(rel, entry.name)); continue; }
        if (!entry.isFile()) continue;
        if (!fs.existsSync(to)) {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
        } else if (rel === '' && entry.name === 'workflows.json') {
          fs.writeFileSync(to, JSON.stringify(mergeRunFiles(readJsonFile(to), readJsonFile(from)), null, 2), { mode: 0o600 });
        }
      }
    };
    walk('');
    fs.writeFileSync(path.join(newDir, ADOPTED), new Date().toISOString());
    return true;
  } catch {
    return false;
  }
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

const stampOf = (run) => Date.parse(run?.updatedAt || run?.createdAt || '') || 0;

/** Two run files, one per organisation: runs joined by id, the newer copy of each, the latest current run. */
export function mergeRunFiles(kept, other) {
  const out = { ...(kept || {}) };
  for (const [tenant, theirs] of Object.entries(other || {})) {
    const mine = out[tenant];
    if (!mine || typeof mine !== 'object') { out[tenant] = theirs; continue; }
    const list = (held) => (Array.isArray(held?.workflows) ? held.workflows : Object.values(held?.workflows || {}));
    const byId = new Map();
    for (const run of [...list(mine), ...list(theirs)]) {
      if (!run?.id) continue;
      const seen = byId.get(run.id);
      if (!seen || stampOf(run) > stampOf(seen)) byId.set(run.id, run);
    }
    const runs = [...byId.values()];
    const currentOf = (held) => runs.find((run) => run.id === held?.current);
    const a = currentOf(mine);
    const b = currentOf(theirs);
    // A run somebody made wins over one the plugin made for them; otherwise the newer.
    const byPerson = (run) => (run?.origin === 'auto' ? 0 : 1);
    const pick = a && b
      ? (byPerson(a) !== byPerson(b) ? (byPerson(a) > byPerson(b) ? a : b) : (stampOf(b) > stampOf(a) ? b : a))
      : (a || b);
    const current = pick?.id ?? mine.current ?? theirs.current;
    out[tenant] = { ...mine, workflows: Array.isArray(mine.workflows) ? runs : Object.fromEntries(runs.map((run) => [run.id, run])), current };
  }
  return out;
}

export function projectId(cwd) {
  return crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

// One binding per repository, not one per directory somebody happened
// to be standing in. `teamflow bind` run in a package and a hook event
// fired from that package's directory have to name the same file as the
// root does, or the binding is written where nothing will look for it.
//
// The tenant is `default` on every service install, so this is one file
// for every organisation a person holds a seat on: it is where every
// plugin before this one wrote, it is still read and still written by an
// install that has no organisation, and `accountBindingPath` is where a
// signed-in one writes instead (MACLEOD-586).
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

// --- a binding belongs to one organisation (MACLEOD-586) ------------
//
// The binding is the most load-bearing store in the plugin: it decides
// which ticket every hook event in this repository is about. It said
// nothing about who bound it, and `bindings/<tenant>/` is `default` on
// every service install, so a repository bound while signed in to
// organisation A went on naming A's ticket after a switch to B. The
// tenant a report lands in comes from the credential, so A's key,
// title, stage, summary, branch and counts were written onto B's board.
// Per-session switching (MACLEOD-524) makes that an ordinary Tuesday for
// a contractor and, unlike the outbox (MACLEOD-583), it needs no outage
// and no queue: it is every report.
//
// The answer is to refuse rather than to re-key. A binding records the
// organisation it was made under; one made under another does not speak
// here, and `teamflow work-on <KEY>` under this one is what makes it
// speak. Nothing is migrated and nothing is moved, so the worst this
// code can do wrong is a ticket that stops advancing -- which `status`,
// `doctor` and the session-start notice say out loud.

/**
 * The organisation to stamp a binding with, or undefined when this
 * install has none to stamp.
 *
 * `accountScope` falls back to the tenant where there is no credential,
 * and the tenant tells no two organisations apart. Stamping that would
 * be a lie that refuses the person's own binding the moment they sign
 * in, so an install with no credential stamps nothing and refuses
 * nothing: it behaves exactly as it always has.
 */
export function organisationScope(config = {}) {
  const scope = accountScope(config);
  return scope && !isLegacyScope(scope) ? scope : undefined;
}

/**
 * "This machine cannot name an organisation", said out loud.
 *
 * Every service report names the organisation it belongs to, and
 * `postEnvelope` refuses one that does not (MACLEOD-601 audit, finding
 * 3). A CI token exchanged against a service that named no account is
 * the one credential that legitimately has no answer, and it still has
 * to be able to report — so it says this, which is an argument
 * somebody typed rather than an argument somebody forgot.
 *
 * Never a real scope: `scopeOf` only ever mints `account-` and `fp-`
 * names, and a tenant literally called `unscoped` is a legacy scope,
 * which `organisationScope` already answers `undefined` for.
 */
export const UNSCOPED = 'unscoped';

/** The organisation a report from this configuration belongs to. */
export function reportScope(config = {}) {
  return organisationScope(config) || UNSCOPED;
}

/**
 * The user binding for THIS organisation.
 *
 * A second directory beside the tenant one, never a re-keying of it: an
 * older plugin goes on reading `bindings/<tenant>/`, which is neither
 * moved nor deleted, and two organisations on one machine stop
 * overwriting each other's ticket — bind under B and A's binding is
 * still there when the next session switches back.
 *
 * Undefined where there is no organisation, and the tenant file is then
 * the only one there has ever been.
 */
export function accountBindingPath(cwd, config = {}) {
  const scope = organisationScope(config);
  if (!scope) return undefined;
  return path.join(dataDir(), 'bindings', scope, `${projectId(repositoryRoot(cwd))}.json`);
}

/** Where a user binding written now goes. */
export function userBindingPath(cwd, config = {}) {
  return accountBindingPath(cwd, config) || projectBindingPath(cwd, config);
}

/** The user binding files, this organisation's before the shared one. */
export function userBindingPaths(cwd, config = {}) {
  const own = accountBindingPath(cwd, config);
  const legacy = projectBindingPath(cwd, config);
  return own ? [own, legacy] : [legacy];
}

/** The user binding in force: this organisation's file, else the shared one. */
export function readUserBinding(cwd, config = {}) {
  for (const file of userBindingPaths(cwd, config)) {
    const found = readJson(file);
    if (found?.jiraKey) return found;
  }
  return undefined;
}

/**
 * The shared binding, once this organisation's own file has taken over
 * and names a different ticket.
 *
 * Two copies of the plugin run on one machine as a matter of course —
 * Claude Code's cached release fires the hooks while a checkout's CLI
 * binds — and the older copy reads only `bindings/<tenant>/`. Leaving a
 * superseded file there would have that copy attribute today's work to
 * yesterday's ticket, silently, which is worse than attributing it to
 * nothing.
 *
 * So the superseded file goes, and it is the one place this change
 * removes anything an older plugin reads. The rule it bends
 * (MACLEOD-583: never delete what an older version reads) was written
 * about a workflow nothing re-creates; a binding is re-created by the
 * command that was just run. What is NOT done is the other repair —
 * mirroring this binding into the shared file so the older copy stays
 * right — because that file is shared by every organisation, and
 * writing this organisation's ticket into it would hand the key to an
 * older copy signed in as another. A stale ticket is a bug; that would
 * be this ticket.
 */
export function retireSharedBinding(cwd, config = {}, key = undefined) {
  const shared = projectBindingPath(cwd, config);
  // No organisation: the shared file is the one just written.
  if (shared === userBindingPath(cwd, config)) return false;
  const held = readJson(shared);
  if (!held?.jiraKey || held.jiraKey === key) return false;
  try {
    fs.unlinkSync(shared);
    return true;
  } catch {
    return false;
  }
}

/**
 * The organisations this data directory holds state for.
 *
 * Used for one question only: whether an UNSTAMPED binding — written
 * before this version, or by a plugin that had no organisation — may be
 * adopted by whoever is signed in. On a machine that has only ever held
 * one organisation's state there is nobody else it could belong to; on
 * one that has held two there is no safe guess, so it is refused until
 * somebody re-binds it.
 *
 * The evidence is state other subsystems wrote for their own reasons,
 * and never a record this rule keeps for itself. A record of its own
 * would begin the day this version is installed, and the first
 * organisation to ask would answer in its own favour by having written
 * it; that is the mistake MACLEOD-583 made and undid.
 *
 * Every store on this machine that names an organisation is read, and
 * the reason is that the cheap subset is not a safe subset (MACLEOD-586
 * audit, finding 2). The projects cache was the load-bearing one and it
 * is written only by a `resolveProject` that answered: the hook asks
 * with a 1.5 second budget and caches nothing on a timeout. So an
 * organisation that worked here through an outage — queueing reports,
 * writing session state, never reaching the projects route — left no
 * trace in it at all, and its binding would have been adopted by the
 * next organisation to sign in. The queue and the session files record
 * that organisation for their own purposes, so they answer it.
 *
 * What is left is narrow and stated rather than hidden: an organisation
 * that has signed in on this machine and then done nothing whatever —
 * no report queued or sent, no session, no project, no workflow, no
 * binding — leaves nothing behind, and an unstamped binding would be
 * adopted with it present. `outbox-discards.json` is deliberately not
 * read: it is two counters and names nobody.
 *
 * `readable` is the other half of the answer, and it is why this
 * returns a pair. All of this evidence lives in the user data
 * directory, which is exactly the directory a sandboxed worktree agent
 * cannot read — the case `.teamflow/binding.json` exists for. There
 * every listing throws, "nobody else has been here" would be a
 * statement about a directory nobody looked in, and a pre-upgrade local
 * binding left by another organisation's agent is a realistic
 * dogfooding artefact. So unreadable is not empty: it is unknown, and
 * an unstamped binding is refused rather than adopted on it. A data
 * directory that does not exist yet IS empty, and says so — nothing can
 * have been left in a directory that was never created.
 */
function organisationsSeen(config = {}) {
  const seen = new Set();
  const add = (name) => { if (name && !isLegacyScope(String(name))) seen.add(String(name)); };
  add(organisationScope(config));
  let readable;
  try {
    fs.readdirSync(dataDir());
    readable = true;
  } catch (error) {
    readable = error?.code === 'ENOENT';
  }
  try {
    for (const key of Object.keys(readJson(workflowsPath(), {}) || {})) add(key);
  } catch { /* an unreadable store is no evidence either way */ }
  // One file or directory per organisation: the name is the answer.
  for (const dir of ['projects', 'bindings']) {
    try {
      for (const name of fs.readdirSync(path.join(dataDir(), dir))) {
        add(name.endsWith('.json') ? name.slice(0, -'.json'.length) : name);
      }
    } catch { /* never written on this machine */ }
  }
  // The actors of every session this machine has run, which this
  // version stamps on every hook event.
  try {
    for (const name of fs.readdirSync(path.join(dataDir(), 'sessions'))) {
      if (name.endsWith('.json')) add(readJson(path.join(dataDir(), 'sessions', name))?.account);
    }
  } catch { /* no session has ever been written here */ }
  // And what is waiting to be delivered, which carries the owner that
  // queued it (MACLEOD-583) — the one record an outage cannot suppress,
  // because an outage is what creates it.
  try {
    for (const name of fs.readdirSync(outboxDir())) {
      if (name.endsWith('.json')) add(scopeOf(ownerId(readJson(path.join(outboxDir(), name))?.owner)));
    }
  } catch { /* nothing queued */ }
  return { seen, readable };
}

/**
 * Whether a binding may speak for the organisation signed in now, and
 * why not when it may not.
 *
 * Undefined means it speaks. That is the answer for every binding on a
 * single-organisation machine and for every install with no credential,
 * which is what keeps this change invisible to nearly everybody.
 */
export function bindingRefusal(record, config = {}) {
  const key = record?.jiraKey || record?.key;
  if (!key) return undefined;
  const account = organisationScope(config);
  if (!account) return undefined;
  const boundTo = typeof record.account === 'string' && record.account ? record.account : undefined;
  if (boundTo) return boundTo === account ? undefined : { key, account, boundTo };
  const { seen, readable } = organisationsSeen(config);
  const others = [...seen].filter((one) => one !== account).sort();
  if (others.length) return { key, account, others };
  // Nothing found, and no way to know whether that means nothing is
  // there: a sandboxed agent cannot read the directory the evidence
  // lives in (MACLEOD-586 audit).
  return readable ? undefined : { key, account, unreadable: true };
}

/** The record, or nothing at all when it belongs to another organisation. */
export function usableBinding(record, config = {}) {
  return bindingRefusal(record, config) ? undefined : record;
}

/**
 * A binding another organisation made for this repository.
 *
 * For the explanation and never for a candidate. One file per
 * organisation means the files this session can read are silent about
 * the one it must not use, so without this a person who switched
 * organisation would see no ticket, no error and no reason — which is
 * the failure mode the whole plugin is built to avoid. The key is read
 * only to be said back to the person who bound it, on this machine.
 */
function otherOrganisationBinding(cwd, config = {}) {
  const account = organisationScope(config);
  if (!account) return undefined;
  const file = `${projectId(repositoryRoot(cwd))}.json`;
  let dirs;
  try { dirs = fs.readdirSync(path.join(dataDir(), 'bindings')).sort(); } catch { return undefined; }
  for (const dir of dirs) {
    if (dir === account || isLegacyScope(dir)) continue;
    const held = readJson(path.join(dataDir(), 'bindings', dir, file));
    if (held?.jiraKey) return { ...held, account: held.account || dir };
  }
  return undefined;
}

/**
 * Why this repository is reporting nothing, from the binding files
 * already in hand.
 *
 * A file that speaks ends the question: this organisation has a binding
 * here and there is nothing to explain. Only when none of them speaks
 * is another organisation's file looked for, which is also the only
 * case where the extra read costs anything.
 */
function refusalFrom(records, cwd, config) {
  for (const record of records) {
    const refusal = bindingRefusal(record, config);
    if (refusal) return refusal;
  }
  if (records.some((one) => one?.jiraKey)) return undefined;
  return bindingRefusal(otherOrganisationBinding(cwd, config), config);
}

/** The refusal in force for this repository, for `status` and `doctor`. */
export function bindingRefusalFor(cwd, config = {}) {
  return refusalFrom([readJson(localBindingPath(cwd)), readUserBinding(cwd, config)], cwd, config);
}

/** An organisation scope as a person would name it. */
function scopeName(scope) {
  if (!scope) return 'an unknown organisation';
  return scope.startsWith('account-') ? scope.slice('account-'.length) : 'a credential that names no organisation';
}

/**
 * Why nothing is being reported under this ticket, in one line.
 *
 * It names the remedy, because a refusal a person cannot act on is a
 * ticket that has stopped moving for a reason nobody can find.
 */
export function refusalLine(refusal) {
  if (!refusal) return undefined;
  const unstamped = 'it was bound before TeamFlow recorded which organisation a binding belongs to';
  const because = refusal.boundTo
    ? `it was bound under ${scopeName(refusal.boundTo)}`
    : refusal.unreadable
      ? `${unstamped}, and nothing here can read the data directory to see whose it is`
      : `${unstamped}, and this machine holds work for ${refusal.others.map(scopeName).join(', ')} as well`;
  return `Nothing is synced for ${refusal.key}: ${because}, and this session syncs to TeamFlow `
    + `under ${scopeName(refusal.account)}. Run \`teamflow work-on ${refusal.key}\` to bind it `
    + 'here, or `teamflow org switch` to sync under the organisation it belongs to.';
}

// --- the workflows this machine knows about (MACLEOD-540) -----------
//
// The file lives here rather than in workflow.mjs because a hook has to
// read it -- every report says which run it belongs to -- and core.mjs
// is what a hook already imports. workflow.mjs owns deciding what goes
// in it; this owns where it is and how it is keyed.
//
// Keyed by the organisation the credential resolves to: a member can
// hold seats in several and switches between them per session, so one
// org's runs must not appear in another's, and must never be published
// to it. It was keyed by `tenantId`, which reads as the same thing and
// is not — see `workflowScope` (MACLEOD-583).

export function workflowsPath() {
  return path.join(dataDir(), 'workflows.json');
}

// The organisation, not the S3 tenant (MACLEOD-583). `tenantId` is
// `default` on every service install, so keying by it put two
// organisations' runs in one bucket: `teamflow workflow ticket` under B
// would find, advance and *publish* a plan created under A, with B's
// credential and therefore into B's tenant.
export function workflowScope(config = {}) {
  return accountScope(config) || 'unknown';
}

/**
 * A bucket keyed by something that is not an organisation: `default`,
 * or whatever `TEAMFLOW_TENANT_ID` was set to, as written by any plugin
 * before 0.3.14.
 *
 * `account-` and `fp-` are reserved prefixes: `accountScope` mints them
 * and nothing else may. Two consequences, both accepted rather than
 * fixed, because prefixing the tenant keys too would be a migration of
 * the one file this whole ticket is about not migrating.
 *
 * A tenant literally named `account-x` reads as an organisation bucket,
 * so its runs are never offered for adoption. That is a false negative
 * — the person keeps their data and must move it by hand — and never a
 * false positive, which is the right direction to fail in.
 *
 * And the two keyspaces are not disjoint: `accountScope` maps
 * organisation `x` to `account-x`, so a credential-less S3 install with
 * `TEAMFLOW_TENANT_ID=account-x` sharing a data directory with a
 * service install for organisation `x` would share one bucket. It takes
 * both installs, one directory and an adversarially chosen tenant name.
 */
function isLegacyScope(key) {
  return !/^(account|fp)-/.test(String(key));
}

/**
 * Runs an older plugin left under a tenant name, waiting to be claimed.
 *
 * They are NOT read as this organisation's, ever. There was a rule here
 * that said "the one organisation this data directory has reported
 * for", and it could not work: the evidence was a file that begins the
 * day this version is installed and that every successful report writes
 * to, so the first organisation to send one hook event answered the
 * question in its own favour. On the exposed machine — a consultant,
 * two organisations, one data directory — that showed one customer's
 * plan in the other's terminal, let `teamflow workflow ticket` publish
 * it into the wrong tenant, and overwrote the first customer's run.
 *
 * There is no safe automatic answer: the fact needed is history from
 * before anything recorded it. So it is asked out loud instead —
 * `teamflow workflow show` says a run is there and `teamflow workflow
 * adopt` claims it, on the say-so of the one person who knows.
 *
 * This organisation having runs of its own ends the question: its own
 * bucket wins, silently, and nothing is offered.
 */
export function unclaimedWorkflows(config = {}) {
  const all = readJson(workflowsPath(), {}) || {};
  const scope = workflowScope(config);
  if (Object.keys(all[scope]?.workflows || {}).length) return [];
  const found = [];
  for (const [key, bucket] of Object.entries(all)) {
    if (key === scope || !isLegacyScope(key)) continue;
    for (const [id, workflow] of Object.entries(bucket?.workflows || {})) {
      found.push({
        from: key,
        id,
        name: workflow?.name || id,
        status: workflow?.status,
        tickets: (workflow?.tickets || []).length,
      });
    }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Claim one of them for this organisation, by id.
 *
 * Copies, never moves and never deletes: an older plugin on this
 * machine goes on reading the bucket it wrote, and nothing a newer
 * version does destroys what an older one left.
 *
 * `from` names the bucket when two of them hold the same id — two
 * `TEAMFLOW_TENANT_ID` values on one machine — because otherwise this
 * would silently take whichever sorted first and the person could not
 * ask for the other. Undefined when the id is not on offer, when it is
 * ambiguous and `from` does not resolve it, or when the file changed
 * under us between the offer and the write.
 */
export function adoptWorkflow(id, config = {}, { from } = {}) {
  const matches = unclaimedWorkflows(config)
    .filter((row) => row.id === id && (!from || row.from === from));
  if (matches.length !== 1) return undefined;
  const [offered] = matches;
  const all = readJson(workflowsPath(), {}) || {};
  const source = all[offered.from]?.workflows?.[id];
  // The listing was read a moment ago and this is a second read of the
  // same file. A CLI is the only caller, so a race here is somebody
  // editing the file by hand — answer "no" rather than throwing.
  if (!source) return undefined;
  const scope = workflowScope(config);
  const mine = all[scope] || { current: null, workflows: {} };
  mine.workflows = { ...(mine.workflows || {}), [id]: source };
  // Cannot clobber a live `current`, and the reason is two functions
  // away: `unclaimedWorkflows` offers nothing once this scope holds any
  // workflow, so adopt is unreachable unless `current` is already null.
  // Relax that guard, or add a caller that skips the offer, and this
  // line starts overwriting whatever run somebody is in the middle of.
  mine.current = id;
  all[scope] = mine;
  fs.mkdirSync(path.dirname(workflowsPath()), { recursive: true });
  writeJson(workflowsPath(), all);
  return offered;
}

/**
 * Reading never migrates, never falls back and never writes.
 *
 * Two plugin versions share this file in ordinary life — Claude Code
 * runs the cached release while a checkout or `npx` runs another, and
 * an upgrade can be followed by a downgrade. Re-keying in place would
 * take the customer's running workflow away from whichever version did
 * not do the re-keying; reading another key would take another
 * organisation's run. This organisation's bucket, and nothing else.
 */
export function readWorkflows(config = {}, where = undefined) {
  const all = readJson(workflowsPath(), {}) || {};
  const mine = all[workflowScope(config)] || {};
  const workflows = mine.workflows || {};
  // A converted ad hoc item (MACLEOD-639, ADHOC-15) is renamed on every
  // read, so a local copy can never publish the ADHOC node back.
  const aliases = readKeyAliases(config);
  if (Object.keys(aliases).length) {
    for (const workflow of Object.values(workflows)) applyKeyAliases(workflow, aliases);
  }
  const place = runPlace(where);
  const { current, via } = currentRun(mine, workflows, place);
  return { current, workflows, place, via, readCurrent: current, repos: { ...(mine.repos || {}) } };
}

// --- which run is current, per session (MACLEOD-761) ------------------
//
// One `current` per organisation for the whole machine let a second
// Claude Code session, in another repository, take over the first one's
// run: its `workflow create` became current and every agent the first
// session dispatched afterwards joined it. The current run is now kept
// per session and per repository, beside the old field:
//
//   { current, workflows, sessions: { <session id>: { run, at } },
//     repos: { <owner/repo, else the root>: run } }
//
// `current` is still written, so an older plugin on the same machine
// keeps reading a run. This version reads it only for a run from before
// this change (no `repo` of its own) whose filter does not rule this
// repository out. A run made now carries its `repo`, and is never
// another repository's by way of `current`.

const SESSION_POINTERS = 200;

/** Where a command or a hook runs: its session, its repository and, when known, its project. */
export function runPlace(where) {
  if (!where || typeof where !== 'object') return undefined;
  let repo = typeof where.repository === 'string' && where.repository.trim()
    ? where.repository.trim().toLowerCase() : undefined;
  if (!repo && where.cwd) { try { repo = repositoryRoot(where.cwd); } catch { repo = undefined; } }
  const place = {};
  if (where.sessionId) place.session = String(where.sessionId);
  if (repo) place.repo = repo;
  if (typeof where.project === 'string' && where.project.trim()) place.project = where.project.trim();
  return Object.keys(place).length ? place : undefined;
}

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * Whether work from `place` belongs in `run`: the run's project (its
 * filter's, else the one it was made in) when both are known, else its
 * repository. Anything unknown fits: a guard that refused on a guess
 * would split one person's plan in two.
 */
export function fitsRun(run, place) {
  if (!run || !place) return true;
  const wanted = run.filter?.project || run.project;
  if (wanted && place.project) return sameName(wanted, place.project);
  if (run.repo && place.repo) return run.repo === place.repo;
  return true;
}

function currentRun(mine, workflows, place) {
  const held = (id) => (id && workflows[id] ? id : null);
  if (!place) return { current: held(mine.current), via: mine.current ? 'legacy' : null };
  const bySession = place.session ? held(mine.sessions?.[place.session]?.run) : null;
  if (bySession) return { current: bySession, via: 'session' };
  const byRepo = place.repo ? held(mine.repos?.[place.repo]) : null;
  if (byRepo) return { current: byRepo, via: 'repo' };
  const legacy = held(mine.current);
  if (legacy && !workflows[legacy].repo && fitsRun(workflows[legacy], place)) return { current: legacy, via: 'legacy' };
  return { current: null, via: null };
}

/**
 * The pointers as they will be written. This place's are set when its
 * current run changed, or was already its own; a run it only inherited
 * from the old field is not claimed by being read.
 */
function pointersFor(mine, state) {
  const sessions = { ...(mine.sessions || {}) };
  const repos = { ...(mine.repos || {}) };
  const place = state.place;
  const chosen = state.current && (state.current !== state.readCurrent || (state.via && state.via !== 'legacy'));
  if (place && chosen) {
    if (place.session) sessions[place.session] = { run: state.current, at: new Date().toISOString() };
    if (place.repo) repos[place.repo] = state.current;
  }
  const kept = Object.entries(sessions)
    .filter(([, v]) => v && typeof v === 'object' && v.run)
    .sort((a, b) => String(b[1].at || '').localeCompare(String(a[1].at || '')))
    .slice(0, SESSION_POINTERS);
  const out = {};
  if (kept.length) out.sessions = Object.fromEntries(kept);
  if (Object.keys(repos).length) out.repos = repos;
  return out;
}

// --- converted ad hoc items (MACLEOD-639, ADHOC-15) -------------------
//
// `teamflow adhoc convert` turns `ADHOC-<n>` into a tracker ticket; the
// service records the alias and moves the card. This machine keeps its
// own copy of what each ad hoc key became -- written by the convert
// command, and by any report the service answered with `converted_to`
// -- so the session binding, the binding files and the local workflow
// copies follow it without asking the service again. Keyed by the
// organisation like workflows.json, for the same reason.

export function keyAliasesPath() {
  return path.join(dataDir(), 'aliases.json');
}

/** `{ 'ADHOC-3': { to, tracker, at } }` for this organisation. */
export function readKeyAliases(config = {}) {
  const all = readJson(keyAliasesPath(), {}) || {};
  const mine = all[workflowScope(config)];
  return mine && typeof mine === 'object' ? mine : {};
}

export function recordKeyAlias(from, to, config = {}, { tracker } = {}) {
  if (!isAdHocKey(from) || !to || isAdHocKey(to)) return false;
  const all = readJson(keyAliasesPath(), {}) || {};
  const scope = workflowScope(config);
  all[scope] = {
    ...(all[scope] || {}),
    [String(from).toUpperCase()]: { to: String(to), ...(tracker ? { tracker } : {}), at: new Date().toISOString() },
  };
  try {
    fs.mkdirSync(path.dirname(keyAliasesPath()), { recursive: true });
    writeJson(keyAliasesPath(), all);
    return true;
  } catch {
    return false;
  }
}

// --- ad hoc work into tickets (MACLEOD-642) ---------------------------
//
// The organisation may turn ad hoc work into tickets: automatically, which
// the service does on its own, or after the person says yes. For "ask
// first" the report's answer carries `adhoc_ticket: {mode, tracker, key}`
// and the session hears one line, once per item: this file remembers which
// items it was said for, keyed by organisation like aliases.json.

const TRACKER_WORDS = { linear: 'Linear', github: 'GitHub', jira: 'Jira' };

export function adhocAskedPath() {
  return path.join(dataDir(), 'adhoc-asked.json');
}

/** The one line the coding agent reads. Words for a person, a command to run on a yes. */
export function adhocTicketLine(key, tracker) {
  const word = TRACKER_WORDS[tracker] || tracker;
  return `This work has no ticket. Ask the person whether to make one in ${word}. `
    + `If they agree, run \`teamflow adhoc ticket ${key}\`.`;
}

/**
 * The line for an "ask first" answer, the first time only; undefined after,
 * for any other answer, and when this machine cannot remember it said it
 * (a line it cannot stop repeating is worse than none).
 */
export function askAboutTicketOnce(answer, config = {}) {
  if (answer?.mode !== 'ask' || !isAdHocKey(answer.key) || !TRACKER_WORDS[answer.tracker]) return undefined;
  const key = String(answer.key).toUpperCase();
  const all = readJson(adhocAskedPath(), {}) || {};
  const scope = workflowScope(config);
  if (all[scope]?.[key]) return undefined;
  all[scope] = { ...(all[scope] || {}), [key]: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(adhocAskedPath()), { recursive: true });
    writeJson(adhocAskedPath(), all);
  } catch {
    return undefined;
  }
  return adhocTicketLine(key, answer.tracker);
}

/**
 * Rename `from` to `to` in one workflow, in place. True when anything moved.
 *
 * The mirror of `rename_workflow` in adapters/teamflow/convert.py: the
 * node keeps its phase, rank, state, cycle and note and says it was
 * converted; every edge is repointed both ways with its reason kept; a
 * node or edge that would duplicate one already there is dropped.
 */
export function renameWorkflowKey(workflow, from, to) {
  if (!workflow || !from || !to) return false;
  let changed = false;
  const tickets = Array.isArray(workflow.tickets) ? workflow.tickets : [];
  const held = new Set(tickets.map((t) => t.key));
  const out = [];
  for (const t of tickets) {
    if (t.key === from) {
      changed = true;
      if (!held.has(to)) out.push({ ...t, key: to, addedBy: 'converted' });
      continue;
    }
    out.push(t);
  }
  if (changed) workflow.tickets = out;
  if (Array.isArray(workflow.dependencies)) {
    const seen = new Set();
    const deps = [];
    for (const d of workflow.dependencies) {
      const e = { ...d };
      if (e.from === from) { e.from = to; changed = true; }
      if (e.on === from) { e.on = to; changed = true; }
      const pair = `${e.from}\u0000${e.on}`;
      if (e.from === e.on || seen.has(pair)) { changed = true; continue; }
      seen.add(pair);
      deps.push(e);
    }
    workflow.dependencies = deps;
  }
  for (const phase of workflow.phases || []) {
    if (!(phase.tickets || []).includes(from)) continue;
    changed = true;
    phase.tickets = [...new Set(phase.tickets.map((k) => (k === from ? to : k)))];
  }
  if (workflow.stalledOn?.key === from) {
    workflow.stalledOn = { ...workflow.stalledOn, key: to };
    changed = true;
  }
  return changed;
}

export function applyKeyAliases(workflow, aliases = {}) {
  let changed = false;
  for (const [from, alias] of Object.entries(aliases)) {
    if (alias?.to && renameWorkflowKey(workflow, from, alias.to)) changed = true;
  }
  return changed;
}

/**
 * The session and this directory's binding files follow a converted key.
 *
 * Called on every hook before the binding is chosen, and after a report
 * the service answered with `converted_to`. One file read when nothing
 * was ever converted. True when anything was rebound.
 */
export function followKeyAliases(state, cwd, config = {}) {
  const aliases = readKeyAliases(config);
  if (!Object.keys(aliases).length) return false;
  const hop = (key) => (isAdHocKey(key) ? aliases[String(key).toUpperCase()] : undefined);
  let moved = false;
  const bound = state?.binding && hop(state.binding.key);
  if (bound) {
    state.binding = { ...state.binding, key: bound.to, ...(bound.tracker ? { tracker: bound.tracker } : {}) };
    moved = true;
  }
  const named = state?.jira && hop(state.jira.key);
  if (named) state.jira = { ...state.jira, key: named.to };
  /*
   * The node minted for a dispatched agent follows too (MACLEOD-726, census
   * fix 4). Left behind, the agent's binding moved to the ticket while its
   * node kept the ad hoc key, so the agent read as "moved to" its own
   * ticket, and its end never closed the node the board shows.
   */
  const minted = state?.dispatch && hop(state.dispatch.key);
  if (minted) {
    state.dispatch = { ...state.dispatch, key: minted.to, was: String(state.dispatch.key).toUpperCase() };
    moved = true;
  }
  /*
   * The history belongs to the work, and the work kept going under a new
   * name. `withHistory` starts both lists again when the bound key and
   * `historyKey` differ -- right for a session rebound to another ticket,
   * wrong here -- so the history's key follows the alias too, and the
   * next report carries the transitions and rework it had.
   */
  const kept = state && hop(state.historyKey);
  if (kept) state.historyKey = kept.to;
  if (cwd) {
    for (const file of [localBindingPath(cwd), ...userBindingPaths(cwd, config)]) {
      const held = readJson(file);
      const alias = held && hop(held.jiraKey);
      if (!alias) continue;
      const record = { ...held, jiraKey: alias.to, convertedFrom: held.jiraKey };
      if (alias.tracker) record.tracker = alias.tracker;
      delete record.adhoc;
      try { writeJson(file, record); moved = true; } catch { /* the session binding still moved */ }
    }
  }
  return moved;
}

/**
 * Writing is additive and touches one key: this organisation's.
 *
 * It used to mirror into the tenant-keyed bucket as well, so an older
 * plugin would keep reading the same run. That mirror overwrote
 * whatever was in that bucket — which, on a machine two organisations
 * share, is the other organisation's work. An older plugin catching up
 * is not worth destroying a run nothing re-creates, so it does not, and
 * `teamflow workflow adopt` is how a run crosses the versions instead.
 */
export function writeWorkflows(state, config = {}) {
  const all = readJson(workflowsPath(), {}) || {};
  const scope = workflowScope(config);
  const mine = all[scope] || {};
  // The pointers survive every writer (MACLEOD-761): a caller that read
  // without a place must not wipe each session's current run. `current`
  // stays the last run anybody chose, for an older plugin.
  const legacy = state.place && !state.current ? (mine.current || null) : (state.current ?? mine.current ?? null);
  all[scope] = { current: legacy, workflows: state.workflows, ...pointersFor(mine, state) };
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
/**
 * The run statuses that mean nothing more will happen (MACLEOD-601).
 *
 * The single answer to "is this run still live", because three places
 * needed it and two of them had written their own: `workflowRef` here,
 * `ticketWorkflow` in the dashboard, and `backfillCards`, which asked
 * `status === 'running'` and thereby called a BLOCKED run finished. A
 * blocked run is live — `openTickets` counts a blocked ticket as open
 * and `finishRun` refuses to finish over one — so backfilling its hints
 * silenced its stale cards permanently, with no command able to recover
 * them.
 *
 * Here in core.mjs rather than in workflow.mjs because core is what a
 * hook already imports and what workflow.mjs imports from, so this is
 * the one direction the dependency can point.
 */
export const RUN_OVER = ['done', 'cancelled', 'archived'];

/** True when a run is over. Anything else — including `blocked` — is live. */
export function isOver(workflow) {
  return RUN_OVER.includes(workflow?.status);
}

export function workflowRef(key, config = {}) {
  if (!key) return undefined;
  const { workflows } = readWorkflows(config);
  const holding = Object.values(workflows)
    .filter((w) => (w.tickets || []).some((t) => t.key === key));
  if (!holding.length) return undefined;
  // How over a run is (MACLEOD-601). Not a boolean: `archived` is more
  // over than `done`, because tidy archives a run precisely to get it
  // out of the way -- and it is archived NOW, so a recency tie-break
  // would otherwise let it win over the run that actually delivered.
  const live = (w) => (w.status === 'archived' ? 2 : isOver(w) ? 1 : 0);
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
const TRACE_EVENTS = new Set([
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Notification', 'Stop',
  'SubagentStart', 'SubagentStop', 'PreCompact', 'SessionStart', 'SessionEnd',
  'PostToolUseFailure', 'TaskCompleted',
]);
const TRACE_BUILTIN = /^[A-Z][A-Za-z]{0,29}$/;
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
   * `event` and `tool` are VALUES rather than key names, so neither is
   * written as it arrived. The events are a closed vocabulary and are
   * listed. A tool is written only when it is one of Claude Code's own,
   * which Claude Code names and which are letters and nothing else; an
   * MCP tool is named by its server, a 40-character identifier is also
   * the shape of an access token, and so every `mcp__…` is written as
   * `mcp` and which one it was is given up.
   */
  const event = String(input?.hook_event_name || '');
  const tool = String(input?.tool_name || '');
  return {
    at: new Date().toISOString(),
    event: TRACE_EVENTS.has(event) ? event : 'Unknown',
    tool: tool.startsWith('mcp__') ? 'mcp' : TRACE_BUILTIN.test(tool) ? tool : undefined,
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
 * An agent actor that never started (MACLEOD-641, audit K4): made by a
 * `SubagentStop` for an agent this machine never saw begin. No task, no
 * type, the placeholder name, still at BACKLOG, and a start and end
 * under a second apart.
 * The hook no longer writes these; older plugins wrote thousands.
 */
export function isPhantomAgent(actor) {
  const agent = actor?.agent;
  if (!actor?.agentKey || !agent || agent.task || agent.type) return false;
  // It did no work: a phantom is made at BACKLOG and never leaves it.
  if (actor.stage && actor.stage !== 'BACKLOG') return false;
  if (agent.name && agent.name !== 'Agent') return false;
  const start = Date.parse(agent.startedAt || '');
  const end = Date.parse(agent.endedAt || '');
  return Number.isFinite(start) && Number.isFinite(end) && Math.abs(end - start) < 1000;
}

const PURGED = '.purged-phantom-agents';

/**
 * Once per data folder, delete the phantom agent files an older plugin
 * wrote, and with them the ends they still owed (MACLEOD-641). The
 * adoptOldData pattern: a marker makes it once, and it never throws.
 * Returns how many it removed, or false when it did not run.
 */
export function purgePhantomAgents(dir = dataDir()) {
  try {
    if (fs.existsSync(path.join(dir, PURGED))) return false;
    const sessions = path.join(dir, 'sessions');
    let removed = 0;
    for (const name of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
      if (!name.endsWith('.json') || !isPhantomAgent(readJson(path.join(sessions, name)))) continue;
      fs.rmSync(path.join(sessions, name), { force: true });
      removed += 1;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, PURGED), new Date().toISOString());
    return removed;
  } catch {
    return false;
  }
}

/**
 * Whether an owed end is older than a report this machine has since made
 * on the same key (MACLEOD-641, audit K5). Sent a day late, such an end
 * put an old stage back on the card; the newer report already said more.
 */
export function supersededEnd(actor, actors = []) {
  const key = actor?.binding?.key;
  const at = Date.parse(actor?.updatedAt || '') || 0;
  return Boolean(key) && actors.some((other) => other.binding?.key === key
    && (other.sessionId !== actor.sessionId || other.agentKey !== actor.agentKey)
    && (Date.parse(other.lastPublishedAt || '') || 0) > at);
}

/** Every actor file on this machine. Local files only. */
export function allActors() {
  const dir = path.join(dataDir(), 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(dir, name))).filter(Boolean);
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
 * Every actor on this machine that is still working on one ticket.
 *
 * MACLEOD-601. When the run says a ticket is verified, an actor still
 * standing at `running` on it is an agent that finished hours ago and
 * never sent a `SubagentStop` -- its worktree was removed, its process
 * was killed, or the session it belonged to was cleared. `SessionEnd`
 * flags what it can see; this is for the ones nothing flagged, found by
 * the fact the run knows and they do not: the ticket is over.
 *
 * Scoped to this organisation, unconditionally. `sessions/` is one
 * directory per machine, shared by every repository and every client on
 * it, so an unscoped sweep over a key reaches another customer's actor
 * on a ticket that happens to be spelled the same -- and the caller
 * would then publish it. An actor written before organisations were
 * recorded names none and is left to whoever can say whose it is.
 */
export function actorsForKey(key, config = {}) {
  const wanted = String(key || '').trim();
  if (!wanted) return [];
  const dir = path.join(dataDir(), 'sessions');
  if (!fs.existsSync(dir)) return [];
  const mine = organisationScope(config);
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(dir, name)))
    .filter((state) => state?.binding?.key === wanted)
    .filter((state) => Boolean(mine) && state.account === mine)
    .sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')));
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
  return tool === 'Agent' || tool === 'Task' || isWorkflowTool(tool);
}

/**
 * The Workflow tool starts agents of its own, and Claude Code documents
 * no SubagentStart for them (MACLEOD-641, tracking gaps). Its PreToolUse
 * is the one hook there is, so the session records the workflow run as
 * one launch and mints it a node, as it does for an `Agent`.
 */
export function isWorkflowTool(tool) {
  return tool === 'Workflow';
}

/**
 * What a launch records from a tool's input: the `Agent` tool's own
 * fields, or a workflow run's name and description under the type
 * "workflow". Never anything else the input holds.
 */
export function launchFields(tool, toolInput = {}) {
  const given = toolInput || {};
  if (!isWorkflowTool(tool)) return given;
  return { name: given.name, description: given.description, subagent_type: 'workflow' };
}

/**
 * Record one launch. Never the prompt: `tool_input.prompt` is the whole
 * brief, model- and user-written, and `docs/REPORTING_CONTRACT.md` has
 * always said a prompt stays on the machine.
 */
export function recordLaunch(sessionId, toolInput = {}, launchedBy = undefined, represented = {}, toolUseId = undefined, promptId = undefined) {
  const name = agentLabel(toolInput.name, 64);
  const task = agentLabel(toolInput.description, 80);
  const type = agentLabel(toolInput.subagent_type, 40);
  if (!name && !task && !type) return undefined;
  // Named for the tool call when the payload carries its id (MACLEOD-639
  // audit): a hook re-entered for the same call finds its launch and
  // records nothing twice, and the call's PostToolUse finds it by name.
  const id = launchId(toolUseId);
  if (toolUseId) {
    const held = findLaunch(sessionId, id);
    if (held) return held;
  }
  const launch = { id, name, task, type, at: new Date().toISOString() };
  // A node still to be minted, on the async path (MACLEOD-639 audit):
  // PreToolUse is synchronous and spends nothing on the network.
  if (represented.pending) launch.pending = true;
  // How the board represents this agent (MACLEOD-639, ADHOC-13): the ad
  // hoc key minted for it and its derived title, or the session's own
  // key it will report under, or why neither could be had. Local, and
  // what `teamflow status` counts; the agent's first hook reads `key`.
  for (const field of ['key', 'title', 'under', 'reason', 'review', 'lens']) {
    if (represented[field]) launch[field] = String(represented[field]).slice(0, 180);
  }
  // What the agent is for (MACLEOD-722): the answer and its fixed
  // features, enums and numbers only. The prompt it was scored on is
  // not here and never was.
  if (represented.role && typeof represented.role === 'object') launch.role = represented.role;
  // The agent that launched this one, when it was an agent (MACLEOD-639):
  // its capped id, which becomes `agent.parentAgent` on the launched
  // one's rows so the board can nest them.
  if (launchedBy) launch.launchedBy = String(launchedBy).slice(0, 80);
  // The user prompt it was launched under (`prompt_id`, MACLEOD-722): a
  // batch never spans two prompts. Local only; an opaque id.
  if (typeof promptId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(promptId)) launch.promptId = promptId;
  // A file nobody else writes, named for its tool call or for nothing but
  // chance, so five of these at once are five files rather than four
  // lost updates.
  writeJson(path.join(launchesPath(sessionId), `${id}.json`), launch);
  pruneLaunches(sessionId);
  return launch;
}

/** A launch's id: the tool call's id when it is a safe file name, else a fresh one. */
export function launchId(toolUseId) {
  return typeof toolUseId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(toolUseId) ? toolUseId : crypto.randomUUID();
}

/** One launch by id, claimed or not. Local files only. */
export function findLaunch(sessionId, id) {
  if (!sessionId || !id) return undefined;
  const entry = launchFiles(sessionId).find((one) => one.name === `${id}.json` || one.name.startsWith(`${id}${CLAIMED}`));
  return entry ? { id, ...entry.launch } : undefined;
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
  // A background launch answers with an object (`{ status:
  // 'async_launched', agentId, … }`) rather than text, whose JSON puts a
  // quote on each side of the colon (MACLEOD-640).
  const text = typeof response === 'string' ? response : JSON.stringify(response ?? '');
  return /(?:^|[^A-Za-z])agentId"?:\s*"?([A-Za-z0-9_-]{1,80})/.exec(text)?.[1];
}

/** Attach an id to the newest launch that has none, so a Start can find it by id. */
export function claimLaunch(sessionId, agentId, type = undefined, toolUseId = undefined) {
  if (!agentId) return undefined;
  const unclaimed = launchFiles(sessionId).filter((entry) => !isClaimed(entry.name));
  // The launch of this very tool call, when the payload names it
  // (MACLEOD-640): three agents dispatched at once are three PostToolUse
  // events in any order, and "the newest" would swap their names.
  const own = toolUseId ? unclaimed.find((entry) => entry.name === `${launchId(toolUseId)}.json`) : undefined;
  if (own) return claimFile(own, agentId);
  const candidates = unclaimed
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
 * The keys a repository's own `.teamflow.json` is not allowed to set
 * (MACLEOD-616).
 *
 * A file inside a checkout is untrusted input: whoever published the
 * repository wrote it, and opening somebody's repository in an editor is
 * not consent to anything. It may describe the project — which tracker,
 * which workspace, which repo, what the test command is. It may not
 * decide where a credential goes or which credential is used.
 *
 * It could, until this. `serviceUrl` was merged from the project layer
 * like any other key, and `credential()` attached this machine's session
 * to whatever origin the merged config named. A repository containing
 * `{"serviceUrl": "http://attacker.example"}` collected the device
 * credential of everybody who opened it, on the first hook, with no
 * prompt and nothing visibly wrong.
 *
 * Each key here either routes a request or authenticates one:
 *
 *   * `serviceUrl` — where every report and every members call goes.
 *   * `authIssuer`, `authClientId` — who signs this machine in, and so
 *     which identity provider sees the sign-in.
 *   * `authScopes`, `authApiScope` — what the resulting token is good
 *     for. Widening them is asking for a credential nobody agreed to.
 *   * `apiKey`, `accessToken` — a credential, handed over outright.
 *   * `dataUri`, `awsProfile` — the same attack through S3: a repository
 *     choosing which of the user's AWS profiles writes where.
 *   * `oidcAudience` — what a CI token is addressed to, which is the one
 *     thing stopping a token minted here being spent elsewhere.
 *
 * The user's global file (`~/.config/teamflow/config.json`) and the
 * environment keep full power over all of them. Those are the user
 * speaking; a file that arrived with a `git clone` is not.
 *
 * The value is the environment variable that still sets it, or
 * `undefined` where the only way is the global file, so `status` and
 * `doctor` can print the remedy beside the refusal rather than leaving
 * somebody with a self-hosted service wondering why reporting stopped.
 */
export const UNTRUSTED_PROJECT_KEYS = Object.freeze({
  serviceUrl: 'TEAMFLOW_SERVICE_URL',
  authIssuer: 'TEAMFLOW_AUTH_ISSUER',
  authClientId: 'TEAMFLOW_AUTH_CLIENT_ID',
  authScopes: undefined,
  authApiScope: undefined,
  apiKey: 'TEAMFLOW_API_KEY',
  accessToken: undefined,
  dataUri: 'TEAMFLOW_DATA_URI',
  awsProfile: 'TEAMFLOW_AWS_PROFILE',
  oidcAudience: 'TEAMFLOW_OIDC_AUDIENCE',
  // Not environment variables at all, and deliberately so. `trustedOrigins`
  // is the list that lets an ambient credential leave for a service that is
  // not the hosted one, and `accessTokenOrigin` says a token was minted by
  // the service it is about to be sent to. Both are the answer to "may this
  // go there", so neither may be set by anything but the user's own file or
  // the plugin itself.
  trustedOrigins: undefined,
  accessTokenOrigin: undefined,
  // What the plugin runs and when it gives up (MACLEOD-639): the gate
  // commands `rerun_gate` executes, the deadlines, the retry policy. A
  // file inside a clone may not choose a command this machine runs on a
  // lead's say-so, so the whole block is the user's own file only.
  delivery: undefined,
});

// --- whose home this is (MACLEOD-623) --------------------------------
//
// "The user's own file" and the session are anchored on the home
// directory, and `os.homedir()` honours $HOME — which a repository can set
// (a `.claude/settings.json` "env" block, an `.envrc`). A repo-chosen HOME
// made an attacker's directory "the global file": its `serviceUrl` read as
// the user's own and its `trustedOrigins` were trusted. So these paths come
// from the account record (`os.userInfo().homedir`), which ignores $HOME.
//
// The tests redirect HOME to a throwaway, and ignoring it naively would run
// every test against the developer's real credentials — the accident that
// leaked one during MACLEOD-616. So HOME is honoured only after
// `enableTestHome()` has run IN THIS PROCESS: `plugin/tests/sandbox.mjs`
// calls it, and child processes get it only from
// `--import plugin/tests/child-sandbox.mjs`, which the test helpers add. No
// environment variable can switch it on. (Not "HOME is inside the temp
// directory": TMPDIR is repository-settable too.)
//
// It fails closed. No account record (a container with no passwd entry)
// is not a reason to fall back to $HOME; and TEAMFLOW_TEST_SANDBOX set
// where the seam never ran is a harness that forgot it — or a repository
// pretending to be one. Either way no credential is read, `status` and
// `doctor` say why, and reporting stops.

let testHome = false;

/** The one switch that lets $HOME stand: called by the test sandbox only. */
export function enableTestHome() {
  testHome = true;
}

/** Why no home can be trusted here, in words, or undefined. */
export function homeRefusal() {
  if (testHome) return undefined;
  if (process.env.TEAMFLOW_TEST_SANDBOX === '1') {
    return 'TEAMFLOW_TEST_SANDBOX is set in this environment, but this is not a TeamFlow test run, '
      + 'so TeamFlow reads no credential and reports nothing. If you did not set it yourself, the '
      + 'repository you have open did (a `.claude/settings.json` "env" block or an `.envrc`); '
      + 'unset it.';
  }
  try {
    if (os.userInfo().homedir) return undefined;
  } catch { /* no account record */ }
  return 'TeamFlow cannot tell whose home directory this is: the operating system has no account '
    + 'record for this user (a container without a passwd entry?), and $HOME is not trusted in its '
    + 'place because a repository can set it. No credential is read and nothing is reported until '
    + 'the user has one.';
}

/** Nowhere: a path that cannot be read or created, for a refused home. */
const REFUSED_HOME = path.join(os.devNull, 'teamflow-home-refused');

/** The home directory the user's own files live in (see above). */
export function userHome() {
  if (testHome) return os.homedir();
  if (homeRefusal()) return REFUSED_HOME;
  return os.userInfo().homedir;
}

/** The user's own config, the one place a repository cannot write. */
export function globalConfigPath() {
  return path.join(userHome(), '.config', 'teamflow', 'config.json');
}

/**
 * A repository's config, split into what it may say and what it may not.
 *
 * Silence is not an attempt: a key present and empty is the same nothing
 * `mergeConfig` already skips, so it is dropped without being reported
 * as ignored. Anything else that is named here is dropped *and* named,
 * because a silent ignore is a support ticket that reads "TeamFlow
 * stopped working".
 */
export function projectFacts(projectConfig = {}) {
  const facts = {};
  const ignored = [];
  for (const [key, value] of Object.entries(projectConfig || {})) {
    if (key in UNTRUSTED_PROJECT_KEYS) {
      if (value !== undefined && value !== '') ignored.push(key);
      continue;
    }
    facts[key] = value;
  }
  return { facts, ignored };
}

/** Which routing or credential keys this checkout's `.teamflow.json` tried to set. */
export function ignoredProjectKeys(cwd) {
  return projectFacts(readJson(path.join(cwd, '.teamflow.json'), {})).ignored;
}

/**
 * The one line `status` and `doctor` print about it. Names the keys, says
 * why, and gives the one remedy — because the person reading it is far
 * more likely to be a developer with a legitimate preview service than
 * anybody's attacker.
 */
export function ignoredProjectLine(keys = []) {
  if (!keys.length) return undefined;
  const remedy = keys
    .map((key) => (UNTRUSTED_PROJECT_KEYS[key] ? `${key} → ${UNTRUSTED_PROJECT_KEYS[key]}` : `${key} → global file only`))
    .join(', ');
  return `.teamflow.json set ${keys.join(', ')} — ignored: a file inside a repository may not choose `
    + 'where a credential goes or which one is used (MACLEOD-616). Set it in the environment, '
    + `or in ~/.config/teamflow/config.json: ${remedy}`;
}

/**
 * Three layers, least specific first: the global file, the project's own
 * `.teamflow.json`, then the environment. `mergeConfig` keeps that order and
 * skips the layers that are silent, so an unset variable leaves the file's
 * answer standing and a set one replaces it.
 *
 * The project layer is filtered first (`UNTRUSTED_PROJECT_KEYS`). The other
 * two are not: both are the user speaking.
 */
export function loadConfig(cwd) {
  const globalConfig = readJson(globalConfigPath(), {});
  const projectConfig = projectFacts(readJson(path.join(cwd, '.teamflow.json'), {})).facts;
  const merged = mergeConfig(globalConfig, projectConfig, {
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
  // The repository's own checks (ADHOC-20), from `.teamflow/checks.json`.
  // Read to classify a run of exactly one of those commands and to name
  // them on the report; never to run one (checks.mjs).
  merged.checks = readChecks(cwd);
  return merged;
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

/**
 * True inside a linked git worktree (`git worktree add`, `claude -w`),
 * false in a repository's main checkout and outside any repository.
 * A linked worktree's git dir is `<common>/worktrees/<name>`, so the two
 * answers differ there and nowhere else (MACLEOD-639 audit).
 */
export function isLinkedWorktree(cwd) {
  const answer = git(cwd, ['rev-parse', '--git-dir', '--git-common-dir']);
  if (!answer.ok) return false;
  const [gitDir, common] = answer.stdout.split('\n').map((line) => path.resolve(cwd, line.trim()));
  if (!gitDir || !common) return false;
  const real = (dir) => { try { return fs.realpathSync(dir); } catch { return dir; } };
  return real(gitDir) !== real(common);
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
  // A quoted message is one token (MACLEOD-640): `-m "merge: copy for
  // DEMO-7"` split on spaces made `copy`, `for` and `DEMO-7"` refs, and
  // a key named only in the message a merged branch.
  const tokens = found[1].match(/"[^"]*"?|'[^']*'?|\S+/g) || [];
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

/**
 * The issue key a `git merge <branch>` names, read from the merged
 * branch (MACLEOD-639).
 *
 * The flow that left our own audited cards in LOCAL_AUDIT for days has
 * no pull request in it: agents work in worktrees on branches named for
 * their tickets, and the main session — bound to a different ticket —
 * merges them with `git merge`. The merge was classified, but it landed
 * on the main session's key, and the merged ticket never heard. The
 * branch name is already the documented fallback for attribution, so
 * the key is read from there. Undefined when no source carries one, or
 * when two sources name two different keys and nobody can say which.
 */
export function mergedBranchKey(command) {
  const keys = new Set();
  let branch;
  for (const ref of mergeSources(command)) {
    const key = extractJiraKey(ref);
    if (!key) continue;
    keys.add(key);
    branch = ref;
  }
  if (keys.size !== 1) return undefined;
  return { key: [...keys][0], branch: String(branch).slice(0, 200) };
}

/*
 * May a merge be credited to this key? (MACLEOD-640.) A key TeamFlow
 * minted always may: it is nobody's release branch. Any other `WORD-1`
 * is a key by shape only — `git merge hotfix-3`, "bump next-15" — so it
 * must be of the bound ticket's own project, or of a prefix this machine
 * already knows (the configured prefixes, the tickets of its runs):
 * a merge never puts on the board a card no tracker of this organisation
 * holds. A GitHub tenant's keys are `repo#N`, which neither a branch nor
 * this rule reads, so only its ad hoc keys are credited.
 */
function creditable(key, state = {}, config = {}) {
  if (isAdHocKey(key)) return true;
  const tracker = state.binding?.tracker || trackerOf(config);
  if (tracker === 'github') return false;
  if (state.binding?.key && issueProject(key, tracker) === issueProject(state.binding.key, tracker)) return true;
  const seen = [];
  try {
    for (const workflow of Object.values(readWorkflows(config).workflows)) {
      for (const ticket of workflow.tickets || []) seen.push(ticket.key);
    }
  } catch { /* an unreadable runs file teaches nothing */ }
  return Boolean(knownPrefixes(config, seen)?.has(key.split('-')[0].toUpperCase()));
}

// At most this many tickets are credited by one merge.
const MERGE_KEYS_MAX = 20;

/**
 * The tickets whose work a successful `git merge` just landed on the
 * trunk (MACLEOD-640).
 *
 * Twenty ad hoc cards sat at their last step because nothing ever
 * reported their merge: the main session merges agent branches named
 * `worktree-agent-…`, which carry no key, and a key of another project
 * than the session's was dropped. The work says whose it is in two
 * places, and both are read: the keys its commit messages name, over
 * exactly the range this merge moved HEAD (the reflog entry it wrote,
 * so a merge that was already up to date credits nothing), and the
 * binding a worktree of this repository holds for the merged branch.
 *
 * On the trunk only: a merge into a work branch is a sync, not a
 * delivery. Keys only, never a message: nothing read here is kept.
 * Capped, deduplicated, and empty on any error.
 */
export function landedKeys(command, input = {}, state = {}, config = {}) {
  try {
    const cwd = input.cwd;
    if (!cwd || /already up[ -]to[ -]date/i.test(JSON.stringify(input.tool_response ?? ''))) return [];
    const trunks = new Set([...TRUNK_NAMES, defaultBranchName(cwd, config)]);
    if (!trunks.has(git(cwd, ['branch', '--show-current']).stdout.trim())) return [];
    const sources = mergeSources(command);
    // The entry this merge wrote reads `merge <ref>: …`.
    const moved = git(cwd, ['reflog', '-1', '--format=%gs']).stdout.trim();
    if (!/^merge /.test(moved) || (sources.length && !sources.some((ref) => moved.startsWith(`merge ${ref}:`)))) return [];
    const found = new Map();
    const note = (key, branch) => {
      if (key && !found.has(key) && found.size < MERGE_KEYS_MAX) found.set(key, { key, branch });
    };
    // The merged worktree's own binding: a person's or a dispatch's word.
    const worktrees = git(cwd, ['worktree', 'list', '--porcelain']).stdout.split(/\n\n+/);
    for (const block of worktrees) {
      const dir = /^worktree (.+)$/m.exec(block)?.[1];
      const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
      if (dir && branch && sources.includes(branch)) {
        note(normalizeIssueKey(readJson(localBindingPath(dir))?.jiraKey), branch);
      }
    }
    const branch = sources.length === 1 ? String(sources[0]).slice(0, 200) : undefined;
    const log = git(cwd, ['log', '--format=%B', '-n', '200', 'HEAD@{1}..HEAD']).stdout;
    for (const match of log.matchAll(ISSUE_ALL_RE)) {
      const key = match[1].toUpperCase();
      if (creditable(key, state, config)) note(key, branch);
    }
    return [...found.values()];
  } catch {
    return [];
  }
}

/**
 * The branch a `git push` sends, when the command names one. `git push`,
 * `git push -u origin HEAD` and `git push --force-with-lease` name
 * none, which means the current branch.
 */
export function pushedBranch(command) {
  const found = /\bgit\s+push\b([^;&|]*)/i.exec(String(command));
  if (!found) return undefined;
  const takesValue = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo']);
  const words = [];
  const tokens = found[1].trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--') continue;
    if (token.startsWith('-')) {
      if (takesValue.has(token)) i += 1;
      continue;
    }
    words.push(token);
  }
  // `git push <remote> <refspec>`: the refspec is the second word, and
  // `src:dst` pushes `src` to `dst`. `HEAD` is the current branch.
  const refspec = words[1];
  if (!refspec || refspec === 'HEAD') return undefined;
  const src = refspec.replace(/^\+/, '').split(':')[0].replace(/^refs\/heads\//, '');
  return src === 'HEAD' ? undefined : src;
}

/** Where a `git push` sends it, when the refspec names a destination other than the source. */
export function pushedDestination(command) {
  const found = /\bgit\s+push\b([^;&|]*)/i.exec(String(command));
  if (!found) return undefined;
  const refspec = found[1].trim().split(/\s+/).filter((t) => t && !t.startsWith('-'))[1];
  if (!refspec || !refspec.includes(':')) return undefined;
  return refspec.replace(/^\+/, '').split(':')[1].replace(/^refs\/heads\//, '') || undefined;
}

/**
 * Whether a push is of the branch this session's ticket is on
 * (MACLEOD-639): the branch it names carries the bound key, or is the
 * branch the session's last git snapshot saw, or is unnamed and the
 * current branch is not the trunk. A push of the trunk is never it.
 */
function pushesBoundBranch(command, state, config = {}) {
  const key = state.binding?.key;
  if (!key) return false;
  const trunks = new Set(TRUNK_NAMES);
  if (config.defaultBranch) trunks.add(String(config.defaultBranch));
  // `git push origin HEAD:main` from a feature branch lands on the
  // trunk: that is the merge, not the ticket going out for review.
  const destination = pushedDestination(command);
  if (destination && isTrunkRef(destination, trunks)) return false;
  const named = pushedBranch(command);
  const branch = named || state.git?.branch;
  if (!branch) return true;
  if (isTrunkRef(branch, trunks)) return false;
  if (!named) return true;
  if (extractJiraKey(named) === key) return true;
  return Boolean(state.git?.branch) && named === state.git.branch;
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
  const result = safeExec(ghBinary(),
    ['pr', 'view', '--json', PR_FIELDS],
    { cwd, timeout: Number(config.lookupTimeoutMs || 5000), env: ghEnv() });
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
  // No account record (a container without a passwd entry) throws here;
  // that is an unknown actor, not a crash (MACLEOD-623).
  let username;
  try { username = os.userInfo().username; } catch { username = ''; }
  const fallback = info.email?.split('@')[0] || info.name || username;
  const id = String(config.actorId || fallback || 'unknown').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return { id, displayName: String(config.actorName || info.name || fallback || id) };
}

export function candidate(key, confidence, source, ref = {}) {
  const normalized = normalizeIssueKey(key);
  if (!normalized) return undefined;
  const out = { key: normalized, confidence, source, tracker: ref.tracker || 'jira' };
  if (ref.boundAt) out.boundAt = ref.boundAt;
  // Which organisation bound it travels with the candidate and onto the
  // session, so a session that switches organisation mid-flight stops
  // naming the ticket it was bound to (MACLEOD-586).
  if (ref.account) out.account = ref.account;
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
  //
  // Each file is judged on its own before they are compared, so a stale
  // binding belonging to another organisation cannot suppress this
  // organisation's older one by being the newer of the two
  // (MACLEOD-586).
  const usable = (Array.isArray(manual) ? manual : [manual]).map((one) => usableBinding(one, config));
  const bound = usable.length > 1 ? preferBinding(usable[0], usable[1]) : usable[0];
  if (bound?.jiraKey) {
    // boundAt travels with the candidate: it is how a `teamflow bind` run
    // after this session started outranks the sticky binding the session
    // already holds (see chooseBinding).
    add({ key: bound.jiraKey, tracker: bound.tracker || tracker, repo: bound.repo, workspace: bound.workspace, boundAt: bound.boundAt, account: bound.account }, 1000, 'manual');
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
  const manual = [readJson(localBindingPath(cwd)), readUserBinding(cwd, config)];
  // Read here rather than asked for again later: the caller has to be
  // able to say why a bound ticket went quiet, and this is the one place
  // that has both files in hand (MACLEOD-586).
  const refused = refusalFrom(manual, cwd, config);
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
  return { candidates, info, refused };
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

const DEFAULT_GITHUB_API = 'https://api.github.com';

/**
 * Where the public issue lookup goes (MACLEOD-623).
 *
 * The host is pinned, by the rule `serviceUrl` follows: a repository can
 * set an environment variable (a `.claude/settings.json` "env" block, an
 * `.envrc`), and before this TEAMFLOW_GITHUB_API pointed title lookups at
 * whatever it named — so a hostile checkout could write card titles onto
 * the victim's board. No credential rides on this request; what it could
 * do is inject content into derived state.
 *
 * So: `api.github.com`, unless the user's OWN global file names a GitHub
 * Enterprise host as `githubApi` (https only) — the one file a repository
 * cannot reach. The environment may still point the lookup at this
 * machine, because a loopback listener is already somebody on the box
 * (that is what the tests use: a port that refuses the connection).
 */
export function githubApiBase() {
  const trim = (value) => String(value || '').trim().replace(/\/+$/, '');
  const own = trim(readJson(globalConfigPath(), {})?.githubApi);
  if (own && originOf(own)?.startsWith('https:')) return own;
  const env = trim(process.env.TEAMFLOW_GITHUB_API);
  if (env && isLoopbackOrigin(originOf(env))) return env;
  return DEFAULT_GITHUB_API;
}

/**
 * A title as it may be stored and drawn (MACLEOD-623): no control
 * characters, and no longer than GitHub itself allows (256). The lookup
 * answers with somebody else's words, and the binding file and the board
 * are where they end up — the reason `readableReason` bounds a service's
 * message (MACLEOD-613).
 */
const TITLE_MAX = 256;

export function boundedTitle(text) {
  const clean = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return [...clean].slice(0, TITLE_MAX).join('');
}

function boundedIssue(found) {
  if (!found?.title) return found;
  const title = boundedTitle(found.title);
  return title ? { ...found, title } : undefined;
}

/**
 * The `gh` the plugin runs (MACLEOD-623 audit, S2).
 *
 * TEAMFLOW_GH_BIN is the tests' stub, and only the test sandbox may name
 * one: from anywhere else it is an environment variable a repository can
 * set, naming a program this plugin would then run. "The test sandbox" is
 * the in-process flag `enableTestHome()` sets, not TEAMFLOW_TEST_SANDBOX,
 * which is itself an environment variable (MACLEOD-622 re-audit).
 */
export function ghBinary() {
  return (testHome && process.env.TEAMFLOW_GH_BIN) || 'gh';
}

/**
 * The variables that steer `gh` somewhere other than github.com and the
 * user's own configuration: a host, a default repository, an enterprise
 * token, and a config directory (whose `http_unix_socket` can reroute
 * every request). A repository can set any of them, so the child never
 * sees them.
 */
const GH_STEERING = ['GH_HOST', 'GH_REPO', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_CONFIG_DIR'];

export function ghEnv(env = process.env) {
  const out = { ...env };
  for (const name of GH_STEERING) delete out[name];
  return out;
}

/** `owner/name`, as GitHub spells a repository, and nothing that could be read as a flag. */
const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/;

async function lookupGithubIssue(repo, number, config = {}) {
  // Checked before either path: `--repo` is an argument to a program, and
  // a value beginning with `-` or carrying a host is not a repository.
  if (!GITHUB_REPO.test(String(repo)) || String(repo).startsWith('-') || !/^\d+$/.test(String(number))) {
    return undefined;
  }
  const gh = safeExec(ghBinary(),
    ['issue', 'view', String(number), '--repo', repo, '--json', 'title,state'],
    { timeout: Number(config.lookupTimeoutMs || 5000), env: ghEnv() });
  if (gh.ok) {
    const found = boundedIssue(enrichFromToolResult('github', gh.stdout));
    if (found?.title) return found;
  }
  try {
    const response = await fetch(`${githubApiBase()}/repos/${repo}/issues/${number}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'teamflow-plugin' },
      /*
       * The one request in the plugin that follows a redirect, and the
       * one that carries nothing worth following it with: two headers,
       * neither a credential, asking a public API for an issue title.
       *
       * GitHub answers 301 for a repository that has been renamed, which
       * is common and invisible — the old name goes on working
       * everywhere else. Refusing it turned every ticket on a renamed
       * repository into a card with no title, which is a worse outcome
       * than the risk: the most a redirect can learn here is that
       * somebody asked about `owner/repo#n`.
       */
      redirect: 'follow',
      signal: AbortSignal.timeout(Number(config.lookupTimeoutMs || 5000)),
    });
    if (!response.ok) return undefined;
    return boundedIssue(enrichFromToolResult('github', await response.json()));
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
  const files = [localBindingPath(cwd), ...userBindingPaths(cwd, config)];
  const file = files.find((candidateFile) => readJson(candidateFile)?.jiraKey === ref.key)
    || userBindingPath(cwd, config);
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

/*
 * A test run's failure points (ADHOC-19). A failed run whose failing tests
 * the output does not name judged nothing about points, so it carries
 * none. A run cut at the name cap did not name every failure, and a
 * partial run (a directory, a filter word, a name filter) did not run
 * every test in its files, so neither checks anything off.
 *
 * Test names do not leave the machine (the owner declined, 2026-09-22):
 * each failing file is one counted point. The switch stays off.
 */
function testRun(input, command, failed, config = {}) {
  const { files, partial } = testScope(command);
  // Which runner ran: a pytest run judges Python tests and nothing else.
  const family = runnerFamily(command);
  if (!failed) return { testRun: { failing: [], files, family, complete: !partial && Boolean(family) } };
  const { names, capped } = readFailingTests(input.tool_response || input.error);
  if (!names.length) return {};
  const failing = (config?.reporting?.failingTests === true
    ? names.map((name) => ({ text: name }))
    : countedByFile(names)).map((one) => withFamily(one, family));
  return { testRun: { failing, files, family, complete: !partial && !capped && Boolean(family) } };
}

function commandOf(input) {
  return typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
}

/*
 * The exit a ticket takes off a machine (MACLEOD-639). `waitingOn` names
 * what the ticket waits for, so a card that sits says why. A merged pull
 * request stays MERGE success here: the pull request sidecar is what
 * sees the merge land and what says CI is next.
 */
const IN_REVIEW = Object.freeze({ stage: 'MERGE', status: 'waiting', summary: 'in review', waitingOn: 'review', sticky: true });
const MERGED = Object.freeze({ stage: 'MERGE', status: 'success', summary: 'Merged', sticky: true, clearRework: true });

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

  if (event === 'SubagentStart') return { summary: 'Agent started', heartbeat: true };
  if (event === 'SubagentStop') return { summary: 'Agent finished', heartbeat: true };
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
      : MERGED;
  }

  if (tool !== 'Bash') return undefined;

  /*
   * A check the repository declares (ADHOC-20): a run of exactly its
   * command is that check's pass or fail and nothing else, so one run
   * never passes two gates. The stage does not move here: the verdict is
   * reported against the check's own gate, which the organisation placed.
   */
  // Only once the run has finished: a verdict needs an exit status.
  const check = (event === 'PostToolUse' || failed) ? checkNameFor(command, config.checks) : undefined;
  if (check) {
    return {
      check: { name: check, passed: !failed, evidence: extractTestEvidence(failed ? (input.tool_response || input.error) : input.tool_response) },
      summary: failed ? `The ${check} check failed` : `The ${check} check passed`,
      heartbeat: true,
    };
  }

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
      ? { stage: 'DEV_REWORK', status: 'failed', summary: 'Dev tests failed', incrementLoop: true, reworkFrom: 'DEV_TEST', evidence: extractTestEvidence(input.tool_response || input.error), sticky: true, ...testRun(input, command, true, config) }
      : { stage: 'DEV_TEST', status: 'success', summary: 'Dev tests passed; awaiting audit', evidence: extractTestEvidence(input.tool_response), sticky: true, clearRework: true, ...testRun(input, command, false, config) };
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
    if (failed) {
      return { stage: 'LOCAL_REWORK', status: 'failed', summary: 'Merge failed', incrementLoop: true, reworkFrom: 'MERGE', sticky: true };
    }
    // A pull request names no branch on the command line, so its merge
    // is the bound ticket's own (MACLEOD-639).
    if (PR_MERGE_RE.test(command)) return MERGED;
    const merged = mergedBranchKey(command);
    // The other tickets whose work this merge landed (MACLEOD-640),
    // credited beside whichever ticket the merge itself is.
    const skip = new Set([state.binding?.key, merged?.key]);
    const landed = landedKeys(command, input, state, config).filter((one) => !skip.has(one.key));
    const also = landed.length ? { alsoFor: landed } : {};
    /*
     * The merged branch names another ticket: that ticket is the one
     * merged, not the one this session is bound to. The transition is
     * addressed to it (`forKey`) and moves this session's own ticket
     * nowhere; publishState carries it separately. A branch with no key
     * is the bound ticket's own merge, as MACLEOD-574 left it.
     */
    if (merged && state.binding?.key && merged.key !== state.binding.key) {
      /*
       * Only a key `creditable` allows: of the bound ticket's own
       * project, of a prefix this machine knows, or ad hoc. Any `WORD-1`
       * in a branch name is a key by shape — `git merge hotfix-3` would
       * otherwise put a HOTFIX-3 card on the board that no tracker
       * holds — and a GitHub tenant's keys are `repo#N`, which a branch
       * name never carries, so nothing but an ad hoc key is attributed
       * there rather than a ghost.
       */
      if (creditable(merged.key, state, config)) {
        return { stage: 'MERGE', status: 'success', summary: 'Merged', forKey: merged.key, forBranch: merged.branch, ...also };
      }
    }
    return { ...MERGED, ...also };
  }

  if (PR_RE.test(command)) {
    return failed
      ? { stage: 'MERGE', status: 'failed', summary: 'PR operation failed', sticky: true, reworkFrom: 'MERGE' }
      : IN_REVIEW;
  }

  /*
   * A push of the bound branch is the ticket leaving the machine for
   * review (MACLEOD-639). Only out of the three local stages — a second
   * push of a ticket already in review, or one whose CI is running,
   * moves it nowhere — and only forwards: a failed push is a network
   * error, not rework.
   */
  if (GIT_PUSH_RE.test(command)) {
    if (failed || !PRE_REVIEW_STAGES.has(state.stage) || !pushesBoundBranch(command, state, config)) return undefined;
    return IN_REVIEW;
  }

  if (isLocalTest) {
    return failed
      ? { stage: 'LOCAL_REWORK', status: 'failed', summary: 'Local tests failed', incrementLoop: true, reworkFrom: 'LOCAL_TEST', evidence: extractTestEvidence(input.tool_response || input.error), sticky: true, ...testRun(input, command, true, config) }
      : { stage: 'LOCAL_TEST', status: 'success', summary: 'Local tests passed; awaiting audit', evidence: extractTestEvidence(input.tool_response), sticky: true, clearRework: true, ...testRun(input, command, false, config) };
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

/*
 * What a waiting ticket waits on (MACLEOD-639). The five words the
 * contract allows; anything else a transition says is dropped.
 */
const WAITING_ON = new Set(['review', 'ci', 'deploy', 'human', 'dependency']);
const REWORK_MAX = 16;
const REWORK_SUMMARY_MAX = 120;
const TRANSITIONS_MAX = 32;
// One merge may credit MERGE_KEYS_MAX tickets; the rest is room for a
// second merge before the next publish sends them.
const ATTRIBUTIONS_MAX = 24;
// After either of these a ticket's loops are over: the next failure
// starts a new cycle and counts from one.
const CYCLE_CLOSING_STAGES = new Set(['DEV_VERIFIED', 'DONE']);

/** Who a row is attributed to: the agent's name, else the tool, else Claude Code. */
export function actedBy(state = {}) {
  return agentLabel(state.agent?.name, 64) || agentLabel(state.reporter?.tool, 64) || 'Claude Code';
}

/**
 * The rework history and the stage history, kept per ticket
 * (MACLEOD-639).
 *
 * `loopCount` used to be a counter that went up on every failed command
 * for the life of the binding and never came down, which is how a card
 * came to read "x69 loops" with no gate, no reason and no arrow. It is
 * now derived: the number of `rework[]` entries in this plan cycle. A
 * cycle closes when the ticket is verified or done, and the next
 * failure opens a new one. Clearing a loop stamps `clearedAt` rather
 * than erasing the entry, so the history stays readable.
 *
 * Both lists belong to the ticket the session is bound to. A session
 * rebound to another key starts both again: another ticket's failures
 * are not this one's.
 */
function withHistory(state, transition, updatedAt, cleared) {
  const key = state.binding?.key;
  const fresh = Boolean(state.historyKey && key && state.historyKey !== key);
  let log = fresh ? [] : (state.reworkLog || []);
  let transitions = fresh ? [] : (state.transitions || []);
  // Loops this cycle. A counter rather than a timestamp comparison,
  // because two failures a millisecond apart are still two.
  let cycleLoops = fresh || state.cycleClosed ? 0 : (state.cycleLoops || 0);
  let cycleClosed = fresh ? false : Boolean(state.cycleClosed);
  let lastFailure = fresh ? undefined : state.lastFailure;
  let testPoints = fresh ? [] : (state.testPoints || []);
  let testRound = fresh ? 0 : (state.testRound || 0);
  let testsPassed = fresh ? undefined : state.testsPassed;
  const by = actedBy(state);

  // A test run checks its points off in turn (ADHOC-19): a test that
  // fails again stays open, a new failure is a new point, and a test the
  // run covered and passed is fixed. A run of one file covers that file.
  if (transition.testRun) {
    testRound += 1;
    const files = transition.testRun.files || [];
    testPoints = advancePoints(testPoints, {
      gate: 'test',
      round: testRound,
      at: updatedAt,
      failing: transition.testRun.failing,
      judgedAll: transition.testRun.complete === true,
      // Only its own runner's points, and of a run of named files exactly
      // those files' points.
      judges: (point) => pointFamily(point) === transition.testRun.family
        && (!files.length || files.includes(testFile(point.key || point.text))),
      idFor: (point) => stableId('T', 'test', point.key),
    }).points;
  }
  testsPassed = passedRun(transition, updatedAt, testsPassed);

  if (transition.incrementLoop && transition.reworkFrom) {
    cycleClosed = false;
    cycleLoops += 1;
    const summary = agentLabel(transition.summary, REWORK_SUMMARY_MAX) || `${GATE_LABELS[transition.reworkFrom] || transition.reworkFrom} failed`;
    log = [...log, { gate: transition.reworkFrom, at: updatedAt, summary, by }].slice(-REWORK_MAX);
    lastFailure = { stage: transition.reworkFrom, at: updatedAt, summary };
  }
  if (cleared) log = log.map((entry) => (entry.clearedAt ? entry : { ...entry, clearedAt: updatedAt }));
  if (transition.stage && CYCLE_CLOSING_STAGES.has(transition.stage)) cycleClosed = true;
  if (transition.stage && transition.stage !== state.stage) {
    transitions = [...transitions, { stage: transition.stage, at: updatedAt, by }].slice(-TRANSITIONS_MAX);
  }
  return {
    reworkLog: log,
    transitions,
    cycleLoops,
    cycleClosed,
    lastFailure,
    loopCount: cycleClosed ? 0 : cycleLoops,
    historyKey: key || state.historyKey,
    testPoints,
    testRound,
    testsPassed,
  };
}

/*
 * What the newest passing test run covered (MACLEOD-646): its runner's
 * family, whether it ran that whole family, and the test files its
 * command named. File paths only -- the identifier a failure point's key
 * already carries -- never a test's name or output. The service ticks an
 * acceptance criterion linked to one of these files. Any failed test run
 * clears it, so a pass is never read after a later failure.
 */
export function passedRun(transition, at, held) {
  if (transition.incrementLoop && ['LOCAL_TEST', 'DEV_TEST'].includes(transition.reworkFrom)) return undefined;
  const run = transition.testRun;
  if (!run || run.failing.length || !run.family) return held;
  const files = (run.files || []).slice(0, 20).map((file) => String(file).slice(0, 160));
  // `complete` is true for a run of named files in full too; `all` is the
  // whole family, which only a run that named no file is.
  const all = run.complete === true && !(run.files || []).length;
  return { family: run.family, all, ...(files.length ? { files } : {}), at };
}

/**
 * A new plan cycle resets the loop count (MACLEOD-639). Called where the
 * configuration is to hand, before the payload is built: a ticket picked
 * up by a new `/teamflow:build` run starts counting from nought, and its
 * history keeps the earlier entries with their `clearedAt`.
 */
export function refreshReworkCycle(state, config = {}) {
  const key = state.binding?.key;
  if (!key) return state;
  const run = workflowRef(key, config)?.id;
  if (!run) return state;
  if (state.reworkRun && state.reworkRun !== run && !state.cycleClosed) {
    /*
     * This runs after the transition that carried the run's first event
     * has been applied. When that event was itself a failure, the entry
     * it appended belongs to the new run — it is the open one stamped
     * with this very `updatedAt` — so the new cycle starts at one, not
     * at nought with an open loop it cannot count.
     */
    const log = state.reworkLog || [];
    const last = log[log.length - 1];
    const opened = Boolean(last && !last.clearedAt && last.at === state.updatedAt && state.reworkFrom);
    state.cycleClosed = !opened;
    state.cycleLoops = opened ? 1 : 0;
    state.loopCount = state.cycleLoops;
    // The earlier run's loops are over with it: stamped closed at the
    // moment the new run took the ticket, so the open entries in the
    // list are the loops the count says.
    const now = state.updatedAt || new Date().toISOString();
    state.reworkLog = log.map((entry, i) => (
      entry.clearedAt || (opened && i === log.length - 1) ? entry : { ...entry, clearedAt: now }
    ));
  }
  state.reworkRun = run;
  return state;
}

/*
 * The reports a transition owes other tickets: `forKey`, the ticket a
 * merged branch is named for, and `alsoFor`, the tickets whose work the
 * merge landed (MACLEOD-640). One entry per key, newest wins; nothing
 * at all when the transition owes none.
 */
function attributionsAfter(state, transition, at) {
  const credits = [
    ...(transition.forKey ? [{ key: transition.forKey, branch: transition.forBranch }] : []),
    ...(transition.alsoFor || []),
  ];
  if (!credits.length) return {};
  const keys = new Set(credits.map((one) => one.key));
  const others = (state.attributions || []).filter((one) => !keys.has(one.key));
  const by = actedBy(state);
  return {
    attributions: [...others, ...credits.map((one) => ({
      key: one.key,
      branch: one.branch,
      stage: transition.stage,
      status: transition.status,
      summary: transition.summary,
      at,
      by,
    }))].slice(-ATTRIBUTIONS_MAX),
  };
}

export function applyTransition(state, transition) {
  if (!transition) return state;
  const updatedAt = new Date().toISOString();
  /*
   * Addressed to another ticket (MACLEOD-639): a `git merge` of a branch
   * named for a key this session is not bound to. This session's own
   * ticket moves nowhere; the merged ticket's report is carried by the
   * next publish. One entry per key, newest wins.
   */
  const credited = attributionsAfter(state, transition, updatedAt);
  if (transition.forKey) return { ...state, ...credited };
  const cleared = clearsRework(state, transition);
  const evidence = transition.evidence?.length ? transition.evidence : state.evidence;
  const history = withHistory(state, transition, updatedAt, cleared);
  return {
    ...state,
    ...credited,
    stage: transition.stage || state.stage,
    status: transition.status || state.status,
    summary: transition.summary || state.summary,
    ...history,
    // Only a transition that moves the ticket says what it waits on; a
    // heartbeat keeps whatever was there.
    waitingOn: transition.stage
      ? (WAITING_ON.has(transition.waitingOn) ? transition.waitingOn : undefined)
      : state.waitingOn,
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
/** The longest `agentTask` a report carries (the service's AGENT_TASK_MAX). */
export const AGENT_TASK_MAX = 60;

/**
 * What an agent or a session works on, in plain words (MACLEOD-773): the
 * board's row header, "Fixing plugin sign-in". The first source the writer
 * turns into more than "Agent work" wins. Never a path or a worktree's name:
 * a row header made from one is what the owner could not read.
 */
export function agentTaskWords(sources = []) {
  for (const raw of sources) {
    if (!raw) continue;
    const plain = plainTitle(String(raw));
    if (plain !== 'Agent work' && !/[\\/]|worktree-agent/i.test(plain)) return agentLabel(plain, AGENT_TASK_MAX);
  }
  return undefined;
}

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
  // The row's header (MACLEOD-773): its task first, as nodeTitle reads it.
  const said = agentTaskWords([task, agent.name, agent.name && task ? `${agent.name}: ${task}` : '']);
  if (said) block.agentTask = said;
  /*
   * The session this agent runs under, as the same digest `session.id`
   * carries — so the board joins on one value, and so this field is not
   * the raw `session_id` sitting immediately beside a field that is
   * hashed precisely to avoid carrying it (audit finding 7).
   */
  if (agent.parent) block.parent = digest(agent.parent);
  // The agent that launched this one, when it was an agent and not the
  // session (MACLEOD-639), as the same capped id `id` carries. Absent
  // on an agent the session launched, so the board nests only what
  // actually nested.
  if (agent.parentAgent) block.parentAgent = String(agent.parentAgent).slice(0, 80);
  if (agent.startedAt) block.startedAt = agent.startedAt;
  if (agent.endedAt) block.endedAt = agent.endedAt;
  // What it was launched for (MACLEOD-722), enums and numbers only.
  if (agent.role?.as) block.role = { ...agent.role };
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
  // The session's own end only. An agent's actor names the session it
  // runs under, and its end is the agent's (in `agent.endedAt`): stamped
  // here it read as the whole session ending, and every row went `ended`
  // while the session still beat (MACLEOD-641, tracking gap 1).
  if (state.ended && state.updatedAt && !state.agentKey) block.endedAt = state.updatedAt;
  if (info.repository) block.repository = String(info.repository).slice(0, 200);
  if (info.branch) block.branch = String(info.branch).slice(0, 200);
  // What the session itself works on (MACLEOD-773): its ticket's title in
  // plain words. An agent's report names its session but speaks for itself.
  if (!state.agentKey) {
    const said = agentTaskWords([state.jira?.title, state.binding?.title]);
    if (said) block.agentTask = said;
  }
  return block;
}

/**
 * An ad hoc card's title (MACLEOD-646): the `adhoc start` line, else the
 * dispatched agent's name and one-line task, through the writer. Never
 * the prompt, which no state holds. Undefined when nothing better than
 * "Agent work" is known, so the service keeps the title it already has.
 */
export function adHocTitle(state = {}) {
  const agent = state.agent || {};
  // The task line first: it is the Agent tool's description, the words
  // "Simplify review: service" came in. A title an older plugin made from
  // it, then the agent's name, come after; the first that says enough wins.
  const name = agentLabel(agent.name, 64);
  const task = agentLabel(agent.task, 80);
  const sources = [task, state.jira?.title, state.binding?.title, state.dispatch?.title, name,
    name && task ? `${name}: ${task}` : undefined];
  for (const raw of sources) {
    const plain = raw ? plainTitle(raw) : 'Agent work';
    if (plain !== 'Agent work') return plain;
  }
  return undefined;
}

/**
 * The plain line under an ad hoc card's title (MACLEOD-646): the agent's
 * one-line task, when it says more than the title does. Never the prompt.
 */
export function adHocAbout(state = {}, title = adHocTitle(state)) {
  const said = aboutLine(agentLabel(state.agent?.task, 200) || '');
  if (!said) return undefined;
  const words = (text) => new Set(String(text || '').toLowerCase().match(/[a-z0-9'-]+/g) || []);
  const known = words(title);
  return [...words(said)].every((w) => known.has(w)) ? undefined : said;
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
    // Every ad hoc card carries a readable title (MACLEOD-646).
    title: isAdHocKey(key) ? adHocTitle(state) : state.jira?.title,
    about: isAdHocKey(key) ? adHocAbout(state) : undefined,
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
    // ADHOC-20: the names of the checks this repository declares, never
    // their commands, so a card can say a check is not set up here.
    checks: checkNames(config.checks),
    // MACLEOD-639. What a waiting ticket waits on; the loops it has been
    // round, each a gate, a time and one derived line; the last failure;
    // and when it changed stage. Absent rather than empty when there is
    // nothing to say, so an older document is not rewritten with lists.
    ...(state.waitingOn ? { waitingOn: state.waitingOn } : {}),
    ...(state.reworkLog?.length ? { rework: state.reworkLog.slice(-REWORK_MAX) } : {}),
    ...(state.lastFailure ? { lastFailure: state.lastFailure } : {}),
    ...(state.transitions?.length ? { transitions: state.transitions.slice(-TRANSITIONS_MAX) } : {}),
    // ADHOC-19: the failing tests this session has seen, as failure points.
    ...(state.testPoints?.length ? { points: state.testPoints.slice(-50) } : {}),
    // MACLEOD-646: what the newest passing test run covered, file paths only.
    ...(state.testsPassed ? { testsPassed: state.testsPassed } : {}),
    // MACLEOD-726/733: what TeamFlow told the agent on this card, newest last.
    ...(state.directions?.length ? { directions: state.directions.slice(-10) } : {}),
    // MACLEOD-510. Set by refreshDelivery, and absent rather than empty
    // outside a repository or when the branch has no pull request.
    git: state.git,
    pr: state.pr,
    // MACLEOD-532. Absent on a session that never named a tool, which is
    // what the dashboard reads as "connected, version unknown".
    reporter: state.reporter,
    // MACLEOD-639 (ruling 10): what a lead asked this machine to do about
    // the ticket and what came of it. Outcomes and the plugin's own
    // sentence about each, never the action's text.
    ...(Array.isArray(state.actions) && state.actions.length ? { actions: state.actions.slice(-16) } : {}),
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

export function sanitizePayload(value, { kind = 'issue' } = {}) {
  const allowed = new Set([
    'tracker','jiraKey','jiraUrl','title','about','jiraStatus','parentKeys','project','actor','repository','branch',
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
    // MACLEOD-639: what a waiting ticket waits on, and the three history
    // blocks whose own fields are scoped below, so `at` and `by` are
    // allowed inside them and nowhere else on the flat payload.
    'waitingOn','rework','lastFailure','transitions',
    // ADHOC-19: a gate's verdicts on the ticket it judged, scoped below.
    'verdicts', 'points',
    // MACLEOD-646: a passing test run's reach, scoped below.
    'testsPassed',
    // MACLEOD-726/733: what TeamFlow told the agent, scoped below.
    'directions',
  ]);
  /*
   * MACLEOD-639: what only one document kind may carry at its root. A
   * runtime sidecar is a flat execution -- there is no `executions[]`
   * to carry its clocks, its session block or its retry state in -- so
   * `startedAt`, `endedAt`, `session`, `attempts`, `retry` and
   * `supersededBy` are allowed at ITS root and nowhere else; on an issue
   * document the same names stay where MACLEOD-574 and MACLEOD-601 put
   * them, inside `executions[]`. `actions` -- what a lead asked and what
   * came of it -- is the issue document's alone.
   */
  const runtimeRoot = new Set(['startedAt', 'endedAt', 'session', 'attempts', 'retry', 'supersededBy', 'gate', 'failedSteps', 'review',
    // The reviewer's own agent block (MACLEOD-714, carried from MACLEOD-722): the
    // contract always listed it, and without it the board could not put a
    // reviewer under its person nor the service read its role.
    'agent']);
  // A reviewer of a step (MACLEOD-714): its lens, the fixed result and
  // counts. Never the words the reviewer wrote; there is no field for them.
  const reviewOnly = new Set(['lens', 'result', 'round', 'findings', 'high', 'medium', 'low', 'stated']);
  const issueRoot = new Set(['actions']);
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
  // `endedAt` says when a run stopped (MACLEOD-601), and it is allowed
  // inside `executions` and nowhere else for the same reason `at` is: an
  // issue document has `updatedAt` already, and a second clock on the
  // payload would be a second answer to when the ticket last moved.
  const eventOnly = new Set(['at', 'source', 'endedAt', 'agent', 'session']);
  /*
   * MACLEOD-574. `agent` is its own scope rather than seven more names
   * on the flat set above, because six of those names — `name`, `task`,
   * `type`, `parent`, `startedAt`, `endedAt` — are exactly the words a
   * reporter talked into attaching a prompt or a transcript would reach
   * for. Inside the block they are a short label each; anywhere else on
   * the payload they are dropped, `prompt` and `last_assistant_message`
   * among them, because neither is in either set.
   */
  const agentOnly = new Set(['id', 'name', 'task', 'agentTask', 'type', 'parent', 'parentAgent', 'startedAt', 'endedAt', 'role']);
  // What the agent was launched for (MACLEOD-722): the answer, how it was
  // reached and the classifier's fixed features. Enums, flags, one count
  // and one number; the prompt it was scored on has no field here.
  const roleOnly = new Set(['as', 'by', 'intent', 'confidence', 'batch', 'bound', 'position', 'claude', 'step', 'ask',
    'moved', 'outcome']);
  // Which session a run happened in. `repository` and `branch` are in the
  // flat set already; the rest are here and nowhere else, so a transcript
  // path or a raw session id has no field to arrive on.
  // `label` is the plan's name on a `kind: plan` row (MACLEOD-639).
  const sessionOnly = new Set(['id', 'tool', 'startedAt', 'endedAt', 'repository', 'branch', 'label', 'agentTask']);
  // MACLEOD-639. A loop is a gate, two clocks, one derived line and a
  // name; a failure is a stage, a clock and that line; a transition is a
  // stage, a clock and a name. `summary` is the only prose and it is the
  // classifier's own sentence, never a command or its output.
  const reworkOnly = new Set(['gate', 'at', 'clearedAt', 'summary', 'by']);
  const failureOnly = new Set(['stage', 'at', 'summary']);
  const transitionOnly = new Set(['stage', 'at', 'by']);
  // One try of a gate the plugin ran, and why it is still going
  // (MACLEOD-639). `reason` is the runner's sentence, never output.
  const attemptOnly = new Set(['at', 'status', 'reason']);
  const retryOnly = new Set(['attempt', 'of', 'nextAt', 'status', 'reason', 'notifiedAt']);
  const supersededOnly = new Set(['slot', 'at']);
  // What a lead asked and what came of it (ruling 10): six short fields,
  // and `reason` is the plugin's sentence, never the action's text.
  const actionOnly = new Set(['id', 'kind', 'by', 'at', 'outcome', 'reason']);
  // A gate's verdict (ADHOC-19): which gate, pass or fail, the round, a
  // clock, who, and the words the orchestrator deliberately wrote.
  const verdictOnly = new Set(['round', 'gate', 'verdict', 'at', 'by', 'summary', 'raised', 'fixed', 'open', 'notAdded']);
  // A failure point (points.mjs): its id, the gate, the one line, the rounds
  // it failed in, and when it was fixed. Never output, a message or a log.
  const pointOnly = new Set(['id', 'gate', 'key', 'text', 'from', 'rounds', 'lastRound', 'state', 'at', 'by',
    'doneAt', 'doneRound', 'doneBy']);
  // A passing test run's reach (MACLEOD-646): a family, whether it ran all
  // of it, the test files the command named, and when. Never a test name.
  const testsPassedOnly = new Set(['family', 'all', 'files', 'at']);
  // What TeamFlow told the agent (MACLEOD-726/733): a clock, one plain
  // line of the plugin's own words, and whether it is still to come.
  const directionOnly = new Set(['at', 'text', 'next']);
  const nested = {
    testsPassed: testsPassedOnly, directions: directionOnly,
    agent: agentOnly, session: sessionOnly,
    rework: reworkOnly, lastFailure: failureOnly, transitions: transitionOnly,
    attempts: attemptOnly, retry: retryOnly, supersededBy: supersededOnly, actions: actionOnly,
    verdicts: verdictOnly, points: pointOnly, review: reviewOnly, role: roleOnly,
  };
  const rootOnly = kind === 'runtime' ? runtimeRoot : issueRoot;
  function walk(v, scope) {
    if (Array.isArray(v)) return v.slice(0, 50).map((item) => walk(item, scope));
    if (!v || typeof v !== 'object') {
      return typeof v === 'string' ? v.slice(0, 300) : v;
    }
    const out = {};
    for (const [key, item] of Object.entries(v)) {
      const ok = nested[scope]
        ? nested[scope].has(key)
        : allowed.has(key) || (scope === 'event' && eventOnly.has(key)) || (scope === 'root' && rootOnly.has(key));
      if (!ok) continue;
      const next = nested[scope] ? (scope === 'agent' && key === 'role' ? 'role' : scope)
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

// --- where a credential may go (MACLEOD-616) ------------------------
//
// One rule, one function, every caller. `credentialDestination` is the
// only place that decides whether this config's service may be sent a
// credential, and `credential()`, `auth.accessToken()` and the few
// places in auth.mjs that carry a token of their own all ask it. A guard
// written out at each of the dozen call sites is a guard somebody
// forgets at the thirteenth; `credential-route.test.mjs` fails if a new
// caller builds a request URL from anything but `serviceUrl(config)`.

/** The origin of a URL, or undefined if it is not one. */
export function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return undefined;
  }
}

/**
 * This machine and nobody else's.
 *
 * Loopback is the one exception to both rules below, and it is not a
 * convenience: a request to 127.0.0.1 never leaves the computer, so
 * there is nothing to exfiltrate and nothing to intercept. Anybody
 * listening on it can already read `~/.config/teamflow/session.json`.
 * It is also what lets a preview service, `npm run dev` and the whole
 * test suite keep working without a certificate.
 *
 * Exact names only. `*.localhost` resolves to 127.0.0.1 on most
 * machines, but that is resolver policy and not a guarantee — a
 * resolver with a search domain can send `evil.localhost` off the box,
 * and an exemption that depends on how somebody's DNS is configured is
 * not an exemption, it is a hole with a comment on it.
 */
export function isLoopbackOrigin(origin) {
  let host;
  try {
    host = new URL(String(origin)).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  return host === 'localhost'
    || host === '::1' || host === '0.0.0.0'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * The origins an ambient credential may be sent to, beyond the hosted
 * service and this machine (MACLEOD-616 follow-up, F2).
 *
 * Read from the user's global file and from nowhere else — not the
 * environment, and certainly not the repository. "The environment is the
 * user speaking" is false inside an editor: a repository can ship a
 * `.claude/settings.json` with an `env` block, an `.envrc`, a
 * `.vscode/settings.json` terminal environment, and any of them can set
 * `TEAMFLOW_SERVICE_URL` for every process the editor starts. A session
 * is saved from that by the origin recorded at sign-in; an API key or a
 * handed-in access token has no such record, so without this list an
 * environment variable would be enough to send one anywhere.
 *
 * A file in the user's home is a different thing: a repository cannot
 * write one without already running code on the machine, and at that
 * point nothing here would have helped anyway.
 */
export function trustedOrigins() {
  const listed = readJson(globalConfigPath(), {})?.trustedOrigins;
  return (Array.isArray(listed) ? listed : [])
    .map((entry) => originOf(entry))
    .filter(Boolean);
}

/**
 * Who chose the address this config points at (MACLEOD-616 follow-up,
 * B1).
 *
 * The whole rule turns on this and nothing else had to ask it before.
 * The first version of the trusted-origin list let `teamflow login`
 * add the origin it had just signed in against — which sounds like the
 * user's own act and is not, because the origin came from
 * `serviceUrl(config)` and a repository sets that through a
 * `.claude/settings.json` `env` block or an `.envrc`. The remedy became
 * the attack: the refusal told the victim to run `teamflow login`, the
 * login wrote the attacker's origin into the victim's own global file,
 * and every API key afterwards went there with the plugin's blessing.
 *
 * So: four answers, and only two of them are a person.
 *
 *   * `default`  — the hosted service. Nobody had to say anything.
 *   * `typed`    — `--service <url>` on the command line, this run.
 *   * `global`   — `serviceUrl` in the user's own file, which a
 *                  repository cannot write without already running code.
 *   * `environment` — anything else. A variable, from a shell profile or
 *                  from whatever the editor was told to export, and
 *                  there is no way to tell those two apart from here.
 *
 * `environment` is not an accusation; it is an absence of provenance,
 * and it is treated as one.
 */
export function serviceUrlSource(config = {}, typed = undefined) {
  const origin = originOf(serviceUrl(config));
  if (!origin) return undefined;
  if (origin === originOf(defaultServiceUrl())) return 'default';
  if (typed && originOf(typed) === origin) return 'typed';
  if (originOf(readJson(globalConfigPath(), {})?.serviceUrl) === origin) return 'global';
  return 'environment';
}

/**
 * Where the address came from, in words, for a refusal to lead with.
 *
 * A refusal that says "sign in there instead" is a refusal that talks
 * the reader into the thing just declined, so the provenance goes first
 * and the remedy second — and where the provenance is an environment
 * variable, the reader is told that a repository can set one, because
 * that is the fact that changes what they do next.
 */
export function serviceUrlProvenance(config = {}) {
  const origin = originOf(serviceUrl(config));
  if (serviceUrlSource(config) !== 'environment') return undefined;
  return `TEAMFLOW_SERVICE_URL in this environment names ${origin}. If you did not set that `
    + 'yourself, the repository you have open did: a `.claude/settings.json` "env" block, an '
    + '`.envrc` or an editor workspace setting all reach this process.';
}

/**
 * May a credential bound to `bound` be sent to the service this config
 * names? Answers `{ ok: true, origin }` or `{ ok: false, reason }`, and
 * the reason is written for the person who will read it in `status`.
 *
 * Three questions, in the order that makes the answer useful:
 *
 *   1. Is it a URL at all? An unparseable `serviceUrl` used to fall
 *      through `String(...)` and fail at fetch time with a stack.
 *   2. Is it https, or loopback? A credential never travels in clear
 *      over a network somebody else can be on.
 *   3. Is it the origin this credential was issued by? A session is
 *      bound to the service that signed it in, and to no other. This is
 *      a refusal, never a fallback: answering with the API key instead
 *      would be the same credential leaving for the same wrong address
 *      through a different door.
 *
 * `bound` is undefined for a credential the plugin never stored — an API
 * key or a CI access token, which reach the process from the environment
 * or the global file, i.e. from the user. There is no origin to compare
 * to, so those get rules 1 and 2 and not rule 3.
 *
 * Rule 3 is not applied to a loopback destination, and that is a
 * decision rather than an oversight. It buys nothing: a request to this
 * machine reaches nobody else, and anybody who can listen on it can read
 * the session file directly. It costs a great deal: every session signed
 * in before this release records no origin and is read as the hosted
 * service (see `auth.sessionOrigin`), so enforcing rule 3 on loopback
 * would stop `npm run dev`, the e2e preview and every existing install
 * pointed at a local stack from reporting until somebody signed in
 * again. The attack this is all for needs a *remote* address, and rule 3
 * is what refuses one.
 */
export function credentialDestination(config = {}, bound = undefined) {
  const target = serviceUrl(config);
  const origin = originOf(target);
  if (!origin) {
    return { ok: false, reason: `the configured serviceUrl (${target}) is not a URL, so TeamFlow sent no credential` };
  }
  const loopback = isLoopbackOrigin(origin);
  if (!origin.startsWith('https:') && !loopback) {
    return {
      ok: false,
      origin,
      reason: `refusing to send a credential to ${origin} in clear: https is required for anything but localhost`,
    };
  }
  if (bound && bound !== origin && !loopback) {
    const provenance = serviceUrlProvenance(config);
    return {
      ok: false,
      origin,
      // As in `ambientDestination`: no "sign in there instead". Where the
      // address came from an environment variable, that is the first
      // thing the reader needs, because it may not have been them.
      reason: `this machine holds a credential issued by ${bound}, so TeamFlow did not send it to ${origin}. `
        + `${provenance ? `${provenance} ` : ''}`
        // A placeholder, never the declined origin filled in: a line a
        // hurried person can paste is a line they will paste.
        + `If ${origin} is genuinely your service, sign in to it deliberately by typing its `
        + "address yourself — `teamflow login --service <your service's address>` — or put `serviceUrl` in your own "
        + `${globalConfigPath()}`,
    };
  }
  return { ok: true, origin };
}

/**
 * The rule for a credential that records no origin of its own: an API
 * key, or an access token handed in by something other than an exchange
 * against the service it is for.
 *
 * Rules 1 and 2, and then: the hosted service, this machine, or an
 * origin the user listed in their own global file. Not wherever the
 * environment happens to point, because inside an editor the
 * environment is not reliably the user — see `trustedOrigins`.
 *
 * `teamflow login` against another service adds that origin to the list
 * as it signs in, so the ordinary way to reach a self-hosted stack
 * needs nothing typed. Somebody using only an API key against one adds
 * one line to one file, once, and is told exactly which line the first
 * time they are refused.
 */
export function ambientDestination(config = {}) {
  const target = credentialDestination(config);
  if (!target.ok) return target;
  if (target.origin === originOf(defaultServiceUrl())) return target;
  if (isLoopbackOrigin(target.origin)) return target;
  if (trustedOrigins().includes(target.origin)) return target;
  const provenance = serviceUrlProvenance(config);
  return {
    ok: false,
    origin: target.origin,
    // Provenance first, remedy second, and never "sign in there": the
    // origin has just been declined, and telling somebody to
    // authenticate against it is handing over the authorize URL, the
    // PKCE exchange and an id_token as the price of reading the error
    // message (MACLEOD-616 follow-up, B1).
    reason: `${provenance || `no credential on this machine was issued by ${target.origin}`}`
      + ' A credential is only sent to TeamFlow, to localhost, or to a service you '
      + `named yourself. If ${target.origin} is genuinely yours, add "trustedOrigins": `
      + `["${target.origin}"] to ${globalConfigPath()} — by hand, in that file, so the choice is `
      + 'yours and not an environment variable\'s.',
  };
}

/**
 * Whether a configured `apiKey` may be used at all (MACLEOD-630).
 *
 * The hosted service accepts no key: it refuses one on sight, and revokes
 * whatever it recognises. So a key is never sent there, whatever set it
 * — not the global file, not the environment — and the only refusal a
 * person sees is the one line `status` and `doctor` print. The code path
 * stays, dormant, for a self-hosted service: this machine, or an origin
 * the user listed in their own global file (`trustedOrigins`, which the
 * environment and a repository cannot write). Never the hosted origin,
 * and never a remote origin on an environment variable's say-so.
 */
export function apiKeyUsable(config = {}) {
  if (!config.apiKey) return false;
  const target = ambientDestination(config);
  if (!target.ok) return false;
  return !HOSTED_ORIGINS.has(target.origin)
    && target.origin !== originOf(defaultServiceUrl());
}

/**
 * The hosted service under every name it answers to. The two aliases 301 to
 * the primary host, so a key sent to either is a key sent to the service that
 * refuses and revokes it — and a user can list an alias in `trustedOrigins`
 * from an old config without knowing it is the same service.
 */
const HOSTED_ORIGINS = new Set([
  'https://codercat.io', 'https://www.codercat.io', 'https://teamflow.macleodlabs.com',
]);

/** The one line about an ignored key, or undefined when there is none to say. */
export function ignoredKeyReason(config = {}) {
  if (!config.apiKey || apiKeyUsable(config)) return undefined;
  return 'a configured key is ignored: the service does not accept one. '
    + 'Authorize this machine with /teamflow:login';
}

/**
 * The rule for the credential this config would actually use.
 *
 * A stored session answers with the origin that issued it. An access
 * token that came from an exchange against this very service says so
 * through `accessTokenOrigin`, which only the plugin sets — it is in
 * `UNTRUSTED_PROJECT_KEYS`, so a repository cannot claim it. Everything
 * else is ambient.
 */
export function credentialTarget(config = {}) {
  // No trustworthy home, no credential of any kind (MACLEOD-623): the
  // reason reaches `status`, `doctor` and the session-start line.
  const refusedHome = homeRefusal();
  if (refusedHome) return { ok: false, reason: refusedHome };
  const session = auth.readSession();
  if (session) {
    const target = credentialDestination(config, auth.sessionOrigin(session));
    /*
     * One refusal has a second cause worth naming (MACLEOD-616).
     *
     * A session file with no `serviceOrigin` is read as the hosted
     * service, so a self-hosted install is refused against its own
     * address. That is a pre-upgrade session — or a session an older
     * copy of the plugin on this same machine wrote a moment ago: two
     * versions share one data directory, and 0.3.18's sign-in builds a
     * fresh object with no place for the field, so signing in there
     * strips it. The symptom is identical and the second cause is the
     * one nobody guesses.
     */
    if (!target.ok && !session.serviceOrigin) {
      return {
        ...target,
        reason: `${target.reason}. If you just signed in, check that every copy of the TeamFlow `
          + 'plugin on this machine is up to date: an older one writes a session without recording '
          + 'which service issued it',
      };
    }
    return target;
  }
  if (config.accessToken && config.accessTokenOrigin) {
    return credentialDestination(config, originOf(config.accessTokenOrigin));
  }
  return ambientDestination(config);
}

/**
 * Why no credential will be attached, in words, or undefined when one
 * will. Synchronous and network-free, so `status`, `doctor`, the hook's
 * session-start line and the report path can all say the same thing
 * without a round trip.
 */
export function credentialRefusal(config = {}) {
  const target = credentialTarget(config);
  if (!target.ok) return target.reason;
  // The destination is fine and the only credential on offer is a key
  // the service will not take: said here, once, so the same line reaches
  // status, doctor and the session-start hook.
  if (!credentialKind(config)) return ignoredKeyReason(config);
  return undefined;
}

/**
 * What a failed `fetch` on the credential path means, in words.
 *
 * `redirect: 'error'` is set on every request the plugin makes, so a
 * service that answers 301 throws here rather than replaying the request
 * — with its `X-Api-Key`, which `fetch` does NOT strip across origins —
 * at wherever it was pointed. The hosted deployment does redirect
 * `www.codercat.io` and `teamflow.macleodlabs.com` to the primary host,
 * so somebody whose global config still names an old address lands here,
 * and "service unreachable: fetch failed" would send them looking at
 * their network.
 */
export function unreachableReason(error, config = {}) {
  const text = error instanceof Error ? String(error.cause?.message || error.message) : String(error);
  if (/redirect/i.test(text)) {
    return `${serviceUrl(config)} redirected the request, and a credential does not follow a redirect. `
      + 'Point serviceUrl (TEAMFLOW_SERVICE_URL, or the global config file) at the address it '
      + 'redirects to — the primary host, not an alias of it.';
  }
  return `service unreachable: ${text}`;
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
//   3. `apiKey`, for non-interactive installs that cannot do either —
//      against a self-hosted service only. The hosted one refuses a key
//      on sight, so one is never sent there (`apiKeyUsable`, MACLEOD-630).
//
// Callers ask for a credential rather than reading `apiKey`, and the
// outbox stores none: a queued report resolves its credential when it
// is finally sent, which is the only way a one-hour token survives an
// hour of being offline.
export async function credential(config = {}) {
  // Before anything is resolved: may a credential go where this config
  // points at all (MACLEOD-616)? A mismatch is a refusal for every kind
  // at once — falling through to the API key here would send a second
  // credential to the address the first one was refused for.
  if (!credentialTarget(config).ok) return undefined;
  if (auth.hasSession()) {
    const token = await auth.accessToken(config);
    if (token.ok) {
      return { kind: 'bearer', header: 'Authorization', value: `Bearer ${token.token}`, email: token.email };
    }
    // A session that will not refresh has expired or been revoked.
    // Fall through to a key if there is one rather than going dark,
    // and carry the reason so doctor can say what happened.
    if (apiKeyUsable(config)) {
      return { kind: 'api_key', header: 'X-Api-Key', value: String(config.apiKey), degraded: token.reason };
    }
    return undefined;
  }
  if (config.accessToken) {
    return { kind: 'bearer', header: 'Authorization', value: `Bearer ${config.accessToken}` };
  }
  if (apiKeyUsable(config)) {
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
  if (apiKeyUsable(config)) return 'api_key';
  return undefined;
}

// --- whose report is this (MACLEOD-583) -----------------------------
//
// The service takes the tenant from the credential and never from the
// body, so a report that could not be delivered is not "a report": it
// is a report *for one organisation*. One plugin data directory sees
// more than one of them as soon as somebody switches organisation
// between sessions (MACLEOD-524), and state that records only what to
// send hands one customer's work to whichever credential flushes it.
//
// An owner is therefore decided at queue time, and decided without a
// round trip, because at queue time the service is by definition
// unreachable:
//
//   * a signed-in session, browser or device, already knows the
//     organisation it was bound to -- `account` in session.json, the
//     same string `teamflow status` prints. That is the owner.
//   * an API key and a CI OIDC access token know nothing locally. They
//     get a fingerprint: a truncated SHA-256, one way, never the
//     credential and never a prefix of it. It is the same shape
//     auth.mjs already uses to tell one refresh token from another.
//
// A fingerprint names a credential, not an organisation, so two keys on
// one organisation do not match each other and a report queued under
// one key waits for that key. That is the safe direction to be wrong
// in: the failure is a report that waits, never one that is delivered
// to somebody else.
const OWNER_FINGERPRINT_CHARS = 16;

/**
 * A one-way name for a credential. Not reversible to the credential:
 * SHA-256 truncated to 64 bits over a domain-separated input, with a
 * preimage space the size of the credential's own entropy. Nothing here
 * is ever printed, logged or sent.
 */
export function ownerFingerprint(from, value) {
  return crypto.createHash('sha256')
    .update(`teamflow-owner:${from}:${value}`)
    .digest('hex')
    .slice(0, OWNER_FINGERPRINT_CHARS);
}

// `from` says what the fingerprint was taken over, which is the one
// thing a reader of a queued item cannot otherwise work out, and it is
// also what decides whether an owner is stable enough to remember: a CI
// access token is a different string every job.
//
// `kind` is diagnostic and is deliberately NOT compared: an
// organisation is the same organisation whether this session reached it
// with a browser session, a device credential or a key, and requiring
// the kinds to match would strand a report every time somebody signed
// in. `mayDeliver` compares the account (or the fingerprint) and the
// service, and nothing else.
function ownerFrom(kind, secret, config) {
  const base = { kind, serviceUrl: serviceUrl(config) };
  if (kind !== 'api_key') {
    const session = auth.readSession();
    if (session?.account) return { ...base, from: 'account', account: String(session.account) };
    // A session bound by a service that predates organisations, and a
    // device grant that named none. The device id is a stable id rather
    // than a secret; the address is the next best thing. Both are
    // fingerprinted anyway, because neither needs to be on disk in the
    // clear to answer the only question asked of it.
    if (session?.deviceId) return { ...base, from: 'device', fingerprint: ownerFingerprint('device', session.deviceId) };
    if (session?.email) return { ...base, from: 'email', fingerprint: ownerFingerprint('email', session.email) };
  }
  if (kind === 'api_key' && secret) {
    return { ...base, from: 'api_key', fingerprint: ownerFingerprint('api_key', secret) };
  }
  // A token handed in directly: CI, which exchanged its GitHub Actions
  // OIDC token a moment ago and was told the account it was bound to.
  if (config.account) return { ...base, from: 'account', account: String(config.account) };
  // A token and no account: an exchange against a service that named
  // none. It cannot be fingerprinted — the token is replaced every hour
  // and the queued report has to outlive it — so it is recorded as
  // unidentified and matches only another unidentified token on the
  // same service. That is the one credential this fix cannot pin to an
  // organisation, and it is no weaker than it was.
  return { ...base, from: kind === 'api_key' ? 'api_key' : 'token' };
}

/**
 * The owner of the credential this config *would* use, answered without
 * a network call and without a token refresh.
 *
 * This is the one for naming local state (`accountScope`). The outbox
 * uses `currentOwner`, which asks what credential was actually
 * resolved: a session that will not refresh falls back to an API key,
 * and the report then belongs to the key's organisation rather than to
 * the session's.
 */
/**
 * The owner of the credential this config would use.
 *
 * Synchronous, so it can be asked on a hook's path, where a token
 * refresh is not affordable. It is a guess in one case only — a session
 * that will not refresh falls back to an API key, which only resolving
 * the credential discovers — and it is deliberately the *stable* answer
 * rather than the true one, because its whole job is naming local files
 * (`accountScope`). A name that changed halfway through a process would
 * move the workflow store and the projects cache out from under the
 * session using them. Nothing compares this to a queued item's owner;
 * `currentOwner` is what delivery asks.
 */
export function credentialOwner(config = {}) {
  const kind = credentialKind(config);
  if (!kind) return undefined;
  return ownerFrom(kind, kind === 'api_key' ? config.apiKey : config.accessToken, config);
}

/**
 * The owner of the credential a request will actually carry.
 *
 * The one the outbox records and compares, because the organisation
 * that receives a report is the one behind the credential that carried
 * it — not the one the config names.
 */
export async function currentOwner(config = {}) {
  const cred = await credential(config);
  if (!cred) return undefined;
  // The header value, back to the credential itself, so this and
  // `credentialOwner` fingerprint the same string.
  const secret = cred.kind === 'api_key' ? cred.value : String(cred.value).replace(/^Bearer\s+/i, '');
  return ownerFrom(cred.kind, secret, config);
}

/** The owner as one comparable string. Never a credential. */
export function ownerId(owner) {
  if (!owner) return undefined;
  if (owner.account) return `account:${owner.account}`;
  if (owner.fingerprint) return `fp:${owner.fingerprint}`;
  return undefined;
}

/**
 * A queued service report from a plugin that did not record an owner.
 *
 * Nothing on this machine can say whose it was. Any record of which
 * organisations have used this directory begins the day the upgrade
 * runs, so "only one has ever used it" is unknowable from here — and a
 * rule reading such a record is one the first flush after the upgrade
 * satisfies by writing the record itself, whichever organisation
 * happens to be signed in. There is no safe version of the guess.
 *
 * Unreachable for anything this plugin queued, and deliberately kept.
 * `sendReport` is the only caller of `queueOutbox` and always passes
 * `result.owner`; `postEnvelope` attaches an owner to every return path
 * past its credential check, and the one return without one is not
 * retryable and so is never queued. Every item in `outbox2` therefore
 * has an owner by construction. This is for a file somebody edited by
 * hand, and for the next writer who forgets — the branch that is only
 * ever taken when something has already gone wrong is the one that must
 * not guess.
 */
export function isOwnerless(item) {
  return Boolean(item?.endpoint && item?.envelope) && !item?.owner;
}

/**
 * Whether the session flushing may deliver this queued service report.
 *
 * Same organisation, same service, and an owner that says so. An
 * ownerless item is never deliverable by anybody: see `isOwnerless`,
 * and `flushOutbox` for what happens to it instead.
 */
export function mayDeliver(item, current) {
  if (!current) return false;
  const owner = item?.owner;
  if (!owner) return false;
  const me = ownerId(current);
  if (String(owner.serviceUrl || '') !== String(current.serviceUrl || '')) return false;
  // Two unidentified CI tokens on one service. Neither says whose it
  // is, so neither can be told apart; see `ownerFrom`.
  if (!me && owner.from === 'token' && current.from === 'token') return true;
  return Boolean(me) && ownerId(owner) === me;
}

/**
 * The same rule for the legacy S3 branch, which needs nothing recorded:
 * the key already says whose it is. `<dataUri>/tenants/<tenant>/...`,
 * and the current config resolves both halves.
 */
export function mayPut(item, config = {}) {
  const base = String(config.dataUri || '').replace(/\/+$/, '');
  if (!base) return false;
  const uri = String(item?.uri || '');
  if (!uri.startsWith(`${base}/`)) return false;
  const rest = uri.slice(base.length + 1);
  // Not tenant-scoped at all: there is no tenant in it to misdeliver.
  if (!rest.startsWith('tenants/')) return true;
  try {
    return rest.startsWith(tenantPath(config, ''));
  } catch {
    return false;
  }
}

/**
 * The name per-organisation local state is filed under.
 *
 * Not `tenantId`: that is the S3 transport's tenant, it comes from
 * config and `TEAMFLOW_TENANT_ID`, and it is `default` on every service
 * install — so it does not tell two organisations on one machine apart,
 * which is the whole job here. The credential's account does. An install
 * with no service credential keeps the tenant, which is what it has
 * always been keyed by.
 *
 * Pure, and stable for the life of a process. Asking which
 * organisation this is must never write anything — every hook asks, a
 * sandboxed agent's data directory is read-only, and a read path that
 * writes is a read path that can corrupt a store two plugin versions
 * share — and it must never change its answer mid-run, because the
 * answer is a file name.
 */
export function accountScope(config = {}) {
  return scopeOf(ownerId(credentialOwner(config))) || tenantId(config);
}

/**
 * One owner id as the name its state is filed under.
 *
 * Its own function because a second caller needs the identical mapping:
 * reading a queued item's owner back to the bucket that organisation's
 * files would be in (MACLEOD-586). Two spellings of this would mean an
 * organisation the machine has plainly seen reading as one it has not.
 */
function scopeOf(id) {
  if (!id) return undefined;
  return id.replace(':', '-').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 80);
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

/**
 * Where this plugin queues, and it is deliberately not where 0.3.13
 * queued (MACLEOD-583).
 *
 * Recording an owner on an item only binds the plugins that read it.
 * Claude Code runs its cached copy of the plugin while a checkout or
 * `npx` runs another, so an older `flushOutbox` — which has no notion
 * of an owner — sits on the same machine and would happily post this
 * plugin's owner-tagged items with whatever credential it holds, and
 * then delete them. A directory it does not know about is the only
 * thing that stops it: it cannot send, and cannot destroy, what it
 * never lists.
 *
 * The cost is stated rather than hidden: after a DOWNGRADE the older
 * plugin does not see this directory, so those reports wait for the
 * next upgrade or age out. And reports queued BY an older copy stay
 * exposed to that copy until every copy on the machine is updated —
 * a binary that is not ours to run is not ours to fix.
 */
function outboxDir() {
  return path.join(dataDir(), 'outbox2');
}

/**
 * Where 0.3.13 and earlier queued, and still do.
 *
 * Never queued into and never sent from — though the age horizon does
 * delete from it, and deleting is writing. An older plugin on this
 * machine goes on managing its own queue with its own rules until it is
 * upgraded, and taking its fresh items away would lose a single
 * organisation's reports for it. The one thing done here is that
 * horizon: an item nothing has delivered in a week is wrong by now, and
 * without this nothing would ever empty the directory.
 */
function legacyOutboxDir() {
  return path.join(dataDir(), 'outbox');
}

// Two item shapes share the directory: { uri, payload } is an S3 put and
// { endpoint, envelope, idempotencyKey, owner } is a service report.
// flushOutbox only drains the shape the configured transport can
// deliver, so an install that switches over does not lose whatever the
// old one queued — and only the items whose owner it is (MACLEOD-583).
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
  const clean = sanitizePayload(payload, { kind });
  delete clean.tenantId;
  delete clean.slot;
  return clean;
}

// A retry of the same report is the same request, so the service
// replays its first answer instead of charging a second credit.
//
// Deliberately NOT `reportDigest`, which the publish deduplication uses
// (MACLEOD-613). That one ignores `executions[].at` so an unchanged
// ticket is not re-sent; this one must not, because the report that
// does go out after four quiet minutes exists precisely to move the
// ticket's report time, and a replayed answer would leave the board
// drawing it as stale.
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

/**
 * Where this MACHINE keeps what is true of the machine rather than of one
 * install of the plugin (MACLEOD-620 audit, B1).
 *
 * Not `dataDir()`. Claude Code gives every config directory its own
 * `CLAUDE_PLUGIN_DATA`, so two config directories on one laptop — a
 * rotation pool — are two data directories; Cursor, Codex and the CLI use
 * `~/.local/share/teamflow`. The device credential they all present is
 * home-rooted (`~/.config/teamflow/session.json`), so anything keyed to it
 * has to be home-rooted too, or one laptop is several machines to the
 * service and refuses itself.
 */
export function machineDir() {
  return path.join(userHome(), '.local', 'share', 'teamflow');
}

/**
 * The refusals that lift by themselves (MACLEOD-620).
 *
 * Each is remembered per organisation, on this machine, until a report for
 * that organisation is accepted again — so `teamflow status`, `teamflow
 * doctor` and the next session's start can say it. A hook exits 0 and
 * prints nothing, and a board that has gone quiet on purpose must not look
 * like one that broke. Per organisation because an accepted report for one
 * says nothing about another (audit, S2).
 */
const SOFT_REFUSALS = new Set(['reporting_paused', 'payment_failed', 'usage_exceeds_plan', 'credential_in_use', 'trial_ended']);

function softRefusalPath(scope) {
  const name = String(scope || UNSCOPED).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 80) || UNSCOPED;
  return path.join(machineDir(), 'refusals', `${name}.json`);
}

/**
 * The soft refusal this machine last met for this organisation and has not
 * seen lift, or undefined. `scope` is what a report names as its
 * organisation — `reportScope(config)`, or a binding's own account.
 */
export function readSoftRefusal(scope) {
  try {
    const found = JSON.parse(fs.readFileSync(softRefusalPath(scope), 'utf8'));
    if (found && typeof found.reason === 'string' && SOFT_REFUSALS.has(found.reasonCode)) return found;
  } catch {}
  return undefined;
}

function noteSoftRefusal(scope, refusal) {
  const file = softRefusalPath(scope);
  try {
    if (refusal && SOFT_REFUSALS.has(refusal.reasonCode)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({
        reasonCode: refusal.reasonCode, reason: refusal.reason, at: new Date().toISOString(),
      })}\n`, { mode: 0o600 });
    } else if (!refusal && fs.existsSync(file)) {
      // Accepted again for this organisation: the cause is gone, and so is
      // its notice. Another organisation's is not this report's to clear.
      fs.rmSync(file, { force: true });
    }
  } catch {
    // A sandbox that cannot write here loses the notice, never the report.
  }
}

/**
 * This machine's own id, for the one-machine rule (MACLEOD-620).
 *
 * Random, made once and kept in `machineDir()` — never the hostname, which
 * changes with the network and says something about the person. One file
 * per home directory, whatever `CLAUDE_PLUGIN_DATA` says, so every config
 * directory and every tool on the laptop is one machine (audit, B1). A
 * devcontainer or remote shell that shares the home directory shares it
 * too; a copied credential file does not.
 *
 * '' when the id cannot be kept. A fresh id per process would make every
 * session look like a new machine, and a reporter that sends none is
 * simply never asked.
 */
const MACHINE_ID = /^[A-Za-z0-9_-]{16,64}$/;
let machineIdCache;

export function machineId() {
  if (machineIdCache !== undefined) return machineIdCache;
  const file = path.join(machineDir(), 'machine-id');
  const read = () => {
    try {
      const value = fs.readFileSync(file, 'utf8').trim();
      return MACHINE_ID.test(value) ? value : undefined;
    } catch {
      return undefined;
    }
  };
  let id = read();
  if (!id) {
    try {
      fs.mkdirSync(machineDir(), { recursive: true });
      // `wx`: two first hooks racing must not end with two ids.
      fs.writeFileSync(file, `m_${crypto.randomBytes(16).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
    } catch {}
    id = read();
  }
  machineIdCache = id || '';
  return machineIdCache;
}

export function resetMachineIdCache() {
  machineIdCache = undefined;
}


let paymentNoticeShown = false;

// 402 is a billing problem, not a developer's problem. Say it once and
// let the session carry on: reporting is observability, never a gate.
//
// What a 402 means changed in MACLEOD-612. The service meters by seat
// now, so an account with a live reporting seat is never refused for
// balance however hard its agents run. A 402 therefore means one thing
// only: nobody on this account holds a seat. "Top up" was the old
// answer and is no longer an answer at all — there is nothing to top up.
function notePaymentRequired(config, body) {
  if (paymentNoticeShown) return;
  paymentNoticeShown = true;
  const link = body?.payment?.payment_link || body?.payment?.checkout_url;
  const where = link ? `Take a seat: ${link}` : `Take a seat at ${serviceUrl(config)}.`;
  try {
    process.stderr.write(`TeamFlow: reporting paused, no reporting seat on this account. ${where}\n`);
  } catch {}
}

export function resetPaymentNotice() {
  paymentNoticeShown = false;
}

/**
 * The last word on whether this report may go out, taken where the
 * credential is actually chosen (MACLEOD-586 audit, finding 3).
 *
 * Every other check in this ticket asks `organisationScope`, which asks
 * `credentialOwner`, which is deliberately the STABLE answer and not the
 * true one — it has to be, because it names local files and may not
 * change mid-process. Its one guess is the one that matters here: a
 * session that will not refresh falls back to an API key, and the
 * tenant a report lands in is the key's. So a binding stamped
 * `account-acme` passed every synchronous check and the report went out
 * with somebody else's key, which is this ticket's own defect surviving
 * its own fix.
 *
 * Refused rather than queued. The report is not wrong, but it is not
 * this credential's to send, and a queue entry would only ask the same
 * question again later.
 *
 * A credential that names nobody — a bearer token handed in with no
 * account, which fingerprints to nothing — is refused too, and that is
 * the deliberate direction: "I cannot tell whose this is" and "it is
 * theirs" must have the same answer, or the bypass is a missing
 * environment variable away.
 */
function carrierRefusal(account, owner) {
  /*
   * An absent `account` used to mean "skip the check" (MACLEOD-601
   * audit, finding 3). That made the guard opt-in: four publishers
   * never passed one, so four publishers went round it, and two of them
   * are now driven unprompted by reconciliation. A check a caller
   * bypasses by forgetting an argument is not a check.
   *
   * So absence is a refusal, and an install that genuinely names no
   * organisation says so with `UNSCOPED` — an argument somebody had to
   * type, not an omission somebody made.
   */
  if (account === undefined) {
    return 'not sent: this report did not say which organisation it belongs to. '
      + 'Every publisher names one; pass `reportScope(config)`.';
  }
  const carrier = scopeOf(ownerId(owner));
  /*
   * A machine that cannot name an organisation — a CI token exchanged
   * against a service that named none — may still report, and its
   * credential must be as anonymous as it is. A credential that DOES
   * name one is a report scoped to nobody going out on somebody's key,
   * which is the same leak in the other direction.
   */
  if (account === UNSCOPED) {
    return carrier
      ? `not sent: this machine names no organisation and the credential in hand is ${scopeName(carrier)}'s. `
        + 'Sign in with `teamflow login`, or report with that organisation\'s own credential.'
      : undefined;
  }
  if (carrier === account) return undefined;
  const whose = carrier
    ? `the credential in hand is ${scopeName(carrier)}'s`
    : 'the credential in hand names no organisation';
  return `not sent: this report is ${scopeName(account)}'s and ${whose}. `
    + 'Sign in again with `teamflow login`, or re-bind under the organisation reporting now.';
}

async function postEnvelope(endpoint, envelope, idempotencyKey, config, account = undefined) {
  /*
   * The address is rebuilt from `serviceUrl(config)` rather than used as
   * given (MACLEOD-616 follow-up, F4).
   *
   * `sendReport` builds `endpoint` from `serviceUrl(config)` a moment
   * earlier, but `flushOutbox` reads it off disk: a queued item carries
   * the whole URL it was addressed to when it was written. That string
   * is not what `credentialDestination` checked — it checked
   * `serviceUrl(config)` — so a queued item was the one way a credential
   * could still meet a URL nothing had validated. It was saved only by
   * `mayDeliver` comparing the owner's service to the current one, which
   * is MACLEOD-583's rule doing this one's job by coincidence.
   *
   * Only the path and query are kept, so the origin is always the one
   * the rule approved, and the contract test needs no exception for it.
   */
  let route;
  try {
    const asked = new URL(String(endpoint));
    route = `${asked.pathname}${asked.search}`;
  } catch {
    return { ok: false, retry: false, reason: `not sent: ${endpoint} is not an address` };
  }
  const cred = await credential(config);
  // `credentialRefusal` when there is one: a report that was refused
  // because the credential does not belong to this service is a
  // different thing from one that had no credential at all, and only
  // the first has a remedy (MACLEOD-616).
  if (!cred) return { ok: false, retry: false, reason: credentialRefusal(config) || 'no service credential available' };
  // Whose report this was, taken from the credential that is about to
  // carry it rather than from the one config would have chosen: a
  // session that will not refresh falls back to an API key, and the
  // organisation that receives the report is the key's.
  const secret = cred.kind === 'api_key' ? cred.value : String(cred.value).replace(/^Bearer\s+/i, '');
  const owner = ownerFrom(cred.kind, secret, config);
  // Before the fetch, and with no owner on the answer: nothing is sent,
  // so nothing is queued and there is no owner to record.
  const refused = carrierRefusal(account, owner);
  if (refused) return { ok: false, retry: false, refused: true, reason: refused };
  const answer = (result) => ({ ...result, owner });
  const machine = machineId();
  let response;
  try {
    response = await fetch(`${serviceUrl(config)}${route}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [cred.header]: cred.value,
        'Idempotency-Key': idempotencyKey,
        // An identifier, not content (docs/REPORTING_CONTRACT.md).
        ...(machine ? { 'X-Machine-Id': machine } : {}),
      },
      body: JSON.stringify(envelope),
      // `Authorization` is stripped by fetch across a redirect; `X-Api-Key`
      // is not, so a 301 would hand the key to whoever answered it.
      redirect: 'error',
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 5000)),
    });
  } catch (error) {
    // Offline, DNS, TLS, timeout, or a redirect this may not follow. The
    // report is still true, so keep it.
    return answer({ ok: false, retry: true, reason: unreachableReason(error, config) });
  }
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  const status = response.status;
  if (status === 402) {
    notePaymentRequired(config, body);
    const refusal = refusalOf(body, 'no reporting seat on this account');
    // `payment_failed` may arrive as a 402 as well as a 403; either way it
    // is a pause that lifts by itself, and is remembered like one.
    noteSoftRefusal(account, refusal);
    return answer({
      ok: false, retry: false, status, paymentRequired: true,
      ...refusal,
    });
  }
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
  if (status === 429) {
    // The only retryable 4xx. Nothing about the report is wrong; the
    // caller simply arrived too fast, and the same body posted later
    // is accepted.
    return answer({ ok: false, retry: true, status, retryAfterMs, ...refusalOf(body, 'rate limited') });
  }
  if (status >= 500) {
    return answer({ ok: false, retry: true, status, retryAfterMs, ...refusalOf(body, `service returned ${status}`) });
  }
  if (status >= 400) {
    // 400, 401, 403, 413. Re-posting the same body cannot change the
    // answer, and one refused report must never dam the outbox in
    // front of the good reports behind it.
    const refusal = refusalOf(body, `service refused the report (${status})`);
    noteSoftRefusal(account, refusal);
    return answer({
      ok: false,
      retry: false,
      status,
      ...refusal,
    });
  }
  noteSoftRefusal(account, undefined);
  return answer({
    ok: true,
    status,
    replay: Boolean(body?.replay),
    droppedFields: Array.isArray(body?.dropped_fields) ? body.dropped_fields : [],
    // A heartbeat's reply (MACLEOD-641): other sessions on this session's
    // cards, and the cards it holds.
    ...(Array.isArray(body?.others) ? { others: body.others } : {}),
    ...(Array.isArray(body?.holds) ? { holds: body.holds } : {}),
    // A card line's reply (MACLEOD-770): stored, older or no_card.
    ...(['stored', 'older', 'no_card'].includes(body?.said) ? { said: body.said } : {}),
    // An inventory's reply (MACLEOD-773): the board's open cards, which the
    // same pass checks for a merge. Keys only; merged.mjs checks each one.
    ...(Array.isArray(body?.open_keys) ? { openKeys: body.open_keys } : {}),
    // The key this report was sent under became a ticket (ADHOC-15):
    // the service wrote it under `convertedTo`, and the session follows.
    ...(isAdHocKey(body?.converted_from) && typeof body?.converted_to === 'string'
      ? { convertedFrom: String(body.converted_from).toUpperCase(), convertedTo: body.converted_to, convertedTracker: body.converted_tracker }
      : {}),
    // The organisation's ad hoc setting for this item (MACLEOD-642).
    ...(body?.adhoc_ticket && typeof body.adhoc_ticket === 'object' ? { adhocTicket: body.adhoc_ticket } : {}),
  });
}

/**
 * How many files one flush will look at.
 *
 * `limit` bounds the requests a flush makes; this bounds the reading it
 * does to find them, and only unreadable-or-foreign files are read for
 * nothing. It has to be far larger than `limit`, because another
 * organisation's queued reports sit in the same directory, sort by the
 * time they were queued, and are never attempted: a cap anywhere near
 * `limit` would let one long offline stretch under A put a permanent
 * wall in front of every report B queues afterwards. Nothing prunes
 * them except the age horizon below, so the wall would never come down.
 */
const OUTBOX_SCAN_LIMIT = 1000;

/**
 * How long a queued report is worth sending.
 *
 * Every report is a full-state document, so a week-old one describes a
 * ticket that has since been re-reported several times: posting it
 * costs a credit to write something already known and, for a document
 * that sorts after the current one, wrong. This is the only thing that
 * empties the queue of reports nobody can deliver — a foreign item is
 * never attempted, so nothing else ever would.
 */
const OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** When an item was queued: the file name is `<epoch ms>-<uuid>.json`. */
function queuedAt(file, full) {
  const stamp = Number(String(file).split('-')[0]);
  if (Number.isFinite(stamp) && stamp > 0) return stamp;
  try { return fs.statSync(full).mtimeMs; } catch { return undefined; }
}

function discardsPath() {
  return path.join(dataDir(), 'outbox-discards.json');
}

/**
 * What a flush threw away and why, kept until somebody is told.
 *
 * A hook cannot print — every hook exits 0 and says nothing its tool
 * could read as a denial — so the tally waits here for `teamflow
 * status` or `teamflow doctor`, which say it once and clear it.
 */
export function readDiscards() {
  const kept = readJson(discardsPath(), {}) || {};
  return { ownerless: Number(kept.ownerless) || 0, expired: Number(kept.expired) || 0 };
}

export function noteDiscards({ ownerless = 0, expired = 0 } = {}) {
  if (!ownerless && !expired) return;
  const kept = readDiscards();
  try {
    writeJson(discardsPath(), {
      ownerless: kept.ownerless + ownerless,
      expired: kept.expired + expired,
      updatedAt: new Date().toISOString(),
    });
  } catch {}
}

export function clearDiscards() {
  try { fs.unlinkSync(discardsPath()); } catch {}
}

/** Files in a queue directory, oldest first, bounded. */
function queueFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort().slice(0, OUTBOX_SCAN_LIMIT);
}

/**
 * The only thing done to the directory an older plugin owns: remove
 * what it has not managed to deliver in a week.
 *
 * Nothing here is ever sent. The items are that plugin's, queued under
 * rules that could not say whose they were, and this plugin has no way
 * to learn the answer. What it can do is stop them accumulating for
 * ever on a machine whose older copy has since been removed.
 */
function sweepLegacyOutbox(now) {
  let expired = 0;
  for (const file of queueFiles(legacyOutboxDir())) {
    const full = path.join(legacyOutboxDir(), file);
    const queued = queuedAt(file, full);
    if (queued === undefined || now - queued <= OUTBOX_MAX_AGE_MS) continue;
    try {
      fs.unlinkSync(full);
      expired += 1;
    } catch {}
  }
  return expired;
}

/** How many reports an older copy of the plugin still has queued here. */
export function legacyQueued() {
  return queueFiles(legacyOutboxDir()).length;
}

export async function flushOutbox(config, limit = 5) {
  const mode = transportOf(config);
  const now = Date.now();
  if (mode === 'none') return { sent: 0, dropped: 0, deferred: 0, foreign: 0, ownerless: 0, expired: 0, remaining: 0 };
  // The older plugin's directory first, and only ever to age it out.
  let expired = sweepLegacyOutbox(now);
  if (!fs.existsSync(outboxDir())) {
    noteDiscards({ expired });
    return { sent: 0, dropped: 0, deferred: 0, foreign: 0, ownerless: 0, expired, remaining: 0 };
  }
  const files = queueFiles(outboxDir());
  // Resolved once. postEnvelope resolves the same credential a moment
  // later and the access token is cached in memory, so this costs
  // nothing a report was not already paying.
  const owner = mode === 'service' ? await currentOwner(config) : undefined;
  let sent = 0;
  let dropped = 0;
  let deferred = 0;
  let foreign = 0;
  let ownerless = 0;
  let attempted = 0;
  for (const file of files) {
    if (attempted >= limit) break;
    const full = path.join(outboxDir(), file);
    const item = readJson(full);
    // Too old to be true, whoever owns it. Checked before ownership,
    // because an item nobody can deliver is exactly the one that would
    // otherwise sit here for ever.
    const queued = item ? queuedAt(file, full) : undefined;
    if (queued !== undefined && now - queued > OUTBOX_MAX_AGE_MS) {
      fs.unlinkSync(full);
      expired += 1;
      continue;
    }
    if (item?.endpoint && item?.envelope) {
      if (mode !== 'service') continue;
      // Queued by a plugin that did not record whose it was. It is not
      // sent — not by this organisation and not by any other, because
      // nothing here can know which one queued it — and it is not kept
      // either: the ticket's current state goes out again on the next
      // event, so throwing it away costs a duplicate of nothing.
      if (isOwnerless(item)) {
        fs.unlinkSync(full);
        ownerless += 1;
        continue;
      }
      // Somebody else's. Left exactly as it is — not sent, not retried,
      // not rescheduled, not renamed, and counted as neither dropped
      // nor failed — for the session that can deliver it. Skipped and
      // not a stop, because the reports behind it may well be ours, and
      // it does not count against `limit` for the same reason.
      if (!mayDeliver(item, owner)) {
        foreign += 1;
        continue;
      }
      if (item.notBefore && now < item.notBefore) {
        deferred += 1;
        continue;
      }
      attempted += 1;
      /*
       * The organisation this item was queued FOR, not the one this
       * config names (MACLEOD-601 audit, finding 3). `mayDeliver` above
       * has already established that they are the same — that is the
       * whole of MACLEOD-583 — so this re-states the answer rather than
       * asking a second question, and it is what keeps `postEnvelope`
       * able to refuse an unnamed send without the flush becoming the
       * one caller that is exempt. An item whose owner names nobody is
       * `UNSCOPED`: it was queued by a credential that could not say,
       * which is a fact about it and not an omission here.
       */
      const forWhom = scopeOf(ownerId(item.owner)) || UNSCOPED;
      const result = await postEnvelope(
        item.endpoint, item.envelope, item.idempotencyKey, config, forWhom);
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
      if (!mayPut(item, config)) {
        foreign += 1;
        continue;
      }
      attempted += 1;
      if (!s3Put(item.uri, item.payload, config).ok) break;
      fs.unlinkSync(full);
      sent += 1;
      continue;
    }
    fs.unlinkSync(full);
    dropped += 1;
  }
  noteDiscards({ ownerless, expired });
  const remaining = fs.existsSync(outboxDir())
    ? fs.readdirSync(outboxDir()).filter((name) => name.endsWith('.json')).length
    : 0;
  return { sent, dropped, deferred, foreign, ownerless, expired, remaining };
}

/**
 * What is in the outbox and what a flush has thrown away, for the two
 * commands a person runs when a ticket stops moving.
 *
 * Reads; never delivers, never discards. `discarded` is cleared by
 * whoever prints it — see `clearDiscards`.
 */
export async function outboxSummary(config = {}) {
  const discarded = readDiscards();
  // Evidence of an older copy of the plugin on this machine, which is
  // the one thing this fix cannot reach: items in the directory only a
  // pre-0.3.14 plugin writes to. Cheap, read-only, and the only honest
  // way to say the machine is not fully fixed yet.
  const legacy = legacyQueued();
  if (!fs.existsSync(outboxDir())) return { queued: 0, foreign: 0, legacy, discarded };
  const files = fs.readdirSync(outboxDir()).filter((name) => name.endsWith('.json')).sort()
    .slice(0, OUTBOX_SCAN_LIMIT);
  const mode = transportOf(config);
  const owner = mode === 'service' ? await currentOwner(config) : undefined;
  let queued = 0;
  let foreign = 0;
  for (const file of files) {
    const item = readJson(path.join(outboxDir(), file));
    if (!item) continue;
    queued += 1;
    if (item.endpoint && item.envelope) {
      if (mode === 'service' && !isOwnerless(item) && !mayDeliver(item, owner)) foreign += 1;
    } else if (item.uri && item.payload && mode === 's3' && !mayPut(item, config)) {
      foreign += 1;
    }
  }
  return { queued, foreign, legacy, discarded };
}

/** The one sentence `status` and `doctor` both say about the outbox. */
export function outboxLine(summary) {
  const parts = [`${summary.queued} report${summary.queued === 1 ? '' : 's'} queued`];
  if (summary.foreign) parts.push(`${summary.foreign} waiting for another organisation`);
  if (summary.legacy) {
    parts.push(`${summary.legacy} in the queue an older plugin owns — a copy before 0.3.14 is `
      + 'still installed on this machine and will send them with whatever credential it holds; '
      + 'update every copy');
  }
  if (summary.discarded.ownerless) {
    parts.push(`${summary.discarded.ownerless} discarded: queued by an older version `
      + 'without saying which organisation they were for; the current state is sent '
      + 'again on the next event');
  }
  if (summary.discarded.expired) {
    parts.push(`${summary.discarded.expired} discarded: queued more than seven days ago`);
  }
  return parts.join('; ');
}

// POST one report to the service. kind is the envelope kind
// ("issue" or "runtime"); slot is required for runtime and absent for
// an issue, because it is a path segment the service checks.
export async function sendReport(kind, slot, payload, config, { account, flush = true } = {}) {
  if (!credentialKind(config)) return { ok: false, skipped: true, reason: 'no service credential configured' };
  const document = serviceDocument(payload, kind);
  const envelope = slot ? { kind, slot, payload: document } : { kind, payload: document };
  const endpoint = `${serviceUrl(config)}/v1/report`;
  const idempotencyKey = reportIdempotencyKey(kind, slot, document);
  // `account` is the organisation this report belongs to, when the
  // caller knows one (MACLEOD-586). Checked against the credential that
  // will carry it, inside postEnvelope.
  const result = await postEnvelope(endpoint, envelope, idempotencyKey, config, account);
  if (result.retry) {
    // `owner` is the whole fix: where to send it, what to send, and
    // whose it is. Never the credential — that is resolved again when
    // the report finally goes out.
    queueOutbox(scheduleRetry({ endpoint, envelope, idempotencyKey, owner: result.owner }, result));
    return { ok: false, queued: true, status: result.status, reason: result.reason };
  }
  /*
   * `flush: false` is for a sender that is itself already a bounded
   * background pass (MACLEOD-601 audit, finding 9). A flush is up to
   * five more requests of up to five seconds each, so "reconcile posts
   * at most two reports on `Stop`" was really "at most two, each of
   * which may drag five more behind it" — on the path the person is
   * waiting on. The hook flushes on its own beat either way.
   */
  if (result.ok && flush) await flushOutbox(config);
  return result;
}

/**
 * POST one heartbeat (MACLEOD-641). Never queued and never retried: a
 * beat that could not go out is replaced by the next one two minutes
 * later, and a queue of old beats would say a dead session was alive.
 * The payload is heartbeat.mjs's own allowlist, built field by field.
 */
export async function sendHeartbeat(payload, config) {
  if (!credentialKind(config)) return { ok: false, skipped: true, reason: 'no service credential configured' };
  const envelope = { kind: 'heartbeat', payload };
  const idempotencyKey = crypto.createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
  return postEnvelope(`${serviceUrl(config)}/v1/report`, envelope, idempotencyKey, config, reportScope(config));
}

/**
 * One inventory (MACLEOD-641): everything this machine holds open on one
 * repository, so the service can reconcile. Free like a beat, and never
 * queued: the next one is about twenty minutes away.
 */
export async function sendInventory(payload, config) {
  if (!credentialKind(config)) return { ok: false, skipped: true, reason: 'no service credential configured' };
  const envelope = { kind: 'inventory', payload };
  const idempotencyKey = crypto.createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
  return postEnvelope(`${serviceUrl(config)}/v1/report`, envelope, idempotencyKey, config, reportScope(config));
}

/**
 * What this repository's git history proves merged (MACLEOD-726):
 * `{ repo, at, merged: [{ key, merged, mergedAt, via }] }`, from the
 * inventory pass and `teamflow reconcile --merged`. Free like an
 * inventory, and never queued.
 */
export async function sendMerged(payload, config) {
  if (!credentialKind(config)) return { ok: false, skipped: true, reason: 'no service credential configured' };
  const envelope = { kind: 'merged', payload };
  const idempotencyKey = crypto.createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
  return postEnvelope(`${serviceUrl(config)}/v1/report`, envelope, idempotencyKey, config, reportScope(config));
}

/**
 * A card's plain line (MACLEOD-770): `{ jiraKey, line, by, at }`, built
 * field by field here and checked by the words checker before it is
 * called (say.mjs) and again by the service. Free like a merged fact.
 * Queued and retried like a report: the line is the model's work, and a
 * service that did not answer should not lose it.
 */
export async function sendSay({ jiraKey, line, by, at }, config) {
  if (!credentialKind(config)) return { ok: false, skipped: true, reason: 'no service credential configured' };
  const envelope = { kind: 'say', payload: { jiraKey: String(jiraKey), line: String(line), by: String(by), at: String(at) } };
  const endpoint = `${serviceUrl(config)}/v1/report`;
  const idempotencyKey = crypto.createHash('sha256').update(JSON.stringify(envelope)).digest('hex');
  const result = await postEnvelope(endpoint, envelope, idempotencyKey, config, reportScope(config));
  if (result.retry) {
    queueOutbox(scheduleRetry({ endpoint, envelope, idempotencyKey, owner: result.owner }, result));
    return { ok: false, queued: true, status: result.status, reason: result.reason };
  }
  return result;
}

export async function fetchAccount(config) {
  const cred = await credential(config);
  if (!cred) return { ok: false, reason: 'no service credential available' };
  try {
    const response = await fetch(`${serviceUrl(config)}/v1/account`, {
      headers: { [cred.header]: cred.value },
      redirect: 'error',
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 5000)),
    });
    let body;
    try { body = await response.json(); } catch { body = undefined; }
    if (!response.ok) {
      return { ok: false, status: response.status, ...refusalOf(body, `service returned ${response.status}`) };
    }
    return { ok: true, status: response.status, account: body, credential: cred.kind, email: cred.email, degraded: cred.degraded };
  } catch (error) {
    // `doctor`'s `serviceAccess` line is where somebody whose config names
    // an alias of the hosted host will look, so this is one of the two
    // places the redirect refusal has to explain itself (MACLEOD-616).
    return { ok: false, reason: unreachableReason(error, config) };
  }
}

/**
 * The organisation's own name, as the state route spells it in a path.
 *
 * NOT `organisationScope`, which is the local file-name form
 * (`account-acme`, or a fingerprint when the credential names nobody).
 * `GET /v1/state/tenants/<account>/...` compares its path segment
 * against what the credential resolved to at the far end, so a
 * fingerprint there is a 404 every time.
 *
 * Asked of the service only when the credential does not say: an API
 * key that fingerprints to nothing is the case the extra round trip
 * exists for. Memoised for the life of the process because a CLI
 * command reads a handful of documents and asking once per read is a
 * handful of round trips for an answer that cannot change.
 */
let accountNameCache;

export function resetAccountName() {
  accountNameCache = undefined;
}

export async function accountName(config = {}) {
  const known = credentialOwner(config)?.account;
  if (known) return known;
  if (accountNameCache !== undefined) return accountNameCache || undefined;
  const probe = await fetchAccount(config);
  accountNameCache = probe.ok ? String(probe.account?.account || '') : '';
  return accountNameCache || undefined;
}

/**
 * Read one document back out of this organisation's own tenant prefix.
 *
 * The read half of `sendReport`, and the reason `teamflow workflow
 * ticket` can say what the TRACKER now thinks rather than only what it
 * just told the board (MACLEOD-601). The route is the dashboard's own
 * (`GET /v1/state/tenants/<account>/<path>`), the credential is the
 * same one a report goes out under, and the service refuses any tenant
 * but the credential's — so this cannot read another organisation's
 * anything, whatever is passed.
 *
 * Never on the hook path. It is a network round trip with nothing
 * queued behind it, and a hook that waits on one is a hook standing
 * between a ticket and its own report.
 *
 * `missing: true` for a document that is simply not there, which is the
 * ordinary answer for a ticket no tracker has ever mentioned and must
 * read differently from a failure.
 */
export async function fetchState(relativePath, config = {}) {
  const cred = await credential(config);
  if (!cred) return { ok: false, reason: 'no service credential available' };
  const account = await accountName(config);
  if (!account) return { ok: false, reason: 'this credential names no organisation' };
  const clean = String(relativePath || '').replace(/^\/+/, '');
  try {
    const response = await fetch(
      `${serviceUrl(config)}/v1/state/tenants/${encodeURIComponent(account)}/${clean}`,
      {
        headers: { [cred.header]: cred.value },
        redirect: 'error',
        signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 5000)),
      },
    );
    if (response.status === 404) return { ok: true, missing: true, document: undefined };
    if (!response.ok) return { ok: false, status: response.status, reason: `service returned ${response.status}` };
    return { ok: true, document: await response.json() };
  } catch (error) {
    return { ok: false, reason: `service unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// Legacy: one object, one deterministic S3 key, aws CLI credentials.
export async function putReport(relativePath, payload, config) {
  if (!config.dataUri) return { ok: false, skipped: true, reason: 'TEAMFLOW_DATA_URI not configured' };
  const base = String(config.dataUri).replace(/\/$/, '');
  const uri = `${base}/${relativePath.replace(/^\//, '')}`;
  const clean = sanitizePayload(payload, { kind: /(^|\/)runtime\//.test(relativePath) ? 'runtime' : 'issue' });
  const result = s3Put(uri, clean, config);
  if (!result.ok) {
    queueOutbox({ uri, payload: clean });
    return { ok: false, queued: true, reason: result.stderr || 'aws s3 cp failed' };
  }
  await flushOutbox(config);
  return { ok: true };
}

/**
 * What a report SAYS, with every field that only says WHEN removed
 * (MACLEOD-613).
 *
 * This used to blank the top-level `updatedAt` and nothing else, which
 * missed `executions[0].at` — the same value, copied one level down by
 * `issuePayload`. So every report that had bumped `updatedAt` hashed
 * differently from the one before it even when it said exactly the same
 * thing, and the deduplication below never fired for any of them.
 *
 * This fix is worth about a fifth on its own, and the honest split
 * matters because the rest is a judgement rather than a bug. Replaying
 * this machine's own 2026-09-17..20 history: 13,099 reports under the
 * shipped rule; 10,759 with this digest and the old 30s keep-alive, so
 * **18%**; 5,879 with the keep-alive also raised to `KEEP_ALIVE_MS`, so
 * **55%**. The other 37 points are the keep-alive, which is a trade
 * against how promptly a quiet card refreshes — not a defect repaired.
 *
 * Only the clock is removed. A commit sha, a loop count, a PR check
 * count and a piece of evidence are all news, and a report that carries
 * new news is a report that must go.
 */
export function reportDigest(payload) {
  const stable = { ...payload, updatedAt: undefined };
  if (Array.isArray(stable.executions)) {
    stable.executions = stable.executions.map((one) => ({ ...one, at: undefined }));
  }
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

/**
 * How long an unchanged ticket waits before it is restated (MACLEOD-613).
 *
 * The board's freshness bands are `live ≤5min, active ≤15min, stale
 * ≤60min` (src/lib/freshness.ts), driven by report times, so
 * suppressing no-ops without a keep-alive would draw a developer who is
 * quietly editing as stale.
 *
 * This is permission to send, NOT a send: nothing here has a timer, so
 * the report goes out at the first hook AFTER the keep-alive elapses,
 * and the gap a reader of the board actually experiences is the
 * keep-alive plus however long until the next tool call. Measured on
 * the replayed history, counting real gaps between consecutive reports
 * of the same actor (baseline under the shipped rule: 222 gaps over
 * five minutes) — 240s: 304 gaps, +37%. 150s: 241, +8.6%. 90s: 232, and
 * 1,000 more reports for it.
 *
 * MACLEOD-617 then refitted the bands to those measured gaps rather
 * than shortening this, so 150s plus the measured p90 wait for the next
 * hook (92s) lands inside `live` with a minute to spare: a developer at
 * the keyboard reads `live` between transitions, which is what the
 * colour is for. Off all three band edges, and deliberately not the 30s
 * it used to be, which sat exactly on the `live` one of the day — a
 * value on a band edge decides the band by a race, which is the
 * flakiness the fixtures are already forbidden from reproducing. The
 * inequality is asserted from both sides: plugin/tests/coalesce.test.mjs
 * and src/lib/freshnessContract.test.ts.
 */
export const KEEP_ALIVE_MS = 150000;

/**
 * Whether this report goes out now (MACLEOD-613).
 *
 * Three answers and no timer. There is no timer because there is
 * nothing to hold a report in: every hook is a node process that
 * classifies one event and exits, and a debounce would need a state
 * file, a flush and a way for `SessionEnd`'s 1.5s to drain it. None of
 * that is needed, because a burst of edits does not change what the
 * report says — `LOCAL_DEV / running / Implementing locally` from the
 * first edit to the last — so the digest above already collapses the
 * burst to its first report, and the turn's `Stop` sends the last state.
 *
 * Nothing a person is waiting for is ever held: a stage change, a gate
 * verdict, rework, a new commit and a session or agent ending all change
 * the digest and go immediately, and `force` covers `Stop`, `teamflow
 * sync` and the pending-end flush.
 */
export function coalesce(state, payload, { force = false, now = Date.now(), config = {} } = {}) {
  const hash = reportDigest(payload);
  if (force) return { send: true, hash, reason: 'forced' };
  // `heartbeatMs` keeps its name: it has always meant "restate an
  // unchanged ticket no more often than this", and a repository that
  // set it — or a test that set it to 0 — means the same thing by it.
  const keepAlive = Number(config.heartbeatMs ?? KEEP_ALIVE_MS);
  /*
   * Refused is not delivered, and the two are stored as two
   * (MACLEOD-613 audit, finding 1).
   *
   * A report the service read and said no to used to be written down as
   * the last thing published, so the state was lost: the pause lifted
   * and the five hooks that followed sent nothing, because the board's
   * copy and this machine's record disagreed and only this machine's
   * was consulted. `lastPublishHash` is now only ever what was
   * accepted or safely queued.
   *
   * But 0.3.16's rule still holds — a refusal that cannot change its
   * mind must not be re-posted on every hook — so the refusal is
   * remembered separately, and held for the same beat as an unchanged
   * ticket. It is retried when that beat comes round and whenever
   * anything forces a publish, which is every `Stop`: a paused
   * organisation therefore re-attempts about once a turn rather than
   * once a tool call, and the moment the pause lifts the state lands.
   */
  if (state.lastRefusedHash === hash && now - (state.lastRefusedAt || 0) < keepAlive) {
    return { send: false, hash, reason: 'refused' };
  }
  if (state.lastPublishHash !== hash) return { send: true, hash, reason: 'changed' };
  if (now - (state.lastPublishedAt || 0) >= keepAlive) return { send: true, hash, reason: 'keep-alive' };
  return { send: false, hash, reason: 'unchanged' };
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
      // READY_PROD is retired (MACLEOD-594) but a session written by an
      // older plugin still says it, and it meant what DONE means here.
      const terminal = ['DEV_VERIFIED', 'DONE', 'READY_PROD'].includes(session.stage) || session.ended;
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

/**
 * The report a merge of somebody else's branch makes for THEIR ticket
 * (MACLEOD-639): MERGE success on the key the branch name carries,
 * from the session that ran the merge. Everything this session knows
 * about its own ticket — its loops, its stage history, its git
 * snapshot, its pull request, its title — is left off, because none of
 * it is true of the merged one. The execution id is this actor's, which
 * is right: the row on the merged ticket says who merged it.
 */
export function attributedPayload(state, attribution, config, info = {}) {
  const ghost = {
    ...state,
    binding: { ...(state.binding || {}), key: attribution.key, source: 'branch', sticky: false },
    stage: attribution.stage,
    status: attribution.status,
    summary: attribution.summary,
    updatedAt: attribution.at,
    loopCount: 0,
    reworkFrom: undefined,
    rework: undefined,
    reworkLog: undefined,
    lastFailure: undefined,
    testPoints: undefined,
    testRound: undefined,
    testsPassed: undefined,
    waitingOn: undefined,
    transitions: [{ stage: attribution.stage, at: attribution.at, by: attribution.by }],
    evidence: [],
    git: undefined,
    pr: undefined,
    jira: undefined,
  };
  return issuePayload(ghost, config, { ...info, branch: attribution.branch || info.branch });
}

async function publishAttributions(state, config, info) {
  const pending = state.attributions || [];
  if (!pending.length) return;
  state.attributions = [];
  const transport = transportOf(config);
  for (const attribution of pending) {
    const payload = attributedPayload(state, attribution, config, info);
    if (!payload) continue;
    // A network failure is queued by the sender and retried from the
    // outbox; a refusal is the service's answer and is not re-asked.
    if (transport === 'service') {
      await sendReport('issue', undefined, payload, config, {
        account: state.binding?.account || state.account || reportScope(config),
      });
    } else {
      await putReport(tenantPath(config, `issues/${payload.jiraKey}.json`), payload, config);
    }
  }
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
  // Reports addressed to other tickets go first (MACLEOD-639): they are
  // not this ticket's, so this ticket's coalescing must not swallow them.
  await publishAttributions(state, config, info);
  refreshReworkCycle(state, config);
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
  const { send, hash } = coalesce(state, payload, { force, now, config });
  if (!send) return { ok: true, skipped: true, reason: 'Deduplicated' };

  const transport = transportOf(config);
  let issueResult;
  let actorResult;
  if (transport === 'service') {
    /*
     * Whose report this is, carried to the send point (MACLEOD-586).
     *
     * The binding's stamp first, because it is a statement somebody
     * made about this ticket; the actor's otherwise, which this version
     * writes on every hook event. Either way it is compared against the
     * credential the request will actually carry, which is the only
     * comparison that cannot be fooled by a session quietly falling
     * back to an API key.
     */
    issueResult = await sendReport('issue', undefined, payload, config, {
      /*
       * `reportScope` last, never `undefined` (MACLEOD-601 audit,
       * finding 3): a session file written before MACLEOD-586 records
       * no account at all, and with absence now a refusal that session
       * would stop reporting entirely on the day the plugin upgrades.
       * What it falls back to is this machine's own answer, which is
       * exactly the comparison the check wants made.
       */
      account: state.binding?.account || state.account || reportScope(config),
    });
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

  /*
   * Only what the far end actually took (MACLEOD-613 audit, finding 1).
   * `queued` counts: the envelope is on disk with its payload and the
   * outbox owns it from there. A refusal and a `skipped` do not, and
   * writing them down as published is how a ticket's state stops
   * existing anywhere — the board never had it and this machine has
   * stopped intending to send it.
   */
  // The service answered that this ad hoc key is a ticket now (ADHOC-15):
  // remember it and rebind, so the next report is sent under the ticket.
  if (issueResult.convertedTo) {
    recordKeyAlias(issueResult.convertedFrom, issueResult.convertedTo, config, { tracker: issueResult.convertedTracker });
    followKeyAliases(state, state.cwd, config);
  }
  // "Ask first" (MACLEOD-642): said on the next prompt, once per item.
  const ask = askAboutTicketOnce(issueResult.adhocTicket, config);
  if (ask) state.intakePending = [...(state.intakePending || []), ask].slice(-8);
  if (issueResult.ok || issueResult.queued) {
    state.lastPublishHash = hash;
    state.lastPublishedAt = now;
    state.lastRefusedHash = undefined;
    state.lastRefusedAt = undefined;
  } else if (!issueResult.skipped) {
    // Read and refused. Remembered so it is not re-posted on every
    // hook, and deliberately NOT as a publish.
    state.lastRefusedHash = hash;
    state.lastRefusedAt = now;
  }
  state.lastTransport = transport;
  state.lastPublishResult = issueResult.ok
    ? 'ok'
    : issueResult.queued
      ? 'queued'
      : issueResult.paymentRequired
        ? 'payment_required'
        // Refused where the credential is chosen, because the report
        // belongs to another organisation (MACLEOD-586). Its own line
        // carrying the reason in full: `status` is where a person finds
        // out that a ticket has stopped moving on purpose.
        : issueResult.refused
          ? issueResult.reason
          // Nothing was attempted, so nothing failed (MACLEOD-572,
          // plugin audit row 17). A machine with no credential and no
          // data URI used to record `failed` here, and `status` printed
          // it three lines above `identity: not signed in` — so the
          // first thing a lost customer read was that their report had
          // been rejected, which it had not: it was never sent.
          // `skipped` is the flag both transports set for exactly that,
          // and only that; a configured transport that could not
          // deliver is `queued`.
          : issueResult.skipped
            ? 'not sent: this machine has nothing to send it with; run /teamflow:login'
            // The service read the report and answered no (MACLEOD-613).
            // Its reason is the only thing that says why the board has
            // stopped moving, and the bare word `failed` has sent people
            // to debug the dashboard for a paused account.
            : issueResult.reason || 'failed';
  return { ok: Boolean(issueResult.ok && actorResult.ok), transport, issueResult, actorResult };
}

// Sessions record the repository root they were opened against, so the
// question is asked in those terms too: `teamflow status` run three
// directories down is still asking about the same session.
//
// And the organisation they were opened under (MACLEOD-586 audit,
// finding 1). Every CLI path that publishes, prints or edits "the
// session" starts here, and each one remembering the check for itself is
// one of them forgetting: `teamflow sync` did, and would post the ticket
// a session bound under A to whichever board the credential in hand
// names. A session that records another organisation is not this
// session, so it is not returned at all.
//
// Compared only when both sides name one: a session written before this
// version records none and is still answered, or an upgrade would blank
// `teamflow status` until the next hook event, and an install with no
// credential has nothing to compare and never did.
export function latestSessionForCwd(cwd, config = {}) {
  cwd = repositoryRoot(cwd);
  const dir = path.join(dataDir(), 'sessions');
  if (!fs.existsSync(dir)) return undefined;
  const mine = organisationScope(config);
  const candidates = fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(dir, name)))
    .filter((state) => state?.cwd === cwd)
    .filter((state) => !mine || !state.account || state.account === mine)
    .sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
  return candidates[0];
}

export function saveSession(state) {
  // `agentKey` is what makes this an actor rather than a session
  // (MACLEOD-574). Absent on the main actor, which keeps its file name.
  writeJson(sessionPath(state.sessionId, state.agentKey), state);
}
