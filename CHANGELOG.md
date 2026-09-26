# Changelog

What changed in each published version of the TeamFlow plugin, newest first.
Only what a person using it would notice.

## 0.3.49

- **TeamFlow is the control centre for your AI software factory.** The
  plugin's description says so. Nothing else changes when you use it.

## 0.3.48

- **TeamFlow is the AI software factory.** The plugin's description says so.
  Nothing else changes when you use it.

- **Answer your agent from TeamFlow, off by default.** When your
  organisation turns on answers and you run `teamflow two-way on`, you can
  pick an agent's choice, allow or deny a permission, or say continue in
  TeamFlow. Only you can answer your own agent. Nobody else can.

- **Your agents' questions show in TeamFlow.** With agent view on, a
  question your agent waits on shows with its options. It also shows in
  Needs you.

- **A one-minute check-in.** A quiet session gets a nudge after one minute.
  TeamFlow also tidies finished branches and old worktrees for you.

- **`teamflow worktree tidy`** removes worktrees whose work is merged. It
  keeps new files that were never committed.

- **A usage limit is not a stall.** A session paused on a usage limit says
  so, and TeamFlow waits for the limit to reset.

## 0.3.47

- **A region name in a pasted message is not a ticket.** Text such as
  "EU-WEST-1" no longer binds your session to a ticket called WEST-1.

- **Full detail, when your organisation allows it.** With sensitive detail
  on, your agents' code, tool output and edits are sent too, so you can
  read them in TeamFlow. Secrets are still removed. It is off by default.

- **Agent view, off by default.** `teamflow agent-view on` lets your
  organisation read what your agents say, beside their cards. It sends only
  when you and your organisation both turn it on. Code and secrets are taken
  out first, and tool output is not sent unless your organisation allows
  full detail.

## 0.3.46

- **`teamflow status` forgets a finished ad hoc card.** After
  `teamflow adhoc done`, status no longer names the card you just finished.

## 0.3.45

- **`/teamflow:update` says who picks up work sent back.** A card sent back
  reads "waiting for someone to pick it up" until someone takes it. The
  dashboard and your terminal use the same words.
- **A CI run's parts read the same everywhere.** Your terminal names each
  part and its result in the dashboard's words.

## 0.3.44

- **A ticket key in a message does not move your session.** Keys in a
  message from another session, pasted text or a system note are ignored.
  A key you type yourself still binds, and `teamflow bind` always wins.
- **`teamflow workflow restore` brings back runs this computer lost.**
  It reads the board and brings back your open runs. Name a run to bring
  back just that one. It never makes a second copy, and it says what it
  left and why. `teamflow doctor` tells you when to run it.
- **Your runs now have a second copy in `~/.config/teamflow/runs`.** Removing
  the plugin deletes its data folder, but not this copy.

## 0.3.43

- **A card that fails a check goes back to build.** It carries that
  check's failure points, like a ticket sent back by a tester. This is
  true for tests, audits, CI, SonarQube, reviews and your own checks.
- **`/teamflow:update` names the part of a CI run that failed**, for
  example "back from CI/CD · test: 11/12".

## 0.3.42

- **A CI run that does several jobs shows each part.** When one workflow
  builds, lints and tests, the card shows a tick or a cross for each part.
- **`teamflow gates learn`** reads this repository's CI files on your
  machine and drafts a map of those parts. Claude can help you check it.
- **`teamflow gates map --file <path>`** checks the map and sends it to
  TeamFlow. It sends step names and part kinds only. Scripts, commands,
  code and logs stay on your machine.

## 0.3.41

- **Each card can say what a person gets.** `teamflow card say <KEY> "<line>"`
  puts one plain line on the card. TeamFlow checks the words first. It
  refuses code, file names, links and secrets.
- **Claude is asked for that line** when it sends an agent, merges or
  deploys, and only when the card has no current line.
- **`/teamflow:update` prints a Status update**: what is live, what is
  merged, what is still being built and what needs you. It uses the same
  words as the dashboard.
- **TeamFlow tidies cards.** When it finds finished work or a link to a
  finished card, your machine checks the facts and cleans up.
- **Each agent shows the step it is on.** The plugin reads the steps from
  your organisation's plan and labels every agent with its column.
- **Finished agents leave the board by themselves.** Their cards move on
  when the work merges or ends, and they no longer sit in a test column.
- **While paid plans are closed, the plugin says so plainly.** It shows the
  same sentence as the dashboard, and your trial keeps going.

## 0.3.40

- **Each session keeps its own plan.** Two Claude Code sessions on one
  computer no longer share a plan. An agent joins only a plan its work
  fits. `teamflow workflow use` and `teamflow workflow move` put work in
  the right plan, and the tidy-up moves misplaced work by itself.
