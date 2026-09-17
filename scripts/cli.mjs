#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import * as auth from './auth.mjs';
import {
  actor,
  credential,
  credentialKind,
  dataDir,
  fetchAccount,
  gitInfo,
  latestSessionForCwd,
  loadConfig,
  parseBindArgument,
  projectBindingPath,
  publishState,
  resolveGithubRepo,
  serviceUrl,
  tenantId,
  transportOf,
  trackerOf,
  safeExec,
  saveSession,
  writeJson,
} from './core.mjs';

// Two subcommands live in their own modules because they are the two a
// tool other than Claude Code actually runs: `report` moves a ticket and
// `skills` puts these same skills in front of whatever agent is being
// used. Both are lazily imported so `teamflow status` does not pay for
// them.
const TRACKER_MCP = { jira: 'atlassian', linear: 'linear', github: 'github' };
const USAGE = `teamflow \u2014 delivery reporting for TeamFlow

  teamflow login | logout          sign in once, or remove the session
  teamflow status                  who is signed in, what is bound, what was sent
  teamflow bind <issue> | unbind   name the ticket by hand, or stop
  teamflow sync                    publish the current state now
  teamflow doctor                  transport, account, credits, tracker MCP
  teamflow repos [list|add]        register a repository for CI OIDC
  teamflow report --issue ... --stage ...   report one stage transition
  teamflow skills install --for <tool>      install these skills into another tool

\`teamflow report --help\` and \`teamflow skills --help\` list their own flags.`;

const BIND_USAGE = 'Usage: /teamflow:bind <issue>. Accepted: DAEMON-142, ENG-42, #123, owner/repo#123, or a Jira/Linear/GitHub issue URL. A bare #123 needs githubRepo configured or a GitHub origin remote.';

const [command = 'status', ...args] = process.argv.slice(2);
const cwd = process.cwd();
const config = loadConfig(cwd);
const info = gitInfo(cwd);

function print(value) {
  process.stdout.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value, null, 2) + '\n');
}

// "signed in as <email>, org <account>", as much of it as is known.
function identity(email, account) {
  if (email && account) return `signed in as ${email}, org ${account}`;
  if (email) return `signed in as ${email}`;
  if (account) return `org ${account}`;
  return undefined;
}

async function status() {
  const state = latestSessionForCwd(cwd);
  const session = auth.readSession();
  const probe = credentialKind(config) ? await fetchAccount(config) : undefined;
  print({
    tenantId: tenantId(config),
    actor: actor(config, info),
    repository: info.repository,
    branch: info.branch,
    tracker: state?.binding?.tracker || trackerOf(config),
    jiraKey: state?.binding?.key,
    bindingSource: state?.binding?.source,
    stage: state?.stage,
    status: state?.status,
    summary: state?.summary,
    loopCount: state?.loopCount || 0,
    lastPublishResult: state?.lastPublishResult,
    transport: transportOf(config),
    serviceUrl: serviceUrl(config),
    credential: credentialKind(config) || 'none',
    identity: identity(probe?.email || session?.email, probe?.account?.account)
      || (credentialKind(config) ? 'not verified; run /teamflow:doctor' : 'not signed in; run /teamflow:login'),
    credits: probe?.ok ? probe.account?.credits : undefined,
    apiKeyConfigured: Boolean(config.apiKey),
    dataUriConfigured: Boolean(config.dataUri),
    jiraBaseUrlConfigured: Boolean(config.jiraBaseUrl),
    linearWorkspaceConfigured: Boolean(config.linearWorkspace),
    githubRepo: resolveGithubRepo(config, info) || 'not detected',
    pluginData: dataDir(),
  });
}

