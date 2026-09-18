#!/usr/bin/env node
// `teamflow report`: one stage transition, reported by hand.
//
//   npx -y github:macleodlabs-ai/teamflow-plugin report --issue DAEMON-142 \
//     --stage LOCAL_TEST --status success --summary "42 tests, 0 failing"
//
// The Claude Code plugin derives stages from hooks and needs none of
// this. Every other tool does: a Cursor or Copilot agent told to run a
// command, a git hook, an npm script, a JetBrains run configuration.
// They get the same envelope on the same transport with the same
// credential, so a ticket moved from an IDE task is indistinguishable
// on the board from one moved by Claude.
//
// Reporting is observability, never a gate: a bad argument exits 2 and
// says why, but a service that is down, broke or unreachable exits 0
// and leaves the report in the outbox.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  actor,
  cachedIssueTitle,
  gitInfo,
  gitSnapshot,
  issueProject,
  issueUrl,
  loadConfig,
  parseBindArgument,
  prSnapshot,
  putReport,
  sendReport,
  tenantId,
  tenantPath,
  trackerOf,
  transportOf,
} from './core.mjs';

// Mirrors adapters/teamflow/schema.py, which mirrors src/lib/stageMachine.ts.
// Checked here rather than at the service so a typo costs a message
// instead of a refused report and a puzzled developer.
const STAGES = [
  'BACKLOG', 'LOCAL_DEV', 'LOCAL_TEST', 'LOCAL_AUDIT', 'LOCAL_REWORK',
  'MERGE', 'CI_BUILD', 'DEPLOY_DEV', 'DEV_TEST', 'DEV_AUDIT',
  'DEV_REWORK', 'DEV_VERIFIED', 'READY_PROD',
];
const STATUSES = ['running', 'success', 'waiting', 'blocked', 'failed', 'idle'];
const KINDS = ['human', 'claude', 'ci', 'deploy', 'test', 'audit', 'environment', 'security'];
const TRACKERS = ['jira', 'linear', 'github'];

const SUMMARY_MAX = 180;
const EVIDENCE_MAX = 8;

export const USAGE = `teamflow report — report one delivery stage to TeamFlow

  teamflow report --issue DAEMON-142 --stage LOCAL_TEST --status success \\
                  --summary "42 tests, 0 failing"

Required
  --issue KEY        DAEMON-142, ENG-42, #123, owner/repo#123 or an issue URL
  --stage STAGE      ${STAGES.join(', ')}

Optional
  --status STATUS    ${STATUSES.join(', ')} (default: running)
  --summary TEXT     up to ${SUMMARY_MAX} characters (default: "<STAGE> <status>")
  --evidence L=V     a label and a link or figure; repeatable, up to ${EVIDENCE_MAX}
  --rework-from S    the stage that failed, when --stage is LOCAL_REWORK or DEV_REWORK
  --loop N           rework count for this ticket
  --title TEXT       the ticket title, when the caller knows it
  --tracker T        ${TRACKERS.join(', ')} (default: the configured tracker)
  --kind K           what did the work: ${KINDS.join(', ')} (default: human)
  --label TEXT       how it is named on the board (default: teamflow report)
  --id TEXT          execution id, to update one row rather than add one
  --repository R     overrides the git remote
  --branch B         overrides the current branch
  --actor NAME       overrides the git user
  --tenant T         legacy S3 transport only
  --dry-run          print the envelope, post nothing
  --help             this text

Credentials come from the same place the Claude Code plugin reads them:
a signed-in session (/teamflow:login), TEAMFLOW_API_KEY, or an OIDC
token in CI. Nothing but derived state is ever sent.
`;