- **No agent is left without a card.** A session that made or chose a
  plan counts as bound, so its agents always reach a card.
- **Ad hoc work turns into a ticket only in its own project.** When no
  project holds its repository, the card stays ad hoc.

## 0.3.39

- **TeamFlow keeps the session busy while your agent works.** It gives the
  session other ready plan work that no agent has.
- **Old fixes are dropped.** A fix from TeamFlow is never shown after its
  tests pass. The card's History says the fix was not needed.
- **Fixes name the step in plain words**, for example "the local tests".
- **Merged cards close within five minutes.** `teamflow reconcile --merged`
  no longer times out on a large board.

## 0.3.38

- **Finished work is closed from git.** When a ticket's work is merged into
  main, the plugin tells TeamFlow, and the card closes. Only work that came in
  through a merge counts. A commit made straight on main does not.
- **`teamflow reconcile --merged`** does the same for cards that were left
  open before this version. `--dry-run` lists them first.
- **`teamflow continue status` says why** the last stop did not carry on, for
  example "an agent this session sent out was still working".
- An agent that moved to another ticket closes its old card.

## 0.3.37

- **TeamFlow keeps your agents going.** When a session in a plan stops,
  TeamFlow tells it the next step: fix a failed check first, then the next
  ready item. It never answers a question meant for you, and never acts after
  a usage limit or an error. It stops after 5 in a row, or when nothing
  changed. `teamflow continue on|off|status` turns it on or off.
- **Agents that wait start by themselves.** When an agent waits for work that
  is done, or for a commit that is on GitHub, TeamFlow tells it to start.
  While it still waits, its card says what it waits for.
- **`teamflow progress`** prints the state of all current and remaining work
  as one table. `--csv` gives a file you can open in a spreadsheet.
- **Reviewers are known.** A review team's agents show as reviewers on the
  card, whatever their names.

### Also

- An agent that moves to a real ticket keeps that ticket in its plan.
- A fix queued on an ad hoc card follows the ticket it became.

## 0.3.36

- **Background agents show as live** while they work, and as ended after.
  A resumed session is no longer read as ended.
- **An agent's card folds into the real ticket** it moves its work to, and an
  empty agent card closes by itself.
- **No lost cards.** A card for a new agent is sent first and retried if
  needed.
- **Workflow runs** get a card on the board too.

## 0.3.35

- **Trial ended** links to the new pricing page, https://codercat.io/pricing/.

## 0.3.34

- **Trial ended.** When a trial ends, the plugin says so and links to the
  pricing page. Your board stays readable.
- **More tools listed.** Grok, the Codex IDE extension, OpenCode, OpenHands,
  Pi, Kiro and Qwen Code have setup guides. Claude Code is the tested one; the
  rest are marked untested for now.
- **`teamflow adhoc titles --from <file>`** sends titles a person reviewed.
- **Plain ticket text.** A ticket made from ad hoc work says what the work is,
  where it is now and what each check said.

### Also

- **Better ad hoc titles.** "Simplify review: service" keeps both halves. A
  title never ends on "until" or "and", and an agent's code name such as
  "ws-d-opus" is never a title.
- **One plain line under an ad hoc title.** When the title is short, the card
  also says what the work is, from the agent's task.
- **`teamflow adhoc titles`** also fills that line, from the session record,
  then the first commit, then the plan. A card already made a ticket is listed
  for a rename by hand and never sent.

## 0.3.33

- **Plain titles for agents' cards.** A card for a dispatched agent says what
  the work is, such as "Security fixes", instead of a branch name and a tool
  name. Every report for an ad hoc card now carries its title, so a later
  report never leaves the card without one.
- **`teamflow adhoc titles`** gives a title to every ad hoc card on the board
  that has none. It uses this machine's session records, then the first
  commit that names the card. It prints what it would send; `--send` sends.
- **Plain words everywhere the plugin speaks.** Its lines, its command output
  and the summaries it puts on a card use short sentences and no internal
  words: a "check", never a "gate"; "no result", never "no verdict".

## 0.3.32

- **A live heartbeat for every session.** Every two minutes the plugin tells
  TeamFlow which agents are still working and on what. When Claude Code stops
  without ending, one last message says so. The board then shows stopped,
  stuck and offline agents as they are, not as "building".
- **An agent's end closes its plan item.** The item becomes done, or rework
  when the agent failed.
- **Account switches and usage limits.** A switch to another account (for
  example with claude-sessions) counts as the same session carrying on. When
  a usage limit stops a turn, the board says when it resets. After the reset
  the plugin checks the work and shows a desktop notice if it has not carried
  on.