function bind() {
  const ref = parseBindArgument(args.join(' '), config, info);
  if (!ref) throw new Error(BIND_USAGE);
  writeJson(projectBindingPath(cwd, config), {
    jiraKey: ref.key,
    tracker: ref.tracker,
    repo: ref.repo,
    workspace: ref.workspace,
    tenantId: tenantId(config),
    boundAt: new Date().toISOString(),
  });
  const state = latestSessionForCwd(cwd);
  if (state) {
    state.binding = { key: ref.key, tracker: ref.tracker, repo: ref.repo, workspace: ref.workspace, confidence: 1000, source: 'manual', sticky: true };
    state.updatedAt = new Date().toISOString();
    saveSession(state);
  }
  print(`TeamFlow bound this project to ${ref.tracker} issue ${ref.key}. Run /teamflow:sync to publish immediately.`);
}

function unbind() {
  try { fs.unlinkSync(projectBindingPath(cwd, config)); } catch {}
  const state = latestSessionForCwd(cwd);
  if (state) {
    delete state.binding;
    state.updatedAt = new Date().toISOString();
    saveSession(state);
  }
  print('TeamFlow manual binding cleared. Automatic detection will resume.');
}

async function sync() {
  const state = latestSessionForCwd(cwd);
  if (!state?.binding?.key) throw new Error(`No issue is currently bound. ${BIND_USAGE}`);
  const result = await publishState(state, config, info, { force: true });
  saveSession(state);
  print(result);
}

async function doctor() {
  const claude = safeExec('claude', ['mcp', 'list'], { cwd, timeout: 5000 });
  const tracker = trackerOf(config);
  const server = TRACKER_MCP[tracker];
  const mcpVisible = new RegExp(server, 'i').test(claude.stdout + claude.stderr);
  const issueSource = {
    jira: config.jiraBaseUrl || 'jiraBaseUrl NOT CONFIGURED',
    linear: config.linearWorkspace || 'linearWorkspace NOT CONFIGURED',
    github: resolveGithubRepo(config, info) || 'githubRepo NOT CONFIGURED and no GitHub origin remote',
  }[tracker];
  const transport = transportOf(config);

  const report = {
    node: process.version,
    gitRepository: info.repository || 'not detected',
    transport,
    serviceUrl: serviceUrl(config),
    credential: credentialKind(config) || 'none',
    signedIn: auth.readSession() ? `yes, ${auth.readSession().email || 'session present'}` : 'no; run /teamflow:login',
    apiKeyFallback: config.apiKey ? 'configured' : 'not configured',
    tracker,
    issueSource,
    trackerMcp: mcpVisible
      ? `${server} visible`
      : `${server} not visible yet; TeamFlow bundles it, restart/reload plugin then use /mcp to authenticate`,
    configFiles: [
      path.join(process.env.HOME || '', '.config', 'teamflow', 'config.json'),
      path.join(cwd, '.teamflow.json'),
    ],
  };

  if (transport === 'service') {
    // The one question a reporter cannot answer locally: does the org
    // still have credits? A 402 during a session is silent by design,
    // so doctor is where it has to be visible.
    const probe = await fetchAccount(config);
    report.serviceAccess = probe.ok ? 'ok' : `not verified: ${probe.reason}`;
    // A session that will not refresh silently demotes the reporter to
    // its API key. Say so rather than letting it look healthy.
    if (probe.degraded) report.warning = `the signed-in session is not usable (${probe.degraded}); falling back to the API key. Run /teamflow:login again`;
    if (probe.ok) {
      // The kit's `plan` and `bought` are two credit buckets, not a
      // plan name: plan credits expire and are spent first. The names
      // here say which is which so a low balance is readable.
      report.account = probe.account?.account;
      report.identity = identity(probe.email || auth.readSession()?.email, probe.account?.account);
      report.credits = probe.account?.credits;
      report.planCredits = probe.account?.plan;
      report.boughtCredits = probe.account?.bought;
      if (probe.account?.plan_expires_at) report.planCreditsExpireAt = probe.account.plan_expires_at;
      if (probe.account?.credits === 0) report.warning = 'no credits left; reports are refused with 402 until the subscription renews or the account is topped up';
    }
  } else {
    // Legacy S3 reporting: the AWS CLI and the bucket are the transport.
    const aws = safeExec('aws', ['--version'], { timeout: 2000 });
    report.awsCli = aws.ok ? aws.stdout || 'available' : 'missing/unavailable';
    report.dataUri = config.dataUri || 'NOT CONFIGURED';
    const s3Probe = config.dataUri
      ? safeExec('aws', ['s3', 'ls', String(config.dataUri).replace(/\/data\/?$/, '')], { timeout: 5000 })
      : { ok: false, stderr: 'neither TEAMFLOW_API_KEY nor TEAMFLOW_DATA_URI is configured' };
    report.s3Access = s3Probe.ok ? 'ok' : `not verified: ${s3Probe.stderr || 'failed'}`;
  }
  print(report);
}

