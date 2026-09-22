#!/usr/bin/env node
// A background reporter's sidecar: what one CI job, deploy, test run or
// audit says about a ticket, and -- since MACLEOD-639 -- when it started,
// when it ended, and where the run itself can be read.
//
// The owner's rule 4: a started gate with no finish past its deadline is
// "no verdict", never "running forever". A sidecar that says `running`
// once and is never rewritten was the live board's deploy gate for 41
// hours. So a gate has a lifecycle now: `startedAt` is what a deadline
// is measured from, `endedAt` is what closes it, and every reporter is
// asked for both. `teamflow ci start|end|fail <gate>` is the two lines a
// workflow author writes; `teamflow ci run <gate> -- <command>` runs the
// command itself and, when it fails or gives no verdict in time, retries
// it -- bounded, with backoff, every try written on the sidecar and the
// reason it is still going written as `retry` -- because the owner's
// ruling is that the plugin fixes and reruns a gate and the dashboard
// only says there is a delay, and why. A gate the plugin did not run is
// never retried by it: an external gate reports start and end and that
// is all this knows about it.
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.mjs';
import {
  apiKeyUsable, loadConfig, putReport, reportScope, sendReport, tenantId, tenantPath, transportOf,
} from './core.mjs';
import { gateDeadlineMs, gateDeadlinesOf, gateFamily } from './workflow.mjs';
import { policyOf } from './selfheal.mjs';
import { pointLine } from './points.mjs';

// Every key shape the service accepts (`_JIRA_KEY` and `_GH_KEY` in
// adapters/teamflow/schema.py): CORE-217, ADHOC-3, and owner/repo#12 or
// repo#12 for a GitHub tracker, which keeps the repository's own case.
const JIRA_KEY = /^[A-Za-z][A-Za-z0-9]{0,19}-\d{1,9}$/;
const GITHUB_KEY = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,63}#\d{1,9}$/;

/** The key as the service takes it, or undefined when it is not one. */
export function issueKey(value) {
  const raw = String(value ?? '').trim();
  if (raw.includes('..')) return undefined;
  if (GITHUB_KEY.test(raw)) return raw;
  if (JIRA_KEY.test(raw)) return raw.toUpperCase();
  return undefined;
}

export const SLOTS = new Set(['ci', 'audit-local', 'deploy', 'dev-test', 'audit-dev', 'security']);
// Slots a connector owns (`RESERVED_SLOTS` in adapters/teamflow/schema.py):
// a tracker's, a pull request's, an external system's such as SonarQube.
// The plugin never writes one, whatever a gate is called.
export const RESERVED = new Set(['tracker', 'pr', 'sonarqube']);
// A gate id as the board keys a column: lower case, hyphens (`is_gate_id`).
const GATE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const KINDS = ['ci', 'deploy', 'test', 'audit', 'security', 'environment'];
const TERMINAL = new Set(['success', 'failed', 'blocked', 'idle']);

function argOf(argv, name, fallback) {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? true : value;
}

/** Every value of a flag that may be given more than once. */
function argsOf(argv, name) {
  return argv.flatMap((arg, i) => (arg === `--${name}` && argv[i + 1] !== undefined
    && !argv[i + 1].startsWith('--') ? [argv[i + 1]] : []));
}

// --- the url ---------------------------------------------------------------

/**
 * A link to the customer's own run and nothing else: https, one line,
 * at most 512 characters. Anything else is refused with a sentence,
 * because a URL is the one free-text field on this document and "a
 * link" is the whole of what it may be.
 */
