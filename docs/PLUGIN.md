# Claude Code plugin workflow

TeamFlow is deliberately zero-touch during normal development.

## Lifecycle

```text
SessionStart
  → restore tenant-scoped project binding
  → inspect branch/latest commit for an issue key
  → expose bundled Atlassian / Linear / GitHub MCP

UserPromptSubmit
  → inspect prompt locally for an explicit issue reference
  → improve binding confidence
  → inject only the selected tracker and issue key as context

PostToolUse / PostToolUseFailure (async)
  → classify tool locally
  → derive LOCAL_DEV / LOCAL_TEST / LOCAL_AUDIT / MERGE
  → derive DEPLOY_DEV / DEV_TEST / DEV_AUDIT / DEV_VERIFIED
  → test/audit failure creates explicit reworkFrom stage
  → sanitize + deduplicate
  → POST the current state to the service as one report

PreToolUse (Agent / Task, in the parent)
  → record the agent's name and one-line task in the launch registry
  → never the prompt, which sits in the same tool_input

SubagentStart / SubagentStop
  → the agent's own actor: match its launch, name it, end it
  → its stage, its ticket and its status are its own, not its parent's

TaskCompleted
  → heartbeat

Stop
  → publish idle state
  → flush any ends SessionEnd could not publish

SessionEnd
  → local-only cleanup; no network work
  → ends every actor of the session and marks their ends for the next turn
```

## An actor is (session, agent)

A subagent's hook events carry the **parent's** `session_id`. State is
therefore keyed by session *and* agent, or five teams in five worktrees and
the main session share one file and whoever fired last decides the ticket
and the stage for everybody (MACLEOD-574).

The agent key is, in order:

1. `agent_id`, where the payload carries one;
2. the agent that has already claimed this repository root;
3. an agent that started but has not shown a root of its own yet — a
   worktree-isolated agent's `SubagentStart` fires before its worktree
   exists, so its first event comes from the parent's directory;
4. a **digest** of the repository root, when it is not the session's own;
5. nothing at all, which is the main actor and keeps the file name and the
   behaviour it has always had.

On disk: `sessions/<id>.json` is the main actor, `sessions/<id>--<digest>.json`
is one agent, and `sessions/<id>.launches/` is the launch registry — one file
per launch, claimed by atomic rename, because five agents launched in one
message are five hook processes and a shared JSON file loses updates.

A digest and never the path: a working directory carries an OS username, a
client's name and a repository's name, and `docs/REPORTING_CONTRACT.md` is
the rule it would break.

A session that has never launched an `Agent` has no agents, so a developer
who `cd`s into a second repository gets an actor of their own — two
repositories must not overwrite each other's stage — and no `agent` block.

## Every dispatched agent is a node on the board

The owner's ruling (MACLEOD-639): all work is represented, and the tool
guarantees it rather than the orchestrator remembering. A session dispatched
thirteen teams into worktrees with no `teamflow workflow create`, and the
board had no run, no phases and no edges for a day. `plugin/scripts/dispatch.mjs`
is the answer, on the events the hooks already see:

- **The `Agent` (`Task`) tool's PreToolUse in the parent** — registered in
  `hooks.json` for that tool alone, with a 2 s timeout — is the dispatch.
  Claude Code holds the dispatch until this hook exits, so it is local only:
  from `name`, `description`, `subagent_type` and `isolation`, never
  `prompt`, the plugin (a) makes sure a live run exists for the
  organisation, creating one named after the bound ticket or `Unplanned run
  <date>` with `origin: auto`, status `running`, no `--order-text`; (b) puts
  the session's own ticket in the pool; (c) records the launch, marked
  `pending` when the agent is owed a node — sent to a worktree, or
  dispatched by a session that holds no ticket. The run is created under an
  exclusive lockfile next to `workflows.json` (stale after 10 s) and re-read
  once the lock is held, so thirty dispatches at once make one run. No
  credential refresh, mint or publish happens on this event.
- **The mint is on the async path.** The first of the dispatch's async
  events — the tool's own PostToolUse, the agent's `SubagentStart`, or the
  agent's first tool event — mints the ad hoc key (`POST /v1/adhoc`, bounded
  by the service timeout), publishes the item once with a title derived from
  the label and the task and no execution, adds it to the pool as
  `addedBy: dispatch`, `running/build`, and publishes the run. A foreground
  agent's PostToolUse only arrives when it has finished, which is why the
  agent's own events can settle it. The mint record, one file per session
  and tool call under `sessions/<id>.mints/`, is the idempotency key: a
  re-entered hook reads the key it already has, and a mint that failed on
  the network is tried again on a later event, up to five times.
- **Gates on minting.** Only in a repository bound to TeamFlow — a binding
  on disk for it in this organisation, a session bound by a person, the
  project's `.teamflow.json` naming the organisation in `org`, or the
  organisation's cached projects claiming the repository; otherwise the
  launch carries reason `unbound` and no run is created. At most 50 nodes a
  session, after which an agent goes under the session's ticket with reason
  `cap`. An agent launched by an agent is never minted a node: it is bound
  to its parent's node with reason `nested`.
- **The agent's `SubagentStart`** matches its launch as before and binds
  the agent to its node, at manual strength: a prompt naming the parent
  ticket does not pull it off, a later `work-on` in the worktree wins because
  it is newer. An agent with no node and no binding inherits the session's
  key on its first tool event — below a branch name, so its own repository
  still outranks it — and a person in a second repository is never rebound.
- **`git worktree add` and a non-interactive `claude`** through Bash, on
  PostToolUse (the async path; a synchronous hook on every shell command is
  a cost every command would pay), make sure the run exists. No node is
  minted for them: there is no agent to name yet.
- **The nudge.** On the one dispatch that had to create the run, one line —
  `TeamFlow created run "<name>" for this work; plan it with `teamflow
  workflow depends` so the board shows the phases.` — is said on the
  dispatching tool's own PostToolUse (Claude Code reads `additionalContext`
  there) or the next prompt, whichever comes first, and never on
  SessionStart.
- **The proof.** `teamflow status` and `teamflow doctor` always print
  `dispatched: N agents dispatched, M unrepresented, …`. `M` is agents with
  neither a node nor a key to report under, and is meant to read 0; a
  service that refused to mint shows as `under the session's ticket` with
  its reason in brackets. Every path fails open: a refused mint, a service
  that is down, a throw — the hook exits 0, prints nothing a tool reads as
  a denial, and the agent still reaches the board under the session's
  ticket.
- **CLAUDE.md.** The rule itself — create, plan/add, depends, ticket — goes
  into the project's own instructions between `<!-- BEGIN teamflow workflow
  -->` markers: written by `teamflow skills install --for <tool>` (Claude Code
  into `CLAUDE.md`, every other tool inside its rules document), by
  `teamflow hooks install --git` (into `CLAUDE.md` when the repository keeps
  one, else `AGENTS.md`, which it creates when neither file exists), and by
  the first `SessionStart` of the main session in a project bound to
  TeamFlow that already has a `CLAUDE.md` — never a new file, never inside
  a linked git worktree (an agent's, or a main session started with
  `claude -w`; told apart by `git rev-parse --git-dir` differing from
  `--git-common-dir`), replaced in place, unchanged on a second write. `teamflow skills uninstall --for claude-code` takes it back
  out and nothing else.

On the wire this is two fields (`docs/REPORTING_CONTRACT.md`): `origin: auto`
on a workflow document and `dispatch` in `tickets[].addedBy`, mirrored in
`adapters/teamflow/schema.py` and `src/types.ts`. The board draws an `auto`
run as unplanned — real nodes, unknown edges — until `depends` levels it.

## What does this tool actually send?

`agent_id` is documented on `SubagentStart` and `SubagentStop` and on tool
events fired inside a subagent. Whether a given build of Claude Code, or any
of the other seven tools, really puts it on all of them is something no test
on this machine can answer, because a synthetic payload proves only what the
test put in it — so the plugin is built to work either way, and there is an
opt-in trace for settling it from real payloads (MACLEOD-573).

```bash
TEAMFLOW_HOOK_TRACE=1        # in the environment of the session you want to watch
```

One line per event in `<data dir>/hook-trace.jsonl`, holding the event name,
the tool name, the **key names** present on the payload and on `tool_input`,
whether `agent_id` and `agent_type` were present, and whether the event came
from the session's own repository root. Names and booleans: never a value,
never a path, never a prompt, never an id.

A key name is only written if it is on an **allowlist** — the hook payload's
documented fields, and the tool-input fields this plugin's tools actually
carry, both in one constant each in `core.mjs`. Anything else is counted into
`otherKeys` and never written. A key name is content too: the first cut
screened key names by shape, and a shape test passes `ghp_…`, `sk_live_…`,
`xoxb_…`, `glpat_…`, `AIzaSy…` and `npm_…` without blinking, because every
common token prefix is a valid identifier. The cost of the allowlist is that
a field Claude Code adds tomorrow arrives as a number rather than a name —
which is still the signal you need, and is a better trade than a debug file
that can print a customer's access token.

The event name and the tool name are values, so they are held to the same
rule. The event is written only if it is one of the hook events that exist.
A tool is written only if it is one of Claude Code's own, whose names are
letters and nothing else; an MCP tool is named by its server, so every
`mcp__…` is written as `mcp` and which one it was is given up.

It is capped at forty names of forty characters per list, 2 KB per line and
2 MB per file, it is never sent anywhere, it fails open like every other thing
a hook does, and `teamflow doctor` names the file while it exists so nobody
forgets it. Delete it when you are done with it.

## Install lifecycle

Recommended:

```bash
npm run plugin:install
npm run plugin:uninstall
```

`scripts/plugin-lifecycle.mjs` wraps Claude Code's marketplace/plugin CLI. TeamFlow hooks, skills and tracker MCP config are plugin-owned, not copied into arbitrary repository settings. Therefore plugin uninstall removes the active integration as one unit.

Optional uninstall flags:

- `--remove-marketplace` removes the MacleodLabs marketplace registration.
- `--purge-data` removes `~/.local/share/teamflow`.
- `--purge-config` removes `~/.config/teamflow`, including the signed-in session.

Purge is never implicit.

## Signing in

The dashboard needs no plugin: open it and sign in with your email (Google, GitHub, a passkey or an emailed link). Connecting Claude Code is three commands inside a session: `/plugin marketplace add macleodlabs-ai/teamflow-plugin`, `/plugin install teamflow@macleodlabs`, then `/teamflow:login` once. An in-session install is active immediately on Claude Code 2.1.221 and later (older versions say to run `/reload-plugins`); a terminal install with `claude plugin install` needs `/reload-plugins` in the open session or a new one, which is what its "Restart to apply changes" means. The command exists only in Claude Code, the terminal tool: the Claude app and the website do not have it.

**The plugin is authorized, never logged in** (MACLEOD-622). The owner's rule: "Plugin always uses credentials issued via device auth flow. Login is for users into dashboard." `/teamflow:login` is the device authorization grant, and what it opens is the consent page, never the identity provider's bare sign-in page:

```text
/teamflow:login
  → POST /v1/auth/device {label: <hostname>, client: <detected tool>}
  ← device_code (secret), user_code (WXYZ-1234), verification_url(_complete)
  → the consent page (/device?code=WXYZ-1234) opens in this machine's browser,
    or both addresses are printed when there is none
  (the page says "Claude Code on <machine> wants to sync your work to TeamFlow",
   shows the code, and has Approve and Deny; somebody not signed in signs in
   inside that page and lands back on it)
  → POST /v1/auth/device/token {device_code, grant_type: urn:…:device_code}
    (polled at `interval`)
  ← refresh_token (drt_…) + access_token (dat_…, one hour) + device_id
  → session.json at 0600: the refresh token, the device id, the origin
  → device-access.json at 0600: the current access token and its expiry
