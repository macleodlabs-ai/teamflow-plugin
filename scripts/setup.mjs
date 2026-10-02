// One team set-up (MACLEOD-938): `teamflow setup [--dry-run] [--yes]`.
//
// The organisation's owners and admins keep one baseline in TeamFlow
// (adapters/teamflow/team_setup.py). This module offers it to a machine.
// Owner decision 7: offered with a preview, never forced. A company that
// must enforce it uses Claude Code's own managed settings instead.
//
// What it writes, and only with the person's yes:
//   <claude dir>/teamflow-team.md   the shared CLAUDE.md text. TeamFlow
//                                   owns this file and replaces it whole.
//   <claude dir>/CLAUDE.md          one `@` import line for that file,
//                                   added once. The person's own lines
//                                   are never touched.
//   <claude dir>/settings.json      extraKnownMarketplaces, enabledPlugins
//                                   and permissions.allow / deny entries
//                                   it does not have yet. A key the
//                                   person set is kept as they set it.
//   ~/.claude.json (user scope)     mcpServers entries it does not have.
//                                   A header names a variable, `${NAME}`;
//                                   the value stays on the machine.
// It checks tools and variables and lists what is missing; it installs
// nothing and runs nothing the baseline names. The tools it asks for a
// version come from its own fixed table, with its own fixed arguments.
//
// The record (<data dir>/team-setup.json) keeps the version applied and
// digests of what TeamFlow wrote, so the heartbeat can say whether the
// machine is behind or a part changed since. Digests only, never text.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OWNED_FILE = 'teamflow-team.md';
const RECORD_FILE = 'team-setup.json';
const OWNED_HEAD = (version) => `<!-- TeamFlow writes this file from your team's set-up (version ${version}). `
  + 'TeamFlow replaces it on the next update. Put your own lines in CLAUDE.md. -->\n\n';

// The tools TeamFlow can check. The same names as KNOWN_TOOLS in
// adapters/teamflow/team_setup.py; a name the service lets through but
// this table lacks is listed as "not checked", never run.
export const TOOLS = {
  claude: { args: ['--version'], how: 'Install Claude Code from code.claude.com.' },
  git: { args: ['--version'], how: 'Install Git from git-scm.com.' },
  node: { args: ['--version'], how: 'Install Node.js from nodejs.org.' },
  npm: { args: ['--version'], how: 'npm comes with Node.js, from nodejs.org.' },
  pnpm: { args: ['--version'], how: 'Install pnpm from pnpm.io.' },
  yarn: { args: ['--version'], how: 'Install Yarn from yarnpkg.com.' },
  bun: { args: ['--version'], how: 'Install Bun from bun.sh.' },
  python3: { args: ['--version'], how: 'Install Python from python.org.' },
  uv: { args: ['--version'], how: 'Install uv from docs.astral.sh/uv.' },
  pip3: { args: ['--version'], how: 'pip comes with Python, from python.org.' },
  gh: { args: ['--version'], how: 'Install the GitHub CLI from cli.github.com.' },
  glab: { args: ['--version'], how: 'Install the GitLab CLI from gitlab.com/gitlab-org/cli.' },
  docker: { args: ['--version'], how: 'Install Docker from docker.com.' },
  aws: { args: ['--version'], how: 'Install the AWS CLI from aws.amazon.com/cli.' },
  gcloud: { args: ['--version'], how: 'Install the Google Cloud CLI from cloud.google.com/sdk.' },
  az: { args: ['--version'], how: 'Install the Azure CLI from learn.microsoft.com/cli/azure.' },
  terraform: { args: ['-version'], how: 'Install Terraform from terraform.io.' },
  kubectl: { args: ['version', '--client'], how: 'Install kubectl from kubernetes.io.' },
  go: { args: ['version'], how: 'Install Go from go.dev.' },
  rustc: { args: ['--version'], how: 'Install Rust from rustup.rs.' },
  cargo: { args: ['--version'], how: 'Cargo comes with Rust, from rustup.rs.' },
  java: { args: ['-version'], how: 'Install a Java JDK, for example from adoptium.net.' },
  make: { args: ['--version'], how: 'Install make with your system tools.' },
  jq: { args: ['--version'], how: 'Install jq from jqlang.org.' },
  deno: { args: ['--version'], how: 'Install Deno from deno.com.' },
};

// --- where things live ---------------------------------------------------