export function checkUrl(url) {
  const text = String(url ?? '');
  if (!text) return { ok: true, url: undefined };
  if (/[\r\n]/.test(text)) return { ok: false, reason: '--url must be one line' };
  if (text.length > 512) return { ok: false, reason: '--url must be at most 512 characters' };
  if (!/^https:\/\/[^\s/?#]+/.test(text)) return { ok: false, reason: '--url must be an https link to the run' };
  return { ok: true, url: text };
}

// --- the payload ---------------------------------------------------------

/**
 * One sidecar, from flags and environment. Pure: what leaves is decided
 * here and checked in a test, and the transport below only carries it.
 *
 * `endedAt` is set for any terminal status, `--ended` or not: a gate
 * that reports `success` has by definition finished, and a terminal
 * report with no end is exactly the row a deadline would have to guess
 * about. `--ended <iso>` names the moment; `--ended` alone means now.
 * `startedAt` defaults to now on a `running` report and to `--started`
 * otherwise; a terminal report that does not know when it started
 * leaves it out, and the service carries the running report's forward.
 */
export function buildRuntimePayload(argv = [], env = {}, { now = new Date().toISOString() } = {}) {
  const jiraKey = issueKey(argOf(argv, 'jira', env.TEAMFLOW_JIRA_KEY));
  const slot = String(argOf(argv, 'slot', env.TEAMFLOW_RUNTIME_SLOT || 'ci'));
  const kind = String(argOf(argv, 'kind', env.TEAMFLOW_RUNTIME_KIND || slot));
  const label = String(argOf(argv, 'label', env.TEAMFLOW_RUNTIME_LABEL || slot));
  const stage = String(argOf(argv, 'stage', env.TEAMFLOW_STAGE || 'CI_BUILD'));
  const status = String(argOf(argv, 'status', env.TEAMFLOW_STATUS || 'running'));
  const summary = String(argOf(argv, 'summary', env.TEAMFLOW_SUMMARY || label));
  const id = String(argOf(argv, 'id', env.TEAMFLOW_RUNTIME_ID || `${slot}-${env.GITHUB_RUN_ID || Date.now()}`));

  if (!jiraKey) {
    return { ok: false, code: 2, reason: 'runtime-report requires --jira PROJECT-123 (or owner/repo#12) or TEAMFLOW_JIRA_KEY' };
  }
  if (!SLOTS.has(slot)) {
    return { ok: false, code: 2, reason: `runtime-report slot must be one of: ${[...SLOTS].join(', ')}` };
  }
  const link = checkUrl(argOf(argv, 'url', env.TEAMFLOW_RUNTIME_URL));
  if (!link.ok) return { ok: false, code: 2, reason: link.reason };

  const payload = {
    tenantId: undefined,
    jiraKey,
    slot,
    id: id.slice(0, 120),
    kind: KINDS.includes(kind) ? kind : 'ci',
    label: label.slice(0, 120),
    stage,
    status,
    summary: summary.slice(0, 180),
    updatedAt: now,
  };
  const started = argOf(argv, 'started', env.TEAMFLOW_RUNTIME_STARTED);
  if (typeof started === 'string' && Number.isFinite(Date.parse(started))) payload.startedAt = started;
  else if (status === 'running') payload.startedAt = now;
  const ended = argOf(argv, 'ended', env.TEAMFLOW_RUNTIME_ENDED);
  if (typeof ended === 'string' && Number.isFinite(Date.parse(ended))) payload.endedAt = ended;
  else if (ended === true || TERMINAL.has(status)) payload.endedAt = now;
  if (link.url) payload.url = link.url;
  /*
   * The steps a failed run failed at (ADHOC-19): each one's name, one
   * line, and nothing else. The service turns them into failure points
   * the next passing run checks off. Never output or a log line.
   */
  const steps = [...new Set(argsOf(argv, 'failed-step').map((step) => pointLine(step, 120)).filter(Boolean))].slice(0, 20);
  if (status === 'failed' && steps.length) payload.failedSteps = steps;
  // Which gate of the pipeline this is, when the reporter says: the
  // board keys its column on it. Only a well-formed id, never a reserved
  // one -- those belong to their connectors.
  const gate = argOf(argv, 'gate', env.TEAMFLOW_GATE);
  if (typeof gate === 'string' && GATE_ID.test(gate)) {
    if (RESERVED.has(gate)) return { ok: false, code: 2, reason: `${gate} is reserved for its connector; the plugin never writes it` };
    payload.gate = gate;
  }
  return { ok: true, payload };
}

// --- the transport --------------------------------------------------------

/**
 * Sign in as CI does and send one sidecar. Never throws past its
 * caller: background reporting is observability and must not break a
 * build.
 *
 * CI signs in per job. A workflow with `permissions: id-token: write`
 * trades its GitHub Actions OIDC token, which names the repository,
 * workflow and ref, for a one-hour access token. That is why the
 * example workflow carries no secret. TEAMFLOW_API_KEY is the fallback
 * for CI that cannot mint an OIDC token at all.
 */
export async function reportRuntime(payload, config, { stderr = (s) => process.stderr.write(s) } = {}) {
  const document = { ...payload, tenantId: tenantId(config) };
  if (!config.accessToken && !config.ciSignedIn) {
    const ci = await auth.githubOidcAccessToken(config);
    if (ci.ok) {
      config.accessToken = ci.token;
      // And which service minted it, so it may be sent back there whatever
      // named that address: a token returning to its own issuer leaks
      // nothing, and without this a self-hosted Actions run is refused
      // (MACLEOD-616). In process only — never a config key anything else
      // can set.
      config.accessTokenOrigin = ci.origin;
      // The exchange already said which organisation the repository is
      // registered to. Carried so a report queued offline knows whose it is
      // without a second call, and so a token replaced an hour later still
      // matches it (MACLEOD-583).
      if (ci.account) config.account = ci.account;
    } else if (ci.attempted) {
      stderr(`TeamFlow: OIDC sign-in failed (${ci.reason}); ${apiKeyUsable(config) ? 'falling back to TEAMFLOW_API_KEY' : 'no fallback credential is configured'}\n`);
    }
    config.ciSignedIn = true;
  }
  // The service derives the object path from the envelope's slot and the
  // account's tenant, so only the legacy S3 path spells the key out.
  return transportOf(config) === 'service'
    // Through the organisation check (MACLEOD-586, MACLEOD-601 audit
    // finding 3). A background reporter carries an issue key just as a
    // hook does, and a CI job that fell back to the wrong credential
    // would put one customer's build on another's board.
    ? sendReport('runtime', document.slot, document, config, { account: reportScope(config) })
    : putReport(tenantPath(config, `runtime/${document.jiraKey}/${document.slot}.json`), document, config);
}

// --- teamflow ci: two lines for a workflow author -------------------------
//
// `teamflow ci start deploy` and `teamflow ci end deploy` (or `fail`)
// around the step, with `--url` for the run's own page. The gate id is
// any string the pipeline uses; the slot it lands in is worked out from
// it, and the stage from the slot. `start` writes down when it started
// beside the job, so `end` on the same runner carries the same clock
// without the author having to.

const GATE_SLOT = { ci: 'ci', build: 'ci', test: 'ci', 'dev-test': 'dev-test', audit: 'audit-local',
  'audit-local': 'audit-local', 'audit-dev': 'audit-dev', security: 'security', deploy: 'deploy' };
const SLOT_STAGE = { ci: 'CI_BUILD', deploy: 'DEPLOY_DEV', 'dev-test': 'DEV_TEST', 'audit-local': 'LOCAL_AUDIT',
  'audit-dev': 'DEV_AUDIT', security: 'DEV_AUDIT' };
const SLOT_KIND = { ci: 'ci', deploy: 'deploy', 'dev-test': 'test', 'audit-local': 'audit', 'audit-dev': 'audit', security: 'security' };

/** Which slot a gate id lands in. Any string; unknown ids go by family. */
export function slotFor(gate) {
  const id = String(gate || '').toLowerCase();
  if (GATE_SLOT[id]) return GATE_SLOT[id];
  const family = gateFamily(id);
  return family === 'deploy' ? 'deploy' : family === 'audit' ? 'audit-dev' : 'ci';
}

function markerPath(gate, env) {
  const dir = env.RUNNER_TEMP || env.TEAMFLOW_CI_TEMP || os.tmpdir();
  const run = String(env.GITHUB_RUN_ID || env.TEAMFLOW_RUNTIME_ID || 'local').replace(/[^A-Za-z0-9._-]+/g, '-');
  return path.join(dir, `teamflow-ci-${run}-${String(gate).replace(/[^A-Za-z0-9._-]+/g, '-')}.json`);
}

function readMarker(gate, env) {
  try { return JSON.parse(fs.readFileSync(markerPath(gate, env), 'utf8')); } catch { return undefined; }
}

function writeMarker(gate, env, value) {
  try {
    const file = markerPath(gate, env);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  } catch { /* a temp dir; `end` then carries no start and the service keeps the running report's */ }
}

/**
 * The flags `teamflow ci <verb> <gate>` turns into a report. Pure, so the
 * three verbs are a table in a test rather than three CI runs.
 */
export function ciArgs(verb, gate, rest = [], env = {}, { now = new Date().toISOString(), marker } = {}) {
  const named = String(gate || '').toLowerCase();
  if (RESERVED.has(named)) return { ok: false, reason: `${named} is reserved for its connector; the plugin never writes it` };
  const slot = slotFor(gate);
  const id = argOf(rest, 'id', env.TEAMFLOW_RUNTIME_ID || `${slot}-${env.GITHUB_RUN_ID || 'local'}`);
  const label = argOf(rest, 'label', env.TEAMFLOW_RUNTIME_LABEL
    || (env.GITHUB_RUN_NUMBER ? `${gate} #${env.GITHUB_RUN_NUMBER}` : String(gate)));
  const status = verb === 'start' ? 'running' : verb === 'fail' ? 'failed' : verb === 'end' ? 'success' : undefined;
  if (!status) return { ok: false, reason: 'Usage: teamflow ci start|end|fail|run <gate> [--jira KEY] [--url https://...] [--summary "..."] [--step "<failed step>"]...' };
  const summary = argOf(rest, 'summary', verb === 'start' ? `${gate} started` : verb === 'fail' ? `${gate} failed` : `${gate} passed`);
  const args = ['--slot', slot, '--kind', SLOT_KIND[slot], '--stage', SLOT_STAGE[slot], '--status', status,
    '--id', String(id), '--label', String(label), '--summary', String(summary)];
  if (GATE_ID.test(String(gate).toLowerCase())) args.push('--gate', String(gate).toLowerCase());
  const jira = argOf(rest, 'jira', env.TEAMFLOW_JIRA_KEY);
  if (typeof jira === 'string') args.push('--jira', jira);
  const url = argOf(rest, 'url', env.TEAMFLOW_RUNTIME_URL
    || (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined));
  if (typeof url === 'string') args.push('--url', url);
  // `teamflow ci fail <gate> --step "Unit tests" --step "Lint"`: the steps
  // that failed, which become the gate's failure points (ADHOC-19).
  if (verb === 'fail') for (const step of argsOf(rest, 'step')) args.push('--failed-step', step);
  if (verb === 'start') args.push('--started', now);
  else {
    const started = argOf(rest, 'started', marker?.startedAt);
    if (typeof started === 'string') args.push('--started', started);
    args.push('--ended', now);
  }
  return { ok: true, args, slot };
}

// --- the runner: retry n of m, and say why ---------------------------------

/** The first pause between tries, doubling each time. */
export const BACKOFF_S = 30;

/**
 * What one finished try means for the sidecar: pure, so the policy is a
 * table in a test and the loop below only follows it.
 *
 * `attempt` is 1-based; `of` is the tries in all. A try that fails or
 * times out with tries left is a `running` report carrying the attempt
 * and a `retry {attempt, of, nextAt, status: retrying, reason}`; the
 * last failure is `failed` with `retry.status: delayed`, the reason and
 * `notifiedAt` -- somebody is told there is a delay, and why -- and a
 * pass is `success`. The same `retry` block the orchestrator's policy
 * writes (selfheal.mjs), so the board reads one shape.
 */
export function afterAttempt({ attempt, of, exit, timedOut, deadlineMs, at, attempts = [], nextAt, gate = 'gate' }) {
  const reason = timedOut
    ? `no verdict after ${Math.round(deadlineMs / 60000)} min`
    : exit === 0 ? 'passed' : `${gate} command exited ${exit}`;
  const status = timedOut ? 'idle' : exit === 0 ? 'success' : 'failed';
  const history = [...attempts, { at, status, reason }].slice(-16);
  if (status === 'success') {
    return { status: 'success', attempts: history, summary: attempt > 1 ? `passed on attempt ${attempt} of ${of}` : 'passed', again: false };
  }
  if (attempt >= of) {
    const said = `${reason} · ${of} ${of === 1 ? 'attempt' : 'attempts'}`;
    return {
      status: 'failed', attempts: history, summary: `delayed · ${said}`, again: false,
      retry: { attempt, of, status: 'delayed', reason: said.slice(0, 120), notifiedAt: at },
    };
  }
  return {
    status: 'running',
    attempts: history,
    retry: { attempt: attempt + 1, of, nextAt, status: 'retrying', reason: reason.slice(0, 120) },
    summary: `retrying · attempt ${attempt + 1} of ${of} · ${reason}`,
    again: true,
  };
}

function runOnce(command, { cwd, env, timeoutMs, stdio = 'inherit' }) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), { cwd, env, stdio, shell: false });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch { /* gone */ } }, timeoutMs);
    child.on('error', () => { clearTimeout(timer); resolve({ exit: 127, timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ exit: code ?? 1, timedOut }); });
  });
}

