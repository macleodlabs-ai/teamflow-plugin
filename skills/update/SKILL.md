---
name: update
description: Show a short Status update of the work, from the TeamFlow board: what is live, what is merged but not deployed yet, what is still being built and what needs the user, with one plain line per piece. Use when the user asks how it is going, for an update, a status update, a summary for a manager, or what shipped.
command: update
---

Run this command with the shell tool and return its output as it is:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin update
```

It prints four headings, in this order: Live now, Merged but not deployed yet, Still being built, Needs you. These are the words the dashboard shows. Each row is one plain line about what a person gets from the piece, then who and when.

The line on each row is the one the card carries. When a row shows only a title, the card has no plain line yet. If you worked on that card, write one with `teamflow card say <KEY> "<one or two short sentences>"`: say what a person gets, with no code, file names or links.

If it says it could not read the board, tell the user to run the doctor skill. Do not write an update of your own instead: the groups must be the board's.

Inside Claude Code the plugin is already on disk, so
`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" update` is the same command without the npx round trip. Use it when `CLAUDE_PLUGIN_ROOT` is set.
