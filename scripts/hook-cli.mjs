#!/usr/bin/env node
// `teamflow hook --for <tool> [--event <name>]`: the hook entry every
// tool other than Claude Code calls.
//
// Claude Code has plugin/hooks/hooks.json and scripts/hook.mjs. Every
// other tool's hook configuration points here instead, because their
// payloads differ and the classifier's does not: this reads the event
// off stdin, puts it through that tool's adapter in adapters.mjs, and
// hands the result to the same pipeline hook.mjs uses.
//
// The contract with every one of these tools is the same and is not
// negotiable:
//
//   - exit 0, always, whatever happened;
//   - say nothing on stdout that the tool could read as a denial,
//     because in Cursor, Copilot, Gemini CLI and Cline stdout is how a
//     hook denies an action and a reporter that accidentally denied a
//     shell command would be worse than no reporter at all;
//   - never wait long enough to be noticed.
//
// failOpen() in hook-core.mjs enforces the first. The second is
// PASSIVE_STDOUT in adapters.mjs, which is empty for every tool that
// treats silence as consent and the smallest possible "carry on" for
// Gemini CLI, which parses stdout as JSON, and Cline, which reads a
// decision object. It is written before any reporting happens, so a
// slow or broken report cannot hold the tool up either.

import { ADAPTERS, PASSIVE_STDOUT } from './adapters.mjs';
import { failOpen, handleEvent, readStdin } from './hook-core.mjs';
import { loadConfig, repositoryRoot, safeExec } from './core.mjs';

export function parse(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const body = token.slice(2);
    const eq = body.indexOf('=');
    const name = eq >= 0 ? body.slice(0, eq) : body;
    options[name] = eq >= 0 ? body.slice(eq + 1) : argv[++i];
  }
  return options;
}

// The only place TeamFlow runs a developer's command rather than
// watching one. It exists for the git pre-push fallback, where there is
// no agent to watch and a push is otherwise no evidence of anything.
// Opt-in: nothing runs unless `.teamflow.json` names the command.
// safeExec captures rather than inherits, so the suite's output is
// echoed to stderr once it finishes: a developer whose push just ran
// the tests has to be able to see why they failed, and stderr is the
// stream a git hook may write to freely.
export function runTestCommand(config, cwd, echo = (text) => process.stderr.write(text)) {
  const command = config.testCommand ? String(config.testCommand).trim() : '';
  if (!command) return undefined;
  echo(`TeamFlow: running \`${command}\` before the push. The push is not gated on it.\n`);
  const result = safeExec('/bin/sh', ['-c', command], { cwd, timeout: 10 * 60 * 1000 });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (output) echo(`${output}\n`);
  return { command, ok: result.ok, output: output.slice(-4000) };
}

export async function run(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  const options = parse(argv);
  const tool = options.for;
  const adapter = tool ? ADAPTERS[tool] : undefined;
  // An unknown tool is a typo in somebody's hook config. Saying so on
  // stderr is safe; stdout is not.
  if (!adapter) {
    process.stderr.write(`TeamFlow: no hook adapter for "${tool || '(none)'}". Known: ${Object.keys(ADAPTERS).sort().join(', ')}\n`);
    return;
  }

  // Consent first, work second: whatever else happens below, the tool
  // has already been told it may carry on.
  const passive = PASSIVE_STDOUT[tool];
  if (passive) process.stdout.write(passive);

  const payload = await readStdin();
  // The root, not wherever the shim was run from. These tools promise
  // nothing about the working directory they hand a hook, and
  // `.teamflow.json`, the project id and the binding all hang off it.
  const root = repositoryRoot(cwd);
  const config = loadConfig(root);
  const context = { cwd: root, event: options.event, config };
  if (tool === 'git' && options.event === 'pre-push') context.test = runTestCommand(config, root);

  const event = adapter(payload, context);
  if (!event) return;
  await handleEvent({ cwd: root, ...event });
}

export async function main(argv = process.argv.slice(2)) {
  await failOpen(() => run(argv));
}
