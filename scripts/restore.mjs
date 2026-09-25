// Bring back runs this machine lost (MACLEOD-794).
//
// On 2026-09-24 removing a stray marketplace uninstalled the plugin, and
// Claude Code deleted its data folder with workflows.json in it. The run
// "website-refactor" (27 nodes) was still on the board, but this machine
// could no longer name it. Hygiene is the tool's job: a lost local file
// must not lose a run.
//
// Read-only against the service: one read of the board, one of this
// machine's inventory. Nothing received is passed to a shell; a run comes
// back through `published`, the same filter that decides what leaves.
//
// Whose run is it? The service keeps two answers and no more:
//   - `inventories/<machine>--<repo>.json`: the open and lately finished
//     run ids this machine reported for this repository. Proof of this
//     machine, but each pass replaces it, so it is often already empty.
//   - the run's `actor.id`: who started it. The workflow document names
//     no machine, on purpose (docs/REPORTING_CONTRACT.md), so a person on
//     two computers matches on both.
// Anything else comes back only when it is named.
import * as core from './core.mjs';
import { hashOf, repositoryName } from './inventory.mjs';
import { ID, published, stated } from './workflow.mjs';

const FINISHED = new Set(['done', 'cancelled', 'archived']);

/** One line of a name that came from the service: no control characters. */
function clean(value, max = 80) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, max);
}

/**
 * Which runs on the board come back, and which stay, with why.
 * Pure: the board's runs, this machine's runs and who this is are passed in.
 *
 * `wanted` is an id or a name. Named, a run comes back whoever started it,
 * but never over a copy already here.
 */
export function restorePlan(board, local, { wanted, machineRuns = new Set(), ownerId } = {}) {
  const restore = [];
  const skipped = [];
  const runs = Object.entries(board || {})
    .filter(([id, doc]) => ID.test(id) && doc && typeof doc === 'object' && doc.id === id)
    .map(([, doc]) => doc)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const want = wanted === undefined ? undefined : String(wanted).trim().toLowerCase();
  const chosen = want === undefined ? runs
    : runs.filter((doc) => doc.id === want || clean(doc.name).toLowerCase() === want);
  for (const doc of chosen) {
    const row = { id: doc.id, name: clean(doc.name) || doc.id, doc };
    if (local?.[doc.id]) skipped.push({ ...row, why: 'here' });
    else if (want !== undefined) restore.push({ ...row, why: 'named' });
    else if (FINISHED.has(doc.status)) skipped.push({ ...row, why: 'finished' });
    else if (machineRuns.has(doc.id)) restore.push({ ...row, why: 'machine' });
    else if (ownerId && doc.actor?.id === ownerId) restore.push({ ...row, why: 'owner' });
    else if (doc.actor?.displayName) skipped.push({ ...row, why: 'other', owner: clean(doc.actor.displayName, 40) });
    else skipped.push({ ...row, why: 'unknown' });
  }
  return { restore, skipped, matched: chosen.length };
}

const CAME_BACK = {
  named: 'You named it.',
  machine: 'This computer reported it.',
  owner: 'You started it.',
};

const LEFT = {
  here: (n) => `${n} ${n === 1 ? 'run is' : 'runs are'} already on this computer.`,
  finished: (n) => `${n} ${n === 1 ? 'run is' : 'runs are'} finished.`,
  other: (n) => `${n} ${n === 1 ? 'run belongs' : 'runs belong'} to other people.`,
  unknown: (n) => `${n} ${n === 1 ? 'run does' : 'runs do'} not show who started ${n === 1 ? 'it' : 'them'}.`,
};

