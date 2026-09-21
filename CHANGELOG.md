# Changelog

What changed in each published version of the TeamFlow plugin, newest first.
Only what a person using it would notice.

## 0.3.24

- **`/teamflow:login` authorizes the plugin on the consent page, every
  time.** It opens TeamFlow's consent page in your browser — naming the tool
  and this computer, with the code your terminal shows — instead of the
  hosted sign-in page. Approve once and the machine stays authorized until
  it is revoked. With no browser here it prints the code and the page's
  address for a browser anywhere; `--device` still works and does the same.
- **Reports now carry a one-hour access token.** The long-lived part of the
  authorization is sent only to TeamFlow's token endpoint, never with a
  report, and revoking the computer (by `/teamflow:logout` or on the
  Organisation page) stops it on its next report. Many sessions and agents on
  one machine refresh together without ever signing it out.
- **Machines authorized before this version keep reporting**, and switch to
  the new tokens by themselves on their first report, keeping their place on
  the Organisation page. An older copy of the plugin on the same machine keeps
  working with what this one writes.
- **Operator commands need a person.** `teamflow admin` and `teamflow org`
  ask for `teamflow login --browser`, a personal sign-in kept apart from the
  plugin's authorization; nothing reports with it.
- **A repository can no longer choose where issue titles are looked up.**
  GitHub titles come from `api.github.com`, or from a GitHub Enterprise host
  named as `githubApi` in your own `~/.config/teamflow/config.json` — never
  from an address an environment variable in a checkout names. Titles are
  also cut to 256 characters and stripped of control characters before they
  reach a card.
- **A repository can no longer choose which files count as yours.** Your
  TeamFlow config and session are read from your account's home directory,
  not from `$HOME`, which a checkout can set. On a machine with no account
  record for the user (some containers), TeamFlow now reads no credential
  and `teamflow status` says why, instead of trusting `$HOME`.
- **The test sandbox never opens a browser.** (Developers of the plugin only.)

## 0.3.23