/**
 * Run a gate's command and report it: start, each try, the end.
 *
 * Every try is bounded at TWICE the gate's deadline -- the moment the
 * plugin writes a silent gate off everywhere else, never the 1x the
 * board only draws doubtfully at -- and a try that runs past it is
 * killed and counted as "no verdict", which is a reason to retry like
 * any failure. A 45-minute deploy under a 30-minute deadline is amber
 * on the board and untouched here. The exit code is the command's
 * last, so a workflow step still fails when the gate does. `exec` is
 * the seam a test replaces.
 */
export async function runGate(gate, command, {
  config = {}, env = process.env, cwd = process.cwd(), rest = [], exec = runOnce,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => new Date().toISOString(),
  send = reportRuntime, print = (s) => process.stdout.write(`${s}\n`),
} = {}) {
  const slot = slotFor(gate);
  // One policy for every gate the plugin runs (selfheal.mjs): the
  // organisation's `delivery.retry.attempts`, or three. `--retries N`
  // is N re-runs after the first try, for a workflow that knows better.
  const given = argOf(rest, 'retries');
  const of = given !== undefined && given !== true
    ? Math.min(Math.max(0, Number(given) || 0), 20) + 1
    : policyOf(config).attempts;
  const backoffS = Number(argOf(rest, 'backoff', config?.delivery?.gate_backoff_s)) || BACKOFF_S;
  const deadlineMs = gateDeadlineMs(slot, gateDeadlinesOf(config));
  const killMs = 2 * deadlineMs;
  const startedAt = now();
  const base = ciArgs('start', gate, rest, env, { now: startedAt });
  if (!base.ok) { print(base.reason); return 2; }
  const first = buildRuntimePayload(base.args, env, { now: startedAt });
  if (!first.ok) { print(first.reason); return first.code; }
  await send(first.payload, config).catch(() => ({ ok: false }));

  let attempts = [];
  let exit = 1;
  for (let attempt = 1; attempt <= of; attempt += 1) {
    const result = await exec(command, { cwd, env, timeoutMs: killMs });
    exit = result.timedOut ? 124 : result.exit;
    const at = now();
    const pauseMs = backoffS * 1000 * 2 ** (attempt - 1);
    const nextAt = new Date(Date.parse(at) + pauseMs).toISOString();
    const verdict = afterAttempt({ attempt, of, exit: result.exit, timedOut: result.timedOut, deadlineMs: killMs, at, attempts, nextAt, gate });
    attempts = verdict.attempts;
    const payload = {
      ...first.payload,
      status: verdict.status,
      summary: `${gate}: ${verdict.summary}`.slice(0, 180),
      updatedAt: at,
      startedAt,
      attempts,
      ...(verdict.retry ? { retry: verdict.retry } : {}),
      ...(verdict.status === 'running' ? {} : { endedAt: at }),
    };
    await send(payload, config).catch(() => ({ ok: false }));
    print(`TeamFlow: ${gate} ${verdict.summary}.`);
    if (!verdict.again) break;
    await sleep(pauseMs);
  }
  return exit;
}

