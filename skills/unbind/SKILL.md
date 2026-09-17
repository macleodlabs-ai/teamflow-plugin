---
name: unbind
description: Clear the explicit TeamFlow issue binding and return to automatic detection.
command: unbind
disable-model-invocation: true
---

Run:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin unbind
```

Return only the command result.

Inside Claude Code the plugin is already on disk, so
`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" unbind` is the same command without the npx round trip. Use it when `CLAUDE_PLUGIN_ROOT` is set.
