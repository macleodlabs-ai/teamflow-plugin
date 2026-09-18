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

TaskCompleted / SubagentStart / SubagentStop
  → update summary/subagent count

Stop
  → publish idle state

SessionEnd
  → local-only cleanup; no network work
```

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

```text
/teamflow:login
  → GET /v1/capabilities for the hosted UI's issuer and client id
  → authorization code with PKCE (S256), loopback redirect on 127.0.0.1
  → browser opens; the developer signs in
  → POST /v1/members/identity with the ID token, claiming the seat
  → refresh token written to ~/.config/teamflow/session.json at 0600
  → access token held in memory, refreshed five minutes before expiry
```

The authorize request asks for the sign-in scopes the service publishes, `openid email profile`, plus the paid-API scope it names separately in `auth.api_scope`. Both are needed on one token: the same credential identifies the developer and then calls `/v1/report`. Duplicates are dropped, so an override that already names the API scope does not ask for it twice.

The seat binding is not optional. A member who has just signed in holds a token from the pool and nothing else, so the service cannot yet tell which seat is theirs, and an unbound access token authenticates as nobody. The ID token is what claims the seat: it is the one artifact that proves a given subject owns a given verified email. It happens before anything is written, because a session whose token authenticates as nobody is worse than no session, and it is idempotent, so signing in again is free. A service that does not run the orgs module answers 404 and sign-in continues without it.

Nothing but the refresh token reaches the disk. A refresh token is revocable and scoped to one machine; an access token on disk would be a bearer secret with an hour of life and no way to take it back.

### A machine with no browser

The browser does not have to be opened by the plugin. `teamflow login --no-browser`, a box with no display (no `DISPLAY` or `WAYLAND_DISPLAY`, and not macOS or Windows), an `open` that exits non-zero, or a run with no terminal — Claude Code drives the CLI over a pipe — all print the authorize URL immediately and keep the loopback listener up for the whole three minutes. The person opens that URL in a browser on the same machine and the redirect lands where it always did. The URL used to be printed only after the timeout, when the port it points back to had already closed, which is the same as not printing it.

The browser still has to be on *this* machine, because the redirect goes to `127.0.0.1`. A browser somewhere else is what device-code sign-in is for.

### A browser on another machine

`teamflow login --device`, and what a machine with no browser does on its own:

```text
teamflow login --device
  → POST /v1/auth/device            (no credential; the machine has none yet)
  ← device_code (secret), user_code (WXYZ-1234), verification_url, interval
  → the terminal prints the URL and the code
  (the person opens https://codercat.io/app/#device in any browser anywhere,
   signs in as usual, types the code and approves)
  → POST /v1/auth/device/approve    (their ID token, from the dashboard)
  → POST /v1/auth/device/token      (polled at `interval`)
  ← a device credential, stored at ~/.config/teamflow/session.json at 0600
```

The three paths, and when each one is taken:

| Where the browser is | What runs | What is stored |
| --- | --- | --- |
| This machine, openable | the loopback sign-in, browser opened here | a refresh token |
| This machine, not openable | the loopback sign-in, URL printed here | a refresh token |
| Any other machine | the device flow (`--device`) | a device credential |

The command chooses without being asked: `--device` forces it, and a run with `--no-browser`, `TEAMFLOW_NO_BROWSER=1`, or no display takes it whenever the service publishes `auth.device` in its capabilities. A service that does not publish it falls back to printing the authorize URL, which is the best that can be done there. When a loopback sign-in times out, the message names `--device`, because "nobody opened the URL" and "the browser is on another machine" look the same from here.

The stored credential is not a token from the identity provider. It is a device credential: bound to that person's seat, held as a peppered hash at the service, shown once, and revocable on its own — `teamflow logout` revokes it at the service as well as removing the file, and the members page lists every machine signed in this way. Nothing about it is refreshed, so `teamflow status` reports the credential as `device` rather than `bearer`, and `teamflow org` and the admin routes refuse it: those need the ID token that names a verified address, and a device credential names a seat.

The organisation is chosen in the browser, not on the terminal. An address holding seats on several organisations is asked on the approval page, which is where the question can be answered; `--org` is ignored by a device sign-in and says so.

`GET /v1/capabilities` gets ten seconds and one retry, because a cold Lambda behind CloudFront can spend most of the first window starting up. A service that never answers is reported as unreachable. A service that answers but publishes no auth block is reported as unconfigured, naming `TEAMFLOW_AUTH_ISSUER` and `TEAMFLOW_AUTH_CLIENT_ID` — two different faults, and telling somebody the second when the first happened sends them after configuration that was never the problem.

The loopback listener binds the first free port in 52480-52489. Every one of those is registered as a callback URL on the app client, so the range cannot grow without a deploy. The `state` returned by the identity provider must match the one this process sent, or the code is discarded unredeemed: it belongs to somebody else's sign-in.

### More than one organisation

An address can hold a live seat on several organisations, and the service refuses to guess which one a sign-in is for: `POST /v1/members/identity` answers `409 ambiguous_seat` with the organisations, their role and their plan. Binding to the wrong one credits the developer's reports to the wrong organisation, and nothing downstream can undo that.

```text
teamflow login
  → 409 ambiguous_seat
  → on a terminal: the organisations as a numbered list, and one question
  → anywhere else (a hook, CI, a pipe): the same list, then
    "run `teamflow login --org <id>`"
  → POST /v1/members/identity with {id_token, account}
