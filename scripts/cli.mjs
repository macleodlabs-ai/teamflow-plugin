#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import * as auth from './auth.mjs';
import { claudeBinary } from './claude-bin.mjs';
import { NO_PROJECT, resolveProject } from './project.mjs';
import {
  actor,
  clearDiscards,
  credential,
  credentialKind,
  dataDir,
  dataDirWritable,
  fetchAccount,
  gitInfo,
  isWorktree,
  latestSessionForCwd,
  loadConfig,
  localBindingPath,
  outboxLine,
  outboxSummary,
  parseBindArgument,
  projectBindingPath,
  publishState,
  resolveGithubRepo,
  resolveIssueTitle,
  serviceUrl,
  tenantId,
  transportOf,
  trackerOf,
  safeExec,
  saveSession,
  writeJson,
  writeLocalBinding,
  pluginVersion,
  staleBuild,
  tracePath,
} from './core.mjs';

// Two subcommands live in their own modules because they are the two a
// tool other than Claude Code actually runs: `report` moves a ticket and
// `skills` puts these same skills in front of whatever agent is being
// used. Both are lazily imported so `teamflow status` does not pay for
// them.
const TRACKER_MCP = { jira: 'atlassian', linear: 'linear', github: 'github' };
const USAGE = `teamflow \u2014 delivery reporting for TeamFlow

  teamflow login [--org <id>] [--no-browser] [--device]  sign in once, naming an org if asked for one
  teamflow logout                  remove the session
  teamflow org [switch <id>]       which organisation this session reports to
  teamflow status                  who is signed in, what is bound, what was sent
  teamflow bind <issue> [--local] | unbind
                                   name the ticket by hand, or stop; --local writes
                                   the binding inside the repository, for a worktree
  teamflow work-on <issue>         bind, with --local implied inside a git worktree;
                                   identical to bind everywhere else
  teamflow next [--dry-run]        take the top-priority open ticket and bind it
  teamflow adhoc start "<what the work is>" | title "<...>" | done
                                   work that arrived without a ticket: TeamFlow
                                   mints the key; \`teamflow adhoc --help\` has the rest
  teamflow workflow create <name> | add <KEY> | show | status <s>
                                   the pool of tickets a run works through;
                                   \`teamflow workflow --help\` lists its flags
  teamflow sync                    publish the current state now
  teamflow doctor                  transport, account, credits, tracker MCP and connections
  teamflow trackers [list]         the issue trackers this org has connected
  teamflow trackers connect <tracker> [--projects a,b] [--filter <team>]
                                   authorise a tracker; prints the URL to open
  teamflow repos [list|add]        register a repository for CI OIDC
  teamflow admin code [create|list|revoke]  invite codes, for superadmins
  teamflow admin launch [--confirm]         end demo mode; run once, on the day
  teamflow report --issue ... --stage ...   report one stage transition
  teamflow skills install --for <tool>      install these skills into another tool
  teamflow hooks status | install           report automatically from that tool
  teamflow hook --for <tool>                the hook entry itself; tools call this

\`teamflow report --help\`, \`teamflow skills --help\`, \`teamflow hooks --help\`
and \`teamflow admin --help\` list their own flags.`;

const BIND_USAGE = 'Usage: /teamflow:bind <issue> [--local]. Accepted: DAEMON-142, ENG-42, #123, owner/repo#123, or a Jira/Linear/GitHub issue URL. A bare #123 needs githubRepo configured or a GitHub origin remote.';

const [command = 'status', ...args] = process.argv.slice(2);
const cwd = process.cwd();
const config = loadConfig(cwd);
const info = gitInfo(cwd);

function print(value) {
  process.stdout.write(typeof value === 'string' ? value + '\n' : JSON.stringify(value, null, 2) + '\n');
}

