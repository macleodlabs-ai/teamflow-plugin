// Saved processes (MACLEOD-968).
//
// The owner, 2026-10-03: "Let's simplify the default sdlc in teamflow
// plugin. as opus only needs occasional audits. But still needs tdd.
// Allow for saving sdlc's. And respecting them."
//
// A process says how a run works its tickets. It is data and never a
// command: a name and two switches, each from a closed set. The service
// keeps an organisation's saved processes (`settings/processes.json`);
// this file is the one place the plugin spells the shape, and
// adapters/teamflow/processes.py is the service's copy of the same rules.

/** Test-first: `proved` means the hooks must see a failing run before the code change and a passing one after. */
export const TDD = Object.freeze(['proved', 'off']);

/**
 * When an audit is due.
 * - `risky_and_plan_end`: a ticket whose change is risky, and the whole plan once before it ends.
 * - `every_ticket`: every ticket, before its status step.
 * - `phase_end`: the whole phase, once its tickets are built and tested.
 * - `on_request`: only when a person asks.
 */
export const AUDIT = Object.freeze(['risky_and_plan_end', 'every_ticket', 'phase_end', 'on_request']);

/** What makes a change risky. Derived from the paths a ticket's work touched; the paths never leave the machine. */
export const RISK_AREAS = Object.freeze(['auth', 'money', 'reporting', 'infra']);

export const BUILT_IN = Object.freeze([
  Object.freeze({ id: 'standard', name: 'Test-driven', tdd: 'proved', audit: 'risky_and_plan_end', checks: Object.freeze([]), builtIn: true }),
  Object.freeze({ id: 'careful', name: 'Test-driven, full review', tdd: 'proved', audit: 'every_ticket', checks: Object.freeze([]), builtIn: true }),
  Object.freeze({ id: 'phase-review', name: 'Test-driven, phase review', tdd: 'proved', audit: 'phase_end', checks: Object.freeze([]), builtIn: true }),
  Object.freeze({ id: 'fast', name: 'Fast', tdd: 'off', audit: 'on_request', checks: Object.freeze([]), builtIn: true }),
]);

export const DEFAULT_ID = 'standard';
export const SAVED_MAX = 20;
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NAME_MAX = 40;

/**
 * A check a process adds (MACLEOD-968, owner 2026-10-03: "allow for custom
 * tools eg. Sonarqube ... some may occur inside the Cicd"; "Don't recreate.
 * Adapt what we have"). Each source is something TeamFlow already has:
 * - `command`: a check the repository declares by name in
 *   `.teamflow/checks.json` (the pipeline's `check` gates, ADHOC-20). The
 *   command lives in the repository, never here; the hooks report it.
 * - `sonarqube`: the SonarQube connection (the pipeline's `external` gates).
 * - `webhook`: any tool posts its pass or fail to a signed URL, the
 *   SonarQube webhook route made general. The secret is never in a process.
 * `at` places it: after Test, after Review (both before Merge), or inside
 * CI/CD. A command runs on the developer's machine, so it is never `ci`.
 */
export const CHECK_SOURCES = Object.freeze(['command', 'sonarqube', 'webhook']);
export const CHECK_AT = Object.freeze(['test', 'review', 'ci']);
export const CHECKS_MAX = 10;
const CHECK_KEYS = ['id', 'label', 'source', 'at', 'check', 'project', 'url', 'note', 'options'];
const NOTE_MAX = 500;
/** The board's switches for a check column (pipeline GateOptions). Never a command. */
const VIDEO = ['off', 'on-pass'];

/** One check, cleaned, or a plain sentence saying why not. */
export function cleanCheck(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'A check is a name, a source and a place.' };
  const extra = Object.keys(raw).filter((key) => !CHECK_KEYS.includes(key));
  if (extra.length) return { error: `A check holds a name, a source and a place only. Remove "${extra[0]}".` };
  const id = String(raw.id ?? '').trim().toLowerCase();
  if (!ID.test(id)) return { error: 'A check id is up to 32 small letters, digits or dashes.' };
  const label = String(raw.label ?? '').replace(/\s+/g, ' ').trim();
  if (!label || label.length > NAME_MAX) return { error: `A check name is 1 to ${NAME_MAX} characters.` };
  if (!CHECK_SOURCES.includes(raw.source)) return { error: `A check comes from one of ${CHECK_SOURCES.join(', ')}.` };
  if (!CHECK_AT.includes(raw.at)) return { error: `A check sits after test, after review, or in CI/CD.` };
  if (raw.source === 'command' && raw.at === 'ci') return { error: 'A command check runs on the developer\'s machine, so it comes before Merge.' };
  const out = { id, label, source: raw.source, at: raw.at };
  if (raw.source === 'command') {
    const name = String(raw.check ?? id).trim().toLowerCase();
    if (!ID.test(name)) return { error: 'A command check names its entry in .teamflow/checks.json.' };
    out.check = name;
  }
  if (raw.source === 'sonarqube') {
    if (raw.project !== undefined) out.project = String(raw.project).slice(0, 200);
    if (raw.url !== undefined) {
      const url = String(raw.url);
      if (!/^https:\/\/[^\s]{1,500}$/.test(url)) return { error: 'A SonarQube link starts with https://.' };
      out.url = url;
    }
  }
  if (raw.note !== undefined) {
    // The organisation's words for the coding agent at this check. Shown, never run.
    const note = String(raw.note).trim();
    if (note.length > NOTE_MAX) return { error: `A check's note is at most ${NOTE_MAX} characters.` };
    if (note) out.note = note;
  }
  if (raw.options !== undefined) {
    const given = raw.options;
    if (!given || typeof given !== 'object' || Array.isArray(given)) return { error: 'A check\'s settings are a video choice and whether to attach it.' };
    const extraOption = Object.keys(given).filter((key) => !['video', 'attach'].includes(key));
    if (extraOption.length) return { error: `A check's settings hold video and attach only. Remove "${extraOption[0]}".` };
    const options = {};
    if (given.video !== undefined) {
      if (!VIDEO.includes(given.video)) return { error: `Video is one of ${VIDEO.join(', ')}.` };
      options.video = given.video;
    }
    if (given.attach !== undefined) options.attach = Boolean(given.attach);
    if (Object.keys(options).length) out.options = options;
  }
  return { check: out };
}