/** Claude Code's user folder: CLAUDE_CONFIG_DIR when set, else ~/.claude. */
export function claudeDir(env = process.env, home = os.homedir()) {
  return env.CLAUDE_CONFIG_DIR ? path.resolve(env.CLAUDE_CONFIG_DIR) : path.join(home, '.claude');
}

/** Where Claude Code keeps user-scope MCP servers. */
export function claudeJsonPath(env = process.env, home = os.homedir()) {
  return env.CLAUDE_CONFIG_DIR ? path.join(path.resolve(env.CLAUDE_CONFIG_DIR), '.claude.json') : path.join(home, '.claude.json');
}

/** The import line for the owned file: `@~/...` under home, else the full path, spaces escaped. */
export function importLine(file, home = os.homedir()) {
  const rel = path.relative(home, file);
  const shown = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~/${rel.split(path.sep).join('/')}` : file;
  return `@${shown.replace(/ /g, '\\ ')}`;
}

export function places({ env = process.env, home = os.homedir(), data } = {}) {
  const dir = claudeDir(env, home);
  return {
    dir,
    owned: path.join(dir, OWNED_FILE),
    claudeMd: path.join(dir, 'CLAUDE.md'),
    settings: path.join(dir, 'settings.json'),
    claudeJson: claudeJsonPath(env, home),
    record: data ? path.join(data, RECORD_FILE) : undefined,
  };
}

// --- small helpers -------------------------------------------------------

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

/** A JSON file as an object; {} when absent. Throws on a file that is there but not JSON, so it is never overwritten. */
function readObject(file) {
  const text = readText(file);
  if (text === undefined || !text.trim()) return {};
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${file} is not a JSON object`);
  return value;
}

