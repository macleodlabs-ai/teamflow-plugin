// A repository's own checks, and the custom gates a card still has to pass
// (MACLEOD-639, ADHOC-20).
//
// An organisation on Growth or above adds a column to its pipeline: a
// check each card must pass between two columns, a linter say. The
// organisation names the check and its place. The COMMAND is the
// repository's, declared in its own `.teamflow/checks.json`:
//
//   { "lint": "npm run lint", "typecheck": "npx tsc -b" }
//
// and never the service's. Nothing here runs a command, and nothing here
// has the means to: this module imports no process API. What it does is
// classify. When somebody -- a developer or an agent -- runs exactly one
// of those commands, `classifyTool` (core.mjs) reads the run as that
// check's pass or fail, and the hook reports it as a runtime sidecar in
// the slot `check-<name>`, the way a test run is reported. The service
// then draws it at the place the organisation chose.
//
// Exactly: the command as the repository wrote it, whitespace trimmed and
// runs of spaces folded, and nothing else. `npm run lint -- --fix` is not
// `npm run lint`, so a run that changed what the check does is not
// reported as the check passing.
//
// Only the check NAMES leave the machine (`checks` on the issue report),
// so a card can say "Not set up in this repository" for a check the
// organisation added and this repository never declared. The commands
// never do.

import fs from 'node:fs';
import path from 'node:path';

export const CHECKS_FILE = path.join('.teamflow', 'checks.json');
// A check name is a gate id: lower case, digits and hyphens (`is_gate_id`).
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const COMMAND_MAX = 200;
export const CHECKS_MAX = 16;
// Names a connector owns; a repository may not claim one.
const RESERVED = new Set(['tracker', 'pr', 'sonarqube', 'hygiene']);
// Checks the plugin writes into checks.json itself (check-presets.mjs).
export const PRESET_GATES = new Set(['lint', 'playwright']);

function fold(command) {
  return String(command ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * The repository's checks, `{name: command}`, from the nearest
 * `.teamflow/checks.json` at or above `cwd`, stopping at the repository's
 * root (the first directory holding `.git`). File reads only: this runs
 * inside every config load, where a spawned `git` would cost every hook.
 * Anything malformed is left out, never guessed at.
 */
export function readChecks(cwd) {
  let dir = path.resolve(cwd || process.cwd());
  for (let depth = 0; depth < 32; depth += 1) {
    const file = path.join(dir, CHECKS_FILE);
    if (fs.existsSync(file)) return parseChecks(safeRead(file));
    if (fs.existsSync(path.join(dir, '.git'))) return {};
    const up = path.dirname(dir);
    if (up === dir) return {};
    dir = up;
  }
  return {};
}

function safeRead(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/** `{name: command}` with only well-formed entries, at most CHECKS_MAX. */
export function parseChecks(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, command] of Object.entries(raw)) {
    if (Object.keys(out).length >= CHECKS_MAX) break;
    if (!NAME.test(name) || RESERVED.has(name)) continue;
    const folded = fold(command);
    if (!folded || folded.length > COMMAND_MAX || /[\r\n]/.test(String(command))) continue;
    out[name] = folded;
  }
  return out;
}

/** The check a command IS, exactly, or undefined. */
export function checkNameFor(command, checks = {}) {
  const ran = fold(command);
  if (!ran) return undefined;
  for (const [name, declared] of Object.entries(checks || {})) {
    if (declared === ran) return name;
  }
  return undefined;
}

/** The names, for the issue report. Never the commands. */
export function checkNames(checks = {}) {
  return Object.keys(checks || {}).filter((name) => NAME.test(name)).slice(0, CHECKS_MAX);
}

/** A plain label: `lint` -> `Lint`, `type-check` -> `Type check`. */
export function checkLabel(name) {
  const words = String(name).replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * One check verdict as a runtime report: slot `check-<name>`, `gate`
 * the name, kind `test`. The stage is a placeholder the service
 * replaces with the stage of the gate the organisation placed the check
 * after; the plugin does not know the pipeline and must not guess it.
 * No command, no output: the summary is the plugin's own sentence.
 */
export function checkPayload(key, name, passed, { now = new Date().toISOString(), evidence = [] } = {}) {
  const label = checkLabel(name);
  return {
    jiraKey: key,
    slot: `check-${name}`,
    id: `check-${name}-${key}`.slice(0, 120),
    kind: 'test',
    label,
    stage: 'LOCAL_TEST',
    status: passed ? 'success' : 'failed',
    summary: passed ? `${label} passed` : `${label} failed`,
    gate: name,
    startedAt: now,
    endedAt: now,
    updatedAt: now,
    ...(evidence.length ? { evidence: evidence.slice(0, 4) } : {}),
    // Its failure point (ADHOC-19): one per check, raised by a failure and
    // checked off by the next pass. The service applies the same rule
    // points.mjs does (`points.on_runtime`), with the slot as the runner,
    // so a check's run judges only its own point.
    ...(passed ? {} : { failedSteps: [`${label} check`] }),
  };
}

/**
 * The custom gates a card still has to pass, in plain words, for
 * `teamflow status`, `teamflow gates` and the build skill (ADHOC-20).
 * `pipeline` is what the service resolved for this repository's
 * project; `stage` is where the card is. A gate before the card's
 * column is behind it and is not listed.
 */
export function gateLines(pipeline, checks = {}, stage = 'BACKLOG') {
  const gates = Array.isArray(pipeline?.gates) ? pipeline.gates : [];
  const here = gates.findIndex((gate) => Array.isArray(gate.stages) && gate.stages.includes(stage));
  const lines = [];
  gates.forEach((gate, index) => {
    if (index <= here || (gate.kind !== 'check' && gate.kind !== 'external')) return;
    const before = [...gates.slice(0, index)].reverse().find((g) => g.stages?.length)?.label || 'the start';
    const after = gates.slice(index + 1).find((g) => g.stages?.length)?.label;
    const place = after ? `between ${before} and ${after}` : `after ${before}`;
    const note = typeof gate.note === 'string' && gate.note.trim()
      ? ` Your organisation's instructions: "${gate.note.trim().slice(0, 500).replace(/"/g, "'")}"` : '';
    if (gate.kind === 'check') {
      lines.push((checks[gate.id]
        ? `${gate.label}: this repository's "${gate.id}" check must pass, ${place}.`
        : PRESET_GATES.has(gate.id)
          ? `${gate.label}: not set up yet. TeamFlow sets it up in this repository. It does not stop the card.`
          : `${gate.label}: not set up in this repository. Add "${gate.id}" to ${CHECKS_FILE}. It does not stop the card.`) + note);
    } else {
      const tool = gate.external?.system === 'sonarqube' ? 'SonarQube' : 'an outside tool';
      lines.push(`${gate.label}: TeamFlow asks ${tool} for a pass, ${place}.${note}`);
    }
  });
  return lines;
}
