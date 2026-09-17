---
name: sync
description: Force TeamFlow to publish the current issue delivery state now.
command: sync
disable-model-invocation: true
---

Run:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin sync
```

Return only the command result.

Inside Claude Code the plugin is already on disk, so
`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" sync` is the same command without the npx round trip. Use it when `CLAUDE_PLUGIN_ROOT` is set.
