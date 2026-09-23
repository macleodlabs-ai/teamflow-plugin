// Check gates the plugin sets up by itself (MACLEOD-639).
//
// The owner: "For the linter and other similar file based settings. We
// need to automate its insertion via the plugin. It should be automatic."
//
// A check gate (ADHOC-20) needs its command in the repository's own
// `.teamflow/checks.json`. For a gate the plugin knows -- `lint` today --
// the plugin writes that entry itself, so nobody copies a line anywhere.
//
// The boundary that does not move: the service names the gate and never
// the command. The command comes from THIS table, on this machine, from
// what the repository already has (its own `npm run lint` first). A
// command string received from the service is never written into a
// repository, because a repository file is something agents and people
// later run. And nothing here runs a command: it writes one JSON entry.
//
// Only into the main checkout, never an agent's worktree (whose commit it
// would land in); only an entry that is missing, never one the repository
// already chose; at most once every few hours per repository, on `Stop`,
// the event that may already use the network. Fails open.

import fs from 'node:fs';
import path from 'node:path';
import { CHECKS_FILE, PRESET_GATES, parseChecks } from './checks.mjs';

// MegaLinter checks 50+ languages from one command.
export const MULTI_LANGUAGE_LINT = 'npx mega-linter-runner --flavor all';

// Hourly: an owner's edited note reaches the agent within the hour.
export const SYNC_EVERY_MS = 60 * 60 * 1000;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/** The command this machine would use for a known gate, or undefined. */
export function presetCommand(gateId, root, options = {}) {
  if (!PRESET_GATES.has(gateId)) return undefined;
  if (gateId === 'playwright') {
    const config = playwrightConfig(root);
    if (!config) return undefined;
    return options.video === 'on-pass'
      ? `npx playwright test --config ${wrapperName(config, root)}`
      : 'npx playwright test';
  }
  const scripts = readJson(path.join(root, 'package.json'))?.scripts;
  if (scripts && typeof scripts.lint === 'string' && scripts.lint.trim()) return 'npm run lint';
  return MULTI_LANGUAGE_LINT;
}

/** Every command this plugin could have written for a gate: those, and only those, it may change. */
function ownCommands(gateId, root) {
  const out = new Set();
  for (const video of ['off', 'on-pass']) {
    const command = presetCommand(gateId, root, { video });
    if (command) out.add(command);
  }
  if (gateId === 'lint') out.add(MULTI_LANGUAGE_LINT).add('npm run lint');
  return out;
}

// ---------------------------------------------------------- Playwright
//
// Playwright has no command-line switch for video (`--trace` only), so
// "Record a video when the tests pass" is a config: a small file beside
// the repository's own, so every relative path in it resolves exactly as
// before, that is that config with `video: 'on'`. Written only when it is
// missing or is this plugin's own (its first line says so); never over a
// file somebody else wrote.

const PLAYWRIGHT_CONFIGS = ['playwright.config.ts', 'playwright.config.mts', 'playwright.config.mjs', 'playwright.config.js', 'playwright.config.cjs'];
export const WRAPPER_MARK = '// Written by TeamFlow for the Playwright column (MACLEOD-639).';

export function playwrightConfig(root) {
  return PLAYWRIGHT_CONFIGS.find((name) => fs.existsSync(path.join(root, name)));
}

function commonJs(config, root) {
  if (config.endsWith('.cjs')) return true;
  if (!config.endsWith('.js')) return false;
  return readJson(path.join(root, 'package.json'))?.type !== 'module';
}

export function wrapperName(config, root) {
  if (commonJs(config, root)) return 'playwright.teamflow.config.cjs';
  return `playwright.teamflow.config.${config.split('.').pop()}`;
}

