# Changelog

What changed in each published version of the TeamFlow plugin, newest first.
Only what a person using it would notice.

## 0.3.14

- **Security: a report queued for one organisation can no longer be delivered
  into another.** A report that could not be sent — the service unreachable,
  a laptop offline — waited in a queue that recorded where to send it and
  what to send, but not whose it was, and the next session to succeed at
  anything sent the lot with its own credential. The service takes the
  organisation from the credential, so a report written while signed in to
  one organisation could land on another's board. It needed a machine that
  has signed in to two, which per-session organisation switching makes
  ordinary. Every queued report now records the organisation it was queued
  for, and only a session signed in to that organisation can send it.
- **Reports queued by an earlier version are discarded rather than sent.**
  They record no organisation and nothing on the machine can work out which
  one they belonged to, so guessing was the bug. Nothing is lost that
  matters: every report is the ticket's whole current state, and the next
  thing you do re-sends it. `teamflow status` and `teamflow doctor` say how
  many were discarded, once.
- **Reports queued by a copy of the plugin older than 0.3.14 stay exposed
  until every copy on the machine is updated.** Claude Code runs its own
  cached copy, so a checkout or an `npx` run can be newer than the one your
  editor loads. This version queues where an older one cannot see it, which
  stops the older copy misdelivering *this* version's reports — but it
  cannot change what that copy does with its own. `teamflow doctor` says so
  when it can see an older copy's queue. Update every copy.
- **Going back to an older version leaves recent reports waiting.** They are
  in a queue the older version does not read. The next upgrade sends them,
  or they expire after a week.
- **A queued report is given up on after seven days.** A week-old report
  describes a ticket that has moved on many times since.
- **Workflows are now filed per organisation, so a workflow started on an
  older version shows as "no workflow yet" until you adopt it.** Runs used
  to be filed per machine, which meant a run started under one organisation
  could be advanced and published under another; nothing on the machine
  records which organisation started an older one, and every way of working
  it out turned out to favour whoever happened to be signed in. So
  `teamflow workflow` says the run is there, `teamflow workflow adopt` lists
  what it found, and `teamflow workflow adopt --yes <id>` claims one. It is
  copied, not moved, and nothing is sent.
- The cached project list is filed per organisation too. The first command
  after upgrading fetches it again.
- **A workflow names who is running it**, so the board shows a run's queued
  tickets as that person's — "queued · phase 3 of 5" — instead of as
  nobody's. The owner is the name you gave git or TeamFlow, never the
  machine's login, and a workflow with no stated name stays unowned until
  somebody with one touches it.
- `TEAMFLOW_HOOK_TRACE=1` no longer writes a tool's or an event's name as it
  arrived. Events are a fixed list, Claude Code's own tools keep their
  names, and every MCP tool is written as `mcp`: an MCP server names its own
  tools, and a name can be shaped like an access token.

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