```

`teamflow login --org <id>` skips the question. An id the address holds no seat on is refused `no_seat` and nothing is written — a session bound to no seat looks configured and 401s on every report.

The session file gains `account` and `accountName` beside the refresh token, so `teamflow org` can say where reports go without a round trip. Nothing else about the file changes: still no access token, still no ID token, still 0600.

```bash
teamflow org                      # the organisation reports go to, and the others
teamflow org switch <id>          # POST /v1/members/switch, per session
```

`teamflow org` reads `GET /v1/members/me` with the ID token as the bearer — the access token names a seat, and this has to answer for the address, which is what the other organisations are found by.

A switch is **per session**: the service answers with an account-scoped token for the credential in hand and moves no binding, so this CLI goes to the named organisation and the dashboard tab beside it stays where its holder put it. Reports already published stay where they were published. A device credential — the one `/teamflow:login` leaves on a machine that cannot open a browser — switches the same way and may move to any seat its person holds; an account key cannot switch at all, because it names the account rather than a person.

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

An environment that can neither open a browser nor mint an OIDC token can set `apiKey` (`TEAMFLOW_API_KEY`) instead. It is the last credential tried: a session, then an access token handed in directly, then the key. A signed-in developer stops sending a long-lived secret the moment there is something better.

`/teamflow:doctor` warns when a session has expired or been revoked and reporting has quietly demoted to the key.

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

`slot` is present only for `kind: "runtime"`. The service validates the payload against the privacy allowlist, drops any field it does not recognise, lists what it dropped in `dropped_fields`, and writes the document under the tenant its own credential names. One accepted report costs one credit.

Two fields the reporter deliberately does **not** send: `tenantId`, because the account behind the credential owns the tenant, and a payload-level `slot`, because the envelope already carries it where the service can check it against the known slots.

The actor rollup (`actors/<id>.json`) has no service equivalent yet. The allowlist knows two kinds, `issue` and `runtime`, so on the service transport the plugin publishes the issue report only.

### Answers and failure

| Answer | What the reporter does |
| --- | --- |
| 2xx | done. An identical re-post comes back `replay: true` and is not charged again |
| 402 | the organisation is out of credits. Logged once per session, never queued, never blocking |
| 429 | rate limited. Queued and retried after `Retry-After`, or after a backoff of 15s doubling to a five-minute cap |
| other 4xx | the service refused the report. Not retried: the same body cannot get a different answer, and one bad report must not dam the good ones behind it |
| 5xx, timeout, offline | queued and retried on the next flush, with the idempotency key it was queued with |

429 is the one retryable 4xx. The limit is 120 requests a minute for the whole account, shared by a Claude session, its subagents and CI, so it is reachable in ordinary use: nothing is wrong with the report, the caller simply arrived too fast, and the same body posted later is accepted. A queued report records `attempts` and `notBefore`; a flush skips anything not yet due, and a retry that is refused again is rewritten in place rather than re-queued, so a stale full-state document cannot sort to the back of the queue and overwrite a fresher one. `Retry-After` is honoured as seconds or as an HTTP-date, capped at five minutes, because a reporter that sleeps longer than that has stopped reporting.

The outbox lives at `<plugin data>/outbox` and is drained, up to five at a time, after each successful report. Reporting is observability: no failure of it ever blocks Claude Code, a hook or CI.

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

Binding is also where a title is learned: see below.

`/teamflow:doctor` reports the transport, the service account and its credits, the configured tracker, the resolved issue source and whether that tracker's bundled MCP server is visible; authenticate it once through `/mcp`.

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
- **completion** — the tracker's "done" moves the ticket to `READY_PROD` and sets `deliveredAt`, and a reopen after done is drawn as `DEV_REWORK` with `reworkFrom: READY_PROD`;
- **metadata** — title, assignee, status name and labels, which overwrite whatever the plugin guessed from a branch name. The status name is a tooltip, never a column: "Ready for QA" is one team's name for another team's stage.

What a tracker event may never do is set a delivery stage the skill owns. It never moves a ticket backwards or sideways inside `LOCAL_DEV`..`DEV_VERIFIED`, so Jira saying "In Progress" about a ticket the skill already has in `DEV_TEST` is Jira being behind, and the ticket does not move. A ticket the skill has never reported is different: there, an in-progress status is the only signal there is, and it puts the ticket in `LOCAL_DEV`. Nothing is inferred from silence either: no event, no change.

No hook changes when a tracker is connected, and nothing stops when one breaks. With every connection dead the board draws exactly what the plugin and the background reporters report, which is what it drew before trackers existed. A connection is made once per organisation by an owner on the members page, not in this plugin's config.

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

- **Each invocation is one report and one credit.** The plugin skips an
  unchanged heartbeat because it compares against the state it last
  sent; a CLI run has no such state and always carries the clock. Call
  it at a transition, not on a timer.
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
| `login`, `logout`, `status`, `bind`, `next`, `unbind`, `sync`, `doctor`, `repos` | the nine the plugin's skills wrap |
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
  confirm `teamflow status` still names the repository. That is what
  the shim's `cd` is for.

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