/** Write a file in one step, keeping the mode an existing file had. */
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* a new file */ }
  const tmp = `${file}.teamflow-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function hash(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex').slice(0, 16);
}

const same = (a, b) => canonical(a) === canonical(b);

/** -1, 0 or 1, comparing dotted numbers. */
export function compareVersions(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** The MCP entry Claude Code reads, from one baseline server. */
export function mcpEntry(server) {
  const entry = { type: server.type || 'http', url: server.url };
  if (server.auth === 'header' && server.header && server.env) {
    const scheme = server.header.toLowerCase() === 'authorization' ? 'Bearer ' : '';
    entry.headers = { [server.header]: `${scheme}\${${server.env}}` };
  }
  return entry;
}

// --- tools ---------------------------------------------------------------

/** The version a tool prints, by its own fixed arguments, or undefined. */
export function toolVersion(name, { run = defaultRun } = {}) {
  const spec = TOOLS[name];
  if (!spec) return { checked: false };
  try {
    const out = run(name, spec.args);
    if (out === null) return { checked: false };
    const found = String(out || '').match(/(\d+(?:\.\d+){0,3})/);
    return { checked: true, version: found ? found[1] : undefined, present: true };
  } catch {
    return { checked: true, present: false };
  }
}

async function defaultBinary(name) {
  if (name !== 'claude') return name;
  const { claudeBinary } = await import('./claude-bin.mjs');
  return claudeBinary().bin;
}

let claudeBin;
function defaultRun(name, args) {
  // The real `claude` only through claude-bin.mjs's guard; null when it says no.
  const bin = name === 'claude' ? claudeBin : name;
  if (!bin) return null;
  return execFileSync(bin, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
}

/** Each tool the baseline names: have, ok, and how to get it. */
export async function checkTools(tools = [], { run } = {}) {
  if (!run && tools.some((t) => t.name === 'claude')) claudeBin = await defaultBinary('claude');
  return tools.map((tool) => {
    const got = toolVersion(tool.name, run ? { run } : {});
    const ok = got.checked && got.present && (!tool.min || (got.version && compareVersions(got.version, tool.min) >= 0));
    return { name: tool.name, min: tool.min, have: got.version, checked: got.checked, present: Boolean(got.present), ok: Boolean(ok), how: TOOLS[tool.name]?.how };
  });
}

// --- the plan ------------------------------------------------------------

/**
 * What applying `baseline` (the service's `{version, setup}`) would change.
 * Pure but for reads. `changes` lists each file and the keys it gains;
 * `kept` lists the person's own values left as they are.
 */
export function plan(baseline, { env = process.env, home = os.homedir(), data } = {}) {
  const at = places({ env, home, data });
  const setup = baseline?.setup || {};
  const version = String(baseline?.version || '0');
  const changes = [];
  const kept = [];
  const managed = { marketplaces: [], plugins: [], mcp: [], allow: [], deny: [] };
  const next = {};

  // CLAUDE.md: the owned file, and one import line in the person's file.
  if (typeof setup.claudeMd === 'string' && setup.claudeMd.trim()) {
    const text = OWNED_HEAD(version) + setup.claudeMd.replace(/\s*$/, '\n');
    const before = readText(at.owned);
    // The header names the version; a new version alone is not a change to the words.
    const body = (t) => String(t || '').replace(/^<!-- TeamFlow writes[^\n]*-->\n\n/, '');
    if (body(before) !== body(text)) {
      changes.push({ file: at.owned, what: before === undefined ? 'create' : 'replace', keys: ['the team\'s shared instructions'] });
    }
    next.owned = body(before) === body(text) && before !== undefined ? undefined : text;
    const line = importLine(at.owned, home);
    const mine = readText(at.claudeMd);
    const has = String(mine || '').split('\n').some((l) => l.trim() === line || l.includes(line));
    if (!has) {
      changes.push({ file: at.claudeMd, what: mine === undefined ? 'create' : 'add line', keys: [line] });
      next.claudeMd = mine === undefined || !mine.trim()
        ? `${line}\n`
        : `${mine.replace(/\n*$/, '\n')}\n${line}\n`;
    }
  }

  // settings.json: add what is missing, keep what the person set.
  const settings = readObject(at.settings);
  const added = [];
  const outSettings = JSON.parse(JSON.stringify(settings));
  for (const [name, source] of Object.entries(setup.marketplaces || {})) {
    managed.marketplaces.push(name);
    const want = { source };
    const have = settings.extraKnownMarketplaces?.[name];
    if (have === undefined) {
      outSettings.extraKnownMarketplaces = { ...(outSettings.extraKnownMarketplaces || {}), [name]: want };
      added.push(`extraKnownMarketplaces.${name}`);
    } else if (!same(have, want)) {
      kept.push(`You set the plugin source ${name} yourself. TeamFlow left it as it is.`);
    }
  }
  for (const id of setup.plugins || []) {
    managed.plugins.push(id);
    const have = settings.enabledPlugins?.[id];
    if (have === undefined) {
      outSettings.enabledPlugins = { ...(outSettings.enabledPlugins || {}), [id]: true };
      added.push(`enabledPlugins.${id}`);
    } else if (have !== true) {
      kept.push(`You turned off the plugin ${id}. TeamFlow left it off.`);
    }
  }
  for (const side of ['allow', 'deny']) {
    for (const rule of setup.permissions?.[side] || []) {
      managed[side].push(rule);
      const list = Array.isArray(outSettings.permissions?.[side]) ? outSettings.permissions[side] : [];
      if (!list.includes(rule)) {
        outSettings.permissions = { ...(outSettings.permissions || {}), [side]: [...list, rule] };
        added.push(`permissions.${side}: ${rule}`);
      }
    }
  }
  if (added.length) {
    changes.push({ file: at.settings, what: fs.existsSync(at.settings) ? 'add keys' : 'create', keys: added });
    next.settings = `${JSON.stringify(outSettings, null, 2)}\n`;
  }

  // User-scope MCP servers.
  const servers = Object.entries(setup.mcpServers || {});
  if (servers.length) {
    const claudeJson = readObject(at.claudeJson);
    const out = JSON.parse(JSON.stringify(claudeJson));
    const mcpAdded = [];
    for (const [name, server] of servers) {
      managed.mcp.push(name);
      const want = mcpEntry(server);
      const have = claudeJson.mcpServers?.[name];
      if (have === undefined) {
        out.mcpServers = { ...(out.mcpServers || {}), [name]: want };
        mcpAdded.push(`mcpServers.${name}`);
      } else if (!same(have, want)) {
        kept.push(`You set the server ${name} yourself. TeamFlow left it as it is.`);
      }
    }
    if (mcpAdded.length) {
      changes.push({ file: at.claudeJson, what: fs.existsSync(at.claudeJson) ? 'add keys' : 'create', keys: mcpAdded });
      next.claudeJson = `${JSON.stringify(out, null, 2)}\n`;
    }
  }

  const envRows = (setup.env || []).map((row) => ({ name: row.name, where: row.where || '', set: Boolean(env[row.name]) }));
  const signIn = servers.filter(([, s]) => s.auth === 'oauth').map(([name]) => name);
  return { version, project: baseline?.project || '', changes, kept, managed, next, env: envRows, signIn, tools: setup.tools || [], at };
}

/** Write what `plan` said, in the order that leaves no import without its file. */
export function apply(planned) {
  const { at, next } = planned;
  if (next.owned !== undefined) writeText(at.owned, next.owned);
  if (next.claudeMd !== undefined) writeText(at.claudeMd, next.claudeMd);
  if (next.settings !== undefined) writeText(at.settings, next.settings);
  if (next.claudeJson !== undefined) writeText(at.claudeJson, next.claudeJson);
}

// --- the fingerprint -----------------------------------------------------

/** Digests of the parts TeamFlow manages, as they are now. */
export function digests(managed = {}, at) {
  const settings = (() => { try { return readObject(at.settings); } catch { return {}; } })();
  const claudeJson = (() => { try { return readObject(at.claudeJson); } catch { return {}; } })();
  const owned = readText(at.owned);
  return {
    ...(owned === undefined ? {} : { claudeMd: hash(owned) }),
    settings: hash({
      marketplaces: (managed.marketplaces || []).map((n) => settings.extraKnownMarketplaces?.[n] ?? null),
      plugins: (managed.plugins || []).map((n) => settings.enabledPlugins?.[n] ?? null),
      allow: (managed.allow || []).map((r) => (settings.permissions?.allow || []).includes(r)),
      deny: (managed.deny || []).map((r) => (settings.permissions?.deny || []).includes(r)),
    }),
    mcp: hash((managed.mcp || []).map((n) => claudeJson.mcpServers?.[n] ?? null)),
  };
}

export function readRecord(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/** The record after an apply: version, digests, tools found. */
export function recordAfter(planned, tools, now = new Date().toISOString()) {
  const missing = tools.filter((t) => !t.ok).length + planned.env.filter((e) => !e.set).length;
  const record = {
    version: planned.version,
    ...(planned.project ? { project: planned.project } : {}),
    managed: planned.managed,
    applied: digests(planned.managed, planned.at),
    tools: tools.filter((t) => t.have).map((t) => ({ name: t.name, version: t.have })),
    missing: Math.min(missing, 100),
    at: now,
  };
  writeText(planned.at.record, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * What the heartbeat sends: `{machine, version?, project?, claudeMd?,
 * settings?, mcp?, drift?, missing?, tools?}`. Digests and versions only.
 */
export function fingerprint({ machine, env = process.env, home = os.homedir(), data } = {}) {
  if (!machine) return undefined;
  const at = places({ env, home, data });
  const record = at.record ? readRecord(at.record) : undefined;
  if (!record?.version) return { machine };
  const now = digests(record.managed, at);
  const changed = ['claudeMd', 'settings', 'mcp'].filter((k) => (record.applied || {})[k] !== now[k]);
  return {
    machine,
    version: String(record.version),
    ...(record.project ? { project: record.project } : {}),
    ...now,
    drift: changed.length > 0,
    missing: Number(record.missing) || 0,
    tools: (record.tools || []).slice(0, 30),
  };
}

/** Keep the version the service says this machine should have. */
export function noteWanted(version, { data } = {}) {
  if (!data || !/^\d{1,6}(\.\d{1,6})?$/.test(String(version || ''))) return;
  const file = path.join(data, RECORD_FILE);
  const record = readRecord(file) || {};
  if (record.wanted === String(version)) return;
  writeText(file, `${JSON.stringify({ ...record, wanted: String(version) }, null, 2)}\n`);
}

const PART_WORDS = { claudeMd: 'the shared instructions', settings: 'your settings', mcp: 'your MCP servers' };

/** The one line a session and `teamflow status` show, or undefined. */
export function setupNotice({ env = process.env, home = os.homedir(), data } = {}) {
  if (!data) return undefined;
  const at = places({ env, home, data });
  const record = readRecord(at.record);
  if (!record) return undefined;
  const wanted = record.wanted;
  if (!record.version) {
    return wanted && wanted !== '0' ? 'Your team shares a Claude Code set-up. Run `teamflow setup` to see it.' : undefined;
  }
  const list = [];
  if (wanted && wanted !== '0' && wanted !== String(record.version)) list.push(`version ${wanted} is out, you have ${record.version}`);
  const now = digests(record.managed, at);
  for (const part of ['claudeMd', 'settings', 'mcp']) {
    if ((record.applied || {})[part] !== now[part]) list.push(`${PART_WORDS[part]} changed here`);
  }
  if (!list.length) return undefined;
  return `The team set-up changed. Update? (${list.join('; ')}.) Run \`teamflow setup\` to see what changes.`;
}

