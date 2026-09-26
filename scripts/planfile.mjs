// A plan as a file (MACLEOD-880): reviewable in a pull request, applied
// with `teamflow workflow apply <file>`, dry-run first.
//
// The file holds tracker keys, the links between them with a reason each,
// and the names of the checks the run expects. Nothing else. A plan file
// is data a person reviews, and a field that could hold a command would
// turn reviewing it into running it, so an unknown field is refused and
// never ignored.
//
//   name: Backlog sweep
//   keys:
//     - MACLEOD-538
//     - MACLEOD-540
//   edges:
//     - from: MACLEOD-540
//       on: MACLEOD-538
//       reason: needs the reporter field that release adds
//   gates: [lint, playwright]
//
// JSON with the same four fields works too. The YAML is a small strict
// subset, read here without a dependency (the plugin has none and runs on
// Node 18.17): a top-level mapping of scalars, block lists of scalars,
// block lists of one-level mappings, `[a, b]` lists of scalars, quoted or
// plain scalars and `#` comments. Anchors, multi-line strings, nesting
// deeper than that and tabs are refused with the line number, never
// guessed at.

import fs from 'node:fs';
import { CHECKS_FILE, PRESET_GATES, checkLabel, checkNameFor } from './checks.mjs';

const FIELDS = ['name', 'keys', 'edges', 'gates'];
const EDGE_FIELDS = ['from', 'on', 'reason'];
// A tracker key, an ad hoc key or a GitHub `owner/repo#12`. No spaces:
// a key with a space in it is a sentence, or a command.
const KEY = /^[A-Za-z0-9][A-Za-z0-9._/#-]{0,119}$/;
// A check name is a gate id, as in checks.mjs.
const GATE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const NAME_MAX = 80;
const REASON_MAX = 180;
const KEYS_MAX = 1000;
const EDGES_MAX = 2000;

class PlanError extends Error {}

function fail(text) {
  throw new PlanError(text);
}

// --- the YAML subset ----------------------------------------------------

/** The line without its comment. A `#` inside quotes, or glued to a word, stays. */
function uncomment(line) {
  let quote = '';
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function scalar(raw, at) {
  const text = raw.trim();
  if (text === '') return '';
  if (text.startsWith('"')) {
    try {
      const value = JSON.parse(text);
      if (typeof value === 'string') return value;
    } catch { /* refused below */ }
    fail(`Line ${at}: TeamFlow cannot read this quoted text.`);
  }
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(text)) fail(`Line ${at}: TeamFlow cannot read this quoted text.`);
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (/^[&*!|>%@`{]/.test(text)) {
    fail(`Line ${at}: a plan file uses plain YAML only. Remove the "${text[0]}" sign.`);
  }
  if (text === 'true') return true;
  if (text === 'false') return false;
  return text;
}

function flowList(raw, at) {
  const inner = raw.trim().slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  let quote = '';
  let start = 0;
  for (let i = 0; i <= inner.length; i += 1) {
    const c = inner[i];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === ',' || i === inner.length) {
      items.push(scalar(inner.slice(start, i), at));
      start = i + 1;
    }
  }
  return items;
}

function value(raw, at) {
  const text = raw.trim();
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) fail(`Line ${at}: a list in brackets must end on the same line.`);
    return flowList(text, at);
  }
  return scalar(text, at);
}

/** `key: value` or `key:`, or nothing. */
function pair(text, at) {
  const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(?:\s+(.*))?$/.exec(text);
  if (!m) return null;
  return { key: m[1], raw: m[2] ?? '', at };
}

/**
 * The subset, as a plain object. Every line is either read or refused
 * with its number; nothing is skipped silently.
 */
export function parseYaml(text) {
  const lines = String(text).split(/\r?\n/).map((line, i) => ({ at: i + 1, line }))
    .map(({ at, line }) => {
      if (/^ *\t/.test(line)) fail(`Line ${at}: use spaces, not tabs.`);
      return { at, line: uncomment(line).replace(/\s+$/, '') };
    })
    .filter(({ line }) => line.trim() !== '' && line.trim() !== '---');
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const { at, line } = lines[i];
    if (/^\s/.test(line)) fail(`Line ${at}: TeamFlow did not expect this line to be indented.`);
    const top = pair(line, at);
    if (!top) fail(`Line ${at}: TeamFlow expected "name: value" here.`);
    if (Object.prototype.hasOwnProperty.call(out, top.key)) fail(`Line ${at}: "${top.key}" is in the file twice.`);
    i += 1;
    if (top.raw.trim() !== '') {
      out[top.key] = value(top.raw, at);
      continue;
    }
    // A block list under it, or nothing.
    const list = [];
    let dash = -1;
    while (i < lines.length && /^\s/.test(lines[i].line)) {
      const row = lines[i];
      const indent = row.line.match(/^ */)[0].length;
      const body = row.line.slice(indent);
      if (!body.startsWith('- ') && body !== '-') {
        fail(`Line ${row.at}: TeamFlow expected a list item that starts with "- ".`);
      }
      if (dash < 0) dash = indent;
      if (indent !== dash) fail(`Line ${row.at}: this list item has a different indent from the one above it.`);
      const first = body.slice(1).trim();
      i += 1;
      const head = first.startsWith('"') || first.startsWith("'") ? null : pair(first, row.at);
      if (!head) {
        if (first === '') fail(`Line ${row.at}: this list item is empty.`);
        list.push(scalar(first, row.at));
        continue;
      }
      // A one-level mapping: its first field on the dash line, the rest
      // indented to line up with it.
      const item = {};
      item[head.key] = value(head.raw, row.at);
      const inner = indent + 2;
      while (i < lines.length) {
        const next = lines[i];
        const nextIndent = next.line.match(/^ */)[0].length;
        if (nextIndent <= dash) break;
        if (nextIndent !== inner) fail(`Line ${next.at}: line this field up with the one above it.`);
        const field = pair(next.line.slice(inner), next.at);
        if (!field || field.raw.trim() === '') fail(`Line ${next.at}: TeamFlow expected "name: value" here.`);
        if (Object.prototype.hasOwnProperty.call(item, field.key)) fail(`Line ${next.at}: "${field.key}" is in this item twice.`);
        item[field.key] = value(field.raw, next.at);
        i += 1;
      }
      list.push(item);
    }
    out[top.key] = list;
  }
  return out;
}

// --- the plan ---------------------------------------------------------

/**
 * The four fields, checked. Anything else in the file is refused by name,
 * because a plan file holds keys and reasons and never a command.
 */
export function planFrom(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('A plan file holds one set of fields: `name`, `keys`, `edges` and `gates`.');
  const extra = Object.keys(raw).filter((field) => !FIELDS.includes(field));
  if (extra.length) {
    fail(`A plan file holds \`name\`, \`keys\`, \`edges\` and \`gates\` only. Remove "${extra[0]}". A plan never holds a command.`);
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name) fail('The plan file needs a name.');
  if (name.length > NAME_MAX) fail(`A plan name has at most ${NAME_MAX} characters.`);

  const keysIn = raw.keys ?? [];
  if (!Array.isArray(keysIn)) fail('"keys" must be a list of ticket keys.');
  if (keysIn.length > KEYS_MAX) fail(`A plan holds at most ${KEYS_MAX} keys.`);
  const keys = [];
  keysIn.forEach((key, n) => {
    const clean = typeof key === 'string' ? key.trim() : String(key ?? '');
    if (!KEY.test(clean)) fail(`Key ${n + 1} ("${String(key).slice(0, 40)}") does not look like a ticket key.`);
    if (!keys.includes(clean)) keys.push(clean);
  });

  const edgesIn = raw.edges ?? [];
  if (!Array.isArray(edgesIn)) fail('"edges" must be a list of links.');
  if (edgesIn.length > EDGES_MAX) fail(`A plan holds at most ${EDGES_MAX} links.`);
  const edges = [];
  edgesIn.forEach((edge, n) => {
    const label = `Link ${n + 1}`;
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) fail(`${label} needs "from", "on" and "reason".`);
    const odd = Object.keys(edge).filter((field) => !EDGE_FIELDS.includes(field));
    if (odd.length) fail(`${label} holds "${odd[0]}". A link holds from, on and reason only.`);
    const from = String(edge.from ?? '').trim();
    const on = String(edge.on ?? '').trim();
    const reason = String(edge.reason ?? '').replace(/\s+/g, ' ').trim();
    if (!KEY.test(from) || !KEY.test(on)) fail(`${label} needs a ticket key in "from" and in "on".`);
    if (from === on) fail(`${label}: ${from} cannot wait on itself.`);
    if (!reason) fail(`${label} needs a reason. Say why ${from} waits on ${on}.`);
    if (reason.length > REASON_MAX) fail(`${label}: a reason has at most ${REASON_MAX} characters.`);
    const same = edges.find((e) => e.from === from && e.on === on);
    if (same) fail(`${label}: ${from} waits on ${on} twice in this file.`);
    edges.push({ from, on, reason });
  });

  const gatesIn = raw.gates ?? [];
  if (!Array.isArray(gatesIn)) fail('`gates` must be a list of check names.');
  const gates = [];
  for (const gate of gatesIn) {
    const clean = String(gate ?? '').trim();
    if (!GATE.test(clean)) fail(`"${clean.slice(0, 40)}" is not a check name. Use small letters, digits and hyphens.`);
    if (!gates.includes(clean)) gates.push(clean);
  }
  return { name, keys, edges, gates };
}

