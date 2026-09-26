#!/usr/bin/env node
// The waiting hook (MACLEOD-848), registered by plugin/hooks/hooks.json as
// a synchronous PreToolUse hook for AskUserQuestion and a synchronous
// PermissionRequest hook. two-way.mjs says why it must be synchronous.
//
// With this machine's `teamflow two-way` off (the default) it reads one
// config file and exits 0 with no output: Claude Code asks as always. On,
// it waits up to `waitSeconds` for the developer's answer from TeamFlow
// and prints Claude Code's own decision for it. Nothing else is printed,
// and nothing received is run. Any error prints nothing and exits 0.
import { failOpen, readStdin } from './hook-core.mjs';
import { twoWaySwitch, waitForAnswer } from './two-way.mjs';
import { drivenBy } from './driven.mjs';

await failOpen(async () => {
  if (!twoWaySwitch().on) return;
  const input = await readStdin();
  // Another tool drives this session (MACLEOD-908): it answers its own
  // questions, so exit at once and let it.
  if (drivenBy(input, process.env, input.cwd)) return;
  const output = await waitForAnswer(input);
  if (output) process.stdout.write(JSON.stringify(output));
});