```

It is what an IDE does: authorized once, authorized until somebody revokes it. The **refresh token** is the device record's secret — a peppered hash at the service, bound to one person's seat, listed on the Organisation page — and it goes to `POST /v1/auth/device/token` and nowhere else, always at `serviceUrl`, never at the `tokenUrl` stored in the file and never at an address a repository file names. The **access token** is what rides on each request; it lives an hour and is refreshed five minutes early. It is a signed claim naming the device record, and the service checks every use against that record, so revoking the device — `teamflow logout`, the member's own devices list, or an owner's revoke on the Organisation page — ends the refresh token and every access token it minted on the next call, not at the end of the hour.

**The refresh token is never rotated.** Many hook processes and agents on one machine share one session file and refresh at the same moment when the hour runs out; a refresh token that changed on every use would read that as theft and sign an honest person out. A stolen refresh token is answered by the device record instead: one revoke, and MACLEOD-620's one-machine rule (`credential_in_use`), which keys on the record — now stable across refreshes, where a `dk_` gave every re-authorization a new record. A refresh that fails leaves the session alone; only a revoke or `teamflow logout` ends it, and `status` says why reporting stopped.

**Why the access token is cached on disk**, when a Cognito access token never was: that rule's reason was that a token on disk has an hour of life and no way to take it back. A device access token can be taken back — every use is checked against its record — and held in memory only, every hook process (one per tool call) would pay a round trip to the token endpoint, which puts the long-lived secret back on nearly every event.

**A `dk_` from before** keeps reporting across the upgrade. On first use the new plugin presents it once as a refresh token; the service points the *same* device record at a fresh refresh token, the `dk_` matches nothing afterwards, and the session file is rewritten with the refresh token in its place. Several processes migrating at once agree on one winner and the others read back what it wrote. Against a service that cannot migrate yet, the `dk_` keeps reporting and the migration is tried again an hour later. The paired session is written with `refreshToken` and `tokenUrl` on purpose: plugin 0.3.23 and older, sharing the data directory, read it as an ordinary refresh session and keep reporting (the service accepts their form-encoded refresh). A machine that never upgrades keeps reporting with its `dk_` for as long as the device record is not revoked — the service still accepts one as a bearer, and a plugin that asks for a device code without naming the grant still receives one; there is no cutover date yet, and setting one is the owner's decision.

**A person's sign-in is separate.** `teamflow login --browser` runs the old loopback authorization code + PKCE flow against the hosted UI — kept, unlisted, for the one thing a machine's credential must never do, which is act as a person: operator commands (`teamflow admin`) and `teamflow org`. It is written to `~/.config/teamflow/personal-session.json`, the output says it is a personal sign-in and not plugin authorization, and nothing reports with it. Those commands refuse a device authorization and name `--browser`.

### Forgetting to sign in

Reporting fails open, which means an install nobody has signed in on breaks nothing and reports nothing: every event is classified, every session is saved, and `publishState` skips because there is no credential. There is no error, and the only symptom is a board that stays empty, noticed days later. So the plugin says it where the person is looking — Claude Code's first `SessionStart` of a session on a machine with no credential prepends one sentence, once, naming `/teamflow:login`. It is context, never a denial: a reporter that blocked a turn would be worse than one that said nothing (MACLEOD-567).

Every other tool is told twice, in the two places a channel exists (MACLEOD-569).

**At install time**, which is the one moment there is a person's attention and a stream nothing reads as a denial. `teamflow skills install --for <tool>`, `teamflow hooks install --for <tool>` and `teamflow hooks install --git` all end by asking the same local question the hook asks: what transport is configured. On the service transport the last line names the organisation and the project this repository syncs to TeamFlow under; on the legacy S3 transport it says so and points at `teamflow doctor`; with nothing configured at all, the last lines are a block on stderr naming `teamflow login` (which opens the consent page here or prints a code for a browser anywhere) and `teamflow status`, and the JSON on stdout carries the same answer as `signIn` so a script can read it. The command still exits **0**: the hooks *are* installed, which is what was asked for, and a non-zero exit would break `&&` in every setup script and fail a build image that signs in later or reports with a CI OIDC token that only exists inside the job. Non-zero is for "the thing you asked for did not happen"; this is a warning, and it is loud. `--dry-run` writes nothing and asks nobody anything, including the service.

**At run time**, once per machine per day and never per event, through whichever field that tool's own documentation calls informational rather than a denial. The rule is unchanged and outranks the notice: stdout is how a hook denies an action in these tools, so nothing TeamFlow prints there may carry `decision`, `permissionDecision`, `continue`, `stopReason` or `cancel: true`. The mechanism, and each piece of it exists because a plausible-looking shortcut was wrong:

- **The table is data**, `notice` in `plugin/scripts/tools.mjs`, beside the doc URL it was read from. `noticeFor` in `adapters.mjs` is the only reader and builds the answer as *the passive value plus one field*, so a notice can never say less than silence does and cannot introduce a key the table did not name.
- **`audience` is `person` or `agent`** and is never blurred, because it decides *which text is sent*. There are two constants in `hook-cli.mjs`, both with nothing interpolated into them. `NOT_SIGNED_IN` is an imperative — run `teamflow login`, then `teamflow status` — and goes only to a field the vendor says the person reads. `NOT_SIGNED_IN_FOR_AGENT` goes to the three that the model reads (Cursor's `additional_context`, Cline's `contextModification`, Junie's `PreToolUse` fallback); it is declarative, states that this is information for the person and explicitly not a task, asks only that the agent pass it on when it next reports back, and contains no command, no backticks and none of the verbs an agent would read as a step. The reason is not theoretical: the imperative arrives immediately before somebody else's agent takes its next tool call, an agent that simply does as it is told abandons the customer's task, and `teamflow login` opens the consent page and polls for up to three minutes, so obeying it can hang the turn. It is not injection — the string is a constant and no report ever reaches it — it is this plugin instructing an agent that is not ours to instruct. A test asserts the split per channel and fails if either branch stops being exercised.
- **No channel means the day is not spent.** `sayOnce` asks the table first and claims only when there is something to print. This is not hypothetical: Junie's `Stop` looked like the obvious place, and JetBrains' own page says the Stop executor does not surface `systemMessage` in the TUI — so it printed into nothing *and* burnt the notice a Junie-and-Cursor user would have read in Cursor.
- **The claim is an exclusive create**, `<plugin data>/notices/<day>.lock` opened `wx`. Read-then-write is not enough: Cursor sends `afterFileEdit` and `postToolUse` for one edit, Copilot registers six event names, and these are separate processes. Five concurrent hooks against a read-then-write claim produced five notices; against the lock, one.
- **It is the transport, not the credential.** A machine with a `dataUri` and no credential is on the legacy S3 transport and its reports land, so it hears nothing.

| Tool | Install-time notice | Run-time channel | Audience |
| --- | --- | --- | --- |
| Claude Code | n/a — the plugin carries its own hooks | `SessionStart` `additionalContext`, once a session (row above), via `claudeContext` rather than this table | person |
| Cursor | yes | `additional_context` on **`sessionStart`**, "additional context to add to the conversation's initial system context". The installer now registers `sessionStart` for the notice alone — it reports no stage. `postToolUse` / `postToolUseFailure` remain as the fallback for a `.cursor/hooks.json` written before this release. Nothing on `afterFileEdit`, `afterShellExecution` or `stop`; `user_message` is what a *denial* shows on the `before*` hooks and is not used | agent — gets the declarative text |
| VS Code + Copilot | yes | `systemMessage`, one of the three fields documented for every hook beside `continue` and `stopReason`: it "displays a warning to the user in the chat" | person |
| Windsurf | yes | **none.** Cascade documents exit codes and no output schema at all, and a hook's output reaches its UI only when the hook is configured `show_output` — which would be a line in front of the developer on every edit and every command rather than once | — |
| Cline | yes | `contextModification` beside `cancel: false`: "inject text into the conversation" without cancelling | agent — gets the declarative text |
| OpenAI Codex CLI | yes | `systemMessage`, Claude Code's field kept field for field, "surfaced as a warning in the UI or event stream" | person |
| Gemini CLI | yes | `systemMessage`, documented as a non-blocking informational display, printed in place of the bare `{}`; `decision` is the field that blocks and is never set | person |
| JetBrains Junie | yes | `systemMessage` on **`SessionStart`**, which the installer now registers for the notice alone. The page says `systemMessage` is "honoured by the SessionStart, SessionEnd and UserPromptSubmit executors" and, in so many words, that "the Stop executor does not currently surface it in the TUI" — so **not `Stop`**, and not `SessionEnd` either, where hook output is discarded. `PreToolUse` `additionalContext` is the fallback for a `~/.junie/config.json` written before this release, and it is "agent-facing, never published to the TUI": on an old install the model is told and the person is not, until the installer is re-run | person on `SessionStart`; agent on the fallback, which gets the declarative text |
| git fallback (Zed, Aider) | yes | **none.** Two of the three installed hooks redirect both streams to `/dev/null` so a commit stays quiet, so a line there would be burnt unread | — |

The doc URLs are in `plugin/scripts/tools.mjs` beside each record, with the vendor wording each claim rests on quoted in the record itself; the fields above were read on 2026-09-19.

Re-running an installer is safe and is how an existing checkout gains the new `sessionStart` / `SessionStart` entry: hook configs are merged, not replaced, and array entries are unioned, so nothing already in the file moves.

**Coming back out** is `teamflow hooks uninstall --for <tool>`, `--git`, or `--all` (MACLEOD-582), and `teamflow skills uninstall --for <tool>` for the skills, the rules file and the MCP entry as well. It is the inverse of the install and nothing wider, which is knowable for the same reason a reinstall is a no-op: `HOOK_SPECS` says exactly what was added, so exactly that comes out. A shim goes only if it still carries the `TeamFlow delivery reporting` line every one of them is written with — Cline's hook is an executable called `.clinerules/hooks/PostToolUse`, a name a repository may well have used first, and one of those is left alone and said so. A shared config loses TeamFlow's entries and keeps everybody else's; a marked block goes and the customer's own instructions above and below it stay; a file with nothing left in it but what the installer put there is deleted, and a file with anything of theirs in it is not. Uninstalling what was never installed exits 0 and says so. `--dry-run` prints the list without touching anything, and every run prints what it removed on stderr with the JSON on stdout. `--all` is the one that also removes this repository's ticket binding — every place it can live, through `userBindingPaths` (MACLEOD-586) — because a binding left behind is what makes a reinstall months later report against a ticket nobody is working on.

All of it is still safe to do by hand instead, because the installer only ever merges: delete `.teamflow/hooks/<tool>.sh` (and the `.ps1` beside it), which is what the header of each shim says, and delete the block between `# BEGIN teamflow` and `# END teamflow` in `.git/hooks/post-commit`, `post-merge` and `pre-push`, which is what the comment inside the block says.

**Afterwards**, `teamflow status` is still the surface that answers in full — the credential, the repository and the project in one answer, with `not signed in; run /teamflow:login` when that is the problem — and `teamflow doctor` is the longer form, which on a machine with nothing configured answers with the one line to act on rather than with the legacy S3 probe.

### A browser elsewhere, or none

The consent page does not have to be opened by the plugin, and the browser does not have to be on this machine: nothing redirects back to `127.0.0.1`. `teamflow login --no-browser`, `TEAMFLOW_NO_BROWSER=1`, a box with no display (no `DISPLAY` or `WAYLAND_DISPLAY`, and not macOS or Windows), or an `open` that exits non-zero all print the short address to type on a phone and the long one that carries the code (RFC 8628 §3.3.1), and the command keeps polling. A terminal over SSH, a container and a remote agent authorize exactly like a laptop. `--device` is accepted, for old instructions, and changes nothing.