/** `teamflow ci <verb> <gate> ...`, from cli.mjs. Exit codes are its own. */
export async function ciMain(args = [], { config = loadConfig(process.cwd()), cwd = process.cwd(), env = process.env,
  print = (s) => process.stdout.write(`${s}\n`), send = reportRuntime, exec, sleep } = {}) {
  const [verb, gate, ...rest] = args;
  if (!verb || verb === '--help' || verb === '-h' || !gate) {
    print('Usage: teamflow ci start|end|fail <gate> [--jira KEY] [--url https://...] [--summary "..."]\n'
      + '       teamflow ci run <gate> [--retries N] [--backoff S] -- <command...>');
    return verb && gate ? 0 : 2;
  }
  if (verb === 'run') {
    const dash = rest.indexOf('--');
    if (dash < 0 || dash === rest.length - 1) { print('teamflow ci run needs `-- <command>`'); return 2; }
    return runGate(gate, rest.slice(dash + 1), { config, env, cwd, rest: rest.slice(0, dash), send, print, exec, sleep });
  }
  const at = new Date().toISOString();
  const marker = verb === 'start' ? undefined : readMarker(gate, env);
  const built = ciArgs(verb, gate, rest, env, { now: at, marker });
  if (!built.ok) { print(built.reason); return 2; }
  const made = buildRuntimePayload(built.args, env, { now: at });
  if (!made.ok) { print(made.reason); return made.code; }
  if (verb === 'start') writeMarker(gate, env, { startedAt: at, id: made.payload.id });
  const result = await send(made.payload, config).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
  print(JSON.stringify(result, null, 2));
  // Reporting never fails a build.
  return 0;
}

// --- the script ---------------------------------------------------------------

async function scriptMain() {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const tenantOverride = argOf(process.argv, 'tenant', process.env.TEAMFLOW_TENANT_ID);
  if (typeof tenantOverride === 'string') config.tenantId = tenantOverride;
  const made = buildRuntimePayload(process.argv.slice(2), process.env);
  if (!made.ok) {
    process.stderr.write(`${made.reason}\n`);
    process.exit(made.code);
  }
  const result = await reportRuntime(made.payload, config);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  // Background reporting is observability only and must not break CI.
  process.exit(0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await scriptMain();
}