/**
 * The org's tracker connections, as `GET /v1/members/trackers` lists them.
 *
 * Two of the answers are not failures and have to be told apart from the ones
 * that are. `trackers_disabled` is a deployment that does not run the module,
 * which is every deployment until it does; a CI token or a service key is not
 * an org account and has nothing to list. Both would read as "none connected"
 * if only the status code were looked at, and doctor would then warn a team
 * about a tracker they could not have connected.
 *
 * The credential is whatever `credential()` resolves — a signed-in access
 * token, or the API key. An ID token would be refused: the service's verifier
 * accepts `token_use: access` and nothing else.
 */
async function trackerConnections(config) {
  const cred = await credential(config);
  if (!cred) return { ok: false, reason: 'no service credential; run /teamflow:login' };
  try {
    const response = await fetch(`${serviceUrl(config)}/v1/members/trackers`, {
      headers: { [cred.header]: cred.value },
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 5000)),
    });
    let body;
    try { body = await response.json(); } catch { body = undefined; }
    const code = body?.error || body?.code;
    if (response.status === 404 && code === 'not_an_org_account') {
      return { ok: false, reason: 'this credential is not an org account, so it has no tracker connections' };
    }
    if (response.status === 404) return { ok: true, connections: [] };
    if (!response.ok) return { ok: false, reason: body?.message || body?.detail || code || `service returned ${response.status}` };
    const list = Array.isArray(body) ? body : body?.trackers;
    return { ok: true, connections: Array.isArray(list) ? list : [] };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

// One connection, on one line: which tracker, what it is filtered to, which
// projects it covers, when it last delivered and what went wrong last time,
// because those are what somebody asks when issues are not appearing -- and
// "it covers the whole workspace" is as much an answer as any of the others
// (MACLEOD-539, a board of 538 tickets nobody had narrowed).
function trackerLine(connection = {}) {
  const parts = [String(connection.provider || 'unknown')];
  if (connection.filter) parts.push(`filter ${connection.filter}`);
  parts.push(`projects ${scopeWords(connection)}`);
  parts.push(connection.last_delivery_at ? `last delivery ${connection.last_delivery_at}` : 'nothing delivered yet');
  if (connection.last_error) parts.push(`last error: ${connection.last_error}`);
  return parts.join(' · ');
}

/**
 * What this connection covers, in words.
 *
 * Names before ids because a person reads the line, and `all` for an empty
 * scope because empty means everything everywhere else too -- a blank there
 * would read as "none", which is the opposite of what it means.
 */
function scopeWords(connection = {}) {
  const scope = connection.scope && !Array.isArray(connection.scope) ? connection.scope : {};
  const named = (scope.names?.length ? scope.names : scope.ids) || [];
  return named.length ? named.join(', ') : 'all';
}

/** `--projects a,b,c` -> the scope block the service stores. */
function projectsArg(list) {
  const at = list.indexOf('--projects');
  // `--filter` is still read for the connections that were made with it: it
  // is the team or repository the webhook itself is narrowed to, which is a
  // different thing from which of that team's projects reach the board.
  if (at === -1) return undefined;
  const names = String(list[at + 1] || '').split(',').map((one) => one.trim()).filter(Boolean);
  return { ids: [], names: [...new Set(names)] };
}