export function wrapperSource(config, root) {
  const head = `${WRAPPER_MARK}\n// This repository's own Playwright config, with a video of every test.\n// TeamFlow keeps it in step with the column; remove the column to stop.\n`;
  const body = (exporting) => `\nconst video = 'on';\n${exporting} {\n  ...base,\n  use: { ...base.use, video },\n`
    + '  ...(base.projects ? { projects: base.projects.map((project) => ({ ...project, use: { ...project.use, video } })) } : {}),\n};\n';
  if (commonJs(config, root)) {
    return `${head}const loaded = require('./${config}');\nconst base = loaded.default || loaded;\n${body('module.exports =')}`;
  }
  const from = config.endsWith('.ts') ? './playwright.config' : `./${config}`;
  return `${head}import base from '${from}';\n${body('export default')}`;
}

/** Write the video config when the column asks for one. Answers whether it is in place. */
export function writeWrapper(root) {
  const config = playwrightConfig(root);
  if (!config) return false;
  const file = path.join(root, wrapperName(config, root));
  const wanted = wrapperSource(config, root);
  if (fs.existsSync(file)) {
    const held = fs.readFileSync(file, 'utf8');
    if (!held.startsWith(WRAPPER_MARK)) return false;
    if (held === wanted) return true;
  }
  fs.writeFileSync(file, wanted);
  return true;
}

/** The repository root: the nearest directory at or above `cwd` holding `.git`. */
export function repoRoot(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  for (let depth = 0; depth < 32; depth += 1) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
  return undefined;
}

/**
 * `{name: command}` to add: each check gate of the pipeline that has a
 * preset and that the repository does not declare yet.
 */
export function missingPresets(pipeline, checks, root) {
  const out = {};
  for (const gate of Array.isArray(pipeline?.gates) ? pipeline.gates : []) {
    if (gate?.kind !== 'check') continue;
    const options = gate.options && typeof gate.options === 'object' ? gate.options : {};
    const command = presetCommand(gate.id, root, options);
    if (!command || checks[gate.id] === command) continue;
    // Missing, or one of this plugin's own that the column has moved on
    // from (video switched on or off). A command the repository chose
    // is never touched.
    if (checks[gate.id] && !ownCommands(gate.id, root).has(checks[gate.id])) continue;
    if (gate.id === 'playwright' && options.video === 'on-pass' && !writeWrapper(root)) continue;
    out[gate.id] = command;
  }
  return out;
}

/**
 * Add `additions` to `<root>/.teamflow/checks.json`, keeping every entry
 * already there that the repository chose and every key this plugin does
 * not read; an entry this plugin wrote itself may be brought up to date.
 * Answers the names written.
 */
export function writeChecks(root, additions) {
  const names = Object.keys(additions);
  if (!names.length) return [];
  const file = path.join(root, CHECKS_FILE);
  const held = readJson(file);
  if (fs.existsSync(file) && (!held || typeof held !== 'object' || Array.isArray(held))) return [];
  const next = { ...(held || {}) };
  const written = names.filter((name) => next[name] === undefined || ownCommands(name, root).has(next[name]));
  if (!written.length) return [];
  for (const name of written) next[name] = additions[name];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return written;
}

/**
 * The pipeline this repository's project draws (ADHOC-20), as
 * `GET /v1/members/pipeline?project=<id>` resolves it. Undefined when it
 * cannot be asked.
 */
export async function fetchPipeline(config, projectId, timeoutMs) {
  const { credential, serviceUrl } = await import('./core.mjs');
  const cred = await credential(config);
  if (!cred) return undefined;
  try {
    const query = projectId ? `?project=${encodeURIComponent(projectId)}` : '';
    const response = await fetch(`${serviceUrl(config)}/v1/members/pipeline${query}`, {
      headers: { [cred.header]: cred.value },
      redirect: 'error',
      signal: AbortSignal.timeout(Number(timeoutMs || config.serviceTimeoutMs || 5000)),
    });
    if (!response.ok) return undefined;
    const body = await response.json();
    return Array.isArray(body?.pipeline?.gates) ? body.pipeline : undefined;
  } catch {
    return undefined;
  }
}