/** One process, cleaned, or a plain sentence saying why not. Never throws. */
export function cleanProcess(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'A process is a name, two choices and its checks.' };
  const extra = Object.keys(raw).filter((key) => !['id', 'name', 'tdd', 'audit', 'checks', 'builtIn'].includes(key));
  if (extra.length) return { error: `A process holds a name, test-first, review and checks only. Remove "${extra[0]}".` };
  const id = String(raw.id ?? '').trim().toLowerCase();
  if (!ID.test(id)) return { error: 'A process id is up to 32 small letters, digits or dashes.' };
  const name = String(raw.name ?? '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > NAME_MAX) return { error: `A process name is 1 to ${NAME_MAX} characters.` };
  if (!TDD.includes(raw.tdd)) return { error: `Test-first is one of ${TDD.join(', ')}.` };
  if (!AUDIT.includes(raw.audit)) return { error: `Review is one of ${AUDIT.join(', ')}.` };
  const checks = [];
  if (raw.checks !== undefined) {
    if (!Array.isArray(raw.checks)) return { error: 'Checks are a list.' };
    if (raw.checks.length > CHECKS_MAX) return { error: `A process has at most ${CHECKS_MAX} checks.` };
    for (const item of raw.checks) {
      const { check, error } = cleanCheck(item);
      if (error) return { error };
      if (checks.some((c) => c.id === check.id)) return { error: `Two checks are called "${check.id}".` };
      checks.push(check);
    }
  }
  return { process: { id, name, tdd: raw.tdd, audit: raw.audit, checks, builtIn: BUILT_IN.some((p) => p.id === id) } };
}

/**
 * The processes an organisation has: the built-in ones, then its saved
 * ones, and which is the default. `served` is what
 * `GET /v1/members/processes` answered, or undefined when it has not
 * been read; then only the built-in ones exist and Standard is the
 * default. A saved process may not reuse a built-in id.
 */
export function processesOf(served) {
  const saved = [];
  for (const raw of Array.isArray(served?.processes) ? served.processes : []) {
    const { process } = cleanProcess(raw);
    if (process && !process.builtIn && !saved.some((p) => p.id === process.id)) saved.push(process);
  }
  const list = [...BUILT_IN, ...saved.slice(0, SAVED_MAX)];
  const wanted = String(served?.default ?? '');
  return { default: list.some((p) => p.id === wanted) ? wanted : DEFAULT_ID, list };
}

/** The process named `id`, else the organisation's default. Always one. */
export function processFor(served, id) {
  const { default: fallback, list } = processesOf(served);
  return list.find((p) => p.id === id) ?? list.find((p) => p.id === fallback);
}

/**
 * The steps a process asks for, in SDLC stage words (owner, 2026-10-03):
 * the steps each ticket takes, and the review the whole plan gets, if any.
 * The Organisation page draws these and the plugin prints them, so the
 * two can never describe a process differently.
 */
export function processSteps(process, { ci = [] } = {}) {
  const checks = Array.isArray(process.checks) ? process.checks : [];
  const at = (where) => checks.filter((c) => c.at === where).map((c) => ({ id: `check:${c.id}`, label: c.label, check: c.source }));
  const steps = [];
  if (process.tdd === 'proved') steps.push({ id: 'write-test', label: 'Write test', note: 'The test fails first. TeamFlow checks this.' });
  steps.push({ id: 'build', label: 'Build' });
  steps.push({ id: 'test', label: 'Test', note: process.tdd === 'proved' ? 'The new test now passes.' : undefined });
  steps.push(...at('test'));
  if (process.audit === 'every_ticket') steps.push({ id: 'review', label: 'Review' });
  if (process.audit === 'risky_and_plan_end') {
    steps.push({ id: 'review', label: 'Review', only: 'Security-sensitive changes only', note: 'Sign-in, payments, reported data or infrastructure.' });
  }
  steps.push(...at('review'));
  steps.push({ id: 'merge', label: 'Merge' });
  // CI/CD is watched, not run: what the repository's own workflows do,
  // parsed from its files (gatemap.mjs), plus any check placed there.
  steps.push({ id: 'ci', label: 'CI/CD', watched: true, parts: [...ci.map((part) => ({ label: part.label, kind: part.kind })), ...at('ci')] });
  steps.push({ id: 'done', label: 'Done' });
  const plan = {
    risky_and_plan_end: { label: 'Release review', when: 'Before the plan ends' },
    phase_end: { label: 'Phase review', when: 'At the end of each phase' },
    on_request: { label: 'Review', when: 'Only when someone asks' },
  }[process.audit];
  return { steps, plan };
}

/** The same steps as one line: "Write test → Build → Test → Done. Release review before the plan ends." */
export function stepsLine(process) {
  const { steps, plan } = processSteps(process);
  const word = (step) => {
    if (step.only) return `${step.label} (${step.only.toLowerCase()})`;
    const checks = (step.parts || []).filter((part) => part.check).map((part) => part.label);
    return checks.length ? `${step.label} (${checks.join(', ')})` : step.label;
  };
  const line = steps.map(word).join(' → ');
  return plan ? `${line}. ${plan.label}: ${plan.when.toLowerCase()}.` : `${line}.`;
}