// --flag value and --flag=value both, because a git hook writes one
// and a package.json script writes the other.
export function parseArgs(argv) {
  const options = { evidence: [] };
  const errors = [];
  const repeatable = new Set(['evidence']);
  const flags = new Set(['help', 'dry-run', 'version']);
  const alias = { jira: 'issue', h: 'help' };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('-')) {
      errors.push(`unexpected argument: ${token}`);
      continue;
    }
    const body = token.replace(/^--?/, '');
    const eq = body.indexOf('=');
    const rawName = eq >= 0 ? body.slice(0, eq) : body;
    const name = alias[rawName] || rawName;
    if (flags.has(name)) {
      options[name] = true;
      continue;
    }
    const value = eq >= 0 ? body.slice(eq + 1) : argv[++i];
    if (value === undefined) {
      errors.push(`--${rawName} needs a value`);
      continue;
    }
    if (repeatable.has(name)) options[name].push(value);
    else options[name] = value;
  }
  return { options, errors };
}

// "Build=https://ci.example/42" and "Build: 42" both. The separator is
// the first one that appears, so a label may not contain "=" or ":"
// but a value may contain either, which is what a URL needs.
export function parseEvidence(entries) {
  const out = [];
  const errors = [];
  for (const entry of entries) {
    const match = String(entry).match(/^([^=:]+)[=:]([\s\S]*)$/);
    if (!match || !match[2].trim()) {
      errors.push(`--evidence wants "label=value", got: ${entry}`);
      continue;
    }
    out.push({ label: match[1].trim().slice(0, 60), value: match[2].trim().slice(0, 160) });
  }
  if (out.length > EVIDENCE_MAX) {
    errors.push(`--evidence takes at most ${EVIDENCE_MAX} entries, got ${out.length}`);
  }
  return { evidence: out, errors };
}

function oneOf(value, allowed, flag, errors) {
  if (value === undefined) return undefined;
  if (allowed.includes(value)) return value;
  errors.push(`--${flag} must be one of: ${allowed.join(', ')}`);
  return undefined;
}

