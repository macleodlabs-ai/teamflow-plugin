/**
 * The machine's map of its CI (MACLEOD-792): what the runner does, part
 * by part, read where the code is.
 *
 * The owner: "this is where the plugin + claude llm can help — for
 * extracting what code the github runner etc runs, or what sonarqube tests
 * are". The service sees a CI run's job and step NAMES; only the machine
 * can read the workflow files and the scripts they call.
 *
 *   teamflow gates learn [--json]   code first: reads .github/workflows/*.yml
 *                                   (jobs, steps, the head of each `run:`,
 *                                   each `uses:`), the package.json scripts
 *                                   and Makefile targets those steps call,
 *                                   tox and nox environments and
 *                                   sonar-project.properties, and drafts a map.
 *   teamflow gates map --file <f>   checks a map against the strict shape
 *                                   below and the plain-words rule, and sends it.
 *
 * Between the two, the session's own Claude explains the fuzzy parts
 * (`gatemapLines`: one hook notice, only when this repository has no map
 * or its CI files changed): what `make ci` or `npm run verify` really run,
 * which part is which, and the quality gate's conditions.
 *
 * What leaves the machine is the map alone:
 *   {repo, gates: [{gate, parts: [{kind, label, matches: [name globs]}]}],
 *    quality: [{condition, threshold}], sourceHash}
 * Names, kinds, order and thresholds. Never a script, a command's
 * arguments, code or a log (docs/REPORTING_CONTRACT.md). `learn`'s facts
 * (command heads, script names) stay on this machine.
 *
 * `draftKind` answers tests/fixtures/step-kind-vectors.json exactly as the
 * service's rules do (adapters/teamflow/deciders/rules.py::step_kind).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { check as wordsCheck } from './words.mjs';

export const KINDS = ['build', 'lint', 'test', 'security_scan', 'deploy', 'other'];
export const LABELS = {
  build: 'Build', lint: 'Lint', test: 'Tests', security_scan: 'Security scan', deploy: 'Deploy', other: 'Other',
};
export const LIMITS = { gates: 6, parts: 12, matches: 20, quality: 20, label: 40, match: 120, condition: 80, threshold: 20 };
export const STAMP_FILE = 'gatemap.json';
export const ASK_EVERY_MS = 24 * 60 * 60 * 1000;

// --------------------------------------------------------- the rules

const STEP_TOOLS = [
  ['security_scan', /\b(trivy|snyk|codeql|sonar\w*|semgrep|gitleaks|bandit|grype|dependency[- ]review|npm audit|pip-audit|osv-scanner)\b/],
  ['deploy', /\b(sam deploy|cdk deploy|terraform apply|serverless deploy|kubectl apply|helm (upgrade|install)|vercel|netlify deploy|mcpkit deploy|fly deploy)\b/],
  ['lint', /\b(eslint|ruff|flake8|pylint|prettier|stylelint|golangci-lint|rubocop|shellcheck|hadolint|markdownlint|black --check|mypy)\b/],
  ['test', /\b(pytest|vitest|jest|mocha|go test|cargo test|playwright|cypress|rspec|phpunit|tox|nox|npm test|node --test|unittest)\b/],
  ['build', /\b(tsc|webpack|vite build|esbuild|rollup|gradle|mvn|cargo build|go build|docker build|sam build|make build|npm run build|mcpkit gen)\b/],
];
const STEP_WORDS = [
  ['security_scan', /\b(security|scan|vulnerabilit\w*|sast|secrets?)\b/],
  ['deploy', /\b(deploy\w*|release|publish)\b/],
  ['lint', /\b(lint\w*|format\w*|style|typecheck\w*)\b/],
  ['test', /\b(tests?|testing|e2e|spec|specs|coverage|verify)\b/],
  ['build', /\b(build\w*|compil\w*|bundle|package)\b/],
];
const STEP_SETUP = /\b(set ?up|checkout|cache|install|complete job|post |upload-artifact|download-artifact|login|configure|npm ci)\b/;

const norm = (text) => String(text ?? '').toLowerCase().split(/\s+/).filter(Boolean).join(' ');

/** build | lint | test | security_scan | deploy | other, from names alone. */
export function draftKind(step, job = '', command = '') {
  const text = `${norm(command)} ${norm(step)}`;
  const jobName = norm(job);
  for (const [kind, pattern] of STEP_TOOLS) if (pattern.test(text)) return kind;
  if (STEP_SETUP.test(text) && !STEP_WORDS.some(([, p]) => p.test(text))) return 'other';
  for (const [kind, pattern] of STEP_WORDS) if (pattern.test(text)) return kind;
  if (jobName) for (const [kind, pattern] of [...STEP_TOOLS, ...STEP_WORDS]) if (pattern.test(jobName)) return kind;
  return 'other';
}

