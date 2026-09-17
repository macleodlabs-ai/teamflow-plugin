import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import * as auth from './auth.mjs';

// Jira and Linear share this key shape; the configured tracker decides how it is labelled and linked.
const ISSUE_RE = /\b([A-Z][A-Z0-9]{1,11}-\d+)\b/i;
const JIRA_URL_RE = /\/browse\/([A-Z][A-Z0-9]{1,11}-\d+)\b/i;
const LINEAR_URL_RE = /linear\.app\/([\w.-]+)\/issue\/([A-Z][A-Z0-9]{1,11}-\d+)/i;
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

export function parseBindArgument(value, config = {}, info = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;
  // An explicit bind of "#123" means GitHub even when the configured tracker is not.
  const bare = raw.match(/^#?(\d+)$/);
  if (bare) return githubRef(resolveGithubRepo(config, info), bare[1]);
  return detectIssueRef(raw, config, info);
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

function mergeConfig(...configs) {
  return Object.assign({}, ...configs.filter(Boolean));
}

export function dataDir() {
  return process.env.CLAUDE_PLUGIN_DATA ||
    path.join(os.homedir(), '.local', 'share', 'teamflow');
}

export function projectId(cwd) {
  return crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16);
}

export function projectBindingPath(cwd, config = {}) {
  return path.join(dataDir(), 'bindings', tenantId(config), `${projectId(cwd)}.json`);
}

export function sessionPath(sessionId) {
  return path.join(dataDir(), 'sessions', `${sessionId}.json`);
}

export function loadConfig(cwd) {
  const globalConfig = readJson(path.join(os.homedir(), '.config', 'teamflow', 'config.json'), {});
  const projectConfig = readJson(path.join(cwd, '.teamflow.json'), {});
  const config = mergeConfig(globalConfig, projectConfig, {
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
  });
  for (const key of Object.keys(config)) {
    if (config[key] === undefined || config[key] === '') delete config[key];
  }
  return config;
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

function git(cwd, args) {
  return safeExec('git', ['-C', cwd, ...args], { cwd, timeout: 2000 });
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

export function actor(config, info) {
  const fallback = info.email?.split('@')[0] || info.name || os.userInfo().username;
  const id = String(config.actorId || fallback || 'unknown').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return { id, displayName: String(config.actorName || info.name || fallback || id) };
}

export function candidate(key, confidence, source, ref = {}) {
  const normalized = normalizeIssueKey(key);
  if (!normalized) return undefined;
  const out = { key: normalized, confidence, source, tracker: ref.tracker || 'jira' };
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

  if (manual?.jiraKey) {
    add({ key: manual.jiraKey, tracker: manual.tracker || tracker, repo: manual.repo, workspace: manual.workspace }, 1000, 'manual');
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
  const manual = readJson(projectBindingPath(cwd, config));
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
  if (state.binding.sticky && best.confidence < 1000) return state.binding;
  if (best.confidence > (state.binding.confidence || 0)) return { ...best, sticky: false };
  return state.binding;
}

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

export function enrichFromAtlassian(state, input, config) {
  if (!/atlassian|jira/i.test(input.tool_name || '')) return state;
  const response = input.tool_response;
  const key = extractJiraKey(JSON.stringify(response ?? '')) || state.binding?.key;
  if (!key || key !== state.binding?.key) return state;
  const title = stringField(response, ['summary', 'title', 'name']);
  const jiraStatus = stringField(response, ['statusName', 'status', 'state']);
  const url = stringField(response, ['browseUrl', 'webUrl', 'url']);
  const parentKey = extractJiraKey(stringField(response, ['parentKey', 'parent']) || '');
  return {
    ...state,
    jira: {
      ...(state.jira || {}),
      key,
      title: title?.slice(0, 180) || state.jira?.title,
      status: jiraStatus?.slice(0, 80) || state.jira?.status,
      url: /^https?:\/\//i.test(url || '') ? url : state.jira?.url,
      parentKeys: parentKey ? [parentKey] : state.jira?.parentKeys,
    }
  };
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

  if (event === 'SubagentStart') return { summary: 'Subagent started', heartbeat: true };
  if (event === 'SubagentStop') return { summary: 'Subagent finished', heartbeat: true };
  if (event === 'TaskCompleted') return { summary: state.summary || 'Task completed', heartbeat: true };

  if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    return {
      stage: 'LOCAL_DEV',
      status: failed ? 'failed' : 'running',
      summary: failed ? 'Code edit failed' : 'Implementing locally',
      sticky: true,
      clearRework: true,
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

  if (TEST_RE.test(command)) {
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

export function applyTransition(state, transition) {
  if (!transition) return state;
  return {
    ...state,
    stage: transition.stage || state.stage,
    status: transition.status || state.status,
    summary: transition.summary || state.summary,
    loopCount: (state.loopCount || 0) + (transition.incrementLoop ? 1 : 0),
    evidence: transition.evidence?.length ? transition.evidence : state.evidence,
    reworkFrom: transition.clearRework ? undefined : (transition.reworkFrom || state.reworkFrom),
    binding: state.binding ? { ...state.binding, sticky: transition.sticky ? true : state.binding.sticky } : state.binding,
    updatedAt: new Date().toISOString(),
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
    stage: state.stage || 'JIRA',
    status: state.status || 'running',
    summary: String(state.summary || 'Work detected').slice(0, 180),
    updatedAt: state.updatedAt || new Date().toISOString(),
    loopCount: state.loopCount || 0,
    reworkFrom: state.reworkFrom,
    evidence: (state.evidence || []).slice(0, 8),
    executions: [
      {
        id: `claude-${state.sessionId}`,
        kind: 'claude',
        label: state.subagentCount ? `Claude Code + ${state.subagentCount} subagent${state.subagentCount === 1 ? '' : 's'}` : 'Claude Code',
        stage: state.stage || 'JIRA',
        status: state.status || 'running',
        summary: String(state.summary || 'Work detected').slice(0, 180),
        evidence: (state.evidence || []).slice(0, 4),
        updatedAt: state.updatedAt || new Date().toISOString(),
      }
    ],
  };
}

export function sanitizePayload(value) {
  const allowed = new Set([
    'tracker','jiraKey','jiraUrl','title','jiraStatus','parentKeys','project','actor','repository','branch',
    'tenantId','stage','status','summary','updatedAt','loopCount','reworkFrom','evidence','executions',
    'id','kind','label','value','displayName','active','recent','slot'
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

const DEFAULT_SERVICE_URL = 'https://teamflow.macleodlabs.com';

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

export function latestSessionForCwd(cwd) {
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