- **Automatic reporting pauses, said in plain words.** If this machine's
  credential is already reporting from another machine, you see "This
  credential is already in use. Run /teamflow:login on this machine to give
  it its own." If your organisation's usage is far beyond a normal team, you
  see "Usage on the credential exceeds the plan. Contact us to discuss
  Enterprise plans." Each one is followed by a link to
  [the fair use guide](https://codercat.io/docs/fair-use/). A failed payment
  pauses reporting the same way, and says so. `teamflow status`,
  `teamflow doctor` and the next session's start show the pause for the
  organisation it applies to. It lifts by itself, and the board catches up
  at the end of the next turn.
- **Each machine sends a random machine id with its reports.** It's made
  once and kept in `~/.local/share/teamflow`, so every Claude Code config
  directory and every other tool on your laptop is one machine. It's never
  your hostname. A devcontainer that shares your home directory is the
  same machine.
- **Refusals everywhere else read the service's reason code too.** Signing
  in, switching organisation, admin codes, ad hoc keys and projects say
  "organisation" where the service says "account".

## 0.3.22

- **A configured key is never sent to TeamFlow.** The service now refuses a
  key on sight, whatever header or link it arrives in, and revokes any it
  recognises — so the plugin stops offering one. If `TEAMFLOW_API_KEY` or the
  global file still names a key, `status` and `doctor` say once that it is
  ignored and that `/teamflow:login` is what authorizes this machine. Nothing
  changes for a machine that is signed in. A self-hosted service that does
  issue keys still gets one, and only when its address is listed in
  `trustedOrigins` in your own `~/.config/teamflow/config.json`.

## 0.3.21

- **Nothing the plugin says mentions a credit any more.** A seat is a
  person: their agents, subagents, worktrees and CI all report under it, and
  reporting is not billed by volume. The client skill's guidance on when to
  report says why a repeated report adds nothing rather than what it costs,
  and on HTTP 402 it hands your human what the service said, with the link
  the service gave &mdash; a seat is theirs to add, not the agent's. The
  `status`, `org` and `logout` skills use the same words.

## 0.3.20

- **A ticket's state is now sent when it changes, rather than on every hook
  that fires.** Replaying four days of this project's own work through the
  reporter: **13,099 reports before, 5,879 after — 55% fewer.** Two changes
  make that up, and they are not the same kind of thing:
  - **A bug, worth 18 points of it.** Deduplication had been in the plugin
    all along and never once fired, because it ignored the timestamp on the
    outside of a report and missed the copy of it inside. So a run of forty
    edits — all of them "Implementing locally" — was forty reports and forty
    credits. It is now one. On its own this takes 13,099 to 10,759.
  - **A judgement, worth the other 37.** An unchanged ticket used to be
    restated every thirty seconds and is now restated every two and a half
    minutes, which takes 10,759 to 5,879. That is a trade, not a repair: see
    the next entry.
  Nothing you watch for is held back either way. A stage change, a test or
  audit verdict, rework, a new commit, the end of a turn and the end of a
  session or an agent all go immediately, exactly as before.
- **A quiet session still shows as working, and the trade is small.** Two and
  a half minutes is half the width of the board's "active" band, because the
  restatement goes out on the next hook after the interval rather than on a
  timer — so the gap you actually see is the interval plus however long until
  the next tool call. Measured over the same four days, gaps longer than five
  minutes go from 222 to 241. (At four minutes they went to 304, which is why
  they are not four minutes.) A session that has genuinely stopped doing
  anything still goes quiet, because it always did.
- **`teamflow status` and `teamflow doctor` now say *why* the service turned
  a report down.** They used to print the single word `failed`, which has
  sent people to debug the dashboard for a problem that was not there. An
  organisation whose reporting has been paused now reads "reporting is paused
  for this organisation — contact support". A refused report is still never
  queued and never holds up the reports behind it.
- **A report the service turns down is no longer forgotten.** It used to be
  written down as though it had been delivered, so when the reason went away
  — a pause lifted, a key fixed — the state that had been refused was never
  sent: the board had never had it and your machine had stopped meaning to
  send it. It is now remembered as refused, which is a different thing: it is
  not re-sent on every tool call, and it does go out at the end of the next
  turn. The same applies to a machine with no credential, which no longer
  finishes signing in believing it has already reported everything it holds.

## 0.3.19

- **Security: a repository you opened could take your TeamFlow credential.
  Update to this version.** Every version up to and including 0.3.18 let a
  `.teamflow.json` inside a repository set `serviceUrl` — the address the
  plugin talks to — and the plugin then attached your machine's credential to
  whatever address that file named. Opening a repository you did not write, in
  any editor the plugin hooks into, was enough: the first hook sent your
  credential to the address the file chose, with no prompt, nothing to click
  and nothing visibly wrong, because the hooks exit quietly by design. Anyone
  who did that could read your organisation's board — ticket keys and titles,
  assignees, branches, summaries, tracker connections — and write to it, and
  every later report from that checkout went to them as well. The same file
  could hand over an API key, or point the legacy S3 path at their bucket
  through one of your AWS profiles.

  **Who was exposed:** anyone who opened a repository they did not write while
  the plugin was installed and signed in. Nothing else was needed. There is no
  evidence anybody did it, and this was found by us rather than reported.

  **What is fixed:** a file in a repository may describe the project and
  nothing else. `serviceUrl`, `authIssuer`, `authClientId`, `authScopes`,
  `authApiScope`, `apiKey`, `accessToken`, `dataUri`, `awsProfile` and
  `oidcAudience` are now ignored when they come from a repository's own
  `.teamflow.json`; the environment and your own
  `~/.config/teamflow/config.json` keep full power over all of them, because
  those are you speaking. On top of that, a credential is now bound to the
  service that issued it and is refused — not quietly swapped for another one
  — anywhere else, and a credential never travels over plain `http` to
  anything but `localhost`.

  **If you point TeamFlow at your own service** from a repository file,
  reporting will stop until you move that setting. `teamflow status` and
  `teamflow doctor` name the exact key they ignored and the environment
  variable that replaces it, and the plugin now says so once at the start of a
  session too, rather than going quiet. You are not signed out by this update.

  **Updating is the fix.** If you are worried about a specific repository, you
  can also revoke this machine from the members page and sign in again.

- **An API key is no longer sent to a service you have not named.** A
  repository cannot only ship a config file — it can ship a
  `.claude/settings.json` with an `env` block, an `.envrc`, or an editor
  workspace setting, and any of those sets `TEAMFLOW_SERVICE_URL` for every
  process your editor starts. A signed-in session is safe from that, because
  it now records where it was issued; an API key or a handed-in access token
  records nothing, so one of those environment variables was enough to send it
  anywhere. An API key now goes only to TeamFlow itself, to `localhost`, or to
  an origin you listed as `"trustedOrigins"` in your own
  `~/.config/teamflow/config.json` — a file a repository cannot write.
  `teamflow login` against your own service adds it for you, so most
  self-hosted setups need nothing typed; if you use only an API key against
  one, `status` and `doctor` print the exact line to add the first time you
  are refused.

- **Signing in to your own TeamFlow is now something you say, not something a
  variable says for you.** `teamflow login --service <url>`, or `serviceUrl` in
  your own `~/.config/teamflow/config.json`. If the only thing naming a
  non-TeamFlow address is an environment variable, `teamflow login` stops
  before it fetches anything and tells you where the address came from — a
  sign-in hands that address an authorization code and your identity token,
  and a repository can set an environment variable through a
  `.claude/settings.json` "env" block, an `.envrc` or an editor workspace
  setting. `localhost` is unaffected, so local development and previews work
  as before. The messages you see when a credential is held back no longer
  suggest signing in at the address that was just refused; they say where that
  address came from first, and what to do about it second.

- **A credential no longer follows a redirect.** Every request the plugin makes
  now refuses one outright. `fetch` drops an `Authorization` header when a
  response redirects it to another host, but it does *not* drop a custom
  header, and TeamFlow's API key travels as `X-Api-Key` — so a service
  answering `301` could have had the request replayed, key included, at
  whatever address it named. If your configuration points at an alias of the
  TeamFlow host rather than the host itself (`www.`, or the old
  `teamflow.macleodlabs.com`), reporting will now tell you the address
  redirected and ask you to name the primary host, instead of failing as
  though the network were down.

- **A session signed in inside a hostile repository is retired rather than
  reused.** If you ran `teamflow login` while one of those repositories was
  open, your session file recorded the attacker's sign-in service, and
  refreshing it would have handed them a fresh token every hour — including
  after this update, since nothing else about the session looks wrong. The
  plugin now checks that the sign-in service belongs to the service that
  issued the session, and refuses to use one that does not: you are asked to
  run `teamflow login` again, and to revoke the old session on the members
  page. Ordinary sessions are untouched.

- **Update every copy of the plugin on the machine.** Two versions share one
  data directory. 0.3.18's `login` and `deviceLogin` write a session object
  that has no place for the new "where was this issued" field, so signing in
  again from a stale 0.3.18 copy strips it — and a self-hosted user would then
  find the up-to-date copy refusing to report until they sign in with it. It
  fails closed, nothing leaks, and `teamflow doctor` says so when it sees it;
  the remedy is the same one 0.3.14 taught, which is to update all of them.

## 0.3.18

- **`teamflow tidy` no longer says it is closing issues in your tracker when
  it is not.** It used to print "Closing in the tracker: …" with every ticket
  it was about to publish a card for, whatever your tracker said and whether
  or not write-back was switched on — so on an organisation with write-back
  off it named 37 issues it could not touch, and named issues that had been
  Done for weeks. It now reads your tracker settings and each issue's own
  state first: issues the tracker has already closed are not listed, with
  write-back off it says "cards only … nothing moves in linear" and where to
  turn it on, and where write-back is on it says it is *asking* the tracker
  to close them, because whether the request succeeds is the service's
  answer and not something the plugin can promise. `--dry-run` prints the
  same, which is where you decide whether to spend the credits.
- **The CLI no longer says your work is "reported to" your organisation.**
  It syncs to TeamFlow, and the organisation is the board it is filed under
  — not somebody being told about you. `teamflow org` now says "Syncing to
  TeamFlow under Acme Delivery", `org switch` says "This machine now syncs
  to TeamFlow under …", installing hooks says "syncs to TeamFlow under org
  …, project …", and the refusal you get when a ticket is bound under
  another organisation reads the same way. One phrasing everywhere. Nothing
  about what is sent has changed, and a report is still called a report.
- **The consent page now also names Cursor, Windsurf, Zed and Gemini CLI**,
  where before it named only Claude Code. Claude Code running in another
  editor's terminal is still "Claude Code": the tool driving the plugin is
  named ahead of the editor the terminal happens to belong to, so you are not
  shown Cursor for work Claude Code is doing. The name is a convenience, not
  a proof — it is what the asking machine said about itself. The code on the
  page is the thing to check, and it is why the page shows it to you.
- **Where a tool cannot be told apart from the editor around it, the page
  still says "The TeamFlow plugin on your-laptop" rather than guessing.**
  That covers VS Code with GitHub Copilot, JetBrains Junie, Cline and Codex
  CLI, none of which leave anything behind that means only them. Set
  `TEAMFLOW_TOOL=<id>` before `teamflow login` to name one of those yourself;
  an id the plugin does not recognise is ignored rather than shown.

## 0.3.17

- **`teamflow login --device` now sends you to a page that asks one
  question.** Before, the link went to the dashboard, which asked you to sign
  in to a board you had not come for and then offered a code field with
  nothing to compare it against. It now goes to `https://codercat.io/device`
  — a short address you can type on a phone, with
  `https://codercat.io/device?code=WXYZ-1234` for one tap — and that page
  shows the code, names the tool and the computer that asked and when, and
  offers Approve and Deny. Signing in happens inside it: you come back to the
  same question with the code still on it, never to the board.
- **The terminal prints both addresses**, because which one is useful depends
  on where the browser is.
- **The request now says which tool it came from**, so the page can say
  "Claude Code on your-laptop" rather than naming a computer and leaving you
  to guess what on it was asking. Claude Code is detected; anywhere else,
  `TEAMFLOW_TOOL=<id>` names it, and with neither the page says "The TeamFlow
  plugin on your-laptop", which is true whatever asked.
- Links that older plugins print still work: `/app/#device?code=…` lands on
  the new page with the code intact.

## 0.3.16

- **The first command after updating may send a burst of reports, and each
  one costs a credit.** Closing a ticket now publishes the ticket's own card,
  and a run that had been closing tickets without one has a backlog of them.
  Runs that were already finished when you updated are marked as already-told
  and cost nothing; a run still in progress has its cards brought up to date.
  **Run `teamflow tidy --dry-run` first.** It changes nothing and prints two
  numbers you want before you spend anything: how many reports a real pass
  would send, and — separately — which issues it would ask your tracker to
  close.
- **Closing a ticket in a run now closes it everywhere.** `teamflow workflow
  ticket <KEY> --state done --cycle verified` publishes the ticket's card at
  Verified, closes any run still claiming to be working on it, and, where
  two-way write-back is on, is what moves the issue in Linear, GitHub or Jira.
  It prints one line saying what the card **and** the tracker now say —
  `MACLEOD-538: card DEV_VERIFIED · linear done`. Read that line: where the
  tracker has not moved it names the reason and what to do, and it never
  claims a ticket is closed everywhere when it is not. Moving the issue by
  hand stops being the routine step and becomes the fallback the line tells
  you to use.
- **The last ticket of a run finishes the run.** A run is no longer left
  running with nothing open in it.
- **`teamflow tidy` repairs a board that has drifted, and the plugin now does
  a little of it on its own.** Four things it puts right: a card whose run has
  moved on, a run or agent still shown as working when it has finished or gone
  quiet for half an hour, a run with nothing left open, and a ticket binding
  left on work that has shipped. `--dry-run` lists everything first. A couple
  of repairs also happen quietly at the end of a session; `teamflow status`
  and `teamflow doctor` say what the last pass did and what it could not.
- **A card is never republished as Verified unless your tracker agrees.** If
  somebody has reopened the issue, or moved it since the run's verdict, the
  repair is listed and not sent — because sending it would ask the service to
  close, in your tracker, an issue a person deliberately reopened. Those show
  as `owed`: decide which side is right and run it again.
- **A report the service rejects is tried once, not for ever.** It is held
  with the reason, shown in `teamflow status` and `teamflow doctor`, and
  retried only when you run `teamflow tidy`. Previously a report the service
  would never accept was re-sent on every session, and everything behind it
  waited.
- **Empty planning runs left lying around for a week can be retired.**
  `teamflow tidy` archives them: they leave the pickers, stay readable, and
  `teamflow workflow status running` brings one back. Only `tidy` does this,
  never a session on its own, so a run you started on Friday is still there on
  Monday.
- **A reviewer sending a ticket back no longer takes the whole run off the
  board.** `--state rework` was a word the service did not know, and it
  refuses a run document whole rather than field by field, so every later
  update of that run was rejected — silently, at the moment the run had
  something important to say.
- **Every report now names the organisation it belongs to, and one that does
  not is refused.** Four kinds of report did not: the run document itself, its
  gate results, ad hoc items and CI reports. Signed in to one organisation
  with another's key still on the machine, those could land on the wrong
  board. Nothing changes for a machine signed in to one organisation. A report
  already queued from a machine that had no organisation is kept, not thrown
  away, and waits for a session that can deliver it.
- **`teamflow status` and `teamflow doctor` gained a `reconcile` line**: what
  the last pass repaired, what is still owed, and anything held back with its
  reason.

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