// Everything the service needs, assembled the same way issuePayload
// assembles it for a Claude session. The only difference is where the
// stage came from: an argument here, a classified tool call there.
export function buildPayload(options, config, info, now = new Date()) {
  const errors = [];

  if (!options.issue) errors.push('--issue is required (DAEMON-142, ENG-42, #123, owner/repo#123 or an issue URL)');
  if (!options.stage) errors.push('--stage is required');

  const stage = oneOf(options.stage?.toUpperCase(), STAGES, 'stage', errors);
  const status = oneOf((options.status || 'running').toLowerCase(), STATUSES, 'status', errors);
  const kind = oneOf((options.kind || 'human').toLowerCase(), KINDS, 'kind', errors);
  const reworkFrom = options['rework-from']
    ? oneOf(options['rework-from'].toUpperCase(), STAGES, 'rework-from', errors)
    : undefined;
  const trackerFlag = options.tracker
    ? oneOf(options.tracker.toLowerCase(), TRACKERS, 'tracker', errors)
    : undefined;

  let loopCount;
  if (options.loop !== undefined) {
    loopCount = Number(options.loop);
    if (!Number.isInteger(loopCount) || loopCount < 0 || loopCount > 999) {
      errors.push('--loop must be a whole number from 0 to 999');
      loopCount = undefined;
    }
  }

  const { evidence, errors: evidenceErrors } = parseEvidence(options.evidence || []);
  errors.push(...evidenceErrors);

  // The bind grammar, so --issue takes whatever a developer has in the
  // clipboard: a key, a bare number, owner/repo#n or a tracker URL.
  const bindConfig = trackerFlag ? { ...config, tracker: trackerFlag } : config;
  const ref = options.issue ? parseBindArgument(options.issue, bindConfig, info) : undefined;
  if (options.issue && !ref) {
    errors.push(`--issue "${options.issue}" is not an issue key; try DAEMON-142, ENG-42, #123, owner/repo#123 or an issue URL`);
  }

  if (errors.length) return { errors };

  const tracker = ref.tracker || trackerOf(bindConfig);
  const act = actor(config, info);
  const name = options.actor || act.displayName;
  const summary = String(options.summary || `${stage} ${status}`).slice(0, SUMMARY_MAX);
  const updatedAt = now.toISOString();
  const url = issueUrl(ref.key, tracker, config, info, ref);

  const payload = {
    tenantId: tenantId(config),
    tracker,
    jiraKey: ref.key,
    project: issueProject(ref.key, tracker),
    actor: String(name).slice(0, 80),
    stage,
    status,
    summary,
    updatedAt,
    executions: [{
      id: String(options.id || `cli-${act.id}`).slice(0, 80),
      kind,
      label: String(options.label || 'teamflow report').slice(0, 80),
      stage,
      status,
      summary,
      updatedAt,
      ...(evidence.length ? { evidence } : {}),
    }],
  };
  if (url) payload.jiraUrl = url;
  if (options.title) payload.title = String(options.title).slice(0, 200);
  const repository = options.repository || info.repository;
  if (repository) payload.repository = String(repository).slice(0, 200);
  const branch = options.branch || info.branch;
  if (branch) payload.branch = String(branch).slice(0, 200);
  if (loopCount !== undefined) payload.loopCount = loopCount;
  if (reworkFrom) payload.reworkFrom = reworkFrom;
  if (evidence.length) payload.evidence = evidence;

  // The ref travels with the payload so a caller can look the title up
  // without re-deriving which repository `<repo>#<n>` came from.
  return { payload, ref };
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const out = io.stdout || ((text) => process.stdout.write(text));
  const err = io.stderr || ((text) => process.stderr.write(text));
  const cwd = io.cwd || process.cwd();

  const { options, errors: argErrors } = parseArgs(argv);
  if (options.help || argv.length === 0) {
    out(USAGE);
    return argv.length === 0 ? 2 : 0;
  }
  if (argErrors.length) {
    err(`${argErrors.join('\n')}\n`);
    return 2;
  }

  const config = loadConfig(cwd);
  if (options.tenant) config.tenantId = options.tenant;
  const info = gitInfo(cwd);

  let built;
  try {
    built = buildPayload(options, config, info);
  } catch (error) {
    // tenantId() throws on a malformed tenant, which is an argument
    // problem however it arrived.
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (built.errors) {
    err(`${built.errors.join('\n')}\n\nRun \`teamflow report --help\` for the accepted values.\n`);
    return 2;
  }

  // A report for a key whose binding carries no title resolves one,
  // once, and caches it there. Nobody should have to type --title for
  // the board to say what the ticket is called.
  if (!built.payload.title) {
    const found = await cachedIssueTitle(built.ref, cwd, config, info);
    if (found?.title) built.payload.title = String(found.title).slice(0, 200);
    if (found?.status) built.payload.jiraStatus = String(found.status).slice(0, 60);
  }

  // Where the branch is and what its pull request is doing, refreshed on
  // every report (MACLEOD-510). Derived state only: counts, flags, a
  // number, a link and the head commit's subject.
  const branchState = gitSnapshot(cwd, info, config);
  if (branchState) built.payload.git = branchState;
  const pullRequest = prSnapshot(cwd, config);
  if (pullRequest) built.payload.pr = pullRequest;

  const transport = transportOf(config);
  if (options['dry-run']) {
    out(`${JSON.stringify({ transport, envelope: { kind: 'issue', payload: built.payload } }, null, 2)}\n`);
    return 0;
  }
  if (transport === 'none') {
    err('TeamFlow: nothing to report to. Run /teamflow:login in Claude Code, or set TEAMFLOW_API_KEY.\n');
    return 2;
  }

  const result = transport === 'service'
    ? await sendReport('issue', undefined, built.payload, config)
    : await putReport(tenantPath(config, `issues/${built.payload.jiraKey}.json`), built.payload, config);
  out(`${JSON.stringify(result, null, 2)}\n`);
  // A queued or refused report is not the caller's failure to handle.
  return 0;
}

// A bin entry is a symlink, so process.argv[1] is the link and
// import.meta.url is its target. Compare what they resolve to.
function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exit(await main());
}