- **Resume notes.** Before a compaction or a limit, the plugin saves where
  the session was. A resumed session gets a short note of what it was doing.
- **Several sessions.** You are told once when another session already works
  on your ticket, or in the same folder.
- **Ad hoc work into tickets.** When your organisation turns it on, the
  plugin asks you, or TeamFlow makes the ticket for you. New command:
  `teamflow adhoc ticket ADHOC-12`.
- `teamflow status` shows the heartbeat and the last resume note.

## 0.3.31

- **Merged work reaches Done.** When you merge a branch, the tickets of the
  work it brings in are marked merged: the ticket the merged worktree was
  working on, and the ticket keys in its commits. Ad hoc work merged from
  another session no longer stays stuck at its last step.
- **Dispatched agents show on the board.** `teamflow status` counts the agents
  a session sends out, and each one joins the run you are working in.
- **Your runs stay where you left them.** Runs and bindings made from the
  command line before this version move, once, to where the plugin keeps its
  data. Nothing already there is overwritten.
- **Plans say "Done in the plan"** instead of "Verified by the run".

## 0.3.30

- **Playwright videos go on the ticket.** When your organisation's Playwright
  step asks for it, a passing run's video goes from your machine to the
  ticket: on GitHub through your own `gh` (2.99 or later), on Linear through
  a one-time upload link. It runs in the background, and the next session
  says whether it worked. TeamFlow never keeps the video.

## 0.3.29

- **A lint step sets itself up.** When your organisation adds the lint
  step, the plugin adds the lint command to `.teamflow/checks.json` in
  your repository. It uses your own `npm run lint` if you have one, and
  MegaLinter if not. It never changes a command you already chose.
- **A Playwright step sets itself up too.** When your organisation adds it,
  the plugin adds `npx playwright test` to `.teamflow/checks.json`, if your
  repository has a Playwright config. If the step asks for a video, the
  plugin writes `playwright.teamflow.config.ts` beside your config, with
  video on, and uses that. It never writes over a file it did not write.
- **Instructions reach your agent.** At the start of a session, the agent
  reads each custom step's command, or the tool it waits for, and your
  organisation's instructions for it. `teamflow gates` shows them too.
- **Remove a link between two tickets in a plan.**
  `teamflow workflow depends <KEY> --on <KEY> --remove` takes it off the
  board.

## 0.3.28

- **Integrations live in Organisation settings.** `teamflow trackers connect`
  now prints the link to Integrations instead of starting a connection: an
  owner or admin, signed in as themselves, connects trackers there. Linear
  connects by consent and GitHub through the TeamFlow App, so neither needs
  an id or a secret copied by hand.

## 0.3.27

- **Every problem on the board arrives with its fix, and the fix goes to
  the developer.** An Attention row, the card's hover and its dialog offer
  the one action the data supports — mark a gate done, send a fix, bump a
  retry, re-run or skip a gate, resume a plan, snooze, ping or escalate —
  and the service does it on your authority or hands it to the developer's
  own plugin, which performs it and reports back. Escalate always goes to
  the developer first; a viewer's escalate only pings them. Notes on a
  ticket (Team plan and up) stay inside your organisation and never leave
  in a report. Nightly at 03:00 UTC the sweep closes gates nobody answered
  for, marks stalled plans and tidies retired stages, and every one of its
  writes is a row in Recent Activity you can read.
- **Every agent you dispatch is on the board, whether or not you planned a
  run.** When a session starts an agent or a team and there is no run, the
  plugin creates one for you — named after your ticket, marked as
  auto-created — mints an ad hoc node for each agent sent to a worktree
  (titled from the agent's name and one-line task; its prompt never leaves
  the machine), binds the agent to it, and tells you once, right after the
  dispatch: `TeamFlow created run "…"; plan it with teamflow workflow
  depends`. `teamflow status` and `doctor` now print `N agents dispatched,
  M unrepresented`, and M is 0. The rule is also written into your project's
  `CLAUDE.md` between marked lines on the first session (only in a
  repository bound to TeamFlow, only when the file already exists, and never
  inside a git worktree), by `teamflow skills install` and by `teamflow
  hooks install --git` (which creates `AGENTS.md` when the repository has
  neither file). Dispatching an agent is never held up by the network: the
  hook Claude Code waits on is local and times out at 2 s, and the node is
  minted afterwards. Nodes are minted only in a bound repository, at most 50
  a session, and never for an agent started by an agent.
