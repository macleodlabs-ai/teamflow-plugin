---
name: status
description: Show who is signed in, the TeamFlow issue binding and the reporting state for this project.
command: status
disable-model-invocation: true
---

Run this command with the shell tool and return its output without adding interpretation:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin status
```

`identity` says who is signed in and which org the reports are attributed to. If it says "not signed in", tell the user to run the login skill.

Inside Claude Code the plugin is already on disk, so
`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" status` is the same command without the npx round trip. Use it when `CLAUDE_PLUGIN_ROOT` is set.