async function login() {
  const result = await auth.login(config);
  if (!result.ok) {
    throw new Error(`TeamFlow sign-in failed: ${result.reason}${result.authorizeUrl ? `\nOpen this URL by hand and try again: ${result.authorizeUrl}` : ''}`);
  }
  const probe = await fetchAccount(config);
  const org = result.account || (probe.ok ? probe.account?.account : undefined);
  print(`TeamFlow signed in${result.email ? ` as ${result.email}` : ''}${org ? `, org ${org}` : ''}. `
    + `Reporting now uses a one-hour access token refreshed in the background; `
    + `the refresh token is at ${auth.sessionPath()} and /teamflow:logout removes it.`);
}

async function repos() {
  const [action = 'list', target] = args;
  const cred = await credential(config);
  if (action === 'list') {
    const result = await auth.listRepos(config, cred);
    if (!result.ok) throw new Error(`TeamFlow could not list registered repositories: ${result.reason}`);
    print({
      account: result.account,
      oidcAudience: result.audience,
      repositories: result.repos?.length ? result.repos : ['none registered'],
    });
    return;
  }
  if (action !== 'add') throw new Error('Usage: /teamflow:repos add <owner/repo>, or /teamflow:repos list');
  if (!/^[\w.-]+\/[\w.-]+$/.test(String(target || ''))) {
    throw new Error('Usage: /teamflow:repos add <owner/repo>. Give the full repository, for example macleodlabs/teamflow.');
  }
  const result = await auth.registerRepo(config, String(target).toLowerCase(), cred);
  if (!result.ok) throw new Error(`TeamFlow could not register ${target}: ${result.reason}`);
  print(`TeamFlow registered ${result.repo} to org ${result.account}. `
    + `Its workflows can now trade a GitHub OIDC token for access, with audience ${result.audience}. `
    + 'The workflow needs `permissions: id-token: write` and no secret.');
}

function logout() {
  print(auth.clearSession()
    ? `TeamFlow signed out. ${auth.sessionPath()} removed; reporting stops unless an API key is configured.`
    : 'TeamFlow was not signed in; nothing to remove.');
}

try {
  // These two own their exit codes: report must exit 0 on a service
  // failure so a git hook cannot block a push, and skills exits 2 on a
  // bad argument like every other argument error here.
  if (command === 'report') {
    const { main } = await import('./report-cli.mjs');
    process.exit(await main(args));
  } else if (command === 'skills') {
    const { main } = await import('./skills.mjs');
    process.exit(await main(args));
  } else if (command === 'status') await status();
  else if (command === 'bind') bind();
  else if (command === 'unbind') unbind();
  else if (command === 'sync') await sync();
  else if (command === 'doctor') await doctor();
  else if (command === 'login') await login();
  else if (command === 'logout') logout();
  else if (command === 'repos') await repos();
  else if (command === 'help' || command === '--help' || command === '-h') print(USAGE);
  else throw new Error(`Unknown TeamFlow command: ${command}\n\n${USAGE}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
