#!/usr/bin/env node
// The Claude Code hook entry, registered by plugin/hooks/hooks.json.
//
// Claude Code's event shape is the one `classifyTool` reads, so this
// entry adapts nothing: it hands stdin straight to the shared pipeline
// in hook-core.mjs. Every other tool's entry is hook-cli.mjs, which
// translates first and then calls the same pipeline.
import { claudeContext, failOpen, handleEvent, readStdin } from './hook-core.mjs';

await failOpen(async () => {
  const input = await readStdin();
  const { state, justBound, event, project, signedIn, refused, credentialRefused, notices } = await handleEvent(input);
  const output = claudeContext(
    event, state, justBound, undefined, project, signedIn, refused, credentialRefused, notices);
  if (output) process.stdout.write(output);
});
