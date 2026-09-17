---
name: login
description: Sign in to TeamFlow once so reporting uses short-lived credentials instead of a stored key.
command: login
disable-model-invocation: true
---

Run this command with the shell tool:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin login
```

It opens the TeamFlow sign-in page in the user's browser and waits for them to finish. Tell the user to complete sign-in in the browser tab that just opened, then return the command's result.

This is the whole of TeamFlow onboarding. Reporting then uses a one-hour access token refreshed in the background, and only a revocable refresh token is stored on this machine.

If the command fails it prints the reason. When it also prints a URL, the browser could not be opened automatically: give the user that URL to open by hand, then have them run the command again.

Inside Claude Code the plugin is already on disk, so
`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" login` is the same command without the npx round trip. Use it when `CLAUDE_PLUGIN_ROOT` is set.