const COLUMNS_FILE = 'check-columns.json';

/** The custom columns of a pipeline, as the agent is told about them: id, label, instructions, switches. */
export function checkColumns(pipeline) {
  return (Array.isArray(pipeline?.gates) ? pipeline.gates : [])
    .filter((gate) => gate?.kind === 'check' || gate?.kind === 'external')
    .map((gate) => ({
      id: String(gate.id), label: String(gate.label || gate.id),
      ...(gate.kind === 'external' ? { outside: gate.external?.system === 'sonarqube' ? 'SonarQube' : 'an outside tool' } : {}),
      ...(typeof gate.note === 'string' && gate.note.trim() ? { note: gate.note.trim().slice(0, 500) } : {}),
      ...(gate.options?.video === 'on-pass' ? { video: true } : {}),
      ...(gate.options?.attach ? { attach: true } : {}),
    }));
}

/**
 * What the coding agent is told at session start about this repository's
 * check columns: the command that counts, and the organisation's note in
 * its own words, quoted. Shown, never run. Empty when there is nothing to say.
 */
export function columnLines({ cwd, stampDir }) {
  try {
    const root = repoRoot(cwd);
    if (!root || !stampDir) return [];
    const columns = (readJson(path.join(stampDir, COLUMNS_FILE)) || {})[root] || [];
    const checks = parseChecks(readJson(path.join(root, CHECKS_FILE)));
    const lines = [];
    for (const column of columns) {
      const command = column.outside ? undefined : checks[column.id];
      if (!command && !column.note) continue;
      const parts = [`TeamFlow: the ${column.label} column`];
      if (column.outside) parts.push(` waits for a pass from ${column.outside}`);
      else if (command) parts.push(` passes when \`${command}\` passes`);
      if (column.video) parts.push(column.attach ? ', with a video attached to the ticket' : ', with a video recorded');
      parts.push('.');
      if (column.note) parts.push(` Your organisation's instructions for it: "${column.note.replace(/"/g, "'")}"`);
      lines.push(parts.join(''));
    }
    return lines.slice(0, 6);
  } catch {
    return [];
  }
}

/** Whether the cached Playwright step asks for the video on the ticket. */
export function attachWanted({ cwd, stampDir }) {
  try {
    const root = repoRoot(cwd);
    if (!root || !stampDir) return false;
    const columns = (readJson(path.join(stampDir, COLUMNS_FILE)) || {})[root] || [];
    return columns.some((column) => column.id === 'playwright' && column.video && column.attach);
  } catch {
    return false;
  }
}

function stampFile(dir) {
  return dir ? path.join(dir, 'check-presets.json') : undefined;
}

/**
 * Once every SYNC_EVERY_MS per repository: read the pipeline and write
 * any preset it is missing. Never throws. Answers the names written.
 */
export async function syncPresets({ cwd, config, projectId, stampDir, now = Date.now(), load = fetchPipeline }) {
  try {
    const root = repoRoot(cwd);
    if (!root) return [];
    const stamp = stampFile(stampDir);
    const stamps = (stamp && readJson(stamp)) || {};
    const last = Number(stamps[root]);
    if (Number.isFinite(last) && now - last < SYNC_EVERY_MS) return [];
    const pipeline = await load(config, projectId, 3000);
    if (!pipeline) return [];
    if (stamp) {
      try { fs.writeFileSync(stamp, JSON.stringify({ ...stamps, [root]: now })); } catch { /* no stamp, asks again next time */ }
    }
    if (stampDir) {
      try {
        const file = path.join(stampDir, COLUMNS_FILE);
        fs.writeFileSync(file, JSON.stringify({ ...(readJson(file) || {}), [root]: checkColumns(pipeline) }));
      } catch { /* the notes wait for the next sync */ }
    }
    const checks = parseChecks(readJson(path.join(root, CHECKS_FILE)));
    return writeChecks(root, missingPresets(pipeline, checks, root));
  } catch {
    return [];
  }
}