/** What a person reads: what came back, then what stayed and why. */
export function restoreLines(plan, { wanted } = {}) {
  const lines = [];
  if (wanted !== undefined && !plan.matched) {
    return [`The board has no run called "${clean(wanted)}". Check the name or the id on the board.`];
  }
  if (wanted !== undefined && plan.matched > 1) {
    return [`${plan.matched} runs on the board are called "${clean(wanted)}". Name one by its id:`,
      ...plan.skipped.concat(plan.restore).map((row) => `  ${row.id}  ${row.name}`)];
  }
  for (const row of plan.restore) {
    const tickets = (row.doc.tickets || []).length;
    lines.push(`Brought back "${row.name}" (${row.id}), ${tickets} ticket${tickets === 1 ? '' : 's'}, `
      + `${clean(row.doc.status, 20) || 'no status'}. ${CAME_BACK[row.why]}`);
  }
  if (wanted !== undefined && plan.skipped.length) {
    const [row] = plan.skipped;
    lines.push(`"${row.name}" (${row.id}) is already on this computer. TeamFlow changed nothing.`);
    return lines;
  }
  const counts = {};
  for (const row of plan.skipped) counts[row.why] = (counts[row.why] || 0) + 1;
  const left = Object.keys(LEFT).filter((why) => counts[why]).map((why) => LEFT[why](counts[why]));
  if (!plan.restore.length) lines.push(plan.skipped.length ? 'No run came back.' : 'The board has no runs for this organisation.');
  if (left.length) lines.push(`TeamFlow left the others. ${left.join(' ')}`);
  if (counts.other || counts.unknown || counts.finished) {
    lines.push('To bring back one of them, name it: teamflow workflow restore <id>.');
  }
  if (plan.restore.length) lines.push('To work in a run, use: teamflow workflow use <name>.');
  return lines;
}

/** The board's runs, as the service holds them. */
async function boardRuns(config, read) {
  const got = await read('bundle', { ...config, serviceTimeoutMs: Math.max(Number(config.serviceTimeoutMs) || 0, 30000) });
  if (!got?.ok || !got.document) return { ok: false, reason: got?.missing ? 'the service has nothing for this organisation yet' : got?.reason };
  const runs = got.document.documents?.workflows;
  return { ok: true, runs: runs && typeof runs === 'object' ? runs : {} };
}

/** The run ids this machine last reported for this repository. Empty when there is no proof. */
async function machineRunIds(config, cwd, read) {
  const machine = core.machineId();
  if (!machine) return new Set();
  try {
    const root = core.repositoryRoot(cwd);
    const repo = core.digest(repositoryName(root, (dir, args) => core.safeExec(
      process.env.TEAMFLOW_GIT_BIN || 'git', ['-C', dir, ...args], { cwd: dir, timeout: 2000 })));
    const got = await read(`inventories/${hashOf(machine)}--${repo}.json`, config);
    const doc = got?.ok ? got.document : undefined;
    return new Set([...(doc?.runs || []), ...(doc?.finished || [])].map((row) => row?.id).filter((id) => ID.test(String(id))));
  } catch {
    return new Set();
  }
}

/** Everything the plan needs, read from the service and this machine. */
async function gather(config, { info = {}, cwd = process.cwd(), read = core.fetchState } = {}) {
  const board = await boardRuns(config, read);
  if (!board.ok) return board;
  return {
    ok: true,
    runs: board.runs,
    machineRuns: await machineRunIds(config, cwd, read),
    ownerId: stated(config, info)?.id,
  };
}

/**
 * `teamflow workflow restore [<id|name>]`. Writes the runs that come back
 * into workflows.json (and its backup) and returns what to print.
 */
export async function restore(config = {}, { wanted, info, cwd, read, now = new Date() } = {}) {
  const found = await gather(config, { info, cwd, read });
  if (!found.ok) {
    return { ok: false, lines: [`TeamFlow could not read the board: ${found.reason || 'the service did not answer'}. Nothing changed.`] };
  }
  const state = core.readWorkflows(config);
  const plan = restorePlan(found.runs, state.workflows, { wanted, machineRuns: found.machineRuns, ownerId: found.ownerId });
  const lines = restoreLines(plan, { wanted });
  if (plan.restore.length && (wanted === undefined || plan.matched === 1)) {
    for (const row of plan.restore) {
      state.workflows[row.id] = { ...published(row.doc), restoredAt: now.toISOString() };
    }
    core.writeWorkflows(state, config);
  }
  return { ok: true, plan, lines };
}

/**
 * For `teamflow doctor`: one line when this computer holds no runs but the
 * board holds some that are this computer's or this person's. Undefined
 * otherwise, and without asking the service when runs are here.
 */
export async function missingRunsLine(config = {}, { info, cwd, read } = {}) {
  try {
    if (Object.keys(core.readWorkflows(config).workflows || {}).length) return undefined;
    const found = await gather(config, { info, cwd, read });
    if (!found.ok) return undefined;
    const plan = restorePlan(found.runs, {}, { machineRuns: found.machineRuns, ownerId: found.ownerId });
    const n = plan.restore.length;
    if (!n) return undefined;
    return `This computer has no runs, but the board has ${n} of yours. `
      + 'Run teamflow workflow restore to bring them back.';
  } catch {
    return undefined;
  }
}
