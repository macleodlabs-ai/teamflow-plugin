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
//   to wait for is done, or for the one-minute check-in (MACLEOD-845,
//   checkin.mjs). Otherwise it ends quietly.
//
// Any error prints nothing a tool could act on and exits 0: the session
// stops as it always did.
import { failOpen, readStdin } from './hook-core.mjs';
import { blockOutput, decide, logDirection, noteDirection, noteHeld, record, recordWait } from './continue.mjs';
import { readJson, sessionPath } from './core.mjs';
import { acquireLock, runsLockPath } from './dispatch.mjs';
import { drivenBy } from './driven.mjs';

const lock = (fn) => {
  const release = acquireLock(runsLockPath(), { waitMs: 500 });
  if (!release) return { locked: false };
  try { return { locked: true, value: fn() }; } finally { release(); }
};

await failOpen(async () => {
  const input = await readStdin();
  if (process.argv.includes('--watch')) {
    // Every main-session Stop (MACLEOD-845): a plan's waits, and the
    // one-minute check-in. checkin.mjs says why and how it ends.
    if (input.hook_event_name && input.hook_event_name !== 'Stop') return;
    if (!readJson(sessionPath(input.session_id))) return;
    // No check-in rewake in a session another tool drives (MACLEOD-908).
    if (drivenBy(input, process.env, input.cwd)) return;
    const { watchSession } = await import('./checkin.mjs');
    const stop = { background_tasks: input.background_tasks || [], session_crons: input.session_crons || [] };
    const words = await watchSession(input.session_id, stop);
    if (words) {
      process.stderr.write(words);
      process.exit(2);
    }
    return;
  }
  const decision = decide(input);
  if (!decision.continue) {
    if (input.hook_event_name === 'Stop') noteHeld(input.session_id, decision.why);
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