/** A plan from text: JSON when it looks like JSON, else the YAML subset. */
export function parsePlan(text, file = '') {
  const body = String(text ?? '');
  const json = /\.json$/i.test(file) || body.trimStart().startsWith('{');
  let raw;
  if (json) {
    try {
      raw = JSON.parse(body);
    } catch (error) {
      fail(`TeamFlow cannot read the JSON in ${file || 'the plan file'}: ${error.message}`);
    }
  } else {
    raw = parseYaml(body);
  }
  return planFrom(raw);
}

/** The plan in a file. A missing or unreadable file says which. */
export function readPlan(file) {
  if (!file) fail('Say which plan file to apply.');
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    fail(`TeamFlow cannot read ${file}.`);
  }
  return parsePlan(text, file);
}

// --- what applying it would change ----------------------------------------

/**
 * What the run lacks that the file lists, and what the run holds that the
 * file does not. Applying adds the first and leaves the second: a ticket
 * already in a run may be half built, and a file is no reason to drop it.
 * Empty `keys`, `edges` and `gates` mean applying changes nothing.
 */
export function planChanges(workflow = {}, plan) {
  const tickets = new Set((workflow.tickets || []).map((t) => t.key));
  const have = workflow.dependencies || [];
  const edges = [];
  for (const edge of plan.edges) {
    const now = have.find((d) => d.from === edge.from && d.on === edge.on);
    if (!now) edges.push({ ...edge, found: 'planning' });
    else if ((now.reason || '') !== edge.reason) edges.push({ ...edge, found: now.found || 'planning' });
  }
  const listed = new Set(plan.keys);
  const linked = new Set(plan.edges.map((e) => `${e.from}\u0000${e.on}`));
  return {
    keys: plan.keys.filter((key) => !tickets.has(key)),
    edges,
    gates: plan.gates.filter((gate) => !(workflow.gates || []).includes(gate)),
    unlistedKeys: [...tickets].filter((key) => !listed.has(key)),
    unlistedEdges: have.filter((d) => !linked.has(`${d.from}\u0000${d.on}`)).length,
  };
}

