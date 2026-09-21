---
name: org
description: Show which TeamFlow organisation this machine syncs under, and switch to another one the user holds a seat on.
command: org
disable-model-invocation: true
---

Run this command with the shell tool and return its output without adding interpretation:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin org
```

It prints the organisation reports are attributed to, and any others the signed-in address holds a seat on. To move this machine to one of them, run the same command with `switch` and the org id it printed:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin org switch <id>
```

Reports published after the switch are attributed to the new organisation; nothing already published moves. If it says the user is not signed in as a person, tell them to run `teamflow login --browser` (a personal sign-in; the plugin's device authorization cannot switch organisations). A device authorization reports to the organisation chosen on the consent page; to move it, run the login skill again and choose there.

Inside Claude Code the plugin is already on disk, so
`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" org` is the same command without the npx round trip. Use it when `CLAUDE_PLUGIN_ROOT` is set.
