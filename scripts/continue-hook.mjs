#!/usr/bin/env node
// The auto-continue hook (MACLEOD-726, MACLEOD-733), registered by
// plugin/hooks/hooks.json twice:
//
// - on Stop and SubagentStop without `async`: only a synchronous hook's
//   `{"decision": "block", "reason": ...}` keeps Claude Code working.
//   It prints that line only when continue.mjs decides to, and nothing
//   otherwise.
// - with `--watch`, on Stop with `asyncRewake`: in the background, it
//   wakes the session (stderr, exit 2) when something an actor stopped
//   to wait for is done. Otherwise it ends quietly.
//
// Any error prints nothing a tool could act on and exits 0: the session
// stops as it always did.
import { failOpen, readStdin } from './hook-core.mjs';
import { blockOutput, decide, logDirection, noteDirection, record, recordWait, runsFor, watch } from './continue.mjs';
import { loadConfig, readJson, sessionActors, sessionPath } from './core.mjs';
import { acquireLock, runsLockPath } from './dispatch.mjs';

const lock = (fn) => {
  const release = acquireLock(runsLockPath(), { waitMs: 500 });
  if (!release) return { locked: false };
  try { return { locked: true, value: fn() }; } finally { release(); }
};

await failOpen(async () => {
  const input = await readStdin();
  if (process.argv.includes('--watch')) {
    // Only a session in a plan run has anything to wait for.
    const main = readJson(sessionPath(input.session_id));
    if (!main) return;
    const keys = new Set(sessionActors(input.session_id).map((a) => a.binding?.key).filter(Boolean));
    if (!runsFor(keys, loadConfig(main.cwd || input.cwd || process.cwd())).length) return;
    const words = await watch(input.session_id);
    if (words) {
      process.stderr.write(words);
      process.exit(2);
    }
    return;
  }
  const decision = decide(input);
  if (!decision.continue) {
    // Nothing ready, or waiting: what it waits for goes in the run's log.
    if (decision.direction) logDirection(decision.direction, decision.config, { lock });
    if (decision.direction?.kind === 'wait') {
      recordWait(input.session_id, decision.agentKey, decision.direction);
      noteDirection(input.session_id, decision.agentKey, decision.direction);
    }
    return;
  }
  record(decision, { lock });
  process.stdout.write(blockOutput(decision.direction));
});