export function changesNothing(changes) {
  return !changes.keys.length && !changes.edges.length && !changes.gates.length;
}

/** What the run holds beyond the file, in one line, or nothing. */
export function unlistedLine(changes) {
  const keys = changes.unlistedKeys.length;
  const links = changes.unlistedEdges;
  if (!keys && !links) return '';
  const parts = [];
  if (keys) parts.push(`${keys} ticket${keys === 1 ? '' : 's'}`);
  if (links) parts.push(`${links} link${links === 1 ? '' : 's'}`);
  return `The run also holds ${parts.join(' and ')} that the file does not list. TeamFlow kept them.`;
}

// --- the dry run --------------------------------------------------------

/**
 * What a run would do, before anything is sent: its phases, which check
 * each of this repository's commands counts as, and how many times a
 * check is tried. Pure; the caller prints it and writes nothing.
 */
export function dryRunLines(workflow, { checks = {}, gates = [], policy = { attempts: 3, reworkCap: 16 } } = {}) {
  const lines = [];
  const phases = workflow.phases || [];
  const edges = workflow.dependencies || [];
  if (!phases.length) lines.push(`"${workflow.name}" has no tickets yet.`);
  else lines.push(`"${workflow.name}" would run in ${phases.length} phase${phases.length === 1 ? '' : 's'}:`);
  for (const phase of phases) {
    if (phase.state === 'blocked') {
      lines.push(`  Phase ${phase.n} cannot start. These tickets wait on each other: ${phase.tickets.join(', ')}.`);
      continue;
    }
    lines.push(`  Phase ${phase.n}: ${phase.tickets.join(', ')}`);
    for (const key of phase.tickets) {
      for (const edge of edges.filter((e) => e.from === key)) {
        lines.push(`    ${key} waits on ${edge.on}${edge.reason ? `: ${edge.reason}` : '.'}`);
      }
    }
  }

  lines.push('Checks:');
  lines.push('  A test run counts as the test check. An audit counts as the audit check.');
  for (const [name, command] of Object.entries(checks)) {
    const gate = checkNameFor(command, checks);
    if (gate) lines.push(`  \`${command}\` counts as the ${checkLabel(gate)} check.`);
  }
  for (const gate of gates) {
    if (checks[gate]) continue;
    lines.push(PRESET_GATES.has(gate)
      ? `  ${checkLabel(gate)}: not set up yet. TeamFlow sets it up in this repository.`
      : `  ${checkLabel(gate)}: this repository has no command for it. Add "${gate}" to ${CHECKS_FILE}.`);
  }
  lines.push(`Retries: TeamFlow tries a check up to ${policy.attempts} times. `
    + `After ${policy.reworkCap} rounds of rework on one ticket, it stops and tells you.`);
  lines.push('This was a dry run. TeamFlow changed nothing and sent nothing.');
  return lines;
}

export { PlanError };
