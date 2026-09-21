---
name: logout
description: Sign out of TeamFlow on this machine and remove the stored session.
command: logout
disable-model-invocation: true
---

Run this command with the shell tool and return its output:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin logout
```

It deletes `~/.config/teamflow/session.json`. Reporting stops at the end of the current session's token. The login skill signs back in.

Inside Claude Code the plugin is already on disk, so
`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" logout` is the same command without the npx round trip. Use it when `CLAUDE_PLUGIN_ROOT` is set.