// --- words ---------------------------------------------------------------

/** The preview, as a person reads it. */
export function previewLines(planned) {
  const lines = [];
  if (!planned.changes.length) {
    lines.push('Nothing to change. Your machine has the team set-up.');
  } else {
    lines.push(`TeamFlow will make these changes for team set-up version ${planned.version}:`);
    for (const change of planned.changes) {
      lines.push(`  ${change.file} (${change.what})`);
      for (const key of change.keys) lines.push(`    + ${key}`);
    }
    lines.push('TeamFlow keeps your own lines and keys.');
  }
  for (const line of planned.kept) lines.push(line);
  return lines;
}

/** Tools, variables and sign-ins still to do, with how to do each. */
export function todoLines(tools, planned) {
  const lines = [];
  for (const tool of tools) {
    if (tool.ok) continue;
    if (!tool.checked) lines.push(`TeamFlow did not check ${tool.name}.`);
    else if (!tool.present) lines.push(`You need ${tool.name}${tool.min ? ` ${tool.min} or later` : ''}. ${tool.how || ''}`.trim());
    else lines.push(`You have ${tool.name} ${tool.have || 'of an unknown version'}. You need ${tool.min} or later. ${tool.how || ''}`.trim());
  }
  for (const row of planned.env) {
    if (!row.set) lines.push(`Set ${row.name} on this machine.${row.where ? ` Its value is in ${row.where}.` : ''}`);
  }
  for (const name of planned.signIn) lines.push(`Sign in to the server ${name}: run /mcp in Claude Code.`);
  return lines;
}

