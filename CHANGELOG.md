# Changelog

What changed in each published version of the TeamFlow plugin, newest first.
Only what a person using it would notice.

## 0.3.13

- **The board shows the agent teams the terminal shows.** A report now says
  which session it came from and, inside a session, which agent: its name,
  its task and when it started and ended. Several agents working at once for
  one person no longer overwrite each other's ticket, stage or status. What
  is sent is an id, a name, a task line and timestamps, never a prompt.
- **A reviewer's verdict reaches the board.** `teamflow workflow ticket KEY
  --state rework --cycle test|audit|deploy --reason "…"` draws the loop back
  from the gate that failed, and the loop clears when the ticket is back at
  that gate or past it.
- **A branch name is a ticket key only if its prefix is one your organisation
  uses.** `next-15` and `release-2024` no longer invent `NEXT-15` and
  `RELEASE-2024`. With nobody signed in there is nobody to
  ask, and every well-formed key is believed, as before.
- **Merging the trunk into your branch is a sync, not the merge gate.** Only
  merging work *into* the trunk moves a ticket to Merge.
- Tools other than Claude Code say so, once, when nobody has signed in,
  instead of reporting into nothing.
- `TEAMFLOW_HOOK_TRACE=1` writes the *names* of the fields a hook received to
  `hook-trace.jsonl` in the plugin's data directory, for debugging an
  integration. Only names the plugin already knows are written; anything else
  is counted. Off unless you set it.