The organisation is chosen on the consent page, not on the terminal. An address holding seats on several organisations is asked there, which is where the question can be answered; `--org` is ignored and says so. A device authorization reports to the organisation it was approved into; `teamflow org switch` (a person's command) does not move it, and says so — authorize again and choose on the page.

The address opened is the service's own `verification_url`, with only its origin checked against, and if need be replaced by, the service this machine talks to (MACLEOD-572), and the grant is started only against an origin somebody deliberately chose (MACLEOD-616: never an address only an environment variable named).

No test may open a browser. The test sandbox sets `TEAMFLOW_NO_BROWSER=1` and `TEAMFLOW_TEST_SANDBOX=1`; under the second the opener runs only a program inside the sandbox's own temporary tree, so even a test that clears the first reaches its fake `open` and never the system's.

### The personal sign-in (`--browser`)

`GET /v1/capabilities` gets ten seconds and one retry, because a cold Lambda behind CloudFront can spend most of the first window starting up. A service that never answers is reported as unreachable. A service that answers but publishes no auth block is reported as unconfigured, naming `TEAMFLOW_AUTH_ISSUER` and `TEAMFLOW_AUTH_CLIENT_ID` — two different faults, and telling somebody the second when the first happened sends them after configuration that was never the problem.

The authorize request asks for the sign-in scopes the service publishes, `openid email profile`, plus the API scope it names in `auth.api_scope`, and the ID token then claims the person's seat (`POST /v1/members/identity`) before anything is written. The loopback listener binds the first free port in 52480-52489. Every one of those is registered as a callback URL on the app client, so the range cannot grow without a deploy. The `state` returned by the identity provider must match the one this process sent, or the code is discarded unredeemed: it belongs to somebody else's sign-in.

### More than one organisation

An address can hold a live seat on several organisations, and the service refuses to guess which one a sign-in is for: `POST /v1/members/identity` answers `409 ambiguous_seat` with the organisations, their role and their plan. Binding to the wrong one attributes the developer's reports to the wrong organisation, and nothing downstream can undo that.

```text
teamflow login --browser        (a person's sign-in; the consent page asks this itself)
  → 409 ambiguous_seat
  → on a terminal: the organisations as a numbered list, and one question
  → anywhere else (a hook, CI, a pipe): the same list, then
    "run `teamflow login --browser --org <id>`"
  → POST /v1/members/identity with {id_token, account}
```

`teamflow login --browser --org <id>` skips the question. An id the address holds no seat on is refused `no_seat` and nothing is written — a session bound to no seat looks configured and 401s on every report.

The personal session file gains `account` and `accountName` beside the refresh token, so `teamflow org` can say where reports go without a round trip. Nothing else about the file changes: still no access token, still no ID token, still 0600.

```bash
teamflow org                      # the organisation reports go to, and the others
teamflow org switch <id>          # POST /v1/members/switch, per session
```

`teamflow org` reads `GET /v1/members/me` with the ID token as the bearer — the access token names a seat, and this has to answer for the address, which is what the other organisations are found by.

A switch is **per session**: the service answers with an account-scoped token for the credential in hand and moves no binding, so this CLI goes to the named organisation and the dashboard tab beside it stays where its holder put it. Reports already published stay where they were published. A device authorization — what `/teamflow:login` leaves on every machine since MACLEOD-622 — is not moved by `teamflow org switch`, which needs a person's sign-in and says the device still reports where it was approved; an account key cannot switch at all, because it names the account rather than a person.

**Which pool a report is charged to.** The one the session is in. Somebody in three organisations is billed to whichever one the credential posting the report is in, which is why the switch is per session and not per person. A person who signed up alone keeps their own pool on joining; the service asks once whether to fold it into the organisation, and `/teamflow:status` names the organisation the reports are going to.

Somebody already bound to one organisation who names another at login is switching, and the service says so rather than moving billing quietly: identity answers `409 already_bound_elsewhere`, and the plugin retries the same intent against `/v1/members/switch`.

`/teamflow:logout` deletes the session file. `/teamflow:status` and `/teamflow:doctor` print `signed in as <email>, org <name>` from `GET /v1/account`.

| Config key | Env | Purpose |
| --- | --- | --- |
| `serviceUrl` | `TEAMFLOW_SERVICE_URL` | the service to report to; defaults to `https://codercat.io` |
| `authIssuer` | `TEAMFLOW_AUTH_ISSUER` | override the hosted UI the service publishes, to sign in against a preview stack |
| `authClientId` | `TEAMFLOW_AUTH_CLIENT_ID` | the app client to use with that issuer |
| `authScopes` | | override the sign-in scopes the service publishes |
| `authApiScope` | | override the paid-API scope the service publishes |
| `serviceTimeoutMs` | | per-request timeout, default 5000 |

### CI signs in per job

A workflow with `permissions: id-token: write` needs no stored secret. `runtime-report.mjs` asks GitHub for an OIDC token naming the repository, workflow and ref, and trades it at `POST /v1/token` for a one-hour access token. `.github/workflows/teamflow-runtime-example.yml` is the whole pattern.

Two things have to be true first.

**The audience is `https://codercat.io`.** The service checks it, because an audience nobody checks accepts a token minted for somebody else's service, which any workflow in any repository can obtain. The reporter uses that value without being told. It is tied to the hosted origin rather than to `serviceUrl`, so pointing a job at a preview stack does not change what its token is addressed to. A service that sets `orgs.oidc_audience` publishes the value in force at `GET /v1/repos`, and `oidcAudience` (`TEAMFLOW_OIDC_AUDIENCE`) follows it.

**The repository is registered once, by an owner.** `/teamflow:repos add <owner/repo>` does it from Claude Code; `POST /v1/repos` is the same thing by hand. Without it, any repository's CI that could reach the right audience would mint tokens against any account, so the exchange answers `repository_not_registered` until an owner has said which account the repository belongs to. `/teamflow:repos list` shows what is registered and the audience in force. Registration needs the owner's own credential, so it is `owner_only` for everyone else, and `repository_taken` when another organisation has claimed it.

A failed exchange is logged on stderr and the job carries on with whatever credential is left. Reporting never fails a build.

### Non-interactive fallback

**On TeamFlow there is none, and none is needed.** An environment that cannot
open a browser is what `teamflow login` already does there: the code is read on
one screen and approved on another, so the machine never needs a browser of
its own. A pipeline is what the OIDC exchange above is for. Those two cover
every case the old stored secret covered, and TeamFlow issues no such secret
— `apiKey` set against this service is refused with `api_keys_disabled`
rather than quietly demoted to.

The plugin never sends a configured `apiKey` (`TEAMFLOW_API_KEY`, or the
global file) to TeamFlow, whichever layer set it: the service refuses a key on
sight and revokes any it recognises, so sending one could only burn it
(MACLEOD-630). `status` and `doctor` say so in one line — "a configured key is
ignored … authorize this machine with /teamflow:login" — and nothing is sent.
The code path is dormant, not deleted: it is reached only for a self-hosted
service that does issue keys, and only when that service's origin is listed
in `trustedOrigins` in your own `~/.config/teamflow/config.json` — never from
a repository's `.teamflow.json`, and never on an environment variable alone.
There it is last of the three, because a signed-in developer should stop
sending a long-lived secret the moment there is something better.

`/teamflow:doctor` warns when a session has expired or been revoked, and says
to run `/teamflow:login` again. On TeamFlow that is not a demotion to
something lesser — it is the only credential there is, so reporting stops
until the session comes back, and doctor is where that is visible.

### Devcontainers and remote shells: mount both directories, or neither

A device credential is for one machine, and the service refuses a second
machine reporting on it while the first still is (`credential_in_use`,
MACLEOD-620). The plugin tells the service which machine it is with a random
id kept at `~/.local/share/teamflow/machine-id`, beside the per-organisation
pause notices in `~/.local/share/teamflow/refusals/`. The credential itself is
in `~/.config/teamflow/`.

So a devcontainer or remote shell that should report as this machine must
mount **both** `~/.config/teamflow` and `~/.local/share/teamflow` from the
host, or **neither** and run `/teamflow:login` inside to get a credential of
its own. Mounting only `~/.config/teamflow` gives the container the host's
credential with a machine id of its own, so it is a second machine on one
credential and is refused whenever the host is reporting.

## Superadmin invite codes

An invite code lets one organisation start without paying. The service creates it with the seats and the complimentary period the code carries instead of a Stripe subscription, and `admin.superadmins` in `service.config.json` names who may issue one.

```bash
teamflow admin code create --email owner@acme.com --seats 5 --days 365 --note "Acme pilot"
teamflow admin code list
teamflow admin code revoke TF-XXXX-XXXX
```

`--email` is the organisation's admin and is required: the service emails them the code and its redeem link, and locks the code to that address, so anyone else redeeming it is turned away. The command prints the code and the link under the address it was sent to, as a fallback to paste into a message. `list` shows every code with its status — `unredeemed`, `redeemed` with the account that used it, or `expired` — and never the plaintext of a code already issued. `revoke` works only on a code nobody has used.

**These three send the ID token, and nothing else does.** The service matches `admin.superadmins` against the verified email claim, which only the ID token carries; an access token names a subject and a scope, and the service answers 403 telling you to send the ID token instead. `auth.mjs` keeps the ID token beside the access token — same in-memory cache, same expiry, same refresh, never written to disk — and `adminIdToken` is the only way to reach it.

Exit codes separate the two failures: **2** for a refusal, which is a caller who is not a superadmin, a service with no mailer configured, or a bad argument, and **1** for a call that did not get through, which includes not being signed in. A script that retries the second must not retry the first.

The person who receives the code opens `https://codercat.io/signup/?code=TF-XXXX-XXXX`. The signup page prefills the code, puts the plan picker away, asks for the organisation name, the work email and an optional website, and posts to `POST /v1/signup/redeem`.

## Reporting transport

| Config key | Env | Purpose |
| --- | --- | --- |
| `dataUri` | `TEAMFLOW_DATA_URI` | **legacy**: `s3://bucket/data` for installs that write to S3 directly |
| `awsProfile` | `TEAMFLOW_AWS_PROFILE` | **legacy**: AWS profile for the S3 path |

Any service credential selects the service transport; `dataUri` alone selects S3. With neither, reporting is skipped and nothing is queued.

### Service transport

Every report is one `POST /v1/report`:

```text
Authorization:   Bearer <access token>
Idempotency-Key: <sha256 of the report's content, excluding updatedAt>
Content-Type:    application/json

{ "kind": "issue" | "runtime", "slot": "<slot>", "payload": { ... } }
```

The auth header is not hard-coded. `credential(config)` in `plugin/scripts/core.mjs` is the one place that turns config into a header, and every service call asks it rather than reading a field. It refreshes the session's access token when one is needed, and falls back through the order above.

The outbox stores no credential. A queued report resolves one when it is finally sent, which is the only way a one-hour token survives an hour offline.

It does store **whose** the report is (MACLEOD-583). The tenant comes from the credential, so a queued report is a report for one organisation, and one data directory sees more than one as soon as somebody switches between sessions. Each item carries an `owner`: the account the credential resolved to at queue time — the same string `teamflow status` prints — or, for a credential that names no account locally, a truncated SHA-256 fingerprint of it, alongside the service URL and the credential kind. A flush sends an item only when the current credential resolves to the same account and the same service. Anything else is left exactly where it is, unsent and unrescheduled, for the session that can send it, and is skipped rather than stopping the reports behind it — a foreign item does not count against the flush's limit, or one organisation's backlog would be a wall in front of another's. The same rule keys the legacy S3 branch on the tenant in the object's own key.

**An item with no owner is never sent, by anybody.** Nothing on the machine can say which organisation queued it, and the file recording which organisations have reported here begins the day this version is installed, so "only one organisation has ever used this directory" is unknowable — and a rule that reads it is a rule the first flush after the upgrade satisfies by writing it. It is discarded instead, counted, and named in `teamflow status` and `teamflow doctor`. What that costs is one duplicate of nothing: a report is the ticket's whole current state, and the next event sends it again.

A queued report is also given up on after seven days, whoever owns it. Nothing else empties the queue of reports nobody may deliver, and a week-old full-state document is wrong by the time it arrives.

**The queue is `outbox2/`, and `outbox/` is somebody else's.** Recording an owner binds only the plugins that read it, and Claude Code runs its own cached copy of the plugin beside whatever a checkout or `npx` runs: an older `flushOutbox` knows nothing of owners and would post this version's items with its own credential and then delete them. It cannot list a directory it does not know. The legacy `outbox/` is never queued into and never sent from — the only thing done to it is the age horizon, which does delete from it — because an older copy still on the machine goes on managing its own queue with its own rules. Two consequences, stated rather than discovered: reports queued **by** a pre-0.3.14 copy stay exposed until every copy on the machine is updated, and a **downgrade** leaves recent reports waiting in a directory the older copy does not read, until the next upgrade — only the new plugin sweeps, so under a permanent downgrade they wait indefinitely rather than ageing out. `teamflow doctor` says so when it can see a legacy queue.

Anything else that outlives a session and belongs to one organisation is filed under `accountScope(config)` for the same reason: the workflows in `workflows.json` and the projects cache. Not under `tenantId`, which is the S3 transport's tenant and is `default` on every service install. `accountScope` names the organisation the machine is **signed in to** — the account id the sign-in recorded, read from the session — and falls back to a credential fingerprint only when no account id is known. That is deliberately the stable answer rather than the true one: a token expiring mid-session must not rename the bucket a run is being written to, or the workflow would read as "no workflow yet" and the next write would start a second one beside it. Delivery asks a different question, `currentOwner`, which resolves the credential and so knows about the lapse; nothing compares the two.

**A workflow from before 0.3.14 is not adopted automatically.** Unlike a report, discarding it would discard work nothing re-creates — and unlike a report, there is no safe way to guess whose it is. The rule that was here first said "the one organisation this machine has reported for", which read its evidence from a file that every successful report writes to, so it always answered in favour of whoever was signed in: one customer's plan in the other's terminal, publishable from there into the wrong tenant, and the mirror write destroying the first customer's run. So the plugin says what it has and the person decides. `teamflow workflow show` names it in one line; `teamflow workflow adopt` lists the runs by id, name, ticket count and the bucket each came from; `teamflow workflow adopt --yes <id>` copies one into this organisation, with `--from <bucket>` to choose when two buckets hold the same id. Local, nothing sent, and the older bucket is left exactly where it is, because an older copy of the plugin may still be reading it. A run already filed under this organisation ends the question — its own bucket wins, silently, and adopt refuses.

The listing does show the *names* of workflows started before 0.3.14 to whoever is signed in on that machine, including ones another organisation may have started there. That is deliberate and it is the minimum needed to make an informed claim: the person reading it is the same human who created both runs, on their own machine, and the alternative — offering an unlabelled id — is asking somebody to guess. Nothing is read into a report, published, or claimed without the command.

The projects cache goes cold on upgrade, because its file name changed; the first command after upgrading fetches the list again.

A session that lapses has nothing to lapse to. This service issues no long-lived organisation credential, so there is no second owner for the queue to pass to: reports queued under a session that has expired wait for `teamflow login` to bring it back, or reach the seven-day horizon and go. That is the intended shape rather than a gap — a queue that changed hands on an expiry would be reports written by one credential and delivered by another.

`slot` is present only for `kind: "runtime"`. The service validates the payload against the privacy allowlist, drops any field it does not recognise, lists what it dropped in `dropped_fields`, and writes the document under the tenant its own credential names. Reporting is included in the seat: accepted reports are counted so that fair use can be told from a runaway loop, and never priced by volume.

Two fields the reporter deliberately does **not** send: `tenantId`, because the account behind the credential owns the tenant, and a payload-level `slot`, because the envelope already carries it where the service can check it against the known slots.

The actor rollup (`actors/<id>.json`) has no service equivalent yet. The allowlist knows two kinds, `issue` and `runtime`, so on the service transport the plugin publishes the issue report only.

### Answers and failure

| Answer | What the reporter does |
| --- | --- |
| 2xx | done. An identical re-post comes back `replay: true` and is not charged again |
| 402 | no reporting seat on the organisation. Logged once per session, never queued, never blocking |
| 429 | rate limited. Queued and retried after `Retry-After`, or after a backoff of 15s doubling to a five-minute cap |
| other 4xx | the service refused the report. Not retried: the same body cannot get a different answer, and one bad report must not dam the good ones behind it |
| 5xx, timeout, offline | queued and retried on the next flush, with the idempotency key it was queued with |

429 is the one retryable 4xx. The limit is 120 requests a minute for the whole account, shared by a Claude session, its subagents and CI, so it is reachable in ordinary use: nothing is wrong with the report, the caller simply arrived too fast, and the same body posted later is accepted. A queued report records `attempts` and `notBefore`; a flush skips anything not yet due, and a retry that is refused again is rewritten in place rather than re-queued, so a stale full-state document cannot sort to the back of the queue and overwrite a fresher one. `Retry-After` is honoured as seconds or as an HTTP-date, capped at five minutes, because a reporter that sleeps longer than that has stopped reporting.

The outbox lives at `<plugin data>/outbox2` — `outbox/` is the pre-0.3.14 one, see above — and is drained, up to five deliverable items at a time, after each successful report. Reporting is observability: no failure of it ever blocks Claude Code, a hook or CI.

### Legacy S3 transport

Unchanged. With `dataUri` and no service credential, every reporter resolves `tenantId` from config / `TEAMFLOW_TENANT_ID` and writes tenant-scoped objects directly:

```text
data/tenants/acme/issues/ACME-42.json
data/tenants/acme/actors/steve.json
data/tenants/acme/runtime/ACME-42/ci.json
data/tenants/acme/runtime/ACME-42/audit-dev.json
```

This prevents two clients with the same issue key or actor identifier from colliding. On the service transport the tenant prefix comes from the credential instead, and `tenantId` is local bookkeeping only.

## Issue trackers

TeamFlow binds to one tracker per project. The stage machine, reporting contract and dashboard are unchanged; only the key shape and the link differ.

| Config key | Env | Purpose |
| --- | --- | --- |
| `tracker` | `TEAMFLOW_TRACKER` | `jira` (default), `linear` or `github` |
| `jiraBaseUrl` | `TEAMFLOW_JIRA_BASE_URL` | Jira site, linked as `<jiraBaseUrl>/browse/<KEY>` |
| `linearWorkspace` | `TEAMFLOW_LINEAR_WORKSPACE` | Linear workspace slug, linked as `https://linear.app/<workspace>/issue/<KEY>` |
| `githubRepo` | `TEAMFLOW_GITHUB_REPO` | `owner/repo`; derived from `git remote get-url origin` (https and ssh) when absent |

Canonical keys:

- Jira and Linear share the shape `[A-Z][A-Z0-9]{1,19}-\d+` and are stored upper case — the same twenty characters of team key `adapters/teamflow/schema.py` accepts. The configured tracker decides how such a key is labelled and linked.
- GitHub keys are `<repo>#<n>` (repo name only, for example `daemon-core#123`) so they stay unique inside a tenant. `project` is the repo name.

### Detection sources

| Form | Where | Accepted when |
| --- | --- | --- |
| `DAEMON-142` / `ENG-42` | prompt, task, branch, commit | always; labelled with the configured tracker |
| `linear.app/<ws>/issue/ENG-42/...` | prompt, task, Linear MCP result | always; supplies the workspace when `linearWorkspace` is unset |
| `<site>/browse/DAEMON-142` | prompt, task, Atlassian MCP result | always |
| `github.com/<owner>/<repo>/issues/<n>` | prompt, task, GitHub MCP result | always |
| `owner/repo#123` | prompt, task, commit | always |
| `#123`, `fixes #123`, `closes #123` | prompt, commit | `tracker` is `github` and a repo is resolvable |
| `123-anything`, `issue-123`, `gh-123`, `feature/123-anything` | git branch | `tracker` is `github` and a repo is resolvable |
| `gh issue view <n>` / `gh issue create <n>` | Bash command, honours `--repo` | always |

### Binding by hand

`/teamflow:bind` accepts `DAEMON-142`, `ENG-42`, `#123`, `owner/repo#123` or any of the three issue URL forms, normalises to the canonical key and records the tracker. Anything else is rejected with the accepted forms.

**Every form is accepted whatever tracker is configured.** An organisation runs several trackers at once, so the form of the argument names the provider and the binding records it: a Linear URL is Linear's, `owner/repo#123` is GitHub's, and only the two forms that cannot name a provider fall back to configuration — `#123`, which is GitHub and needs `githubRepo` or a GitHub origin remote, and a bare `TEAM-123`, which is Jira or Linear. When the configured tracker is `github` a bare `TEAM-123` is certainly neither a GitHub key nor the configured tracker's, so it is recorded as Linear if `linearWorkspace` is set and Jira otherwise; bind the full issue URL to be explicit. Gating the shared-shape key on the configured tracker is what made `teamflow bind MACLEOD-507` answer the usage error in this repository.

**A worktree can bind itself.** `teamflow bind <KEY> --local` writes `.teamflow/binding.json` inside the repository root instead of under the user data directory, and the plugin's own `.teamflow/.gitignore` keeps it out of the commit (it names `binding.json`, not the directory, because `.teamflow/hooks/` is committed on purpose). It is also the automatic fallback when the data directory cannot be written, which is the ordinary case for an agent sandboxed to its worktree: `teamflow bind` there used to write nothing a hook could find, so the agent's work reported unbound or under whatever key the last bind on that machine had left — the cause of a board that looked stale for agent work. Where both files exist the newer `boundAt` wins, and a tie goes to the local one as the more specific of the two; `teamflow unbind` clears both. An orchestrator can therefore pre-bind a worktree before dispatching an agent into it.

**`teamflow work-on <KEY>` is `bind` under a name a worktree-isolation guard has no reason to refuse.** Some sandboxes refuse any command whose text contains `bind`, on the shape of the string rather than what it writes — `writeLocalBinding` only ever writes inside the repository root, but the guard cannot prove that from the command line alone. `work-on` runs the same code, under a name with no such flag: `--local` is implied when the current directory is a git worktree (its `.git` is a file, or `git rev-parse --git-dir` and `--git-common-dir` disagree) and it behaves exactly as `bind` everywhere else. This is the form CLAUDE.md's Dogfooding section tells a worktree agent to run (MACLEOD-553); where a sandbox refuses that too, the fallback is the issue key in the branch name and every commit message.

**A binding belongs to one organisation (MACLEOD-586).** A repository normally belongs to one, but a person can hold seats on several and switching is per session (MACLEOD-524), so the binding records the organisation it was made under and a binding made under another does not speak: nothing at all is reported under it, and `teamflow status`, `/teamflow:doctor` and the `SessionStart` notice say which organisation it belongs to and that `teamflow work-on <KEY>` binds it here. Without this the tenant a report lands in comes from the credential while the ticket came from the binding, so one customer's key, title, stage, summary, branch and counts were written onto another's board — every report, with no outage needed. The user binding is filed per organisation (`bindings/<organisation>/<project>.json`) rather than per tenant, which is `default` on every service install, so binding under one organisation no longer destroys the other's and switching back needs no re-bind. Nothing is migrated: a binding written before this — no organisation recorded, under the tenant — is still read, and adopted where this data directory has only ever held one organisation's work. Where it has held two there is no safe guess, so it is refused until somebody re-binds it. An install with no service credential has no organisation to compare against and behaves exactly as it always has.

**The last check is at the send point, where the credential is actually chosen.** Every check above asks which credential the configuration *names*, which is deliberately the stable answer and not the true one — a session that will not refresh is not the credential it was a moment ago, and on an install that has some other credential configured the organisation receiving a report would be that one's. So the organisation a report belongs to travels with it to `postEnvelope` and is compared there against the credential the request will carry: a mismatch is refused, never queued, and `teamflow status` prints the reason as the last publish result. A credential that names no organisation at all — a bearer token handed in with no account, which fingerprints to nothing — cannot carry a report that names one either, because "I cannot tell whose this is" and "it is theirs" have to be answered the same way. Two consequences worth knowing: an expired session stops reporting until `teamflow login` is run again, whatever else is configured on the machine, because nothing local can show that another credential is the same organisation's; and an unstamped binding in a worktree whose data directory cannot be read — the sandboxed-agent case that `.teamflow/binding.json` exists for — is refused rather than adopted, because absent evidence and unreadable evidence are not the same answer.

Binding is also where a title is learned: see below.

`/teamflow:doctor` reports the transport, the service account and whether this machine can report, the configured tracker, the resolved issue source and whether that tracker's bundled MCP server is visible; authenticate it once through `/mcp`.

### TeamFlow in `/mcp` (MACLEOD-637)

The plugin's `.mcp.json` declares TeamFlow's own MCP server beside Atlassian's, Linear's and GitHub's, so `/mcp` lists `teamflow` and gives it the same actions: view its tools, Reconnect, and enable or disable it for the project. It is an HTTP server at `https://codercat.io/mcp` with a `headersHelper` — `node "${CLAUDE_PLUGIN_ROOT}/scripts/mcp-headers.mjs"` — that Claude Code runs on every connect and reconnect. The helper prints `{"Authorization": "Bearer dat_…"}`: the machine's one-hour device access token, minted and refreshed by the same `accessToken()` call reports use — plus `X-Machine-Id`, the same random machine id reports carry, so the one-machine rule (MACLEOD-620) holds over MCP too. The service guards `/mcp` itself (`mcp.gateway_auth: "app"`) and accepts there exactly what `/v1/call` accepts; `scripts/postdeploy.sh` fails unless `/mcp` answers a tokenless `tools/list` with 401 and `WWW-Authenticate: Bearer`. The token is never a refresh token, a pre-0.3.24 `dk_` or a browser sign-in, and it is sent only when the MCP url's origin is the one the machine's authorization was issued by and the one the plugin is configured for (MACLEOD-616) — a repository's environment pointing elsewhere gets no token. Claude Code's own MCP OAuth is not used: it needs dynamic client registration, which Cognito does not offer, and the plugin's credential is the device authorization.

| What you want | How |
| --- | --- |
| Connect / authenticate | `/teamflow:login` (the consent page), then Reconnect `teamflow` in `/mcp` |
| Disable for a project | `/mcp` → `teamflow` → disable; reporting is unaffected |
| Disconnect this machine | `/teamflow:logout`, which revokes the device; the next connect prints no header |
| Check it | `/teamflow:doctor` (`teamflowMcp`: connected, tool count, or the reason); `/teamflow:status` says whether a header could be printed, without minting one |

When the machine is not authorized, or the token may not go to that url, the helper prints `{}` on stdout, the reason on stderr and exits 0, so `/mcp` shows `teamflow` as not connected rather than hanging.

### Picking the next ticket

A session that never names an issue reports nothing, and nobody notices until the work is missing from the board. `/teamflow:next` (the `next` skill, `teamflow next` from any shell) is the other end of that: it takes the top-priority open ticket, assigns it in the tracker and binds it, so the hooks attribute everything after it. On `SessionStart` and `UserPromptSubmit` a session with nothing bound is told to run it, in one sentence.

The rule is the same shape everywhere — the tracker's own priority, then the milestone or sprint, then age — and the pick is the first issue in that order that is **unassigned or already the user's**. An issue somebody else holds is skipped, so two people running it a minute apart get two different tickets.

| Tracker | Order | Read through | Assigned with |
| --- | --- | --- | --- |
| GitHub | `priority:*` labels (`p0`/`p1`/`p2`, or `high`/`medium`/`low`), then an issue with a milestone before one without and the earlier due date first, then the oldest issue | `gh issue list --json number,title,labels,assignees,milestone,createdAt --state open` | `gh issue edit <n> --add-assignee @me` |
| Linear | the `priority` field (Urgent, High, Medium, Low, then No priority), then the oldest created date | the Linear MCP server's `list_issues` | `save_issue` with assignee `me` |
| Jira | the priority field (Highest down to Lowest), then the oldest created date | the Atlassian MCP server | the MCP server's assign call |

`teamflow next` does the GitHub half itself, because `gh` is a credential the developer already has. For Linear and Jira the CLI has none and will not ask for one: adding tracker API tokens to the plugin config would put a second credential on every machine to answer a question the session's own MCP servers already answer, so the command prints the workflow to run instead. `teamflow next --dry-run` prints the ordering rule, the ordered list and the pick, and assigns and binds nothing.

The pick is always stated with its reason on one line — the key, the title and the fields the order used — because a command that assigns somebody a ticket has to be arguable with.

### Trackers

Two sources write to a ticket and the plugin owns one of them. The skill reports what happens to the **code** — edits, tests, audits, merges, builds, deploys, verification — which is every stage from `LOCAL_DEV` through `DEV_VERIFIED` plus `LOCAL_REWORK` and `DEV_REWORK`. A tracker webhook reports what happens to the **issue**: that it exists, who has it, which column it sits in, whether it is done.

What the webhooks contribute, and nothing beyond it:

- **existence** — an issue created this morning sits in the backlog column (`BACKLOG`) before anybody opens an editor, and the real ticket replaces it at the first report; a cancelled or deleted issue leaves the columns and keeps its history;
- **completion** — the tracker's "done" moves the ticket to `DONE` and sets `deliveredAt`, and a reopen after done is drawn as `DEV_REWORK` with `reworkFrom: DONE`;
- **metadata** — title, assignee, status name and labels, which overwrite whatever the plugin guessed from a branch name. The status name is a tooltip, never a column: "Ready for QA" is one team's name for another team's stage.

What a tracker event may never do is set a delivery stage the skill owns. It never moves a ticket backwards or sideways inside `LOCAL_DEV`..`DEV_VERIFIED`, so Jira saying "In Progress" about a ticket the skill already has in `DEV_TEST` is Jira being behind, and the ticket does not move. A ticket the skill has never reported is different: there, an in-progress status is the only signal there is, and it puts the ticket in `LOCAL_DEV`. Nothing is inferred from silence either: no event, no change.

No hook changes when a tracker is connected, and nothing stops when one breaks. With every connection dead the board draws exactly what the plugin and the background reporters report, which is what it drew before trackers existed. A connection is made once per organisation by an owner or admin, signed in on the dashboard, under Integrations in Organisation settings, not in this plugin's config. `teamflow trackers connect` asks the service nothing: it prints where to connect one (`<service>/app/#integrations`) and exits 0, because a change to an integration needs a person.

`teamflow status` prints one line per connection under `trackerConnections` — the provider, its project, team or repository filter, when it last delivered and its last error, which are the four things anybody asks when issues are not appearing:

```text
teamflow status
  trackerConnections:
    jira · filter DAEMON · last delivery 2026-09-17T11:00:00Z
    github · filter macleodlabs/teamflow · nothing delivered yet
```

`none connected` is an organisation that has connected nothing. `not listed: <reason>` is an answer that was not a listing — no service credential, a credential that is not an org account, or a deployment with no tracker connections enabled — and it is deliberately not reported as "none connected", because a team cannot be warned about a tracker they were never able to connect.

`teamflow doctor` prints the same lines and adds `trackerWarnings`: one when this repository reports keys from a provider the organisation has not connected (the common case, whose only symptom is issues that never appear), one when the last report's tracker is another unconnected provider, and one per connection whose last delivery failed. Reporting still works in every one of those cases; what is missing is the issue's half of the picture.

`docs/TRACKERS.md` is the reference: who decides what, the mapping table both sides test, the Jira, Linear and GitHub setup walkthroughs, and the order to check things in when a ticket does not appear.

### Projects

A session connects to exactly one project, and it does so by its repository. A project is an organisation-level named set of repositories and tracker projects; a repository belongs to at most one project per organisation and the service enforces that, so the answer is never ambiguous and never needs to be chosen.

The plugin does not stamp a project on a report and never will. A project's membership can change after a report was written, so the repository the report already carries is what decides where it is drawn, and the dashboard filters by project at read time. What the plugin does is *say* which project the work will appear under, because every board view filters by project and work from a repository in none is invisible with nothing anywhere explaining why.

`teamflow status` prints it as `project`, and there are four answers:

```text
teamflow status
  repository: macleodlabs-ai/teamflow
  project: TeamFlow
```

| `project` | What it means |
| --- | --- |
| a name | this repository is in that project, and the work appears there |
| `none — this repository is in no project; add it from the header's project switcher` | the work still lands and nothing is lost, but no board view will draw it |
| `the organisation's default` | the session is not in a git repository at all, so there is nothing to match on |
| `unknown` | the service could not be asked. Not the same as `none`: one says try again, the other says add the repository to a project |

`teamflow doctor` prints the same line and raises the `none` case as `projectFindings`, in the same words. The matching is `src/lib/projectFilter.ts`'s — case-insensitive `owner/repo`, falling back to the last path segment — deliberately, because a plugin that decided a repository was in one project while the board drew it in another would be two answers to one question. A worktree resolves to the same project as the repository it was made from: it is its own repository root, but it is the same repository.

The list is fetched from `GET /v1/members/projects` and cached for five minutes beside the bindings, keyed by tenant. Everything about it fails open. No credential, no network, a service with no projects route, a data directory that cannot be written: reporting is untouched in every case, `/teamflow:login` prints the project line as `unknown`, and the `SessionStart` hook — which is the only event that mentions the project, once, after the ticket — says nothing at all rather than raising an alarm about something that does not affect the work.

## Ticket binding confidence

| Source | Confidence |
| --- | ---: |
| Manual `/teamflow:bind` | 1000 |
| Atlassian, Linear or GitHub tool result, `gh issue` command | 110 |
| User prompt | 100 |
| Claude task | 98 |
| Git branch | 95 |
| Latest commit | 80 |

Substantive work makes an automatic binding sticky. A manual bind can override it.

### Title and status from a tool result

A bound ticket gets its name on the board without a hand-written report.
When the agent looks the issue up — through the Atlassian MCP, the
Linear MCP, a GitHub MCP tool or `gh issue view` — that result is put
through one seam, `enrichFromToolResult(tracker, result)` in
`plugin/scripts/core.mjs`, with one parser per tracker:

| Tracker | Read from | Title | Status |
| --- | --- | --- | --- |
| Jira | Atlassian MCP result | `summary`, or `title` | `status`, plain or wrapped in `{ name }` |
| Linear | Linear MCP result | `title` | `state`, plain or wrapped in `{ name }` |
| GitHub | GitHub MCP result, or `gh issue view` output | `title` | `state` |

Only the bound ticket is enriched. A result naming another key, or
another repository's `#17`, is dropped: a wrong title on the board is
worse than no title. Title is cut at 180 characters and status at 80.

The reporting contract is the hard limit. Key, link, short title and
short status, and nothing else — no description, no comment, no body.
The `gh issue view` parser stops at the `--` separator for exactly that
reason, because everything after it is the issue body.

### The title nothing looked up

An agent that never opened the issue leaves the board with a key and a
stage summary and no name. `teamflow bind` resolves the title once, and
so does the first report for a key whose binding carries none.

Only GitHub is asked, and only with a credential the developer already
has: `gh issue view <n> --repo <owner/repo> --json title,state` when
`gh` is installed and authenticated, otherwise
`https://api.github.com/repos/<owner>/<repo>/issues/<n>` unauthenticated,
which answers for public repositories and fails in silence for
everything else. Jira and Linear are never asked — that would mean an
API token this plugin has never needed — so their titles keep coming
from the tool results above.

The answer is cached on the binding file, including the fact that a
lookup found nothing, so the question is asked once and not once per
report. A lookup that failed at bind time is retried by the first
report and then closed. The lookup never creates a binding file: doing
so would promote an automatically detected key to a manual, sticky one.

Environment variables exist so the tests can never reach github.com:
`TEAMFLOW_GH_BIN` points `gh` at a stub, `TEAMFLOW_GIT_BIN` does the same
for `git`, and `TEAMFLOW_GITHUB_API` points the REST fallback somewhere
else. They sit beside `TEAMFLOW_CLAUDE_BIN`, which does the same for
`claude`.

The REST host is pinned (MACLEOD-623). A repository can set an
environment variable, and a title lookup sent where it chose would let it
write card titles onto somebody else's board, so `TEAMFLOW_GITHUB_API` is
honoured only when it names this machine (a loopback address, which is
what the tests use). Everything else goes to `api.github.com`, unless the
user's own `~/.config/teamflow/config.json` names a GitHub Enterprise API
as `githubApi` (https only) — the one file a repository cannot reach, and
the rule `serviceUrl` already follows. Whatever comes back is stripped of
control characters and cut to GitHub's own 256-character limit before it
is stored on the binding or drawn on a card.

`gh` itself gets the same treatment: `TEAMFLOW_GH_BIN` names a stub only
inside the test sandbox, `GH_HOST`, `GH_REPO`, `GH_ENTERPRISE_TOKEN`,
`GITHUB_ENTERPRISE_TOKEN` and `GH_CONFIG_DIR` are removed from its
environment, and the repository must be `owner/name` before it is passed as
`--repo`.

**"The user's own file" is the account's, not `$HOME`'s** (MACLEOD-623).
`~/.config/teamflow/config.json` and the session are found from
`os.userInfo().homedir`, because a repository can set `$HOME` and the
global file is the one place that must be out of its reach. The tests
redirect HOME, so `$HOME` is honoured only after `enableTestHome()` has run
inside the process: `plugin/tests/sandbox.mjs` calls it, and every plugin
process a test spawns loads `plugin/tests/child-sandbox.mjs` through
`--import` (in `NODE_OPTIONS`, set by the sandbox and the integration
helpers). It fails closed: `TEAMFLOW_TEST_SANDBOX=1` where that import never
ran, or no account record for the user, means no credential is read,
nothing is reported, and `status`/`doctor` say which.

### Where the branch is, and what its PR is doing

Every issue report carries two more blocks of derived state, so the card
dialog can answer "is it in yet" without anybody opening GitHub:

```json
"git": { "branch": "feature/510-card-dialog",
         "head": { "sha": "a1b2c3d4e5f6", "subject": "feat: card dialog (#17)" },
         "commitsSinceMain": 3, "ahead": 0, "behind": 0,
         "pushed": true, "dirty": false },
"pr":  { "number": 42, "url": "https://github.com/macleodlabs/daemon-core/pull/42",
         "state": "open", "mergeable": "clean",
         "checks": { "passing": 1, "failing": 0, "pending": 1 },
         "review": "pending" }
```

- `git` comes from local `git` alone: the branch, the head commit,
  `rev-list --count <default>..HEAD`, `rev-list --left-right --count
  @{upstream}...HEAD` for ahead and behind, and `status --porcelain` for
  dirty. A branch with no upstream has never been pushed. The default
  branch is `origin/HEAD`, or `defaultBranch` in `.teamflow.json`.
  Absent outside a repository.
- `pr` comes from `gh pr view --json
  number,url,state,isDraft,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision`.
  `state` is `open`, `draft`, `merged` or `closed`; `mergeable` is
  `clean`, `conflicting` or `unknown`; `review` is `approved`,
  `changes_requested`, `pending` or `none`. Absent when there is no
  `gh`, no authentication, no pull request or no repository — every one
  of those fails in silence, because none is a problem a report should
  carry and none may interrupt a hook.

The contract still holds: counts, flags, a number, a link and four
enumerated verdicts. The head commit's subject line is the only text,
and nothing reads a commit body, a diff or a file list.

`git` is local and refreshed on every report. `pr` is a round trip to
GitHub and a hook fires on every tool call, so it is refreshed at most
every `prRefreshMs` (30s by default) and always on a forced publish —
the Stop hook at the end of a turn, and `/teamflow:sync`. That is what
moves a pull request from "checks pending" to "approved" on the board
with nobody editing a file.

## Audit semantics

- local tests pass → `LOCAL_TEST`
- local audit passes → `LOCAL_AUDIT`
- local audit fails → `LOCAL_REWORK`, `reworkFrom=LOCAL_AUDIT`
- dev tests pass → `DEV_TEST` (not verified yet)
- dev audit passes → `DEV_VERIFIED`
- dev audit fails → `DEV_REWORK`, `reworkFrom=DEV_AUDIT`

The dashboard uses `reworkFrom` to draw the loop from the exact failed gate.

## Background reporters

Deterministic sidecars support:

- `ci`
- `audit-local`
- `deploy`
- `dev-test`
- `audit-dev`
- `security`

Example:

```bash
node plugin/scripts/runtime-report.mjs \
  --jira ACME-42 \
  --slot audit-dev \
  --kind audit \
  --label "Dev architecture audit" \
  --stage DEV_AUDIT \
  --status running \
  --summary "Auditing deployed acceptance evidence"
```

The reporter posts `{ "kind": "runtime", "slot": "audit-dev", "payload": ... }` to the service, signing in per job when it runs in GitHub Actions. `--tenant` is legacy and applies only to the S3 transport. Background reporter failure always exits successfully so observability cannot break delivery.

### A gate's start and finish, from CI

A sidecar written once as `running` and never rewritten was the live board's deploy gate for 41 hours (MACLEOD-639). So a sidecar carries a lifecycle: `startedAt` is what its deadline is measured from, `endedAt` is what closes it, and `url` is a link to the run itself — the customer's own CI page, never its output (https, one line, at most 512 characters, or the report is refused with a sentence). `runtime-report.mjs` takes `--started <iso>`, `--ended [<iso>]` and `--url <https>`; a `running` report is started now unless told otherwise, and any terminal status is ended now unless told otherwise.

`teamflow ci` is the two lines a workflow author writes. `start` writes the gate as running with the runner's own link, `end` or `fail` closes it with the same id and the start's clock, and the gate id is any string your pipeline uses — `deploy`, `test`, `sonar`, `smoke-eu` — landing in the slot its family suggests:

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write          # the reporter trades this for a one-hour token; no secret
    env:
      TEAMFLOW_JIRA_KEY: ${{ github.event.inputs.jira }}
    steps:
      - uses: actions/checkout@v4
      - run: npx -y github:macleodlabs-ai/teamflow-plugin ci start deploy
      - run: make deploy
      - if: success()
        run: npx -y github:macleodlabs-ai/teamflow-plugin ci end deploy
      - if: failure() || cancelled()
        run: npx -y github:macleodlabs-ai/teamflow-plugin ci fail deploy --summary "deploy step failed"
```

The terminal step runs under `always()`-shaped conditions so a cancelled or failed job still closes the gate; `.github/workflows/teamflow-runtime-example.yml` is the same shape as a whole file. A gate reported this way is external to the plugin: it is never retried by the plugin, whatever happens to it.

`teamflow ci run <gate> -- <command>` is the third form, for a gate the plugin should run itself: it reports the start, runs the command, and when the command fails or gives no verdict within **twice** the gate's deadline (the command is killed then, and never at the 1× the board only draws doubtfully at) it retries it — the policy below — with every try on the sidecar as `attempts[]` and the reason it is still going as `retry`. The step exits with the command's last exit code, so it still fails when the gate does. The key is any shape the service takes: `CORE-217`, or `owner/repo#12` for a GitHub tracker.

## What the plugin does when a gate fails or goes quiet

The owner's rule: a started gate with no finish past its deadline is "no verdict", never "running forever"; and it is up to the plugin to fix and re-run a gate, while a person is only told there is a delay, and why. Deadlines are deploy 30 min, CI and test 2 h, audit 1 h, per gate family, overridable per organisation under `delivery.gate_deadlines` (minutes, by slot or family; the same numbers the service serves in the bundle). The board draws a running gate as doubtful at 1× its deadline; the plugin writes it closed (`idle`, "no verdict for N") at 2×, and never before, so a deploy that takes 45 minutes is amber at 30 and nothing is written until 60. The 2× lives inside the one derivation (`gateStatuses` in `workflow.mjs`), so the verdict and the revisit cannot disagree and a gate cannot take turns between answers.

Before it gives up, the plugin retries. The policy is one pure function, `decide()` in `selfheal.mjs`, and it says one of three things about a gate: re-run it (which attempt, when), it is delayed (why), or nothing. Three attempts by default (`delivery.retry.attempts`, or the bundle's `adapter.delivery.retry`):

- A **failed** gate is re-run at once — during a `/teamflow:build` run that means the agent fixes it and puts the ticket back at the gate, and the running verdict it writes carries `retry {attempt 2, of 3}`. After the last attempt, or when the rework loop reaches sixteen, the gate is `failed` with `retry.status: delayed`, the reason and `notifiedAt`, and the run is `stalled` at that gate.
- A **silent** gate is given 1× its deadline, then 2×, then 4× — each attempt's window doubles — and re-run by the orchestrator on the next phase tick (`teamflow workflow ticket`, any ticket) and at session start, with a fresh clock. After the last window it is a delay, the same way.
- A **stalled run whose blocking gate later reports** — a deploy that finally answers, a CI job that finishes — resumes by itself at the next session start or `teamflow status`: the ticket moves past the gate (or into rework if the verdict was a failure), the run is running again, and one `hygiene[]` row on the run says `resumed after deploy gate verdict`.

What a person sees is the plugin's own state in its own words: the session-start line reads `TeamFlow: deploy gate on MACLEOD-573 delayed · 3 attempts · deploy command exited 1` or `TeamFlow: resumed plan Onboarding hardening after the deploy gate verdict on MACLEOD-573`, and nothing when there is nothing to say. It never contains anybody's request and never a command for the reader to run; nothing is queued for anybody's next session.

### What a lead can ask the plugin to do

A lead watching the board can still act — from the dashboard, as a named intent the service holds for the machine that has the ticket. At every hook round, at session start and in `teamflow status` the plugin asks `GET /v1/members/actions?for=<machineId>`, performs each action it can, answers each with an outcome (`done`, `refused` or `failed`) and its own sentence of at most 120 characters, and never repeats one. Five kinds, and nothing else is an action:

| Kind | What the plugin does |
| --- | --- |
| `fix` | Shows the text (≤ 500 characters) to the agent as `Fix from Steve, 10:12: …`, in the person's name, as guidance. Never executed, never passed to a shell, never authority over the session's rules. |
| `bump` | Restarts the retry policy for the stalled gate on that key now, not at its deadline. |
| `rerun_gate` | Runs the gate again when this machine knows how: a command configured under `delivery.gate_commands` **in your own `~/.config/teamflow/config.json`** (an argv array, or one string split on whitespace; never text from the action, and never from a `.teamflow.json` inside a clone — `delivery` is ignored there), through `teamflow ci run` in the background, reported `done` once the process has started. Only the run's own gates (`test`, `audit`, `deploy`): an external gate such as SonarQube is refused — the plugin never retries what it did not run. Refused with the reason when no command is configured, and `deploy runs only from the main session` from a worktree. |
| `resume_plan` | Puts the run back to running and tells the session which phase is ready. |
| `skip_gate` | Passes the ticket over the gate in the person's name: the gate reads `idle` with `skipped by Steve: flaky suite, verified by hand` — never `success`, which only a run earns — and the run records a `hygiene[]` row saying who. A reason is required; only ever from the service, after its own authority check. |

An action for a ticket no session on this machine is on waits, and the next session bound to that ticket — on any of the developer's machines the service chooses — is shown it first, from the machine's own ledger. Each action is written to that ledger as taken *before* it is performed, so a hook killed halfway never runs a re-run twice. What the ticket's report carries is `actions[] {id, kind, by, at, outcome, reason}`: outcomes and the plugin's sentence, never the action's text. `teamflow config set intake off` makes this machine perform nothing and answer every action `refused: intake off on this machine`, so the lead learns why; `on` (the default) turns it back. The round runs on the async hook path (`Stop`) and in `teamflow status`, never at session start, which does no network at all and only prints what the last round left for it; every call in a round shares one budget, so a service that does not answer costs a round its budget once and never a hook that hangs.
## External gates: SonarQube

The columns of the delivery flow are gates in a pipeline (MACLEOD-639). An
organisation on the Growth plan or above can make an external system one of
them, and SonarQube is the first. It reports the way a CI job does — as a
runtime sidecar, in a `sonarqube` slot of its own that only the webhook can
write — but nothing runs on your machine: SonarQube posts its own webhook to
TeamFlow at the end of every analysis, signed with a secret you paste once.

What lands on the board is the quality gate's verdict for the ticket the
analysed branch belongs to: `success` when the gate passed, `failed` with the
failing conditions as metric names and numbers (`new_coverage 63.2 < 80`),
`idle` when the project has no quality gate. No finding, no rule text, no file
name and no line of code leave SonarQube for TeamFlow.

### Connecting SonarQube

1. **Make the connection.** It is a paste-connect like a Jira webhook
   (docs/TRACKERS.md, appendix), with the provider `sonarqube` and, if you
   want only one SonarQube project, its key as the filter. Until the members
   page offers the button, an owner does it with the dashboard's access token:

   ```bash
   curl -X POST https://codercat.io/v1/members/trackers \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"provider": "sonarqube", "filter": "my-service"}'
   ```

   The answer carries the webhook `url` and the `secret`, **shown once**.

2. **Create the webhook in SonarQube.** Project Settings → Webhooks →
   Create (or Administration → Configuration → Webhooks for every project):

   | Field | What to put in it |
   | --- | --- |
   | Name | `TeamFlow` |
   | URL | the `url` TeamFlow answered with |
   | Secret | the `secret` TeamFlow answered with |

   SonarQube signs every delivery with `X-Sonar-Webhook-HMAC-SHA256` over the
   body using that secret; a delivery that does not verify is refused and the
   connection's last error says so.

3. **Name the ticket.** SonarQube tells TeamFlow the analysed branch, and a
   branch named `feature/ACME-42-rate-limit` is ACME-42 by the same rule the
   plugin binds a branch with. A pull request analysis names the pull
   request's number and not its branch, so it cannot be attributed from the
   payload alone; pass the key or the branch to the scanner instead, and it
   is read first whether the analysis is a branch or a pull request:

   ```bash
   sonar-scanner -Dsonar.analysis.teamflow.key="$GITHUB_HEAD_REF"
   ```

   An analysis that names no ticket is accepted and ignored, so `main` never
   puts a card on the board; and a branch that looks like a key nobody in
   your organisation uses (`next-15`) is accepted and not written, by the
   same rule that keeps a Dependabot pull request off the board.

4. **Give it a column.** An owner adds an external gate to the
   organisation's pipeline (`PUT /v1/members/pipeline`, Growth and above):

   ```json
   {"id": "quality", "label": "SonarQube", "stages": [], "kind": "external",
    "rework": true, "deadlineMin": 60,
    "external": {"system": "sonarqube", "project": "my-service"}}
   ```

   With the gate in place the verdict is drawn in that column; without one it
   is drawn at Local Audit under the gate id `sonarqube`, so the connection
   works before the pipeline is edited. `project` is optional: a gate that
   names one matches only that SonarQube project, a gate that names none
   matches every project on the connection.

SonarQube fires once, when the analysis finishes, so the sidecar carries
`endedAt` and never a `startedAt` it did not see. A start/finish/error system
that does have a start — a CI reporter — writes both through
`plugin/scripts/runtime-report.mjs`, and a gate that started and never
finished is "no verdict" past its deadline on the board.

## Reporting by hand

`teamflow report` posts one stage transition from any shell, through the
same transport with the same credential. It exists so a tool that is not
Claude Code can move a ticket: an IDE task, a git hook, an npm script, a
run configuration.

```bash
npx -y github:macleodlabs-ai/teamflow-plugin report --issue DAEMON-142 \
  --stage LOCAL_TEST --status success --summary "42 tests, 0 failing"
```

`--issue` accepts everything `/teamflow:bind` accepts. `--stage` is one
of the thirteen stages and is checked locally, so a typo costs a message
rather than a refused report. `--dry-run` prints the envelope without
posting it, and `teamflow report --help` lists every flag.

Two differences from the plugin worth knowing:

- **Each invocation is one report.** The plugin skips an unchanged
  heartbeat because it compares against the state it last sent; a CLI
  run has no such state and always carries the clock. Reporting is
  included in the seat and is not priced by volume, but a timer is
  still the wrong caller: it fills the board with repeats of an
  unchanged state and is what fair use is measured against. Call it at
  a transition.
- **It reports the ticket's own document**, the same object the plugin
  owns. A background job that owns a sidecar should keep using
  `runtime-report.mjs` instead, so the two do not contend.

A bad argument exits 2 and names it. Everything else, a refused, queued,
rate-limited or unreachable service, exits 0, because a reporting
failure must never break a push or a build.

## The package, and where it is published

`plugin/` is mirrored flat to the public repository
[macleodlabs-ai/teamflow-plugin](https://github.com/macleodlabs-ai/teamflow-plugin)
by `npm run plugin:publish` (`scripts/publish-plugin.sh`), which tags
each push with the version in `plugin/package.json`. That repository is
both the Claude Code marketplace and the thing `npx -y
github:macleodlabs-ai/teamflow-plugin` fetches, so one push serves both
install paths.

It is deliberately not a registry install. The package keeps the name
`@macleodlabs/teamflow` so a later npmjs publish changes nothing, but
npmjs needs an interactive browser login and GitHub Packages needs a
token even to read a public package, so neither can back a bare `npx
-y`. A public git repository can, and needs no account at all.

Its `teamflow` bin is `plugin/scripts/cli.mjs`: the same script the
plugin's own skills call. That is what makes the skills portable,
because a skill body can name a command that exists whether or not
Claude Code is running.

| Subcommand | |
| --- | --- |
| `login`, `logout`, `status`, `bind`, `work-on`, `next`, `unbind`, `sync`, `doctor`, `repos` | the ten the plugin's skills wrap |
| `admin code` (`create`, `list`, `revoke`) | invite codes, for superadmins; the ninth skill wraps it |
| `report` | one stage transition, from any shell |
| `skills install --for <tool>` | put these skills in front of another agent |
| `hooks` (`status`, `install`) | what reports automatically in this repository, and the git fallback |
| `hook --for <tool>` | the hook entry itself; a tool's hook configuration calls it |

## Portable skills

Every skill in `plugin/skills/*/SKILL.md` is an Agent Skill: frontmatter
with `name` and `description`, a body with the exact command. The body
names the tool-agnostic form,

```bash
npx -y github:macleodlabs-ai/teamflow-plugin status
```

and then names the plugin fast path, `node
"${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" status`, which is the same
command without the npx round trip and is what Claude Code uses. The
slash commands are unchanged: the skill's `name` is still its directory,
so `/teamflow:status` is still `/teamflow:status`.

One command installs the same files into another tool:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin skills install --for cursor
```

A tool that discovers `SKILL.md` files gets them copied, prefixed
`teamflow-` so they do not collide in a shared skills directory. A tool
that only reads a rules file gets that rules file generated from the
same `SKILL.md` sources at install time, which is why there is no second
copy of the instructions to keep in step. The per-tool paths and formats
are in [CLIENTS.md](CLIENTS.md).

## Other IDEs and agent tools

Claude Code was the only automatic client for as long as it was the only
one with a hook. Seven of the other ten have one now, and TeamFlow uses
it: `teamflow skills install --for <tool>` writes that tool's hook
configuration alongside its skills, and the hooks call `teamflow hook
--for <tool>`, which translates that tool's payload into the shape
`classifyTool` already reads.

There is one classifier. An adapter in `plugin/scripts/adapters.mjs`
renames fields and nothing else — it never decides a stage — so a
`LOCAL_TEST` from Cursor and a `LOCAL_TEST` from Claude Code are the
same report with the same summary. A second classifier would drift, and
a stage that appeared in one tool and not the other would be wrong on
the board long before anybody noticed.

Per-tool install, sign-in and configuration are in
[CLIENTS.md](CLIENTS.md). `plugin/scripts/tools.mjs` is the same
information as data, one record per tool, and is what the site reads.

### What is automatic, per tool

Every URL below was read on 2026-09-17 and re-read on 2026-09-18. What
each re-read found is recorded per tool in `verified` in
`plugin/scripts/tools.mjs`, and the client guides render it, because
"the vendor documents this" and "this was watched arriving" are
different claims and a reader deciding whether to trust a board is owed
the difference. `from: 'docs'` is a vendor page, `'source'` is the
tool's own code, and `'run'` — which nothing claims yet — means the
plugin was installed in that tool and the payload was watched arriving.
[What still needs a real run](#what-still-needs-a-real-run) is the list.

| Tool | Level | Where the hooks go | Events TeamFlow subscribes to |
| --- | --- | --- | --- |
| Claude Code | hooks | in the plugin | `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `TaskCompleted`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd` |
| [Cursor](https://cursor.com/docs/agent/hooks) | hooks | `.cursor/hooks.json` | `afterFileEdit`, `postToolUse`, `postToolUseFailure`, `afterShellExecution`, `stop` |
| [VS Code + Copilot](https://code.visualstudio.com/docs/copilot/customization/hooks) and [Copilot CLI](https://docs.github.com/en/copilot/reference/hooks-reference) | hooks | `.github/hooks/teamflow.json` | `PostToolUse`, `PostToolUseFailure`, `Stop` (VS Code); `postToolUse`, `postToolUseFailure`, `agentStop` (CLI) |
| [Windsurf](https://docs.devin.ai/desktop/cascade/hooks) | hooks | `.windsurf/hooks.json` | `post_write_code`, `post_run_command`, `post_cascade_response` |
| [Cline](https://cline.bot/blog/cline-v3-36-hooks) ([payload schema](https://github.com/cline/cline/blob/main/.clinerules/hooks/README.md)) | hooks | `.clinerules/hooks/PostToolUse` | `PostToolUse` |
| [OpenAI Codex CLI](https://learn.chatgpt.com/docs/hooks) | hooks | `.codex/hooks.json` | `PostToolUse`, `Stop` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md) | hooks | `.gemini/settings.json` | `AfterTool`, `AfterAgent` |
| [JetBrains Junie](https://junie.jetbrains.com/docs/junie-cli-hooks.html) | hooks | `~/.junie/config.json` | `PreToolUse`, `Stop` |
| [Zed](https://zed.dev/docs/ai/agent-panel) | git hooks | `.git/hooks/` | `post-commit`, `post-merge`, `pre-push` |
| [Aider](https://aider.chat/docs/usage/lint-test.html) | git hooks | `.git/hooks/` | `post-commit`, `post-merge`, `pre-push` |
| [Claude Desktop](https://code.claude.com/docs/en/desktop) | rules | nothing on disk | none |

**Cursor** is the closest thing to Claude Code here: it has a distinct
`postToolUseFailure`, so a red test run reports `LOCAL_REWORK` rather
than a green gate. `afterShellExecution` documents `command`, `output`,
`duration` and `sandbox`, and as of **2026-09-18 still no exit status**,
so TeamFlow only classifies it when Cursor does supply an exit code; the
definite signal comes from `postToolUse` and `postToolUseFailure`, which
carry `cwd` and `tool_output` of their own.

**Copilot** reads `.github/hooks/*.json` from both the VS Code agent and
Copilot CLI, in two dialects of the same idea. One file registers both:
VS Code's PascalCase event names beside Copilot CLI's camelCase ones. A
tool never fires an event name it does not know, so the halves it does
not recognise cost nothing. Copilot CLI's payload names no event at all,
which the adapter handles by taking a payload that names a tool as a
finished tool call.

The 2026-09-18 re-read of the [hooks
reference](https://docs.github.com/en/copilot/reference/hooks-reference)
found that the two dialects diverge inside the result as well as around
it — `toolResult.resultType` for the CLI against `tool_result.result_type`
for VS Code, and `postToolUseFailure` against `PostToolUseFailure` — and
the adapter was reading only the CLI half of each pair. So a failed tool
call in the VS Code agent was dropped, and a `tool_result` saying
`failure` read as a pass: a red suite reported as a green `LOCAL_TEST`
in the IDE half of a single install. Both halves are read now, and
`PostToolUseFailure` is registered in `.github/hooks/teamflow.json`
beside the camelCase one. `toolArgs` is documented as the parsed
arguments and has been seen as the JSON string of them; both are
accepted.

**Windsurf** puts everything under `tool_info` and, like Cursor,
documents no exit status for `post_run_command` — checked again on
**2026-09-18**, where that event's `tool_info` is `command_line` and
`cwd` and nothing else, not even the output. Writes are reported;
commands whose outcome is unknown are not. The adapter still reads an
exit code and an output if either appears, so the release that adds one
needs no change here.

**Cline** has no hooks config file: the hook is an executable named
exactly after the event, which is why the install writes
`.clinerules/hooks/PostToolUse` and nothing else. Hooks also have to be
switched on once in Settings → Features before Cline will run it, and
Cline's hooks are macOS and Linux only, which is why no `.ps1` is
written for it.

Cline's field names are the one set here taken from a tool's own
repository rather than a vendor page, because the vendor page does not
print them: [`.clinerules/hooks/README.md`](https://github.com/cline/cline/blob/main/.clinerules/hooks/README.md),
read 2026-09-18, gives the payload as a schema. It settled two things
the adapter had guessed at. The event body is `postToolUse` with
`toolName`, `parameters`, `result`, `success` and `executionTimeMs`, and
those are the only spellings — the adapter also accepted `tool_name`,
`toolInput` and `response`, none of which exist, and they are gone,
because an alternative that is wrong is not tolerance but a place for a
real drift to hide. And `success` is a **sibling** of `result`, not
something inside it, while `result` is a string: the adapter was looking
for the outcome inside the result the way every other tool's does,
finding nothing there, and calling every failed Cline tool call a pass.
`success` is read directly now. Of the six documented hook names Cline
fires today, `TaskComplete` is marked "coming soon"; it is mapped
anyway, so the release that ships it is not a silent gap.

**Codex CLI** adopted Claude Code's hook shape field for field, down to
`tool_input` and `tool_response`, so its adapter is almost a
passthrough; only `apply_patch` needs a name mapping.

**Gemini CLI** parses a hook's stdout as JSON, so TeamFlow's hook prints
exactly `{}` and logs to stderr. Its tool names are `write_file`,
`replace` and `run_shell_command`.

**JetBrains Junie** fires `PreToolUse` and no `PostToolUse` at all, and
only reads `~/.junie/config.json` — a project config is ignored unless
Junie is passed `--config-location`. An intended edit is honestly
`LOCAL_DEV` running, so that is reported. An intended test run is not
evidence of anything, so it is dropped, and the gates need the git
fallback. Junie CLI is what has hooks; JetBrains AI Assistant in the IDE
has only two built-in actions (reformat, inspect) and no custom command
hook.

**Zed** has no agent hook a local command can subscribe to. The pull
request that would have added `agent.hooks.pre_tool_use` was closed
unmerged; the open discussion has no commitment behind it.

**Aider** has no hook system either, but it commits after every edit by
default, and `--no-verify` skips only `pre-commit` and `commit-msg`, so
the `post-commit` hook still fires. In practice the git fallback tracks
an Aider session closely.

**Claude Desktop** has two halves. The Code tab reads the same settings
files as the Claude Code CLI, so installing the plugin there gives it
the full automatic path. The chat side runs no local command and has no
hooks, which is why `--for claude-desktop` writes a rules document to
paste into a Project rather than a config file.

### Windows and PowerShell

Every hook config is committed, so the repository is shared between the
Mac and the Windows halves of a team and both have to report. A
`#!/bin/sh` shim run by PowerShell reports from neither, so the install
writes a second shim, `.teamflow/hooks/<tool>.ps1`, for each tool whose
vendor documents a Windows form. It calls the same entry, `teamflow hook
--for <tool>` through `npx` when `teamflow` is not on PATH, and exits 0
whatever happens, exactly like the POSIX one.

| Tool | Windows form | What the config says |
| --- | --- | --- |
| Copilot CLI | a `powershell` field beside `command` | one entry naming both shims |
| Windsurf | a `powershell` field beside `command` | one entry naming both shims |
| Cursor | none; `command` runs through the platform shell | two entries per event, one shim each |
| Cline, Codex CLI, Gemini CLI, Junie | none documented | POSIX shim only |

Cursor is the awkward one. It has no Windows field, and a single command
string cannot be right for both `sh` and PowerShell, so both shims are
registered and the platform decides which one it can run. The `.ps1`
starts with `#!/usr/bin/env true`, which is not a mistake: a POSIX shell
handed that file execs `true`, ignores the PowerShell below it and exits
0 silently, so on macOS and Linux exactly one of the two entries reports
and the board never double-counts. PowerShell reads the same line as a
comment. The reverse — PowerShell handed the `.sh` — logs one ignorable
"not recognized" per tool call and reports nothing, because nothing in a
`.sh` file can be made invisible to PowerShell.

Nothing is invented for the four tools whose vendors document no Windows
form. A field their parser rejects would be worse than none, and the git
fallback below covers a Windows developer using one of them.

### Where a shim runs, and from which directory

Every hook config names the shim relative to the repository root, since
the configs are committed and an absolute path would name the
installer's home directory. What no tool here promises is the *working
directory* it runs the shim with, and several events carry no `cwd` of
their own — Cascade's `post_write_code` has none, nor has Cursor's
`stop` — so the process's own directory is what decides which project
the report belongs to. A subdirectory resolves to a different project
id, which is a different binding: a ticket that stops moving with
nothing in any log to say why.

So each repository shim puts itself back at its root before reporting.
`.teamflow/hooks/<tool>.sh` and Cline's `.clinerules/hooks/PostToolUse`
both sit exactly two levels below it, and the `.ps1` does the same with
`$PSScriptRoot`. Junie's shim is the exception and is written without
it: it lives at `~/.junie/teamflow-hook.sh`, where two levels up is the
home directory's parent, and Junie's payload carries `cwd` and
`project_path` to key the report on instead.

The shim can only answer for the directory the *process* starts in, and
an event that carries its own `cwd` overrides it — Cursor's
`postToolUse` and Copilot's both name the edited file's directory, and
Claude Code's own events name the subfolder a session was started in. So
every hook entry resolves whatever directory it ends up with to the
repository root before anything is derived from it: `repositoryRoot` in
`plugin/scripts/core.mjs` runs `git rev-parse --show-toplevel`, cached
per directory for the life of the process, and the root it returns is
what the project id, the binding file, `.teamflow.json` and the report's
repository and branch are all read from. Outside a repository, and on a
machine with no git, the directory is its own answer: neither is an
error, and a reporter that treated them as one would fail closed. The
one event that does not ask is `SessionEnd`, which has a 1.5s budget and
reuses the root the session already recorded. `teamflow bind` and
`teamflow status` resolve the same way, so binding in a package
directory and reporting from the root still name one project.

### What still needs a real run

Everything above is from documentation or from a tool's own source. None
of it is from watching a payload arrive, which is a different kind of
evidence and the only kind that catches a vendor page that is simply
out of date. For each tool the check is the same three steps: install,
do one thing, look at the board.

1. In the repository, `npx -y github:macleodlabs-ai/teamflow-plugin hooks install --for <tool>`,
   then `teamflow hooks status` to confirm the files.
2. Open the tool on that repository, and from the agent: edit one file,
   then run the test command, then run it again with a deliberately
   failing test.
3. `teamflow status` after each. The edit should read `LOCAL_DEV`
   running, the green run `LOCAL_TEST` success, the red run
   `LOCAL_REWORK` with `reworkFrom` = `LOCAL_TEST`.

What to watch for per tool, beyond that:

- **Cursor** (installed on this Mac, so this is the first one to do).
  Whether `afterShellExecution` has grown an exit status since
  2026-09-18 — if the red run reports `LOCAL_REWORK` at all, it has, and
  the adapter already reads `exit_code`, `exitCode` and `status`. Also
  whether `postToolUse` carries the agent's `cwd` as a subdirectory:
  compare the project in `teamflow status` against the repository root.
- **Windsurf**. Whether `post_run_command`'s `tool_info` carries
  anything about the outcome. If the red run reports nothing at all,
  it does not, and that is the documented behaviour rather than a bug.
- **Cline**. That `success: false` arrives on a failed `execute_command`
  and that the board shows `LOCAL_REWORK`. Hooks must be enabled in
  Settings → Features first, or nothing runs at all and it looks
  identical to a broken adapter.
- **VS Code with Copilot**. That the IDE fires `PostToolUseFailure`
  rather than only the CLI's `postToolUseFailure`, and that its result
  arrives as `tool_result`. Both are registered and both are read, so
  the check is that exactly one report lands per tool call and not two.
- **Any of them, from a subdirectory**. Open the tool on a
  subdirectory of the repository rather than its root, edit a file, and
  confirm `teamflow status` still names the repository. The shim's `cd`
  and `repositoryRoot` cover the two halves of this between them, and a
  failure here says which: a report against the subdirectory means the
  resolver did not run, none at all means the shim did not.

### The git fallback

For a tool with no hook system, and for any team that would rather not
depend on one:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin hooks install --git
```

That writes three marked blocks into this repository's `.git/hooks`:

| Hook | Reports |
| --- | --- |
| `post-commit` | `LOCAL_DEV`, work in progress |
| `post-merge` | `MERGE` |
| `pre-push` | `LOCAL_TEST`, or `LOCAL_REWORK` naming `LOCAL_TEST`, after running the configured test command |

Reporting is then on commit rather than per tool call. It is coarser,
and it happens whether or not a model remembered.

`pre-push` does nothing until `testCommand` is set in `.teamflow.json`,
because a push is not evidence that anything passed:

```json
{ "testCommand": "make check" }
```

With that set, the push runs `make check`, shows its output, reports the
result, and pushes either way. Nothing TeamFlow installs can fail a git
operation: each block ends in `|| true`. A command the built-in patterns
would not recognise, like `make check`, is matched literally against
`testCommand`, which is what makes a project like that reportable at
all.

An existing hook is kept: the block is appended and replaced in place on
reinstall. If `core.hooksPath` points outside the repository — a machine
that sets it globally — the install refuses rather than writing hooks
into every repository you own.

`teamflow hooks status` says, for the current repository, which of these
tools it can see a sign of, whether their hooks are installed, what they
cover, and whether `pre-push` has a test command to run.

## Privacy

Sent: tenant ID, tracker name, issue key/link, short issue title/status when exposed, parent keys, actor, repo/branch, normalized stage/status, concise derived summary, loop/rework metadata, compact evidence and timestamps.

Never sent: prompts, transcripts, file contents, diffs, raw commands, raw tool results, secrets, issue descriptions/comments/attachments, raw CI/test logs.