- **A gate cannot run for ever, and the plugin re-runs one that fails or
  goes quiet.** A test, audit or deploy gate now carries when it started and
  when it ended, and a link to the run. One that has had no verdict past
  twice its deadline (deploy 30 min, CI and tests 2 h, audits 1 h; your
  organisation can change them) is closed as "no verdict for N" instead of
  reading "running" for days. Before that, the plugin retries it: a failed
  gate is fixed and re-run, a silent one is started again after its
  deadline, three attempts by default, and each attempt is on the board.
  When the attempts are spent the gate reads delayed with the reason, the
  plan shows `stalled` on that gate, and you are told — in the plugin's own
  words, at the start of your next session and in `teamflow status`. A
  plan waiting on a gate that later answers picks itself back up. Nothing
  is ever queued for you to run.
- **`teamflow ci start|end|fail <gate>`** is the two lines a CI workflow
  writes to report a gate's start and finish, with the run's own link;
  **`teamflow ci run <gate> -- <command>`** runs the command for you with
  the same retries. `runtime-report.mjs` takes `--started`, `--ended` and
  `--url` (https only).
- **A lead can send your session a fix from the board.** It arrives as
  `Fix from <name>, <time>: …` at the start of a session or in `teamflow
  status`, as their message and never as a command; they can also bump a
  stalled gate, re-run a gate this machine has a command for, resume a
  plan or pass a gate with their reason. What the board records is what
  the plugin did about each, never the text. `teamflow config set intake
  off` turns it off for this machine.
- **A plan is drawn as a plan, not as a person named after it.**
- **Audited tickets no longer sit in Local Audit for days, and a card's loop
  count means something.** `git push` of your branch and `gh pr create` now
  move the ticket to Review saying "in review"; `git merge <branch>` from
  another session moves the ticket the branch is named for, not the one the
  merging session is bound to; and a bare `npm audit` no longer counts as
  the audit gate (`npm run audit:local` and `make audit` still do). Each
  time a gate fails the card now records which gate, when and one line
  about why, and when it passes again the entry is marked cleared rather
  than forgotten. The loop count is the number of loops in the current plan
  cycle and starts again when the ticket is verified or a new build picks it
  up, instead of climbing for ever. Every stage change is written down with
  who made it, and an agent launched by another agent says which one.
- **The board's columns are now a pipeline you can shape.** The ten
  columns are gates in a pipeline: your organisation has one, every
  project inherits it until an admin edits that project's copy, and
  deleting the copy goes back to inheriting. Solo and Team can reorder
  and rename the gates; Growth and above can add and remove them and
  make an external system a gate. SonarQube is the first: connect it
  as a webhook, and its quality gate verdict — pass, or fail with the
  conditions that failed — appears on the ticket the analysed branch
  belongs to. Nothing changes on a board nobody has edited.
- **Leave a one-line note on a plan ticket.** `teamflow workflow ticket
  <KEY> --note "audit: 1 high, fixed before merge"` puts your sentence
  beside the ticket on the dashboard's Status view. It is one line of at
  most 120 characters and only what you typed after `--note`;
  `--note ""` clears it.
- **Turn ad hoc work into a real ticket.** `teamflow adhoc convert
  --project <project>` creates the ticket in your tracker (Linear, or GitHub
  when the TeamFlow App may write issues), in the status the card's gate
  maps to, and the ADHOC card becomes that ticket everywhere: its history,
  its place in every plan and its edges come with it, and the old key still
  finds it. `--to <KEY>` links a ticket you created elsewhere instead. A
  session bound to the ad hoc item follows the ticket on its next hook.

## 0.3.26

- **TeamFlow shows up in `/mcp`, like Linear.** The plugin now brings
  TeamFlow's own MCP server, listed as `teamflow`, with the usual
  actions: see its tools, Reconnect, and switch it off or on for a
  project. It connects with the authorization `/teamflow:login` already
  gave this computer — no second sign-in, no key. If the computer is not
  authorized, `teamflow` shows as not connected and the fix is
  `/teamflow:login`, then Reconnect. `/teamflow:doctor` now says whether it
  connects and how many tools it offers, and `/teamflow:status` whether it
  is authorized.
- **The plugin's own folders follow your account, not the checkout.** The
  per-machine and data folders now come from your account's home directory,
  like your config and session already did, so a repository that sets
  `$HOME` cannot choose where TeamFlow keeps them. `teamflow doctor` lists
  the config file it actually read.

## 0.3.25

- **When a free trial ends, the plugin says so.** If your organisation's
  14-day trial ends without a subscription, reports stop being uploaded and
  `teamflow status`, `teamflow doctor` and the next session's start say
  "Your TeamFlow trial has ended. Subscribe to keep your board updating",
  with the link. Your board stays readable and nothing is deleted. Reports
  made in the meantime are not queued up; the moment somebody subscribes,
  the next report sends the current state and the notice goes away.

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