function connectedProviders(connections) {
  return new Set(connections.map((connection) => String(connection.provider || '').toLowerCase()));
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
  // The other half of the picture: the skill reports what happens to the
  // code, and these are the trackers allowed to report what happens to the
  // issue. Asked for only when there is a credential to ask with.
  const trackers = credentialKind(config) ? await trackerConnections(config) : undefined;
  // Which board view this session's work will land in (MACLEOD-565). The
  // repository decides it, so the answer is the same in a worktree as in
  // the checkout it was made from, and a session outside git gets the
  // organisation's default rather than an error.
  const project = await resolveProject(info.repository, config);
  const stale = staleBuild();
  // What has not reached the service, and what a flush threw away and
  // why. A hook cannot say either — it exits 0 and prints nothing — so
  // this is where a person finds out, and saying it clears it.
  const outbox = await outboxSummary(config);
  if (outbox.discarded.ownerless || outbox.discarded.expired) clearDiscards();
  print({
    tenantId: tenantId(config),
    pluginVersion: pluginVersion() || 'unknown',
    ...(stale ? {
      pluginBuild: `STALE: ${stale.running} is running, ${stale.newest} is installed. `
        + 'Run /reload-plugins.',
    } : {}),
    actor: actor(config, info),
    // Never left out. A customer who ran this in the wrong directory saw
    // no repository line at all and every other line looking healthy,
    // which reads as "fine" rather than as the one thing that is wrong:
    // a report names the repository it came from, and outside a checkout
    // there is none (MACLEOD-567).
    repository: info.repository
      || 'not a git repository — run TeamFlow inside your checkout; a report names the repository it came from',
    project: project.line,
    branch: info.branch,
    tracker: state?.binding?.tracker || trackerOf(config),
    trackerConnections: trackers
      ? (trackers.ok
        ? (trackers.connections.length ? trackers.connections.map(trackerLine) : ['none connected'])
        : [`not listed: ${trackers.reason}`])
      : undefined,
    jiraKey: state?.binding?.key,
    bindingSource: state?.binding?.source,
    stage: state?.stage,
    status: state?.status,
    summary: state?.summary,
    loopCount: state?.loopCount || 0,
    lastPublishResult: state?.lastPublishResult,
    ...(outbox.queued || outbox.legacy || outbox.discarded.ownerless || outbox.discarded.expired
      ? { outbox: outboxLine(outbox) }
      : {}),
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

// Naming the ticket is also the moment to learn what it is called: the
// title is resolved once here and cached on the binding, so the first
// report already carries it and no later one has to ask again.
async function bind(argument = args.filter((a) => a !== '--local').join(' '), { local = args.includes('--local') } = {}) {
  const ref = parseBindArgument(argument, config, info);
  if (!ref) throw new Error(BIND_USAGE);
  const found = await resolveIssueTitle(ref, config, info);
  // An agent sandboxed to its worktree cannot write the user data
  // directory. Asking first, rather than letting the write throw, is
  // what makes `teamflow bind` work there at all — and the fallback is
  // silent because the binding it wrote is just as good.
  const inRepo = local || !dataDirWritable();
  const record = {
    jiraKey: ref.key,
    tracker: ref.tracker,
    repo: ref.repo,
    workspace: ref.workspace,
    title: found?.title,
    status: found?.status,
    // Only a lookup that answered closes the question. One that did not
    // — no `gh`, offline, a private repository — leaves the next report
    // free to try once more rather than blanking the card for good.
    titleLookedUp: Boolean(found?.title),
    tenantId: tenantId(config),
    boundAt: new Date().toISOString(),
  };
  if (inRepo) writeLocalBinding(cwd, record);
  else writeJson(projectBindingPath(cwd, config), record);
  const state = latestSessionForCwd(cwd);
  if (state) {
    state.binding = { key: ref.key, tracker: ref.tracker, repo: ref.repo, workspace: ref.workspace, confidence: 1000, source: 'manual', sticky: true, boundAt: new Date().toISOString() };
    if (found?.title || found?.status) {
      state.jira = { ...(state.jira || {}), key: ref.key, title: found.title, status: found.status };
    }
    state.updatedAt = new Date().toISOString();
    // The session lives in the data directory too. Where that is not
    // writable the binding file is still on disk and the next hook
    // event will find it, so a failure here is not a failed bind.
    try { saveSession(state); } catch {}
  }
  print(`TeamFlow bound this project to ${ref.tracker} issue ${ref.key}${found?.title ? ` — ${found.title}` : ''}`
    + `${inRepo ? ', in this working copy (.teamflow/binding.json)' : ''}. `
    + 'Run /teamflow:sync to publish immediately.');
}

// `bind`, under a name a worktree-isolation sandbox has no reason to
// refuse — it blocks any command whose text contains `bind`, on the
// shape of the string rather than what it writes. Same parsing, same
// title lookup, same session binding, same output: the only difference
// is that `--local` is implied when the current directory is a git
// worktree, so an agent there does not have to know to pass it. Outside
// a worktree this is exactly `bind`.
async function workOn() {
  await bind(undefined, { local: args.includes('--local') || isWorktree(cwd) });
}

function unbind() {
  try { fs.unlinkSync(projectBindingPath(cwd, config)); } catch {}
  try { fs.unlinkSync(localBindingPath(cwd)); } catch {}
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
  // The real `claude` is only ever started through claude-bin.mjs, which
  // refuses under a test runner or a redirected HOME (the keychain dialog
  // and the stray credentials file, twice). When it refuses, the probe is
  // reported as skipped with the reason rather than faked either way.
  const { bin: claudeBin, reason: claudeSkipped } = claudeBinary();
  const claude = claudeBin
    ? safeExec(claudeBin, ['mcp', 'list'], { cwd, timeout: 5000 })
    : { ok: false, stdout: '', stderr: '' };
  const tracker = trackerOf(config);
  const server = TRACKER_MCP[tracker];
  const mcpVisible = new RegExp(server, 'i').test(claude.stdout + claude.stderr);
  const issueSource = {
    jira: config.jiraBaseUrl || 'jiraBaseUrl NOT CONFIGURED',
    linear: config.linearWorkspace || 'linearWorkspace NOT CONFIGURED',
    github: resolveGithubRepo(config, info) || 'githubRepo NOT CONFIGURED and no GitHub origin remote',
  }[tracker];
  const transport = transportOf(config);

  // A stale build is a finding rather than a line of trivia: every other
  // answer in this report describes the build that is running, and if
  // that is not the build that is installed then all of them describe
  // something the next session will not do (MACLEOD-538).
  const stale = staleBuild();
  const outbox = await outboxSummary(config);
  if (outbox.discarded.ownerless || outbox.discarded.expired) clearDiscards();
  const report = {
    claudeProbe: claudeBin ? 'ran' : `skipped: ${claudeSkipped}`,
    pluginVersion: pluginVersion() || 'unknown',
    pluginBuild: stale
      ? `STALE: ${stale.running} is running, ${stale.newest} is installed. `
        + 'Run /reload-plugins; until then this session reports the old behaviour.'
      : 'current',
    node: process.version,
    gitRepository: info.repository || 'not detected',
    ...(outbox.queued || outbox.legacy || outbox.discarded.ownerless || outbox.discarded.expired
      ? { outbox: outboxLine(outbox) }
      : {}),
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

  /*
   * The names-only hook trace (MACLEOD-573), when somebody has turned it
   * on. Named here because a file collecting on a developer's machine
   * that nothing mentions is a file nobody remembers to delete -- and
   * because the answer it is collecting is one a reader of this report
   * may be the person waiting for.
   */
  if (fs.existsSync(tracePath())) {
    report.hookTrace = `${tracePath()} (TEAMFLOW_HOOK_TRACE=1; event and field NAMES only, `
      + 'never a value, never sent anywhere. Delete it when you are done with it.)';
  }

  if (transport === 'service') {
    // Which project this repository's work appears under (MACLEOD-565).
    // A repository in no project still reports and nothing is lost —
    // but every board view filters by project, so the work is landing
    // where nobody is looking and no other line here would say so.
    const project = await resolveProject(info.repository, config);
    report.project = project.line;
    if (project.none) report.projectFindings = [NO_PROJECT];

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

    // Which trackers may report what happens to the issue. A repo whose keys
    // come from a tracker nobody connected still reports fine — the skill is
    // the driver — but nothing that happens in Jira, Linear or GitHub will
    // ever reach the board, and the only symptom is issues that never appear.
    const trackers = await trackerConnections(config);
    if (!trackers.ok) {
      report.trackerConnections = [`not listed: ${trackers.reason}`];
    } else {
      const connected = connectedProviders(trackers.connections);
      report.trackerConnections = trackers.connections.length
        ? trackers.connections.map(trackerLine)
        : ['none connected'];
      const warnings = [];
      if (!connected.has(tracker)) {
        warnings.push(`this repo reports ${tracker} issues, but the org has connected no ${tracker} tracker, `
          + `so ${tracker} updates (created, assigned, done, cancelled) never reach the board. `
          + `Connect one at ${serviceUrl(config)}/members/ and see docs/TRACKERS.md.`);
      }
      // What the last report actually carried, which is the thing a person
      // can check against what they see on the board.
      const seen = latestSessionForCwd(cwd)?.binding;
      if (seen?.tracker && seen.tracker !== tracker && !connected.has(seen.tracker)) {
        warnings.push(`the last report was for ${seen.key || 'an issue'} from ${seen.tracker}, `
          + `which the org has not connected either.`);
      }
      trackers.connections
        .filter((connection) => connection.last_error)
        .forEach((connection) => warnings.push(`the ${connection.provider} connection's last delivery failed: ${connection.last_error}`));
      if (warnings.length) report.trackerWarnings = warnings;
    }
  } else if (transport === 'none' && !config.dataUri) {
    // Nothing is configured at all, which on a new machine means one
    // thing and not the other: the customer has not signed in yet. It is
    // not an install that is on the legacy S3 transport and has lost its
    // bucket, so probing for the AWS CLI and reporting `s3Access: not
    // verified` buries the one actionable line under a page about a
    // transport this person has never heard of (MACLEOD-567).
    report.reporting = 'nothing is being reported: this machine has no credential. '
      + 'Run /teamflow:login once — there is no key to copy.';
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

// --org <id> off any argument list. The chooser prints the ids, so this is
// how a non-interactive run answers the question a second time.
function orgFlag(list) {
  const at = list.indexOf('--org');
  return at === -1 ? undefined : list[at + 1];
}

// Three ways in, and the command picks between them rather than
// asking: a browser here, a URL to open here, or a code to type into
// a browser anywhere. The third is the only one that works when the
// browser is on another machine, because the loopback redirect the
// first two come back to is 127.0.0.1 -- this machine and no other.
/**
 * What was here before this sign-in, in words, or nothing (MACLEOD-572,
 * plugin audit row 9).
 *
 * Signing in again is a normal thing to do and is not refused: the
 * service only objects when a *different* organisation is named. But
 * the session on disk is replaced, and a machine that was reporting as
 * somebody else — a shared box, a demo account, a colleague's laptop —
 * stops doing so without a word. One line, only when there was
 * something to replace, and only when it is not the same thing again.
 */
function replacedSession(before, after) {
  if (!before) return '';
  const was = [before.email, before.account].filter(Boolean).join(', org ');
  const now = [after.email, after.account].filter(Boolean).join(', org ');
  if (!was) return 'The session that was on this machine has been replaced.\n';
  if (was === now) return `This replaced the session already here (${was}).\n`;
  return `This replaced the session that was here: ${was}.\n`;
}

async function login() {
  // Read before anything is written: auth.login overwrites the file.
  const before = auth.readSession();
  const noBrowser = args.includes('--no-browser') || Boolean(config.noBrowser);
  const wantsDevice = args.includes('--device');
  const canOpen = auth.browserPossible();
  if (wantsDevice || ((noBrowser || !canOpen) && await serviceOffersDevice())) {
    return deviceLogin(wantsDevice ? undefined
      : `No browser can be opened here${canOpen ? '' : ' (no display)'}, so TeamFlow is asking for a code instead.`,
    before);
  }
  const result = await auth.login(config, {
    account: orgFlag(args),
    // `--no-browser` is for the person who knows their box has none, or
    // whose browser is somewhere else entirely. The URL is printed and
    // the listener waits either way.
    noBrowser,
    // Only a terminal can be asked. A hook, a CI job or a piped run gets the
    // list printed and the flag to pass instead of a prompt nobody answers.
    chooseAccount: process.stdin.isTTY ? (accounts) => auth.promptForAccount(accounts) : undefined,
  });
  if (result.ambiguous) {
    throw new Error('TeamFlow signed you in, but that address holds a seat on more than one organisation:\n'
      + `${auth.organisationLines(result.accounts)}\n`
      + 'Run `teamflow login --org <id>` with the one to report to.');
  }
  if (!result.ok) {
    // The URL is not repeated when it was already printed while the
    // listener was up: there it was an invitation, here it would be a
    // link to a port that has closed.
    const url = result.authorizeUrl && !result.printedUrl
      ? `\nOpen this URL by hand and try again: ${result.authorizeUrl}`
      : '';
    const elsewhere = result.printedUrl
      ? '\nIf the browser you can use is on another machine, run `teamflow login --device` instead.'
      : '';
    throw new Error(`TeamFlow sign-in failed: ${result.reason}${url}${elsewhere}`);
  }
  const probe = await fetchAccount(config);
  const org = result.accountName || result.account || (probe.ok ? probe.account?.account : undefined);
  print(`TeamFlow signed in${result.email ? ` as ${result.email}` : ''}${org ? `, org ${org}` : ''}.\n`
    + replacedSession(before, { email: result.email, account: org })
    + `${await signedInLines()}\n`
    + `Reporting now uses a one-hour access token refreshed in the background; `
    + `the refresh token is at ${auth.sessionPath()} and /teamflow:logout removes it.`);
}

/**
 * What a person wants to know the moment sign-in finishes: which board
 * their next report lands on, and that one is coming (MACLEOD-565).
 *
 * Asked after the session is written, so the credential that resolves
 * the projects is the one that was just minted. Fails open like every
 * other project lookup: an unreachable service prints "unknown" and the
 * sign-in is still a success, because it is.
 */
async function signedInLines() {
  const project = await resolveProject(info.repository, config);
  return `Project: ${project.line}\n`
    + 'Your next report will appear on the board.';
}

// Whether asking for a code is an option at all. A service that
// predates the flow publishes no such block, and must not be sent to
// a route it would answer 404 to.
async function serviceOffersDevice() {
  // Not gated on the rest of the block being usable: the code flow
  // needs neither an issuer nor a client id, so a service that
  // publishes only that much can still sign this machine in.
  return Boolean((await auth.discoverAuth(config)).device);
}

async function deviceLogin(because, before) {
  if (because) print(because);
  if (orgFlag(args)) {
    // The organisation is chosen in the browser, by the person
    // approving: that is where the question can be answered, and the
    // service asks it there when the address holds several seats.
    print('`--org` is not used by a device sign-in; the browser asks which organisation.');
  }
  const result = await auth.deviceLogin(config);
  if (!result.ok) {
    // A code is one-shot: expired, spent or never approved, the way out
    // is always a fresh one, and a failure that does not say so leaves
    // the person retyping a code the service has already forgotten.
    // Except a refusal — somebody said no in the browser, and telling
    // the terminal to ask again is the wrong advice (MACLEOD-567).
    const again = result.error === 'access_denied'
      ? ' If that was not you, nothing was issued and nothing needs undoing.'
      : ' Run `teamflow login --device` again for a fresh code.';
    throw new Error(`TeamFlow device sign-in failed: ${result.reason}.${again}`);
  }
  const probe = await fetchAccount(config);
  const org = result.account || (probe.ok ? probe.account?.account : undefined);
  print(`TeamFlow signed in${result.email ? ` as ${result.email}` : ''}${org ? `, org ${org}` : ''}, `
    + `as device "${result.label}".\n`
    + replacedSession(before, { email: result.email, account: org })
    + `${await signedInLines()}\n`
    + `Reporting uses a revocable device credential stored at `
    + `${auth.sessionPath()}; /teamflow:logout revokes it here and at the service, and the `
    + 'members page lists every machine signed in this way.');
}

// `teamflow org`, and `teamflow org switch <id>`.
//
// The ID token is what both routes take: the seat belongs to the verified
// address, not to the scope the access token carries.
async function org() {
  const [action, target] = args;
  const token = await auth.adminIdToken(config);
  if (!token.ok) throw new Error(`TeamFlow could not read your organisation: ${token.reason}`);

  if (action === 'switch') {
    if (!target) throw new Error('Usage: teamflow org switch <id>. `teamflow org` lists the ids.');
    const moved = await auth.switchOrg(config, token.token, target);
    if (!moved.ok) throw new Error(`TeamFlow could not switch to ${target}: ${moved.reason}`);
    auth.rememberOrg(moved.account, moved.name);
    print(`TeamFlow now reports to ${moved.name || moved.account}. `
      + 'Reports from this machine are credited to that organisation from now on.');
    return;
  }
  if (action) throw new Error('Usage: teamflow org, or teamflow org switch <id>.');

  const me = await auth.listOrgs(config, token.token);
  if (!me.ok) throw new Error(`TeamFlow could not read your organisation: ${me.reason}`);
  const others = (me.accounts || []).filter((entry) => entry.id !== me.account);
  print(`Reporting to ${me.name || me.account} [${me.account}]`
    + `${[me.role, me.plan].filter(Boolean).join(', ') ? ` \u2014 ${[me.role, me.plan].filter(Boolean).join(', ')}` : ''}\n`
    + (others.length
      ? `You also hold a seat on:\n${auth.organisationLines(others)}\n`
        + 'Switch with `teamflow org switch <id>`.'
      : 'That is the only organisation your address holds a seat on.'));
}

/**
 * `teamflow trackers`, and `teamflow trackers connect <tracker>`.
 *
 * The members page has a button for this; the terminal gets the same flow
 * without one. The CLI cannot finish an authorisation — a consent screen is a
 * browser's job and the callback lands wherever the person opened it — so it
 * asks the service for the URL, prints it, and says what happens next. The
 * connection is already waiting by then, pending, and `teamflow trackers`
 * shows it as connected once the browser has been round.
 */
async function trackers() {
  const [action = 'list', target] = args;
  if (action === 'list') {
    const result = await trackerConnections(config);
    if (!result.ok) throw new Error(`TeamFlow could not list your trackers: ${result.reason}`);
    print(result.connections.length
      ? result.connections.map(trackerLine).join('\n')
      : 'No tracker is connected. `teamflow trackers connect linear` starts one.');
    return;
  }
  if (action !== 'connect' || !target) {
    throw new Error('Usage: teamflow trackers, or teamflow trackers connect <tracker> '
      + '[--projects a,b] [--filter <team>]');
  }
  const at = args.indexOf('--filter');
  const filter = at === -1 ? '' : String(args[at + 1] || '').trim();
  const scope = projectsArg(args);
  const cred = await credential(config);
  if (!cred) throw new Error('TeamFlow needs a credential to connect a tracker; run /teamflow:login.');
  const provider = String(target).toLowerCase();
  const response = await fetch(
    `${serviceUrl(config)}/v1/members/trackers/oauth/${encodeURIComponent(provider)}/start`,
    {
      method: 'POST',
      headers: { [cred.header]: cred.value, 'content-type': 'application/json' },
      body: JSON.stringify({ ...(filter ? { filter } : {}), ...(scope ? { scope } : {}) }),
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 5000)),
    },
  );
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  if (!response.ok || !body?.authorize_url) {
    // `providers` names the way out when the way in was wrong, and it is the
    // one thing a person cannot guess.
    const can = Array.isArray(body?.providers) && body.providers.length
      ? ` Trackers you can authorise: ${body.providers.join(', ')}.`
      : '';
    throw new Error(`TeamFlow could not start ${provider}: `
      + `${body?.detail || body?.error || `the service returned ${response.status}`}.${can}`);
  }
  const minutes = Math.max(1, Math.round(Number(body.expires_in || 600) / 60));
  print(`Open this to authorise ${provider}:\n\n  ${body.authorize_url}\n\n`
    + `It expires in ${minutes} minutes. Approve it and TeamFlow creates the webhook itself — `
    + 'there is nothing to paste. The browser lands back on the members page, and '
    + `\`teamflow trackers\` shows ${provider} connected once it has.`
    + (scope
      ? `\n\nIt will cover ${scope.names.join(', ')}.`
      : '\n\nIt will cover every project the workspace has. '
        + 'Pass --projects to narrow it, or choose them on the members page.'));
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

async function logout() {
  const out = await auth.signOut(config);
  if (!out.ok) {
    print('TeamFlow was not signed in; nothing to remove.');
    return;
  }
  const revoked = out.device
    ? (out.revoked
      ? ' The device credential was revoked at the service too.'
      : ` The device credential could not be revoked at the service (${out.reason});`
        + ' revoke it from the members page.')
    : '';
  print(`TeamFlow signed out. ${auth.sessionPath()} removed; reporting stops unless an API key is `
    + `configured.${revoked}`);
}

try {
  // These two own their exit codes: report must exit 0 on a service
  // failure so a git hook cannot block a push, and skills exits 2 on a
  // bad argument like every other argument error here.
  if (command === 'report') {
    const { main } = await import('./report-cli.mjs');
    process.exit(await main(args));
  } else if (command === 'admin') {
    // Owns its exit codes too: 2 when the service refuses the caller,
    // so a script can tell "not a superadmin" from "call failed".
    const { main } = await import('./admin.mjs');
    process.exit(await main(args, config));
  } else if (command === 'skills') {
    const { main } = await import('./skills.mjs');
    process.exit(await main(args));
  } else if (command === 'hook') {
    // The hook entry a Cursor, Copilot, Windsurf, Cline, Gemini CLI or
    // Codex hook config calls. It owns its exit code absolutely: always
    // 0, whatever happened, because every one of those tools reads a
    // non-zero hook as a reason to stop or to warn the developer.
    const { main } = await import('./hook-cli.mjs');
    await main(args);
  } else if (command === 'hooks') {
    const { main } = await import('./hooks.mjs');
    process.exit(await main(args, { cwd, config }));
  } else if (command === 'status') await status();
  else if (command === 'bind') await bind();
  else if (command === 'work-on') await workOn();
  else if (command === 'next') {
    // Owns its exit code: 0 even when it could not read the tracker,
    // because what it prints then is the workflow to run instead.
    const { main } = await import('./next.mjs');
    process.exit(await main(args, { cwd, config, info, bind }));
  }
  else if (command === 'workflow') {
    const { main } = await import('./workflow.mjs');
    process.exit(await main(args, { cwd, config, info }));
  }
  else if (command === 'adhoc') {
    const { main } = await import('./adhoc.mjs');
    process.exit(await main(args, { cwd, config, info }));
  }
  else if (command === 'unbind') unbind();
  else if (command === 'sync') await sync();
  else if (command === 'doctor') await doctor();
  else if (command === 'login') await login();
  else if (command === 'logout') await logout();
  else if (command === 'trackers') await trackers();
  else if (command === 'repos') await repos();
  else if (command === 'org') await org();
  else if (command === 'help' || command === '--help' || command === '-h') print(USAGE);
  else throw new Error(`Unknown TeamFlow command: ${command}\n\n${USAGE}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
