# Changelog

What changed in each published version of the TeamFlow plugin, newest first.
Only what a person using it would notice.

## 0.3.15

- **Security: a ticket binding now names the organisation it was made under,
  and work bound under one organisation is not reported into another.** A
  binding recorded which ticket a repository was working on and nothing about
  whose it was, so switching organisation and carrying on reported the first
  organisation's ticket key, title, stage, summary, branch and counts onto the
  second's board. Unlike the queued-report defect in 0.3.14 this needed no
  outage and no queue: it was every report. A binding made under another
  organisation now stays silent and says so, in `teamflow status`, in
  `teamflow doctor` and once at the start of a session, and `teamflow work-on
  <KEY>` re-binds it.
- **And the check happens where the credential is actually chosen.** Comparing
  the credential the configuration *names* was not enough: an expired session
  falls back to an API key while still reporting itself as a session, so a
  binding could pass the check and the report still go out under a different
  organisation's key. Every report now carries its organisation to the point
  of sending and is refused there if the credential disagrees. Nothing is sent
  and nothing is queued.
- **Because of that, an expired session sitting beside an API key stops
  reporting until you run `teamflow login` again** — even when the key belongs
  to the same organisation. Nothing on the machine can tell that it does: a
  credential fingerprint names a credential, not an organisation. It says so
  rather than failing quietly, and the alternative is reporting to whoever the
  key happens to belong to.
- **`teamflow hooks uninstall` and `teamflow skills uninstall`**, for Cursor,
  Copilot, Windsurf, Cline, Codex CLI, Gemini CLI, JetBrains Junie and the git
  hook fallback — `--for <tool>`, `--git`, `--all`, and `--dry-run` to see it
  first. Install merges entries into files you own, so uninstall removes
  exactly what install added and nothing else: a third-party hook in the same
  file survives, a file you already had survives, and a file that was wholly
  the installer's is deleted. It prints what it removed. Claude Code never
  needed this — `claude plugin uninstall` already removes the lot — but no
  other tool had a way back out.
- **A gate's verdict is worked out from the ticket rather than remembered.**
  A chip could be left lit for ever: the verdict was cleared using a marker
  held in a local file, and anything that lost the marker — a restored backup,
  a second machine, a copied run — left the board claiming work was still
  going on a ticket that had finished hours earlier. Each gate's status is now
  derived from where the ticket actually is, and every ticket in a run is
  reconciled on each command, so a board that has drifted repairs itself. The
  first command after updating publishes a burst of corrections.
- **The delivery columns are ten rather than eleven.** CI / Build and Deploy
  Dev were always one thing to everybody reading the board — a pipeline builds
  and deploys in one run — and are now one column, **CI/CD**. **Prod Review**
  becomes **Done**, which is where a ticket its tracker calls done belongs;
  the old stage was a manual gate nothing ever emitted, and on a real board it
  had silently become the parking space for every finished ticket. Reports
  from older plugins that still name the old stage are accepted and stored
  under the new one, so nothing needs migrating and no card is lost.
- **`mcpkit deploy` is recognised as a deploy.** It matched no pattern, so a
  service deployed with it reached no column at all.
- **A GitHub repository with a capital letter in its name no longer produces
  two cards for one issue.** The plugin lower-cased the repository half of the
  key and the tracker connector kept GitHub's own casing, so the reports and
  the issue's title, assignee and status landed on two different cards. Lower
  case is now the one spelling on both sides.

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