// ------------------------------------------------------ the CI files

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; }
}

/** The files the map is made from, relative to the root, sorted. */
export function ciFiles(root) {
  const out = [];
  const flows = path.join(root, '.github', 'workflows');
  try {
    for (const name of fs.readdirSync(flows)) {
      if (/\.ya?ml$/.test(name)) out.push(path.posix.join('.github', 'workflows', name));
    }
  } catch { /* no workflows */ }
  for (const name of ['package.json', 'Makefile', 'tox.ini', 'noxfile.py', 'sonar-project.properties']) {
    if (fs.existsSync(path.join(root, name))) out.push(name);
  }
  return out.sort();
}

/** A digest of the CI files: 16 hex. Changes when any of them does. */
export function sourceHash(root, files = ciFiles(root)) {
  const hash = crypto.createHash('sha256');
  for (const rel of files) {
    hash.update(rel).update('\0').update(readText(path.join(root, rel)) ?? '').update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

// ---------------------------------------------- a workflow, by indent

const indentOf = (line) => line.length - line.trimStart().length;
const unquote = (value) => String(value ?? '').trim().replace(/^(['"])(.*)\1$/, '$2');

function keyValue(text) {
  const m = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/.exec(text);
  return m ? [m[1], m[2] === undefined ? '' : m[2].replace(/\s+#.*$/, '')] : undefined;
}

/**
 * `{name, jobs: [{id, name, matrix, steps: [{name, run, uses}]}]}` from one
 * workflow file, by indentation alone. Only what the map needs: a job's id,
 * its `name`, whether it has a `matrix`, and each step's `name`, `uses` and
 * the first line of its `run` (a block scalar's first line too). Nested
 * blocks (`with:`, `env:`) are passed over.
 */
export function parseWorkflow(text) {
  const out = { name: '', jobs: [] };
  let inJobs = false;
  let jobIndent = -1;   // indent of a job id
  let job;
  let stepsIndent = -1; // indent of the job's `steps:` key
  let itemIndent = -1;  // indent of a step's `- `
  let step;
  let block;            // a `run: |` being read: { indent }
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = indentOf(raw);
    const line = raw.trim();
    if (block) {
      if (indent > block.indent) {
        if (!step.run) step.run = line;
        continue;
      }
      block = undefined;
    }
    if (indent === 0) {
      const kv = keyValue(line);
      inJobs = kv?.[0] === 'jobs';
      if (kv?.[0] === 'name') out.name = unquote(kv[1]);
      job = undefined;
      continue;
    }
    if (!inJobs) continue;
    if (jobIndent < 0) jobIndent = indent;
    if (indent === jobIndent) {
      const kv = keyValue(line);
      job = kv ? { id: kv[0], name: '', matrix: false, steps: [] } : undefined;
      if (job) out.jobs.push(job);
      stepsIndent = -1;
      itemIndent = -1;
      step = undefined;
      continue;
    }
    if (!job || indent < jobIndent) continue;
    // Inside the steps list: a new step, a key of this step, or a block
    // nested under one of its keys.
    if (stepsIndent >= 0 && indent >= stepsIndent) {
      const item = line.startsWith('- ') || line === '-';
      if (item && (itemIndent < 0 || indent === itemIndent)) {
        itemIndent = indent;
        step = { name: '', run: '', uses: '' };
        job.steps.push(step);
        block = stepKey(step, line.slice(1).trim(), indent + 2);
        continue;
      }
      if (step && indent === itemIndent + 2) {
        block = stepKey(step, line, indent);
        continue;
      }
      if (indent > stepsIndent) continue;
    }
    // A key of the job itself.
    const kv = keyValue(line);
    if (!kv) continue;
    if (indent <= stepsIndent) {
      stepsIndent = -1;
      itemIndent = -1;
      step = undefined;
    }
    if (kv[0] === 'steps') {
      stepsIndent = indent;
      itemIndent = -1;
      continue;
    }
    if (kv[0] === 'matrix') job.matrix = true;
    if (kv[0] === 'name' && !job.name && indent <= jobIndent + 4) job.name = unquote(kv[1]);
  }
  return out;
}

/** One `key: value` of a step. Answers the block to read for `run: |`. */
function stepKey(step, text, indent) {
  const kv = keyValue(text);
  if (!kv) return undefined;
  const [key, value] = kv;
  if (key === 'name') step.name = unquote(value);
  else if (key === 'uses') step.uses = unquote(value);
  else if (key === 'run') {
    if (/^[|>][-+]?$/.test(value.trim())) return { indent };
    step.run = unquote(value);
  }
  return undefined;
}

/**
 * The head of a command: the tool and, when it is a plain word, what it
 * is asked to do. `npm run verify`, `make ci`, `npx vitest`, `pytest`.
 * Never its arguments.
 */
export function commandHead(run) {
  const first = String(run ?? '').split(/&&|;|\|\|/)[0].trim();
  const words = first.split(/\s+/).filter(Boolean)
    .filter((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w)); // a leading VAR=value
  if (!words.length) return '';
  const plain = (w) => w && /^[A-Za-z0-9][A-Za-z0-9:._-]*$/.test(w);
  const tool = path.posix.basename(words[0]);
  if (!plain(tool)) return '';
  if (['npm', 'yarn', 'pnpm', 'bun'].includes(tool) && words[1] === 'run' && plain(words[2])) return `${tool} run ${words[2]}`;
  if (tool === 'python' || tool === 'python3') return words[1] === '-m' && plain(words[2]) ? `${tool} -m ${words[2]}` : tool;
  if (['npm', 'yarn', 'pnpm', 'bun', 'npx', 'make', 'go', 'cargo', 'docker', 'sam', 'cdk', 'terraform', 'tox', 'nox', 'node', 'vite', 'vitest', 'playwright'].includes(tool)
    && plain(words[1]) && !words[1].startsWith('-')) return `${tool} ${words[1]}`;
  return tool;
}

/** What GitHub calls a step: its name, else "Run <first line>". */
export function stepName(step) {
  if (step.name) return step.name;
  const said = step.run || step.uses;
  return said ? `Run ${said}`.slice(0, 120) : '';
}

// ------------------------------------------------ what the steps call

function packageScripts(root) {
  try {
    const scripts = JSON.parse(readText(path.join(root, 'package.json')) ?? '{}').scripts;
    return scripts && typeof scripts === 'object' ? scripts : {};
  } catch { return {}; }
}

function makeTargets(root) {
  const text = readText(path.join(root, 'Makefile'));
  if (!text) return {};
  const out = {};
  let target;
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z0-9_.-]+)\s*:(?!=)\s*(.*)$/.exec(line);
    if (m) { target = m[1]; out[target] = { deps: m[2].split(/\s+/).filter((d) => /^[A-Za-z0-9_.-]+$/.test(d)), calls: [] }; continue; }
    if (target && line.startsWith('\t')) {
      const head = commandHead(line.trim().replace(/^[@-]+/, ''));
      if (head && !out[target].calls.includes(head)) out[target].calls.push(head);
    } else if (line.trim()) target = undefined;
  }
  return out;
}

function toxEnvs(root) {
  const text = readText(path.join(root, 'tox.ini'));
  if (!text) return [];
  const envs = new Set();
  for (const m of text.matchAll(/^\[testenv:([A-Za-z0-9_.-]+)\]/gm)) envs.add(m[1]);
  const list = /^envlist\s*=\s*(.+)$/m.exec(text);
  if (list) for (const env of list[1].split(/[\s,]+/)) if (/^[A-Za-z0-9_.-]+$/.test(env)) envs.add(env);
  return [...envs];
}

function noxSessions(root) {
  const text = readText(path.join(root, 'noxfile.py'));
  if (!text) return [];
  return [...text.matchAll(/@nox\.session[^\n]*\n\s*def\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]);
}

/** Which SonarQube settings the repository has: keys, and the two that say
 * how the quality gate is waited on. Never a token, a host or a project key. */
function sonarSettings(root) {
  const text = readText(path.join(root, 'sonar-project.properties'));
  if (text === undefined) return undefined;
  const keys = [];
  const wait = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(sonar\.[A-Za-z0-9._-]+)\s*[=:]\s*(.*)$/.exec(line);
    if (!m || /token|login|password|host|projectKey|organization/i.test(m[1])) continue;
    keys.push(m[1]);
    if (m[1] === 'sonar.qualitygate.wait') wait.wait = /^true$/i.test(m[2].trim());
    if (m[1] === 'sonar.qualitygate.timeout' && /^\d+$/.test(m[2].trim())) wait.timeout = Number(m[2].trim());
  }
  return { keys: keys.slice(0, 30), ...wait };
}

function scriptCalls(command) {
  return String(command ?? '').split(/&&|;|\|\|/).map((part) => commandHead(part.trim())).filter(Boolean).slice(0, 8);
}

// ---------------------------------------------------------- learn

const globEscape = (text) => text.replace(/[*?[\]]/g, (c) => `[${c}]`);

/**
 * Everything the code can say, and a draft map from it. `facts` stays on
 * the machine; `draft` is what `gates map` would send once checked.
 */
export function learn(root, repo) {
  const files = ciFiles(root);
  const scripts = packageScripts(root);
  const make = makeTargets(root);
  const workflows = [];
  const usedScripts = {};
  const usedTargets = {};
  for (const rel of files.filter((f) => f.startsWith('.github/'))) {
    const flow = parseWorkflow(readText(path.join(root, rel)));
    workflows.push({
      file: rel,
      name: flow.name,
      jobs: flow.jobs.map((job) => ({
        id: job.id,
        name: job.name || job.id,
        matrix: job.matrix,
        steps: job.steps.map((step) => {
          const head = commandHead(step.run);
          const script = /^(?:npm|yarn|pnpm|bun) run (\S+)$/.exec(head)?.[1] || (head === 'npm test' ? 'test' : undefined);
          if (script && scripts[script]) usedScripts[script] = scriptCalls(scripts[script]);
          const target = /^make (\S+)$/.exec(head)?.[1];
          if (target && make[target]) usedTargets[target] = make[target];
          const name = stepName(step);
          return { name, head, uses: step.uses ? step.uses.split('@')[0] : '', kind: draftKind(name, job.name || job.id, head) };
        }),
      })),
    });
  }
  const order = [];
  const matches = {};
  for (const flow of workflows) {
    for (const job of flow.jobs) {
      const kinds = job.steps.filter((s) => s.kind !== 'other');
      const units = kinds.length ? kinds : [{ name: job.name, kind: draftKind('', job.name) }].filter((u) => u.kind !== 'other');
      for (const unit of units) {
        if (!order.includes(unit.kind)) order.push(unit.kind);
        const pattern = job.matrix && !unit.name ? `${globEscape(job.name)}*` : globEscape(unit.name);
        (matches[unit.kind] ||= []).includes(pattern) || matches[unit.kind].push(pattern);
      }
    }
  }
  const hash = sourceHash(root, files);
  const draft = {
    repo,
    gates: order.length ? [{ gate: 'ci', parts: order.map((kind) => ({ kind, label: LABELS[kind], matches: matches[kind].slice(0, LIMITS.matches) })) }] : [],
    quality: [],
    sourceHash: hash,
  };
  return {
    facts: {
      files, workflows, scripts: usedScripts, make: usedTargets,
      tox: toxEnvs(root), nox: noxSessions(root), sonar: sonarSettings(root),
    },
    draft,
  };
}

// ---------------------------------------------------------- the shape

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const GATE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const HASH = /^[0-9a-f]{16}$/;
const oneLine = (value, max) => typeof value === 'string' && value.length >= 1 && value.length <= max && !/[\r\n\t\0]/.test(value);

function onlyKeys(obj, keys, where, problems) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { problems.push(`${where} must be an object.`); return false; }
  for (const key of Object.keys(obj)) if (!keys.includes(key)) problems.push(`${where} has a field TeamFlow does not take: ${key}.`);
  return true;
}

/** The problems with a map, in plain words. Empty when it may be sent. */
export function validateMap(map) {
  const problems = [];
  if (!onlyKeys(map, ['repo', 'gates', 'quality', 'sourceHash'], 'The map', problems)) return problems;
  if (!REPO.test(String(map.repo ?? ''))) problems.push('The repository must be owner/name.');
  if (!HASH.test(String(map.sourceHash ?? ''))) problems.push('The sourceHash must be the 16 characters `teamflow gates learn` gave.');
  if (!Array.isArray(map.gates) || map.gates.length < 1 || map.gates.length > LIMITS.gates) {
    problems.push(`The map needs 1 to ${LIMITS.gates} columns.`);
  } else {
    map.gates.forEach((gate, g) => {
      const where = `Column ${g + 1}`;
      if (!onlyKeys(gate, ['gate', 'parts'], where, problems)) return;
      if (!GATE.test(String(gate.gate ?? ''))) problems.push(`${where} needs a column id in lower case, such as ci.`);
      if (!Array.isArray(gate.parts) || gate.parts.length < 1 || gate.parts.length > LIMITS.parts) {
        problems.push(`${where} needs 1 to ${LIMITS.parts} parts.`);
        return;
      }
      gate.parts.forEach((part, p) => {
        const at = `${where}, part ${p + 1}`;
        if (!onlyKeys(part, ['kind', 'label', 'matches'], at, problems)) return;
        if (!KINDS.includes(part.kind)) problems.push(`${at} has a kind TeamFlow does not know: ${String(part.kind)}.`);
        if (!oneLine(part.label, LIMITS.label)) problems.push(`${at} needs a label of at most ${LIMITS.label} characters.`);
        else if (wordsCheck(part.label).length) problems.push(`${at}: "${part.label}" is not plain words.`);
        if (!Array.isArray(part.matches) || part.matches.length < 1 || part.matches.length > LIMITS.matches
          || !part.matches.every((m) => oneLine(m, LIMITS.match))) {
          problems.push(`${at} needs 1 to ${LIMITS.matches} step or job names, each on one line.`);
        }
      });
    });
  }
  if (map.quality !== undefined) {
    if (!Array.isArray(map.quality) || map.quality.length > LIMITS.quality) problems.push(`quality holds at most ${LIMITS.quality} conditions.`);
    else map.quality.forEach((row, i) => {
      const at = `Condition ${i + 1}`;
      if (!onlyKeys(row, ['condition', 'threshold'], at, problems)) return;
      if (!oneLine(row.condition, LIMITS.condition)) problems.push(`${at} needs words of at most ${LIMITS.condition} characters.`);
      if (!oneLine(String(row.threshold ?? ''), LIMITS.threshold)) problems.push(`${at} needs a threshold of at most ${LIMITS.threshold} characters.`);
    });
  }
  return problems;
}

// ------------------------------------------------ the hook's notice

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

function writeStamp(stampDir, root, entry) {
  try {
    const file = path.join(stampDir, STAMP_FILE);
    const stamps = readJson(file) || {};
    fs.writeFileSync(file, JSON.stringify({ ...stamps, [root]: { ...(stamps[root] || {}), ...entry } }));
  } catch { /* asked again next time */ }
}

/**
 * The one notice that asks the session's Claude for a map: only when the
 * repository has CI files and no map was sent for them as they are now,
 * and at most once a day for the same files. Never throws.
 */
export function gatemapLines({ cwd, stampDir, now = Date.now(), rootOf }) {
  try {
    const root = rootOf ? rootOf(cwd) : undefined;
    if (!root || !stampDir) return [];
    const files = ciFiles(root);
    if (!files.some((f) => f.startsWith('.github/'))) return [];
    const hash = sourceHash(root, files);
    const held = (readJson(path.join(stampDir, STAMP_FILE)) || {})[root] || {};
    if (held.sent === hash) return [];
    if (held.asked === hash && now - Number(held.askedAt || 0) < ASK_EVERY_MS) return [];
    writeStamp(stampDir, root, { asked: hash, askedAt: now });
    return [
      'TeamFlow: this repository has no current map of its CI. When you have a moment, run `teamflow gates learn --json`.',
      'Check the kind of each part and give it a short plain label. Say what scripts such as `npm run verify` or `make ci` run. '
      + 'Save the map as JSON and run `teamflow gates map --file <path>`. Send names, kinds and order only, never code or logs.',
    ];
  } catch {
    return [];
  }
}

// ------------------------------------------------------------ the CLI

export const USAGE = `teamflow gates learn [--json]      read this repository's CI files and draft a map of its parts
teamflow gates map --file <path>   check a map and send it to TeamFlow`;

export async function main(args = [], ctx = {}) {
  const print = ctx.print || ((line) => process.stdout.write(`${line}\n`));
  const fail = ctx.fail || ((line) => process.stderr.write(`${line}\n`));
  const core = ctx.core || await import('./core.mjs');
  const cwd = ctx.cwd || process.cwd();
  const root = core.repositoryRoot(cwd);
  if (!root) { fail('Run this inside a git repository.'); return 2; }
  const repo = (ctx.info || core.gitInfo)(cwd)?.repository || '';
  const [sub, ...rest] = args;
  if (sub === 'learn') {
    const { facts, draft } = learn(root, repo);
    if (rest.includes('--json')) { print(JSON.stringify({ draft, facts }, null, 2)); return 0; }
    if (!draft.gates.length) { print('TeamFlow found no CI steps it can name in this repository.'); return 0; }
    print(`TeamFlow read ${facts.files.length} CI files. The runner does these parts, in this order:`);
    for (const part of draft.gates[0].parts) print(`- ${part.label}: ${part.matches.length} steps`);
    print('Run `teamflow gates learn --json` to see the draft, then send it with `teamflow gates map --file <path>`.');
    return 0;
  }
  if (sub === 'map') {
    const at = rest.indexOf('--file');
    const file = at >= 0 ? rest[at + 1] : undefined;
    if (!file) { fail(USAGE); return 2; }
    let map;
    try { map = JSON.parse(fs.readFileSync(path.resolve(cwd, file), 'utf8')); } catch { fail('TeamFlow could not read that file as JSON.'); return 2; }
    if (map && typeof map === 'object' && map.draft && !map.gates) map = map.draft;
    const problems = validateMap(map);
    if (problems.length) { for (const line of problems) fail(line); return 2; }
    if (repo && map.repo !== repo) { fail(`The map is for ${map.repo}, but this repository is ${repo}.`); return 2; }
    if (map.sourceHash !== sourceHash(root)) { fail('The CI files changed after you made this map. Run `teamflow gates learn` again.'); return 2; }
    const sent = await (ctx.send || core.sendGateMap)(map, ctx.config || {});
    if (!sent?.ok) { fail(`TeamFlow could not send the map: ${sent?.reason || 'the service did not answer'}.`); return 1; }
    writeStamp(ctx.stampDir || core.dataDir(), root, { sent: map.sourceHash, sentAt: ctx.now || Date.now() });
    print(`TeamFlow has the map of ${map.repo}. The next CI run is sorted by it.`);
    return 0;
  }
  fail(USAGE);
  return 2;
}