// --- the command ---------------------------------------------------------

/** `GET /v1/members/team-setup[?project=]` with this machine's credential. */
export async function fetchBaseline(config = {}, project = undefined) {
  const { credential, serviceUrl } = await import('./core.mjs');
  const cred = await credential(config);
  if (!cred) return { ok: false, reason: 'this machine is not signed in. Run `teamflow login` first' };
  try {
    const query = project ? `?project=${encodeURIComponent(project)}` : '';
    const response = await fetch(`${serviceUrl(config)}/v1/members/team-setup${query}`, {
      headers: { [cred.header]: cred.value },
      redirect: 'error',
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 10000)),
    });
    if (!response.ok) return { ok: false, reason: `TeamFlow answered ${response.status}` };
    return { ok: true, baseline: await response.json() };
  } catch (error) {
    return { ok: false, reason: `TeamFlow could not be reached: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** One yes or no from the terminal; no when nobody can answer. */
export async function askOnce(question, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY) return false;
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input, output });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/**
 * `teamflow setup [--dry-run] [--yes]`. Fetches the baseline, shows the
 * preview, asks once, applies, then lists what is still to do.
 * Returns the exit code. Every dependency can be replaced by a test.
 */
export async function runSetup({
  args = [], config = {}, print = console.log, ask = askOnce, fetch: get = fetchBaseline,
  project, run, env = process.env, home = os.homedir(), data, offer = false,
} = {}) {
  const got = await get(config, project);
  if (!got.ok) {
    if (offer) return 0;
    print(`TeamFlow could not read your team's set-up: ${got.reason}.`);
    return 1;
  }
  const baseline = { ...got.baseline, project: got.baseline?.project || project || '' };
  if (!Object.keys(baseline.setup || {}).length) {
    if (!offer) print('Your team has no shared set-up yet. An owner or admin adds one on the Organisation page.');
    return 0;
  }
  const planned = plan(baseline, { env, home, data });
  const tools = await checkTools(planned.tools, run ? { run } : {});
  const dry = args.includes('--dry-run');
  if (offer && !planned.changes.length) return 0;
  for (const line of previewLines(planned)) print(line);
  if (planned.changes.length && !dry) {
    const yes = args.includes('--yes') || await ask('Apply these changes?');
    if (!yes) {
      print('TeamFlow changed nothing. Run `teamflow setup` when you are ready.');
      return 0;
    }
    apply(planned);
    print('Done. Start a new Claude Code session to load the changes.');
  }
  if (!dry && data) recordAfter(planned, tools);
  const todo = todoLines(tools, planned);
  if (todo.length) {
    print('Still to do on this machine:');
    for (const line of todo) print(`  - ${line}`);
  }
  if (dry && planned.changes.length) print('This was a preview. TeamFlow changed nothing.');
  return 0;
}
