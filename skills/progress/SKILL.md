---
name: progress
description: Show the progress of all current and remaining work as a table, the one the TeamFlow dashboard shows. Use when the user asks for progress, the status of all work, what is left, or a table of current and remaining work.
command: progress
---

Run this command with the shell tool and return its output as it is. It is already a Markdown table:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin progress
```

The first line counts the work by state: Done, Working, Waiting, Needs you, Blocked and Not started. The rows are grouped by plan, then "Not in a plan". The last column says what TeamFlow did or does next.

Add `--csv` for a CSV copy, or `--line` for the first line alone.

If it says it could not read the board, tell the user to run the doctor skill. Do not build a table of your own instead: the numbers must be the dashboard's.

Inside Claude Code the plugin is already on disk, so
`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" progress` is the same command without the npx round trip. Use it when `CLAUDE_PLUGIN_ROOT` is set.
