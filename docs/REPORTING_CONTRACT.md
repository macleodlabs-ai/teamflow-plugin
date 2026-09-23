# TeamFlow reporting contract

The report store is a small tenant-scoped current-state store, not a database or event bus.

## Transport

A reporter posts one report at a time to the service:

```text
POST <serviceUrl>/v1/report
Authorization:   Bearer <access token>
Idempotency-Key: <sha256 of the report's content, excluding updatedAt>
X-Machine-Id:    <this machine's random id, when it has one>

{ "kind": "issue" | "runtime", "slot": "<slot>", "payload": { ... } }
```

A reporter authenticates as itself: a developer's machine with the device credential `teamflow login` leaves behind, or a CI job with a short-lived token it got by exchanging its GitHub Actions OIDC identity. There is no long-lived organisation credential to fall back to — this service issues none, and one presented anywhere (an `X-Api-Key` header, a `?key=`/`?api_key=` query parameter, a bearer with a key's shape) is refused because it was presented, with one 401 `api_keys_disabled` body whatever the key is, and a key the service recognises as its own is revoked on sight (MACLEOD-630). The plugin does not send a configured key to this service at all. The credential is resolved per request, so a queued report authenticates with whatever is valid when it is finally delivered.

`kind` is `issue` for a ticket's current state and `runtime` for one background sidecar; `slot` is present only for `runtime` and must be one of the slots below. The payload is a `TicketState` or a `RuntimeState` as defined in **Allowed current-state data**.

Four properties of this transport are load-bearing:

- **The tenant comes from the credential.** The account behind the token or key owns the tenant prefix. A `tenantId` in the payload is dropped, because a body that names a tenant is describing somebody else's data.
- **Unknown fields are dropped, not rejected.** The service answers 200 and lists what it dropped in `dropped_fields`. A reporter that grows a field, or is talked into attaching a prompt, a diff or a log line, cannot make that field reach the store by naming it something the service has never heard of.
- **`X-Machine-Id` is an identifier, not content** (MACLEOD-620). It's `m_` and 32 random hex characters, made once and kept at `~/.local/share/teamflow/machine-id` — one per home directory, whatever `CLAUDE_PLUGIN_DATA` says, so every Claude Code config directory and every other tool on one laptop sends the same id for the one home-rooted device credential. It is never the hostname, the user name or anything derived from the machine. A devcontainer or remote shell that shares the home directory shares it. The service uses it only to keep a device credential to one machine at a time, and never stores it with a report. It's additive: a reporter that can't keep an id sends no header and is never asked, and so is an older plugin.
- **The idempotency key is the report's content hash.** A heartbeat that repeats an unchanged report is the same request, replayed rather than counted again. Only real progress is a new report. Reporting is included in the seat and is not priced by volume: the count exists so that fair use can be told from a runaway loop, and nothing a person does at a keyboard reaches it.

Answers: 2xx accepted (`replay: true` when it was a repeat); 402 the organisation has no reporting seat, which is logged once and never blocks; 403 `viewer_cannot_report`, refused and not retried; 401 `api_keys_disabled`, a key was presented and none is accepted — refused, not retried, and the key is dead; 403 (or 402) `reporting_paused`, `payment_failed`, `trial_ended`, `usage_exceeds_plan` or `credential_in_use`, a soft refusal: dropped rather than held, never counted, shown by `teamflow status`, `teamflow doctor` and once at session start, and lifted by itself, after which the next `Stop` re-sends current state; 429 rate limited, queued and retried after `Retry-After` or a capped backoff; any other 4xx the report was refused and is not retried; 5xx and network failures are queued and retried with the key they were queued with.

The legacy transport writes the same documents straight to S3 at the paths below with AWS credentials, and is selected when `dataUri` is configured and no service credential is available.

### Video evidence never passes through the service (MACLEOD-639)

When an organisation's Playwright step asks for videos on tickets, the plugin
sends a passing run's `.webm` from the machine **straight to the tracker**:
GitHub through the developer's own `gh issue comment --attach`, Linear through
a pre-signed upload link. The service only answers where the ticket lives
(`POST /v1/evidence/video/start`) and, for Linear, writes the one comment that
links the upload (`POST /v1/evidence/video/done`, with a signed, hour-long
receipt). No video, frame or file name beyond the one uploaded is stored by
TeamFlow; the check's own report is unchanged.

## Discovery and tenant paths

One rule for everything a tenant holds (MACLEOD-548):

```text
<kind>/<id>.json             the subject's own state
<kind>/<id>/<source>.json    what one source contributes to it
```

`kind` is `issues`, `workflows` or `projects`. `id` is the issue key, the workflow id or the project id. `source` is who wrote it. No prefix is special, so a new kind of subject needs no new reader and no new branch in the bundle route.

```text
/data/index.json
/data/tenants/<tenant>/team.json
/data/tenants/<tenant>/actors/<actor>.json
/data/tenants/<tenant>/issues/<ISSUE-KEY>.json
/data/tenants/<tenant>/issues/<ISSUE-KEY>/ci.json
/data/tenants/<tenant>/issues/<ISSUE-KEY>/audit-local.json
/data/tenants/<tenant>/issues/<ISSUE-KEY>/deploy.json
/data/tenants/<tenant>/issues/<ISSUE-KEY>/dev-test.json
/data/tenants/<tenant>/issues/<ISSUE-KEY>/audit-dev.json
/data/tenants/<tenant>/issues/<ISSUE-KEY>/security.json
/data/tenants/<tenant>/issues/<ISSUE-KEY>/tracker.json
/data/tenants/<tenant>/issues/<ISSUE-KEY>/pr.json
/data/tenants/<tenant>/workflows/<WORKFLOW-ID>.json
/data/tenants/<tenant>/projects/<PROJECT-ID>.json
```

`runtime/<ISSUE-KEY>/<source>.json` is the old spelling of a contribution and is still read as the same thing. Everything published before this change keeps rendering, and an object moves to the new path when its next report rewrites it. `team.json` is the tenant's own state and has no id, so the rule leaves it alone without naming it.

`<ISSUE-KEY>` is the canonical key: `DAEMON-142` for Jira, `ENG-42` for Linear, `daemon-core#123` (repo name plus number) for GitHub Issues.

The browser never lists S3. `index.json` supplies deterministic tenant roots; tenant team/actor documents supply issue keys; the browser probes known optional runtime slots.

On the service transport it does not have to. `GET /v1/state/tenants/<account>/bundle` returns the whole tenant in one response — team/org information, every issue document and every runtime sidecar — and it takes that sidecar list from a store listing on every request. Nothing is probed and nothing is written down in advance, so a slot that was never published is simply absent. This is how every credentialed dashboard reads, and it is the only path a live tenant uses.

### `runtime/index.json` is a fixture artefact

The bundled sample data under `public/data` is the exception, because a folder of JSON on a static host cannot be listed. It carries a generated `runtime/index.json` per tenant, plus one in the legacy root mirror:

```json
{ "DAEMON-142": ["audit-dev", "ci"], "CORE-217": ["deploy"] }
```

It exists so the signed-out demo stops asking for the 79 sidecars that are not there. Three things follow, and they are the whole of its contract:

- **Live tenants never use it.** No reporter writes one, no adapter generates one, and the service ignores it. It describes the checked-in fixtures and nothing else. A production tenant's sidecar list comes from the store listing behind `/bundle`, which is current by construction; an index file there would be a second source of truth that could only go stale.
- **It is generated at data-edit time**, by `npm run data:index` (`scripts/runtime-index.mjs`), and a test compares the committed bytes against the files on disk so it cannot drift. There is no per-report regeneration anywhere.
- **It is optional.** A tenant directory without one falls back to probing the slots `team.json` declares, so a hand-copied S3 tree still renders.

A workflow document is read by the index as well as the bundle, so its
`updatedAt` folds into the tenant watermark. Without that a run could advance
every ticket's cycle and a polling dashboard would never see it move.

## Concurrency model

Each writer owns a deterministic object:

- Claude/local work owns tenant `issues/<KEY>.json`;
- CI owns `ci.json`;
- audit jobs own `audit-local.json` or `audit-dev.json`;
- deployment owns `deploy.json`;
- deployed tests own `dev-test.json`;
- scanners own `security.json`;
- an external gate's connector webhook owns the slot named after the system — `sonarqube.json` — and `/v1/report` refuses it by name for the reason it refuses `tracker` and `pr` (MACLEOD-639);
- the tracker webhook owns `tracker.json`, and the same webhook's pull request, review and check deliveries own `pr.json`; `/v1/report` refuses both slots by name, because the webhook proves who sent a delivery with an HMAC signature and a report only proves who holds a credential on the tenant.

The browser merges sidecars by execution ID. Independent background jobs therefore do not contend with Claude's primary ticket state.

## Tenant isolation

On the service transport the account behind the credential is the tenant, so a writer cannot address another tenant's prefix at all. On the legacy S3 transport the tenant ID is part of every local binding and report, and writers should receive IAM permission only for their tenant prefix.

The dashboard tenant selector is **navigation, not authorization**. For external client viewers, enforce viewer isolation at CloudFront/edge/auth level or give each client a distribution/index that exposes only its tenant. Do not rely on hiding the selector for security.

The account behind the credential being the tenant also decides what the plugin has to remember locally. A report that could not be sent is a report *for one organisation*, so each queued item records the organisation it was queued for — the id, or a truncated one-way fingerprint of a credential that names none locally — and is only ever sent by a session that resolves to the same one (MACLEOD-583, `docs/PLUGIN.md`). That lives in `outbox2/`, whose items each carry an `owner` block of `{ kind, serviceUrl, from, account | fingerprint }`. It never holds a credential, a token or a key, it is never sent anywhere, and nothing in it reaches a report.

## Allowed current-state data

- `tenantId`
- `tracker` (`jira`, `linear` or `github`)
- issue key/link and short title/status, carried in the `jiraKey` / `jiraUrl` / `jiraStatus` fields, named for history
- parent/related keys
- actor, repository and branch
- `git`: `branch`, `head.sha` and `head.subject`, `commitsSinceMain`, `ahead`, `behind`, `pushed`, `dirty` — where the branch stands, as counts and flags. Derived state: a count of commits is not the commits, and the subject line is capped at one line's length so a hunk cannot ride in as prose.
- `pr`: `number`, `url`, `state`, `mergeable`, `checks.{passing,failing,pending}`, `review` — what the forge already publishes about the pull request. Derived state: how many checks are in each state, never which ones and never their output.

### What the SERVICE adds: `member`

Everything above is what a reporter may send. `member` is the one field on a stored issue document or runtime sidecar that no reporter sends and none may: it is the email address of the organisation member whose credential posted the report, and the service stamps it from the credential (MACLEOD-588).

The rule has three halves and all three are load-bearing:

- **It comes from the credential, never from the body.** The kit resolves the presenting credential to a member — an account key's member, a device credential's seat, a signed-in person's seat — and hands it to the adapter as `ctx["member"]`. `member` is in `adapters/teamflow/schema.py`'s `DROPPED` list beside `tenantId` and `slot`, so a payload carrying one is thrown away by the allowlist walker and then overwritten; a report claiming another member's address changes nothing but its own `dropped_fields`. The same reason `tenantId` is dropped applies: a body that names a person is describing somebody else's work.
- **A credential that names nobody stamps nothing.** An organisation-wide key carries the account's rights and no person's, so the field is simply absent rather than being filled with the owner. Only a member who still holds an *active* seat on that account is ever stamped; a key that outlived the person it was issued to names nobody.
- **The plugin still never sends an email.** Nothing on the reporting side changes. This is the service adding what it already knows, at the one point where it knows it and the reporter cannot influence it.

The value discloses nothing new to whoever can read it. It is only ever the address of a member of the account the document belongs to, and an organisation's own members' addresses are already listed on its members page to its own members. What it adds is the fact that this report and that member are the same human, which is what lets the dashboard draw one person instead of one per name they report under.

A workflow document is not stamped: it already names its `actor`, and a second answer to who is running a run is a second thing to go stale.

### One event

A ticket's events used to be stored in three shapes — the issue document's `executions[]`, the tracker sidecar's `history[]` and the pull request sidecar's `history[]` — and the dashboard folded all three into one timeline in the browser, on every read, for every ticket. They are one shape now, folded once by whoever writes it:

```jsonc
{
  "id": "gh-7",                    // the writer's own id for it; a delivery id, or an execution id
  "at": "2026-09-19T05:12:00Z",    // when it happened
  "source": "ci",                  // who says so: a slot, or "plugin"
  "kind": "test",                  // the execution vocabulary
  "label": "Unit tests",
  "stage": "LOCAL_TEST",           // optional: not every event moves a ticket
  "status": "failed",              // optional: not every event is a run
  "endedAt": "2026-09-19T05:14:00Z", // optional: when the run stopped
  "summary": "3 of 214 failed",
  "evidence": [ /* the capped list above */ ]
}
```

`endedAt` is a clock and nothing else (MACLEOD-601). It is absent while a run
is going, so its presence is what tells *still running* from *was running when
something last looked* — the board used to claim somebody was working now on
the strength of an event from sixteen hours ago. `agent.endedAt` and
`session.endedAt` already said it for the two rows that carry those blocks;
this is the same fact for a row that carries neither, such as a CI reporter's
or a card republished by `teamflow tidy`. It is allowed inside `executions[]`
and nowhere else: the issue document has `updatedAt` already, and a second
clock beside it would be a second answer to when the ticket last moved.

### Who ran it: the `agent` and `session` blocks

An event the plugin writes may carry two more blocks, and only these two shapes (MACLEOD-574):

```jsonc
{
  "id": "claude-abc123-4f2a91c4",
  "at": "2026-09-19T15:40:00Z",
  "source": "plugin",
  "kind": "claude",
  "label": "wf-trackers-kit",
  "agent": {
    "id": "agent_01H…",                    // the tool's own id, or a digest when it sent none
    "name": "wf-trackers-kit",             // ≤ 64
    "task": "Kit trackers: 533, 537, then 534",   // ≤ 80
    "type": "fork",                        // its subagent_type, ≤ 40
    "parent": "9f1c2b7e4a05",              // the session it runs in, as `session.id` spells it
    "startedAt": "2026-09-19T15:12:00Z",
    "endedAt": "2026-09-19T15:39:00Z"      // once it has stopped
  },
  "session": {
    "id": "9f1c2b7e4a05",                  // a digest of the session id, never the id
    "tool": "Claude Code",
    "startedAt": "2026-09-19T14:58:00Z",
    "endedAt": "2026-09-19T18:02:00Z",
    "repository": "macleodlabs-ai/teamflow",
    "branch": "steve/macleod-574-agents"
  }
}
```

**An agent's `name` and its `task` are short labels the model wrote, of exactly the same class as a workflow's name — and nothing else about the agent leaves the machine.** The prompt it was launched with (`tool_input.prompt` on the `Agent` tool), the messages it wrote (`last_assistant_message` on `SubagentStop`), its transcript and its tool calls are none of them fields here, are never read by the plugin, and are dropped by the unknown-field path on the way in. `name` is capped at 64 characters, `task` at 80 and `type` at 40, all through the same sanitising a workflow name gets: one line, whitespace collapsed, truncated. An agent nobody named is `Agent <type>`.

An agent's `id` is whatever its tool calls the instance. Where the tool names no instance — an older Claude Code, and the seven other tools TeamFlow supports — TeamFlow keys the agent by the repository it is working in, and **what travels is a digest of that path and never the path itself**, because a working directory carries an OS username, a client's name and a repository's name, none of which is derived state. The same is true of the execution id an agent's row carries, and of `agent.parent`, which is the digest `session.id` carries so that the two join. `AGENT`, `SESSION` and `EXECUTION` in `adapters/teamflow/schema.py` refuse an id with a path separator in it, so the rule is a check on both sides rather than a promise on one.

They exist because the board is meant to show what the terminal shows. Claude Code lists its running agents by name and by the one line each was launched with; the board showed `Claude Code + 1 subagent` and counted none of them, because a subagent was a counter on its parent's state with no ticket, no stage and no name of its own.

One identifier is deliberately not hashed: the execution id `claude-<session>` carries the tool's raw `session_id`. It predates all of this and is what a tenant's documents are already keyed by, so changing it would split every card in two on the day a plugin upgrades. A `session_id` is a random UUID the tool mints per session — not a secret, not derived from anything about the machine or the person, and useful precisely because it is stable: it is what correlates the several tickets one session touched. The digest in `session.id` exists for the board to group by, not because the raw id would be a disclosure.

`session` is which session a run happened in, so the board can group a person's work as person → session → agent. `id` is a digest of the tool's `session_id` and **never the id itself**: telling two of somebody's sessions apart is the whole job, and a raw session id is a machine-local identifier with no business on a report. No transcript path, no scratchpad directory, no working directory — `repository` and `branch` are the same two fields the issue document already carries, repeated here because a worktree is the usual reason a person has more than one session open.

**An `agent` block may ride a run of any `kind`, not only `claude`** — a reporter that runs the audit, the suite or the deploy under a named agent says so, and the board draws that agent on its person's lane beside their coding ones. This is a decision rather than an omission (MACLEOD-596): the block has been accepted on every kind since it was introduced, and for a while the swimlanes walked only `claude` runs, so a block on an `audit` run was accepted, stored and drawn nowhere. Tightening the table instead would have turned that silent discard into a silent refusal for anything already sending one. `test_an_agent_block_is_accepted_on_a_run_of_any_kind` in `tests/test_schema.py` pins it.

A `running` agent is believed for as long as it keeps saying so. `SessionEnd` has 1.5 seconds and may not spend them on the network, so a session that is killed leaves its last report standing: the plugin carries those ends on the next turn by anything on the machine, and the dashboard ages out a Claude agent whose last report is older than `freshness`'s `idle` band, drawing it as *stopped reporting* rather than as working. A build or a test suite is not aged out — it is owned by a reporter with a lifecycle of its own and is taken at its word.

`AGENT` and `SESSION` in `adapters/teamflow/schema.py` are the enforcement, and `sanitizePayload` in `plugin/scripts/core.mjs` gives each block a scope of its own rather than adding `name`, `task`, `parent` and the rest to the flat allowlist — those are precisely the words a reporter talked into attaching a prompt would reach for.

`source` is a slot — `ci`, `audit-local`, `deploy`, `dev-test`, `audit-dev`, `security`, `tracker`, `pr` — or `plugin`, for the hooks, which write the issue document and have no slot of their own. `kind` is the execution vocabulary, which gained `tracker` and `forge` with this shape: a status change in Linear and a delivery from GitHub are neither a run nor a person, and calling either of them `ci` would say a build happened when none did.

`stage` and `status` are both optional because not every event is a run. A tracker renaming a status moves no ticket and has no verdict, and a row claiming `success` for it would light a timeline green for an issue nobody has touched.

Identifiers travel in `evidence`, where identifiers already live: a webhook's delivery id is `{"label": "Delivery", "value": "<id>"}` and not a field of its own. Still derived state, on the same rule as everything else here — no title, no branch, no body, no comment, no log.

The issue document's `executions[]` is a list of this too, written by the plugin's hooks and by `teamflow report` with `source: "plugin"`. It is the ticket's own list of what ran, so every row in it names a stage and a verdict even though the shape allows either to be absent.

Documents written before this shape are still read, and so are reports still sent in it. `executions[]` accepts both: a row with `at` is an event, a row without it is the older execution, with `updatedAt` for the clock and no source. A plugin in the field is on somebody's laptop and an upgrade is not something the service gets to require, so the older shape is accepted for as long as one is sending it. A sidecar or an issue document on file keeps rendering until its next report rewrites it, which for an active tenant is minutes; `src/lib/ticketDetail.ts` and `src/lib/dataSource.ts` hold the blocks that read the older spellings, and they go when nothing is left in them.

### The `pr` sidecar

`runtime/<KEY>/pr.json` is the same `pr` block as above, written by the connector webhook instead of by a reporter, and it is an **execution**: `id`, `kind`, `label`, `stage`, `status` and `summary` beside the block, so the dashboard merges it with `ci.json` and `deploy.json` rather than down a path of its own. It also carries `occurredAt` (the forge's clock for the delivery it last applied), `updatedAt`, `deliveryId`, `provider`, `repository`, `headSha`, `checkRuns` and a `history` of the last twenty deliveries.

`checkRuns` maps a runner to its verdict — `passing`, `failing` or `pending` — keyed by the numeric id GitHub gives the workflow or the app that owns the check suite, never by a name and never with a log, an annotation or a step. It exists so the counts are a tally of runners rather than of deliveries: a flaky job that reran four times is one check, and a green rerun cannot clear a different job's genuine failure. It is dropped whole when the head commit changes, because a run that passed against a commit nobody is on says nothing about the code on screen.

`history` rows are events in the one shape above, written with `source: "pr"` and `kind: "forge"`: the forge's `action` is the row's sentence and the delivery id is its evidence. No title, no branch, no body, no review comment.

### The `detail` block on the `tracker` sidecar

`runtime/<KEY>/tracker.json` carries a `detail` block: the structure the tracker keeps around the issue, written only by a verified connector webhook and never by a reporter. Its fields are the whole of it:

- `priority`: `{value, name}` — a number to sort by and a word to read.
- `estimate`: a number. A Linear estimate or Jira story points.
- `project`, `cycle`, `dueDate`: names and a date. `cycle` is a Linear cycle or a Jira sprint.
- `milestone`: `{title, dueOn}`.
- `assignees`: `{id, name}` each, capped at twenty.
- `parent`: `{key, title}`. `children`: the same, capped at fifty.
- `childrenTotal` / `childrenDone`: a tally, for a tracker that counts sub-issues without naming them.
- `relations`: `{type, key, title}` each, capped at fifty, where `type` is `blocks`, `blocked_by`, `related` or `duplicate`.

Derived state, on the same rule as everything above: a key and a title name an issue. A title is capped at 120 characters. No issue description, no comment, no link comment, and no issue body — GitHub's relations are the keys read out of a body that is then dropped, never the body.

An absent field means *this tracker did not say*, which is not the same as an empty list and is not drawn as one. `docs/TRACKERS.md` has the per-tracker table of what each webhook states and what it cannot.

#### `assignee.member` — who the assignee actually is

The `assignee` block on the `tracker` sidecar is `{id, name}` and, when the service could tie the assignee to a person, `member`: the email address of a member of *this* organisation.

It is written at the moment the delivery is applied and never by a reporter. Linear's webhook and its import both carry the assignee's address, and Jira's payload carries one when the site does not hide it; the service compares that address, case-insensitively, against the seats `mcpkit.ledger` holds for this account, and writes the **member's own** address when it matches one. An address that matches no member of this organisation is written nowhere — not into the sidecar, not into a log line, not into a response — and the assignee stays `{id, name}`.

GitHub sends no address at all, so it is matched the other way (MACLEOD-591): its payload names the assignee by GitHub's own numeric user id, and a member who signed in through GitHub has that same id recorded on their seat by the kit — from the verified token and from nowhere a person can type. The service compares the two, within this account's seats only, and writes the member's address on a match exactly as it does for an address. A **login is never matched**, because a login is a label its owner can change and anybody can claim; a display name is never matched against anything, because two people share one often enough to merge them.

The address that does get written is not new information to anybody who can read it: an organisation's own members' addresses are already listed on its members page, to its own members. What the field adds is the fact that this assignee and that member are the same human, which is what stops one person being drawn as three (MACLEOD-588).
- normalized stage/status
- `reworkFrom` and loop count
- concise derived summary
- compact evidence counts/references
- execution IDs/kinds
- timestamps
- `reporter`: what sent the report

### The `reporter` block on an issue report

`reporter` is two fields and no more:

- `tool`: the name of the tool the plugin was running in — `Claude Code`,
  `Cursor`, `Git hooks` — taken from the capability table in
  `plugin/scripts/tools.mjs`, capped at 80 characters.
- `version`: the plugin's own version, capped at 40. Optional, because every
  plugin older than 0.3.6 sends none; a report without one is accepted and the
  dashboard says the version is unknown rather than guessing.

It exists so the dashboard's header can name what is actually reporting
instead of asserting that a plugin is connected. Nothing else about the
machine belongs in it: no hostname, no working directory, no user, no account,
no path. `adapters/teamflow/schema.py`'s `REPORTER` table is the enforcement
and drops anything else.

### The workflow document

`workflows/<id>.json` is the third document kind, beside the issue document
and the runtime sidecar. A workflow is a pool of tickets and the plan for
driving them through build, test, audit and status; the orchestrating skill
owns it and rewrites it as the run advances, which is what makes the plan
live on the board rather than in a session.

It may carry:

- `id` (`wf-` and hex) and `name` — the workflow is addressable, so a ticket the filter missed can be added to it by name
- `status`, `createdAt`, `updatedAt`. `status` is one of `planning`, `running`, `blocked`, `done`, `cancelled`, `archived`. `archived` is a run that is over and should stop being offered — the empty planning run nobody ever filled, retired by `teamflow tidy` (MACLEOD-601). It is deliberately not `cancelled`, which says somebody decided against work they meant to do; an archived run stays readable and leaves the pickers
- `actor`: `id`, `displayName` — who is running it, in exactly the two fields a report already uses for an actor and no others. A workflow's queued tickets have nobody on them by definition, so without this the board reads a run somebody is sitting in front of as nobody's work. No email, no machine, no account; optional, because a document written before the field existed is still valid. `id` is a slug (`[a-z0-9._-]`, capped at 80) and the service refuses anything else: a free-text id took a home directory path and a whole email address, and the first of those names a client the reader's organisation may not be allowed to know about. `displayName` is a stated identity — a configured actor name or the one the working copy is set up with — never the machine's login, because a run owned by a unix account is a person on the board who does not exist
- `filter`: `tracker`, `project`, `state`, `label`, `order` — **what the order was turned into**
- `scope.deploy` — whether deploying is in scope for this run
- `tickets[]`: `key`, `rank`, `phase`, `state`, `cycle`, `addedBy`, `updatedAt`, `note`. `state` is one of `waiting`, `running`, `done`, `blocked`, `skipped`, `rework` — the same six the plugin and the dashboard spell, and the enum refuses the whole document rather than the field, so a state missing from one of the three spellings is a run that stops reaching the board entirely (MACLEOD-601)
- `dependencies[]`: `from`, `on`, `reason`, `found` — which ticket waits on which, and whether planning or a team building found it
- `tickets[].note` (MACLEOD-639, ADHOC-14): one sentence of at most 120 characters that somebody passed to `teamflow workflow ticket <KEY> --note <text>`, such as `audit: 1 high, critical did not stop the harness`, drawn in the Status view's state cell. It is only what the command line passed: never the order, a gate `--reason`, a prompt or anything the plugin composes. The plugin makes it one line, strips every control character and collapses whitespace (`noteLine` in plugin/scripts/workflow.mjs); the service refuses a document whose note is not one clean line (`WORKFLOW_NOTE_MAX`, `_one_line` in schema.py). `--note ""` clears it
- `phases[]`: `n`, `state`, `tickets[]`
- `origin` — `auto` when the plugin created the run itself because a session dispatched agents with no run to hold them (MACLEOD-639). Absent on every run a person created. The board draws an `auto` run as unplanned: its nodes are real, its edges are unknown until `teamflow workflow depends` draws them. `tickets[].addedBy` gains `dispatch` for the same reason: a node the hooks put in the pool because an agent was sent to work on it. Its title is the agent's label and one-line task as the launch registry already carries them, capped like any summary: the label at 64 characters and the task (the `Agent` tool's `description`) at 80, each collapsed to one line; the prompt the agent was given is not an input to it

**The user's order does not travel.** The order is a prompt, and the rule
above admits no exception for this one: it selects tickets on the machine and
only the filter it was turned into is published. A reader of the dashboard
learns that a workflow selected every open Linear ticket in priority order.
They do not learn the sentence that asked for it.

`reason` is the one piece of prose here. It is a short derived sentence
saying why one ticket waits on another, capped exactly as `summary` is, and
it never quotes code, a diff, a log line or a prompt. `adapters/teamflow/schema.py`'s
`WORKFLOW` tables are the enforcement and drop anything else.

**A republish that leaves `actor` out keeps the stored one.** The document is
replaced whole on every write and a live run republishes it once per ticket
that moves, so absence has to mean *I did not say* rather than *nobody*, or
the second write of a run would blank the owner the first one named. The
adapter's `WORKFLOW_CARRIED` is the list of fields that survive a republish
this way, and nothing about it lets a report *clear* a field it did not set —
a value is only ever replaced by another value (MACLEOD-588).

### A gate's lifecycle on the runtime sidecar (MACLEOD-639)

A runtime sidecar is an execution: the same `id`, `kind`, `label`, `stage`,
`status`, `summary`, `updatedAt` an `executions[]` row carries, written whole
by one background reporter to `issues/<key>/<slot>.json`. It has a lifecycle
now, because a sidecar written once as `running` and never rewritten was the
live board's deploy gate for 41 hours. It may additionally carry:

- `startedAt` — when the run started. What a deadline is measured from; a running sidecar with none is read from its `updatedAt`, which is only right for a row written before the field existed. The plugin carries it forward on every republish of a gate that is still the same run, so a revisited gate keeps its original clock and only `updatedAt` advances
- `endedAt` — when the run stopped. Set on every terminal report; a `success` with no end is the row a deadline would have to guess about
- `url` — a link to the run itself: the customer's own CI page. https, one line, at most 512 characters, and the service refuses anything else, because a URL is the one free-text field on this document and "a link" is the whole of what it may be. Never log content
- `supersededBy`: `slot`, `at` — written by the service's nightly sweep when a later gate made this one moot (a deploy that passed over a test gate still `running`). The sweep writes the gate `idle` with this block and never `success`: only a reporter writes success
- `attempts[]`: `at`, `status`, `reason` (≤ 120) — every try of a gate the plugin ran itself (`teamflow ci run`), newest last, capped at 16. `reason` is the runner's own sentence — an exit code, "no verdict after 30 min" — never the command's output
- `failedSteps[]` (ADHOC-19) — the names of the steps a failed run failed at (`teamflow ci fail <gate> --step "Unit tests" --step Lint`), one line each, at most 120 characters and 20 steps, only on a `failed` report. The job's or step's name and nothing else: never its output or a log line. The service turns them into the gate's failure points
- `points[]`, `pointsRound` (ADHOC-19) — **service-written**, never posted: the gate's failure points, the same shape as the issue document's `points[]`, kept by the same rule. From `failedSteps` on a runtime gate (a passing run fixes every point at that gate; a failed run with named steps fixes the steps it no longer fails; a running report carries them on), and on the `sonarqube.json` sidecar from the quality gate's failed conditions, each as two short sentences with the metric in words, the actual value and the rule ("Coverage on new code is 61%. It must be 80% or more."), keyed by metric. Numbers and a metric's name only, as the rest of that sidecar is
- `retry`: `attempt`, `of`, `nextAt`, `status` (`retrying`, `delayed`, `given_up`), `reason` (≤ 120), `notifiedAt` — the plugin's own retry policy as it stands on this gate. `retrying` while a re-run is planned or going; `delayed` once the attempts are spent, with the reason and when the owner was told; `given_up` when a person or a later verdict ended it. **The reason is a bounded, sanitised sentence and never a command, a log line or output**: "deploy command exited 1 · 3 attempts", "no verdict from the deploy gate · 3 attempts". Nothing on it is for anybody to run

Two rules for believing a sidecar. The dashboard believes a running gate until 1× its deadline (deploy 30 min, CI and test 2 h, audit 1 h; per-organisation overrides under `adapter.delivery.gate_deadlines`, served in the bundle as `deadlines`) and draws it as "no verdict" after that; a writer closes it — `status: idle`, summary "no verdict for N" — only at 2×, so a slow deploy is doubted before it is written off. And whenever any of a ticket's gate verdicts changes, every gate with a verdict is written in the same command, so an earlier gate cannot be left `running` under a later one that passed.

### A run's own row is a plan, not a person

The execution `teamflow workflow ticket` publishes on a card — the run's verdict about the ticket, labelled with the plan's name — is `kind: "plan"`, and it always carries a `session` block naming the plan: `id` is the workflow id without its `wf-` prefix (a session id on the wire is a hex digest), `tool` is `teamflow workflow`, and `label` is the plan's name. `session.label` is new for this and is the only addition to the session block. The gate verdicts the same command writes carry the same block. Before this the row was `kind: "claude"` with no agent block, which is what a person's own work looks like, so every run was drawn as an agent named after the plan.

### A stalled run, and what the plugin did to it

The workflow document's `status` gains `stalled`: a running run whose ticket stands at a gate that has had no verdict past twice its deadline, or whose retries are spent. `stalledAt` and `stalledOn` (`key`, `gate`) say which and since when, and are present only while it is stalled. There is no `finished`: `done` is that. `hygiene[]`: `at`, `action`, `by`, `reason` (≤ 120), capped at 20, is what the plugin, or a person through it, did to the run — `resumed` / `plugin` / "resumed after deploy gate verdict", `skipped` / `<who>` / "test gate on CORE-1 skipped: <reason>" — in the same row shape the service's hygiene sidecar keeps, so a resume nobody asked for and a gate somebody passed over are on the record. A skipped gate's own sidecar reads `idle` with "skipped by <who>: <reason>", never `success`, which only a run earns.

### What a lead asked, and what came of it

`actions[]` on the issue document: `id`, `kind` (`fix`, `bump`, `rerun_gate`, `resume_plan`, `skip_gate`), `by`, `at`, `outcome` (`done`, `refused`, `failed`), `reason` (≤ 120), capped at 16. A lead acts from the dashboard; the service holds the intent for the machine that has the ticket (`GET /v1/members/actions?for=<machineId>`, answered per action at `POST /v1/members/actions/{id}/outcome`); the plugin performs what it can and this is its record. **The action's text never travels back**: a `fix` is shown to the agent on the machine and what the report carries is that it was shown; `reason` is the plugin's own sentence ("deploy runs only from the main session"). Nothing here is a queued command, and nothing here is executed from text.

### The project document

`projects/<id>.json` is the fourth document kind. A project is an
organisation-level named set: some GitHub repositories, some Linear projects,
some Jira projects. A ticket belongs to it when its repository is one of the
project's repositories or its tracker project is one of its tracker projects,
and the dashboard shows the active project and nothing else.

**No reporter writes one.** `project` is deliberately not in
`schema.KINDS` and `POST /v1/report` refuses it. A reporting credential sits
on every developer's laptop, and one that could rewrite the organisation's
project set could hide every ticket on the board from everybody. Projects are
written by members, through routes:

| Route | Who |
| --- | --- |
| `GET /v1/members/projects` | any member — which projects exist is navigation |
| `POST /v1/members/projects` | owners and admins. The service mints the id |
| `PUT /v1/members/projects/{id}` | owners and admins. Replaces the document whole |
| `DELETE /v1/members/projects/{id}` | owners and admins. Removes the document and nothing else |

It may carry:

- `id` (`prj-` and 8–32 hex, a safe path segment) and `name` — capped exactly as a workflow name is
- `repos[]`: `owner/repo` strings
- `linear[]`: `{ id, name }` — the far end's project id and the name a person picked it by
- `jira[]`: `{ key, name }`
- `default` — the project a member lands on until they choose. **Exactly one** may hold it: creating or saving a default clears the previous one
- `createdAt`, `updatedAt` — set by the service, not by the body

Identifiers and display names, and nothing else. A project is filled in by a
person in a dialog, which is exactly where a description, a README or a pasted
note would arrive from, so the same allowlist drops them.
`adapters/teamflow/schema.py`'s `PROJECT` tables and `validate_project` are the
enforcement.

Deleting a project deletes no ticket, no sidecar and no workflow. A project is
a view.

**A repository belongs to at most one project** (MACLEOD-565). A session is in
one repository and `teamflow status` has to be able to name the project that
session belongs to, so `POST` and `PUT` answer 409 `repo_taken` — naming the
repository and the owning project's `id` and `name` — rather than letting two
projects claim one. Linear and Jira projects are *not* exclusive: several
TeamFlow projects may watch one tracker project, because nothing locates a
session by a tracker.

**A project is also the import scope** (MACLEOD-565). On `POST`, `PUT` and
`DELETE`, every tracker connection's chosen scope (MACLEOD-559) is set to the
union of that provider's entries across all of the organisation's projects —
the union, because a connection carries one scope and narrowing it to the
project being saved would empty every other project's board. What was *added*
is marked for import through the existing backfill request; what was removed
imports nothing and deletes nothing. An organisation with no projects keeps its
connections unscoped, which is what every one of them was before projects
existed. The response carries `importing`: the connections a slice was asked
for. No import ever runs inside the request.

Two read-only routes serve the dialog and the wizard, and neither writes
anything:

| Route | Answers |
| --- | --- |
| `GET /v1/members/projects/options` (any member) | `repositories[] {name, source: "app"｜"plugin", lastSeenAt, project}`, `linear[] {id, name, connection}`, `jira[]`, `listable {github, linear, jira}` |
| `POST /v1/members/projects/preview` (owners and admins) | `{issues: number｜null, exact: bool}` — a real dry-run count from the far end, `null` where none can be had |

`repositories[]` has two sources and stores neither. One is what each installed
GitHub App connection covers (`provider_scope`). The other is **derived from
the reports themselves**: the `repository` field an issue document already
carries, with its newest `updatedAt` as `lastSeenAt`, which is how an
organisation with no App still gets a checkbox list. There is no registry of
repositories anywhere and there must not be one — it would be a second answer
to what the reports already say. A repository known both ways is `source:
"app"` and keeps its `lastSeenAt`. `project` is the project that already holds
it, or `null`.

### The onboarding document

`onboarding/state.json` (MACLEOD-565) is the fifth document kind and the
smallest. It carries **two fields**, `step` (1–4) and `finished`, and nothing
else — not even an `updatedAt`, because that field is the board's watermark and
a wizard step must not push a tenant's clock past its newest ticket.

It exists because setup progress is the organisation's and not a browser's: a
person signs up on a laptop and installs the plugin on the desktop where they
write code, and a teammate who is also an owner must not be shown step one
again.

| Route | Who |
| --- | --- |
| `GET /v1/members/onboarding` | any member |
| `PUT /v1/members/onboarding` | owners and admins. Body `{step}` or `{finished: true}` |

Everything else in the answer is derived where it already lives, because a copy
here is a copy that goes stale:

- `connected {github, linear, jira}` — counted off the connections
- `projects` — counted off the project documents
- `firstReportAt` — the oldest `updatedAt` among issue documents carrying a
  `reporter` block, which is what tells a report written by a plugin from an
  issue imported off a tracker
- `outside[] {repository, lastSeenAt}` — repositories plugins are reporting
  from that are in no project. **Such a report is accepted and stored exactly
  as any other**; it is simply outside every project's view, and this is what
  lets the switcher offer to put it inside one

The bundle carries the same block as `onboarding`, because the wizard opens on
first paint. It is deliberately *not* in the index's subject lists and not in
`documents`: the board draws issues, workflows and projects, and setup progress
is none of them.

The bundle carries the documents under `documents.projects`, keyed by id, and
the index lists their ids under `projects` — the same way workflows are
carried, because `projects/<id>.json` is a subject document under the one path
rule and needed no reader of its own. The bundle's `scopedProjects` is a
different and narrower thing: every tracker connection's chosen scope,
flattened, which the source pills filter *within* the active project. It was
called `projects` until MACLEOD-562 gave that word one meaning.

### The `workflow` block on a report

`workflow: { id, phase }` says which run the ticket was in when the report was
made. Two fields and no more.

It exists because the event was always arriving and the run was not. Every
hook already writes an execution on the issue document, and `executions[]` is
where a ticket's events have always gone; what nothing said was which pool the
ticket belonged to and which phase it was at, so a dashboard could not show a
run's activity from reports it was already receiving. Adding a second event log
on the workflow document would have been a second answer to a question
`executions` answers, so there is not one.

The plugin fills it from the workflow state on the machine, keyed by the
ticket, so a report is attributed whether it came from the build skill, a
teammate, or somebody working the ticket by hand. A ticket in no run carries no
block. `adapters/teamflow/schema.py`'s `WORKFLOW_REF` table is the enforcement.

Never persist prompts/transcripts, source contents/diffs, raw shell commands/tool output, secrets, issue descriptions/comments/attachments, or raw CI/test logs.

## What TeamFlow writes back to a tracker

Everything above governs what reaches TeamFlow. This governs the one thing
that leaves it: with two-way switched on by an organisation admin, TeamFlow
comments on the issue in the customer's own tracker, in front of their whole
team. It is off for every connection until somebody turns it on
(`GET/PUT /v1/members/trackers/two-way`, admin only).

**Exactly one sentence leaves the machine, and this is it:**

```
Verified on dev by TeamFlow at <updatedAt>: <summary>
Delivered by TeamFlow at <updatedAt>: <summary>
```

with the trailing `: <summary>` replaced by a full stop when the report
carried no summary, and the whole sentence cut to 300 characters with an
ellipsis when it would be longer. `<updatedAt>` is the report's own ISO
timestamp; `<summary>` is the report's own `summary` field, which is already
on the allowlist above. Nothing else is composed, quoted or attached: no
diff, no log, no command, no prompt, no evidence row, no branch name, no
commit subject and no link. The cap is tighter than the report's own
`summary` limit on purpose — a person reading the ticket never agreed to
this contract, so the ceiling is the sentence and not the field it came
from.

**A gate's verdict (ADHOC-19)** is the one other comment. For the newest
entry of an issue document's `verdicts[]`:

```
Audit passed.
Audit passed. <n> points are still open.
Audit found problems. Sent back for rework (round <n>).

<summary>

- [x] <a failure point the round found fixed>
- [ ] <a failure point it raised, or one still open>
```

(`Tests failed.`, `Deploy failed.` and so on for the other gates). The
summary is the entry's own `summary`, when it has one. The task list is the
round's failure points (`raised`, `fixed`, `open` on the entry, their text
from `points[]` below), each ticked when it is done; GitHub and Linear both
draw `- [ ]` as a checkbox. At most 4000 characters: a longer list ends with
`- ... and <n> more on the card.` The summary and every point's text are made
inert as markdown on the way out: `[`, `]`, `(` and `)` are backslash-escaped,
`&` and `<` become `&amp;` and `&lt;`, and a zero-width joiner follows every
`@` and `#` and splits every `://` and `www.`, so nothing in them links (no
raw HTML tag, no bare address), mentions a person or a team, or points at
another issue. A round that could
not add every failure because the card already held 50 open points says so
in its head: "2 more problems were not added. The card holds 50 open
points." Only on the Team plan and up, only where the organisation turned
comments on for that tracker, never for a Jira connection (it holds no write
credential), never for an ad hoc key (no tracker issue), and never for a
verdict older than six hours. Every verdict in the report that has not been
posted is posted, oldest first. Once per verdict: before posting, its marker
`teamflow-round-<sha256(key), 8 hex>-<gate>-<round>-<verdict>` is claimed in
the service's own document `writeback/verdicts/<sha256(key), 32 hex>.json`
(`{posted: [markers]}`, the newest 50), written conditionally on the tag
read, so of two racing reports exactly one posts and a busy tracker cannot
push the marker out. A comment the tracker refused gives its claim back and
is tried on the next report. The key is hashed because a GitHub key holds
`/` and `#`. An informational row with the same id goes on the tracker
sidecar's history. What the tracker answered is logged, never returned to
the caller.

**The transition carries no text at all.** With transitions on, TeamFlow
also moves the issue to the workflow state the admin named on the members
page, per TeamFlow stage. What travels is the state's name, which the admin
typed, resolved to the tracker's own id by the provider.

**When.** Only when a report puts a ticket at `DEV_VERIFIED` or
`DONE` with a status that is not `failed`. Never for an earlier
stage, a rework or a failure, never twice for the same `(key, stage)`, and
never for a ticket the tracker has already marked done, cancelled or
deleted — the tracker wins on closure, and two-way only ever moves forward
from what the skill proved. It never reopens and never closes.

**What is kept about it.** One row on the tracker sidecar's history, in the
one event shape, beside the tracker's own: `source: "tracker"`,
`kind: "tracker"`, the stage that earned it, `status: "success"`, and a
summary naming which parts went out (`Wrote comment, state`). Its `id` is
`wrote_back-<STAGE>`, which is what proves the pair has been written once.
Plus `lastWriteBackAt` on the sidecar. The words themselves are not kept —
they are in the tracker, where they were posted. A sidecar on file from
before this carries the older `wrote_back` row, and that still counts as
proof: reading only the new one would comment a second time on every ticket
TeamFlow has ever verified.

## Caching

Static assets: long/content-hashed caching. Current state: short TTL plus ETag / `If-None-Match`. Missing runtime sidecars are normal.

## The push channel

A dashboard may be told that its tenant moved rather than asking every five seconds (MACLEOD-517). What travels on that channel is a pointer and never a document: the tenant's `updatedAt` watermark and the issue keys that changed, and nothing else. The dashboard then reads `GET /v1/state/tenants/<account>/bundle` exactly as a poll would, so every byte of state still leaves through the one route this allowlist governs. A second way out would be a second allowlist to keep in step with this one, and there is no reason to have one: the reader has to make that request anyway to see the change.

The subscription key is the account the credential resolved to, never one the client named, so a connection only ever hears about its own tenant.

## The ticket's own history, and what it waits on (MACLEOD-639, WS-F)

Four more fields on the issue document, plugin-written, and one more on the `agent` block. Each is derived state on the same rule as everything above — a gate, a clock, a name, and one sentence the classifier itself wrote — and `adapters/teamflow/schema.py` refuses anything beside them. Service-observed history lives elsewhere (below).

| Field | Shape | Why it exists |
| --- | --- | --- |
| `waitingOn` | one of `review`, `ci`, `deploy`, `human`, `dependency` | A card that sits in a column says why. `git push` of the bound branch and `gh pr create` / `gh pr ready` write `MERGE` `waiting` with `review`; it is cleared by the next move. |
| `rework[]` | `{gate, at, clearedAt?, summary, by}`, the latest 16 | Every loop the ticket has been round, so a card can say which gate sent it back and when, rather than `×69` with no reason. `clearedAt` is stamped when the gate passes again; an entry is never erased. `gate` is a `DeliveryStage`, `summary` is the classifier's own line (`Local tests failed`) capped at 120, `by` is the agent's name or the tool's. `loopCount` is redefined as the number of loops **this plan cycle** — it resets when the ticket is verified or done, or when a new `/teamflow:build` run picks it up — so the number a card shows is the number a reader can act on. |
| `lastFailure` | `{stage, at, summary}` | The most recent failed gate, kept after its loop is cleared. |
| `transitions[]` | `{stage, at, by}`, the latest 32 | When the ticket changed stage and who moved it, so "in CI/CD for 41 h" is a fact the plugin recorded, not a guess from `updatedAt`. Written on every stage change the plugin makes. Transitions the **service** observes — a tracker moving the issue, a pull request event — are written to the service-owned `hygiene` sidecar (WS-D) and the read side merges the two lists; nothing the service writes lives on this document, because every report replaces it whole. |
| `agent.parentAgent` | the launcher's capped id, same shape as `agent.id` | Emitted for an agent an agent launched, so the board can nest them. Absent when the session launched it. |
| `verdicts[]` (ADHOC-19) | `{round, gate, verdict, at, by?, summary?, raised?, fixed?, open?, notAdded?}`, the latest 20 | Every gate verdict on **this** ticket: an audit pass, or a round a gate sent it back. `gate` is a workflow cycle (`audit`, `test`, `deploy`, …), `verdict` is `pass` or `fail`, `round` is the attempt at that gate, `by` is the orchestrating person's display name (the report's `actor`). `summary` is the words the orchestrator deliberately wrote with `teamflow workflow ticket <KEY> --findings <text>` (or `--note` on a rework), like a ticket's `note`: one line, whitespace collapsed, control characters stripped, at most 280 characters, never a prompt, diff, command or log. A rework with no words is a round with no `summary`. Published on the ticket's own card, keyed by `<KEY>` and never by the session's binding. Appended, never rewritten: the plugin keeps the last 20 and the service carries the stored list across every report that leaves it out (a hook's report replaces this document whole), unioned by `(gate, verdict, round, at)`. `raised`, `fixed` and `open` are point ids (below): the points this round raised, the open ones it found fixed, and the ones still open after it. |
| `points[]` (ADHOC-19) | `{id, gate, key?, text, from, rounds?, lastRound?, state, at, by?, doneAt?, doneRound?, doneBy?}`, 50 at most, open ones never dropped for the cap: a run that would push an open point out raises no point and counts it on its verdict as `notAdded` | Why a gate sent the card back, one line each, checked off by the runs that follow (one rule: `plugin/scripts/points.mjs`, mirrored in `adapters/teamflow/points.py`). A point failed again stays open and `rounds` goes up; a new failure is a new point in that round; a run that judged every point at its gate marks the ones it did not fail again `done` in that round. On this document the plugin writes two kinds. **Audit and recorded findings** (`F1`, `F2`, …): each `--finding <text>` a person gave to `teamflow workflow ticket <KEY> --state rework`, one line, at most 280 characters, the same sanitising as `note`, at most 20 in one round (more is refused with a sentence, never cut); `--done <ID>` and `--reopen <ID>` change `state`. Nothing is closed by omission: a failed audit only adds points, a second call at the same gate with no new rework in between adds to the same round, and only an audit given with `--rechecked` (a complete re-audit, or a pass that checked everything again) marks the open audit points it does not list `done`. A pass without `--rechecked` closes nothing. **Failing tests** (`T-<6 hex>`, gate `test`), see the next row. Points are never deleted. Carried by the service across reports that leave them out, merged by `id` with the report's copy winning. |
| `points[]` from a test run (ADHOC-19) | **Off. The owner declined on 2026-09-22 for now; cards get a per-file count instead:** one point per failing test file with a count, `<file>: 2 tests failing` (key: the file), or `2 tests failing` when the runner names no file, and no test name. The service drops any named test point it receives. The code still holds the switches (`reporting.failingTests` in the plugin, `adapter.reporting.failingTests` in the service), both off, and they stay off unless the owner decides otherwise. What a named point would carry, for that decision: a failing test's **identifier**, its file and name as the runner printed them on its own summary line (`FAILED tests/test_x.py::test_y`, vitest `FAIL a.test.ts > group > name`, jest `● group › name`, TAP `not ok N - name`, go `--- FAIL: TestName`), with a trailing `[...]` parameter part cut off, at most 20 per run, 160 characters each. Parameter values a runner expands into the name itself (jest's `it.each` with `%s`) cannot be told from the name and stay in it | So a card a test run sent back carries which tests failed, and the next run checks each one off when it passes. Only the identifier: never the assertion message, a diff, a stack trace or any other line of output (`plugin/scripts/failing-tests.mjs`; `plugin/tests/failing-tests.test.mjs` asserts a message printed beside the name never reaches the payload). Test names come from the customer's repository, which is why this row is listed apart. Only a whole-suite run, or named test files run in full, checks a point off; a run of one file judges exactly that file's points. A directory, a filter word, a node id, a glob or a name filter (`-k`, `-t`, `--grep`, `--testNamePattern`) makes a run partial and it checks nothing off, and so does a run with more than 20 failures, whose list was cut. A run judges only its own runner's points: pytest the Python files, go the `_test.go` files, vitest, jest, mocha and node:test the JavaScript and TypeScript ones; a point whose name carries no file keeps its runner in its key (`js|group › name`). |


**Nothing else travels with them.** No command, no test output, no log line, no file name: `summary` is the sentence the classifier already puts in `summary` on the report, and the plugin's `sanitizePayload` allows `at` and `by` inside these blocks and nowhere else on the flat payload.

**Attribution of a merge.** `git merge <branch>` / `git merge --no-ff <branch>` in a bound session, where the merged branch name carries an issue key that is not the bound one, publishes `MERGE` `success` **for the key the branch names** — a second, separate report, carrying that key, the merged branch, one `transitions[]` row and the merging actor's execution, and nothing of the merging session's own ticket. The bound ticket does not move. Only a key of the bound ticket's own project is attributed — any other `WORD-N` token in a branch name is a branch name, and a GitHub tenant's `repo#N` keys never appear in one, so nothing is attributed there rather than a ghost card. A branch with no key is the bound ticket's own merge, as before. When a new plan run picks a ticket up, the earlier run's open loops are stamped `clearedAt` at that moment, so the open entries in `rework[]` are the loops `loopCount` counts. A pull request merge (`gh pr merge`) stays `MERGE` `success` on the bound key; the pull request sidecar is what sees the merge land.

## Gates and pipelines (MACLEOD-639)

### Gate fields on a runtime sidecar

A runtime sidecar may say which gate it reports against: `gate`, optional,
a `Gate.id` such as `ci` or `sonarqube`. The dashboard draws the sidecar in
that gate's column whatever `stage` says, which is how an external system's
verdict reaches a column of its own without a fourteenth stage. `GATE_REPORT`
in `adapters/teamflow/schema.py` is the table and `RuntimeState` in
`src/types.ts` the same field. The run's own clock (`startedAt`, `endedAt`)
and its `url` (https only, a link to the run in the customer's own system,
never log content) are the gate lifecycle's fields and are documented with
it; a gate that started and never ended is "no verdict" past its deadline,
never "running forever".

An external system reports a gate the way a CI job does — a runtime sidecar
the dashboard merges like `ci.json` — in a slot named after the system and
**reserved to its connector webhook**: `sonarqube.json` is in
`RESERVED_SLOTS` beside `tracker` and `pr`, so `/v1/report` refuses it by
name. A reporting key that could post a `sonarqube` verdict would pass a
failed quality gate by hand, and the HMAC on the webhook would prove
nothing. What the webhook writes is the verdict, the failing conditions as
metric names and numbers in plain words (`coverage on new code is 63.2%,
it must be 80% or more`, ADHOC-20) in `summary` and `evidence`, the analysis clock as `endedAt` and the project's url. No
finding, no rule text, no file name, no line of code. The ticket is read out
of the analysed branch name (or the `sonar.analysis.teamflow.key` scanner
property) by the pull request connector's grammar and, before anything is
written, checked against the prefixes and repositories the organisation
actually uses, so a branch called `next-15` opens no card.

### The pipeline document

`pipelines/default.json` is the organisation's pipeline and
`projects/<id>/pipeline.json` is one project's own copy, written only once
somebody edited it (copy-on-write). A pipeline is `{id, name, gates[]}` and a
gate is `{id, label, stages[], kind, rework?, deadlineMin?, external?}`: an
ordered mapping of the thirteen delivery stages into named columns, and
nothing else. `stages` are drawn from `STAGES` and no gate classifies an
event. `PIPELINE` in `adapters/teamflow/schema.py` is the table;
`src/lib/pipeline.ts` the same shape.

**No reporter writes one.** `pipeline` is not in `schema.KINDS` and
`POST /v1/report` refuses it, for the reason a project is refused: a
reporting credential sits on every laptop, and one that could rewrite the
organisation's columns could hide every ticket from everybody. Pipelines are
written by owners and admins through `PUT /v1/members/pipeline` and
`PUT /v1/members/projects/{id}/pipeline`; `GET /v1/members/pipeline?project=`
resolves project → org → default and says which answered (`source`), and the
bundle's `pipeline` field carries the same resolution plus every project's
copy. Solo and Team may reorder and rename the default gates and set
`rework` and `deadlineMin`; adding, removing or re-staging a gate, and any
external gate, is Growth and above. The one free-text field is a gate's
`label`, capped at forty characters; `updatedBy` is the saving member's
address as the ledger names the seat.

### Custom gates: repository checks and SonarQube (MACLEOD-639, ADHOC-20)

An organisation on Growth or above adds its own columns. A custom gate is
a gate of kind `check` or `external` that **holds no stage**: it is a check
a card must pass between two columns, it never takes a stage from the
thirteen, and it never classifies an event. `validate_pipeline` refuses a
custom gate that holds a stage (`custom_gate_stage`). A custom gate's
verdict is drawn at the gate by its `gate` id; its sidecar carries the
first stage of the nearest gate before it (`pipeline.stage_before`), so a
pass holds the card at that point and a failure sends it back from there.

**`check` gates.** The organisation names the check and places it; the
gate's `id` is the check's name. The command is the repository's, in its
own `.teamflow/checks.json` (`{"lint": "npm run lint"}`), and **never the
service's**: the gate table has no field for a command, and one sent is
dropped. The plugin classifies a finished run of exactly a declared command
as that check's pass or fail and reports it as a runtime sidecar:

| Field | Value |
| --- | --- |
| slot | `check-<name>`, a gate id (`schema.is_check_slot`). One sidecar per check, so two checks never overwrite each other |
| `gate` | the name; the service pins it to the slot's name whatever the report says |
| `kind` | `test` |
| `stage` | a placeholder; the service replaces it with `stage_before` for the organisation's pipeline |
| `status`, `summary` | `success`/`failed`; the plugin's own sentence (`Lint passed`), never output and never the command |
| `startedAt`, `endedAt`, `evidence` | as for any gate run; evidence is counts only (`extractTestEvidence`) |

A failed check carries one `failedSteps` entry (`Lint check`), so it
raises one failure point the next pass checks off (`points.on_runtime`,
the slot as the runner). A declared check is classified before the test
and audit patterns: a repository that declares `"unit": "npm test"` makes
`npm test` that check's verdict instead of Local Test. That is intended;
one run never passes two gates.

A check the organisation's pipeline does not hold is accepted and **not
written** (`ignored` in the answer): a repository may declare checks nobody
on the board asked for, and those move no card.

**`checks` on an issue report**, optional: the list of check names the
repository declares, at most sixteen gate ids. Names only; the commands
never leave the machine. A card shows "Not set up in this repository" for
a check the organisation added that this list does not name, and that
check never blocks.

**`external` gates that TeamFlow calls.** SonarQube's webhook stays the
push route. An organisation may also connect SonarQube with a server url
(empty means SonarQube Cloud) and a user token, through
`PUT /v1/members/sonarqube` (owners and admins, Growth and above). The
token is sealed with the kit's connection key into the SonarQube
connection's `token_enc`; the server is its `provider_ref`. Only a person
signed in as themselves may set or remove it (`not_a_person` otherwise): a
plugin key, an OAuth client or a device credential never can, whatever its
role. No answer ever carries the token: `GET /v1/members/sonarqube` returns
`{connected, server, tokenEnding, project, lastError}`, `tokenEnding` being
its last four characters. When a card reaches the gate (a pass at the
stage the gate follows) the service writes a marker
`gates/external/<key>.json` (`{key, at, branch, attempts, claimedAt?}`,
service-owned; `gates/external-run.json` records the one invocation in
flight) and its `gates.external` job asks SonarQube's
`api/qualitygates/project_status`. What it asks about is never the
reporter's choice: a branch whose name carries the card's key (the
webhook's grammar in reverse), or the pull request the GitHub App's signed
`pr` sidecar tied to the card; neither, and nothing is asked. A GitHub
Issues key (`repo#N`) usually works only through the `pr` sidecar,
because a branch name rarely carries `#N`; that fails closed, which is
right. A card that gets no verdict is asked again only a bounded number of
times, and the attempt is counted when it is claimed, before the call. No pull
follows a webhook: the webhook's signed verdict is the answer for the
branch it analysed. Each call has one five-second wall-clock deadline,
lookup and headers included (a timer shuts the socket at the deadline),
follows no redirect, goes only to port 443 of an address that resolved to
a global unicast address at call time (NAT64 prefixes refused) (TLS still checks
the host name), and is never retried inside a request; one invocation
spends at most twenty seconds. The verdict is written through the
webhook's own writer into the `sonarqube` slot, with the same fields and
the same failure points (one per failed condition, keyed by metric, checked
off by a passing analysis); `deliveryId` is `pull:<key>:<time>`. An error
is one fixed sentence on the connection's `last_error`, never SonarQube's
text, and a refused address reads the same as a network failure.

**Plain words.** Since ADHOC-20 a SonarQube verdict's `summary` is a
sentence a layman reads (`Quality gate failed: coverage on new code is
61%, it must be 80% or more`) and each failing condition's `evidence` row is
`{label: "Coverage on new code", value: "61%, must be 80% or more",
status: "failed"}`. Still names and numbers only.

`GET /v1/members/pipeline` also answers `tier`, `customGates` (may this
organisation add a column) and `customGatesTier` (the plan that adds them,
by name), so the editor offers only what the `PUT` would accept.

### What the SERVICE writes beside a card (MACLEOD-639, WS-D)

Three service-owned files, none of which a reporter can write. Each names its writer.

**`issues/<KEY>/hygiene.json` — the reserved `hygiene` slot.** In `RESERVED_SLOTS` beside `tracker` and `pr`, so `POST /v1/report` refuses it (`reserved_slot`). Written by the nightly sweep (`delivery.sweep`, adapters/teamflow/hygiene.py) and by the card routes below, always under the ETag that was read, so a report or a delivery that lands in between makes the write a refused row rather than a lost update. It holds, per key:

- `hygiene[] {at, action, by, role, reason, note?}` capped at 20. `by` is a member's address or `teamflow` for the sweep; `role` is `owner`, `member`, `viewer` or `service`; `reason` is one of `no_verdict | superseded | owner_request | deadline | tracker_done | snooze | ping | action | note | refused`; `note` is ≤ 120 characters through the one-line sanitiser. Recent Activity and a card's History print these rows.
- `attention[] {key, rule, by, kind, snoozedUntil?, pingedAt?, escalatedBy?}` capped at 16 — org-visible marks so two leads do not chase one card. `kind` is `snooze | ping | escalate | action`, one mark per (rule, kind), so a ping never replaces a snooze; `rule` is one line of at most 40 characters, refused before anything is mailed; `escalatedBy` names who escalated when the developer was told by somebody else. Also served flat as the bundle's `attention[]`.
- `decisions[]` and `policy` (WS-K, below) ride on the same sidecar and every hygiene writer keeps them.
- `transitions[] {stage, at, by}` — the stage moves the SERVICE observed (a tracker's Done, a pull request event, the sweep's own migration), kept apart from the plugin's list on the issue document and merged at read.
- `supersededBy {slot, at}` — the sweep closed an earlier gate because a later one answered. Never `success`.
- `actions[] {id, kind, by, role, at, args?, status, servedAt?, servedTo?, outcomeAt?, outcomeReason?}` capped at 16 — the action queue. `kind` is one of `fix | bump | rerun_gate | resume_plan | skip_gate`; `args` is `{text ≤ 500, gate ≤ 40, reason ≤ 120}`, sanitised; `status` moves `pending → served → done | refused | failed`. A `fix`'s text is shown to the agent as guidance from a named person; nothing is ever run from it. The plugin's own record of the outcome is `actions[]` on the issue document (above).
- `notes[] {at, by, text ≤ 500}` capped at 50 — discussion on a ticket (ruling 8), Team plan and up, in-org only. Never in a report and never written to the tracker.

**`members/<id>.json` — the members index.** `{id, email, lastReportAt, lastKey?, aliases[], updatedAt}`, written in `adapter.run` from `ctx.member` — the credential the kit resolved — and never from a field a document carried. `id` is `m-` and sixteen hex characters of the address, so no file name under a tenant carries an email. The bundle serves it joined to the ledger as `members[] {id, displayName, role, kind, lastReportAt, lastKey?, aliases[]}`, every seat included, a member with no reports at `lastReportAt: null`. Person heads and "assigned to X · reported by Y" read this and never guess from a display name.

**`hygiene/sweep.json` — the sweep's record.** `{lastRunAt, nextAt, actions, refused, pending, cursor, sweep_slice_at, snapshot[]}`, one per tenant, written by each slice. `snapshot[]` is ≤ 30 nightly rows of `{date, project, shipped, inFlight, rework, stalled}` per project; the bundle serves it as `snapshot[]` and the clock as `health.sweep {lastRunAt, nextAt, actions, refused}`.

**Bundle additions**, computed in app.py from the documents already read and cached with the bundle's ETag: `members[]`, `attention[]`, `health {refusals24h, pausedUntil, connections[] {id, provider, status, lastError?}, sweep}` (`status` is `ok | failing | pending | waiting` for everybody: a sign-in never finished, or nothing delivered yet, is not `ok`; `lastError`, one line and capped at 120, is in a lead's bundle only), `snapshot[]`, `deadlines {deploy, ci, test, audit}` in minutes (service.config.json `adapter.delivery.gate_deadlines`, then the org's `settings/delivery.json`; drawn at 1×, written at 2×), `idleAfter` (minutes), `reportedColumns[]` (every stage any reporter in the tenant has ever emitted into) `pings {KEY: …}` (WS-I's records) and `tier` (the organisation's plan, lower-cased, so the page can say a Team-plan button's reason before it is pressed; the service still decides).

**Card routes**, every one attributed to a seated person (a pipeline token is refused):

| Route | Who | Writes |
| --- | --- | --- |
| `POST /v1/members/cards/{key}/actions {action, args?}` | `fix`, `bump`, `rerun_gate`, `resume_plan`, `skip_gate`, `mark_gate_done`: the card's developer (tracker `assignee.member`, else the issue document's `member`) or an owner/admin; viewers refused with a sentence. `ping`: any member or viewer. `snooze {for: 24h｜7d, rule?}`: members, org-visible; a viewer's snooze stays in their browser. `escalate`: **always to the developer first** — from anybody but the card's developer it is a ping to the developer (ping.send, its limits and opt-out) plus an `escalate` mark naming who asked, with nothing on the tracker, no note and nobody else told; a refused ping writes nothing. Only the card's developer escalating their own card passes it on: the organisation's leads are mailed (`ping.pass_on`, same limits) and, on the Team plan and up, the loop reasons go on the card as a note and to the tracker where a credential and the comments switch exist. `sync_tracker`: owners and admins, behind the two-way switch, refused with a members-page link for a connection with no credential | a `hygiene[]` row per write |
| `POST /v1/members/cards/{key}/gates/{slot}` | Mark gate done by name: `idle` "closed by <member>" holding the column, or `success` "…, corroborated by <slot>" only when a later gate or the tracker says so | the sidecar + a row |
| `POST /v1/members/cards/{key}/notes {text}` | members and viewers, Team plan and up | `notes[]` |
| `GET /v1/members/actions?for=<machineId>` | the developer's own credential; each action served once (`servedTo`, `servedAt`) | `actions[]` |
| `POST /v1/members/actions/{id}/outcome {outcome, reason, for?}` | the developer's credential, for an action in `served` (409 `not_served` otherwise); `for`, when sent, must be the machine it was served to; a settled outcome is never overwritten (409 `already_settled`) | `actions[]` + a row |

**Write-back from verified events** (spec 1.6): Backlog → In Progress on the first LOCAL_DEV report of a key when `states.LOCAL_DEV` is mapped; → Done only from the pull request sidecar's HMAC-verified `merged` delivery, never from a plugin-reported MERGE; a tracker reopen silences write-back on that key until the tracker moves again.

## Decisions (MACLEOD-639, WS-K)

Nothing in this section travels in a report. It is what the **service** decides about a ticket that has stopped, from derived state it already holds, and where it keeps the answer.

`adapters/teamflow/decide.py` answers three fixed questions — `delay_kind` (`flake | real_failure | waiting_on_person | external`), `same_failure_as_previous` (`yes | no`), `note_kind` (`question_for_developer | fyi | decision_needed`) — and a policy chooses one action from a **closed** set, `retry_now | stop_retrying | wait | route_to_developer | attach_only | resume_plan` (the harness's own moves: `retry_now` is its bump, `resume_plan` its resume), or nothing when no answer clears the confidence threshold. There is no other action: no command, no skip, no escalate, and a decider that names one is dropped and logged. The plugin's stage classifier is not consulted. Every action carries a `criticality` (`low | medium | high | critical`, rules-computed from the state) and `escalated`, whether a person was shown it, per the organisation's `escalation` setting (`always | by_criticality | never`; `adapter.decide.escalation`, overridable as `escalation` on the pipeline document — the one optional field this contract appends to `PIPELINE`). `critical` stops the harness whatever the setting.

| Field | Where | Shape | Why it exists |
| --- | --- | --- | --- |
| `decisions[]` | the service-owned `hygiene` sidecar, `issues/<key>/hygiene.json`, served by the bundle as `documents.runtime[<key>].hygiene` | `{question, chosen, confidence, by, at, input, criticality, escalated, action?}` — `by` is `rules` or `laya`, `input` the hash of the state decided from (`updatedAt` excluded, so a heartbeat is not a change) | So the Attention row can say *why* a card stopped and why the harness did what it did, and so a decision is made once per change rather than once per report. The write is a read-modify-write with a version check, because the sweep, attention marks and notes share the file. |
| `policy` | the same sidecar | `{action, reason ≤ 120, at, input, criticality, escalated, waitingOn?, learned?}` or null | One answer for WS-E's self-heal and WS-D's Attention row alike; `escalated` is whether the row is drawn or the entry stays in History. `learned` is true when the action rests on a lowered bar with current held-out proof (ADHOC-25). |

The sidecar's slot is in `RESERVED_SLOTS`, so `/v1/report` refuses it by name; only the service writes it, and the rows above are the only rows this contract adds to it (`DECISION` and `DECISION_POLICY` in `adapters/teamflow/schema.py`, `Decision` and `DecisionPolicy` in `src/types.ts`).

**What a decider sees** is the derived-state allowlist `decide.STATE_FIELDS` and nothing beside it: `gate`, `status`, `gateKind`, `updatedAt`, `startedAt`, `endedAt`, `waitingOn`, `loopCount`, `rework[]` (`gate`, `at`, `clearedAt`, `summary` ≤ 120), `lastFailure`, `retry` (`attempt`, `of`, `status`, `reason` ≤ 120) and `note` (≤ 500, whitespace collapsed to one line). Every one of them is already a field this document allows or a count of them. When the decider is a self-hosted Laya endpoint (any tier; `adapter.decide` in service.config.json, docs/DEPLOYMENT.md §9) that dict and the fixed question table are the whole request body, and `tests/test_decide.py` asserts it on the bytes a fake server received.

### TeamFlow's own actions (WS-K2)

Also service-written, never reported. `adapters/teamflow/autonomy.py`
consumes `policy` and may queue, as actor `teamflow` with role
`autonomous`, one of `bump`, `resume_plan` or a `fix` whose text is only
"`<gate>` failed again the same way, reported as "`<words>`". Take a
different approach before retrying.", where `<words>` is
`lastFailure.summary` made inert (control characters, backticks, quotes,
`$`, pipes, semicolons, redirects and ampersands removed, no leading
prompt marker, one line, ≤ 120) and quoted as the report's own -- never `skip_gate`, never a ping,
never any other text. Nothing new leaves the service: the queue row is
the one `actions[]` already carries and the plugin already serves.

| Field | Where | Shape | Why it exists |
| --- | --- | --- | --- |
| `autonomy` | the `hygiene` sidecar | `{autonomous: true, state: acting｜stopped｜idle, at, reason? ≤ 120, input?, criticality?, shown, action? {id, kind, at, label?}, decision? {question, chosen, confidence}, awaiting? verdict, fixGate?, fixes?, learned?, recent[] ≤ 64, done[] ≤ 16}` | So the Attention row and History can say what TeamFlow did and why ("re-ran the Local test gate at 10:12 (flake, 0.9)"), so the escalation setting decides who sees it (`shown`), and so an input is acted on once and a card's hourly count and fix count are enforced. |
| `attention[].kind: autonomy_off` | the same sidecar | the existing mark, `{key, rule: "*", by, kind}` | The card's developer or a lead switched TeamFlow's actions off here; everyone sees who. |
| `hygiene[]` with `by: teamflow`, `role: autonomous`, `reason: action` | the same sidecar | the existing row | One History row per TeamFlow action and per stop. |
| `settings/autonomy.json` | per tenant, written by `PUT /v1/members/autonomy` (owners and admins) | `{enabled?, by?, at?, projects[] {project, enabled, by, at}, updatedAt}` | Whether TeamFlow acts in the organisation and in each project; project over organisation, default on. |
| `settings/autonomy-limits.json` | the service's own store account `teamflow:service`, written by `PUT /v1/admin/autonomy` (superadmins) | `{global {per_ticket_hour?, per_org_hour?, fix_cap?, by, at}, orgs[] {account, …, by, at}, updatedAt}` | The rate limits (default 12 per card and 600 per organisation an hour) and the fix cap (2), per organisation over global over config. |
| `hygiene/decide/<key>/<slot｜issue>.json`, `hygiene/decide.json`, `hygiene/autonomy.json` | per tenant | `{key, at, path?}`; `{dispatchedAt, finishedAt}`; `{window, count}` | The markers the report path leaves, one per source so a later report never hides an earlier sidecar's verdict, the job's in-flight record, and the organisation's hourly count. Bookkeeping; never served to a dashboard. |

## Converting an ad hoc item into a ticket (MACLEOD-639, ADHOC-15)

Nothing new travels in a report. `POST /v1/members/cards/{ADHOC-n}/convert` (`{project}` or `{to}`; the card's developer or an owner, never a viewer, Team plan and up) is a member action, and everything it writes is service-owned.

**What leaves for the tracker** when the service creates the issue (Linear through its authorisation; GitHub only when the App installation holds `issues: write`; never Jira, whose connections hold no credential): the ad hoc `title`, the tracker state mapped from the card's gate (the organisation's write-back `states` map first, then Backlog / In Progress / In Review / Done), the card's developer's address as a lookup the tracker answers or ignores (Linear only; never written to the issue), and this description, built only from named derived fields:

```
Converted from the TeamFlow ad hoc item <ADHOC-n>.
Stage: <stage label> (<status>).
Gates: <slot> <status>, ...
Rework at <gate>: <rework summary, one line, ≤ 120>      (at most five)
TeamFlow card: https://<service domain>/app/#delivery?issue=<ADHOC-n>
Ref: teamflow-<ADHOC-n>-card
```

The report's own `summary` is not in it, and neither is anything else: no prompt, diff, log, command, branch or evidence. `tests/test_adhoc_convert.py` asserts a summary written as a prompt does not reach the body.

| Field | Where | Shape | Why it exists |
| --- | --- | --- | --- |
| alias document | `aliases/<ADHOC-n>.json`, served as `documents.aliases[<ADHOC-n>]` | `{from, state, provider, at, by}` plus `{target, marker}` while `state` is `pending`, and `{to, url, project}` once `done` — `by` is the converting member's address as the ledger names the seat | Which ticket an ad hoc key became. The pending document is written create-only before the tracker is asked, which is the claim; a retry after a lost response finds the issue by `marker` (`teamflow-<ADHOC-n>-card` on the description's last line: letters, digits and hyphens only, so no markdown normalisation can escape it; the older `[teamflow:<ADHOC-n>]` form is still looked for) and believes a search hit only when its body holds the exact marker, instead of creating a second one. No report can reach `aliases/`. |
| `convertedTo`, `convertedAt`, `convertedBy` | `issues/<ADHOC-n>.json`, rewritten by the service as a small record (key, title, stage, status, `member`) | key, ISO time, member address | So links and search that name the ad hoc key land on the ticket ("was ADHOC-n"). A later report under the ad hoc key is written under the ticket instead, so the record is never overwritten. |
| `convertedFrom` | the converted ticket's issue document, `issues/<KEY>.json` | the ad hoc keys it was, sorted | Stamped by the move and carried by the service on every later report for that key, which merges the report's history lists (`transitions`, `rework`, `executions`, by identity) into the moved ones instead of replacing them; the report still wins every other field. |
| `addedBy: "converted"` | a workflow ticket | one more value of the existing enum | The node was renamed from an ad hoc key in place; phase, rank, state, cycle, note and every edge are kept. |
| `converted_from`, `converted_to`, `converted_tracker` | the `/v1/report` answer, never a document | keys and a tracker kind | Tells the plugin that sent a report under a converted key to rebind to the ticket. |

## Pings: the service mails one member at another's request (MACLEOD-639)

`POST /v1/members/cards/{key}/ping {note?}` sends **one mail to the card's
developer and to nobody else** (ruling 7: a viewer's escalate is a ping to
the developer, and there is no path from a viewer to anyone else). The
developer is the seat the tracker sidecar's `assignee.member` names — a
verified match written by `people.resolve_assignee`, never a display name —
and the request cannot name a recipient: an address in the body is ignored,
and a card whose assignee matched no seat is refused with that sentence.

| Route | Who |
| --- | --- |
| `POST /v1/members/cards/{key}/ping` | any active member or viewer of the organisation. A credential that names no person (an account key, a pipeline token) is refused: a ping is attributed to somebody |

What bounds it is the kit's mechanism, TeamFlow's meaning: the ledger's
compare-and-set counter, `adapter.delivery.pings_per_card_per_day` (3) and
`pings_per_sender_per_day` (20) per UTC day, and the developer's own
`notify_pings` flag on their ledger row, cleared only by the link at the
foot of every ping mail (`GET /v1/mail/pings/off/{token}`, signed under the
stack's token key, 30 days). Each refusal is a sentence: `opted_out`,
`card_cap`, `sender_cap`, `no_developer`, `mail_disabled`. `mail.pings` in
`service.config.json` is the switch.

**What is kept about it.** `pings/<KEY>.json` — `{jiraKey, pings[] {at, by,
note?}}`, newest last, capped at 20 — is **service-written** by this route
and by nothing a plugin reports: its own subject kind under the one path
rule, not a sidecar under `issues/<KEY>/`, so the board never reads it as an
execution. `by` is the sender's seat address; `note` is the sender's one
line, whitespace-collapsed and capped at 120 characters. The issue document
is untouched by a ping; the one sidecar it writes is the service-owned
`hygiene` slot, a `hygiene[]` row with `reason: ping` and an `attention[]`
mark with `pingedAt`, so a card's History and the Attention row say who
pinged and when (WS-D, both doors). The mail's clearing-link token is in the
mail and in no stored object. The bundle serves the record as `pings {KEY:
{pings[]}}`.

## Learning from outcomes (MACLEOD-639, WS-K3)

No report carries anything new for this: every field below is written by the service, from documents this contract already allows, into service-owned documents four path segments deep under `learning/v1/` (so no subject rule reads one as a card, and the bundle never serves them).

| Field | Where | Shape | Why it exists |
| --- | --- | --- | --- |
| `decider_version` | each row of `decisions[]` on the `hygiene` sidecar | ≤ 40 characters: `rules-2026.09`, or a Laya endpoint's own `model_version` | So an outcome label says which model it grades, and a shadow comparison can tell two models apart. |
| capture log | `learning/v1/decisions/<key>.json` | `entries[] {id, question, input, at, chosen, confidence, by, decider_version, criticality, escalated, action?, autonomous, source, features, label?}`, 50 per card | The sidecar keeps only the latest decision; this keeps each one with the derived state it was made from until its outcome is known. |
| label row | `learning/v1/labels/<yyyy-mm-dd>.json` | `rows {<opaque id>: {org, question, input, features, chosen, confidence, by, decider_version, label, truth?, labelled_at, decided_at, criticality, action?, escalated, autonomous}}` | What happened next, per decision: `correct`, `wrong` (with `truth`), `criticality_under`, `should_show`, `criticality_over` or `unlabelled`. |
| calibration | `learning/v1/calibration/current.json` | per answer (`question:chosen`) `{value, source, labels, correct, precision, buckets}`, `raised`, `changes[] {at, text}`, `versions[]`, `holdUntil?` | The organisation's own confidence bars, one per answer so a common answer cannot lower a rare one's, and every change as a sentence. |
| consent | `learning/v1/consent/state.json` | `{own, pooled, history[] {at, by, switch, value}, purgeBefore?, purgedAt?}` | Owners' and admins' two switches, set only by a signed-in person, with who and when; `purgeBefore` is stamped when own training is switched off. |
| private model | `learning/v1/entitlements/private-model.json` | `{enabled, source, at}` | The flag for the "trained only on your data" tier; the billing webhook will set it once the product exists (nothing writes it yet). |

`features` hold **no free text**. They are `decide.STATE_FIELDS` without `note`: `gate`, `status`, `gateKind`, the clocks, `waitingOn`, `loopCount`, and `lastFailure {stage, at, digest, flake}`, `retry {attempt, of, status, digest, flake}`, `rework[] {gate, at, clearedAt?, digest, flake}`, where `digest` is the first 16 hex characters of sha256(organisation + the normalised line) and `flake` whether the line matched the rules' transient-failure pattern. A failure line or retry reason is therefore only ever compared for equality within one organisation, and never kept; a note is not kept at all; every other string is a short enum, id or timestamp (`decision_labels.SHORT`), and anything else is dropped at the write (`decision_labels.clean_row`). A label row never holds a ticket key (the row id is a hash of it), a member, an address, a command, a prompt, a diff or a log. Labels are kept 90 days. When an owner switches own training off, capture and labelling stop at once, the policy reads the default bars at once, and a purge job starts at once and deletes every capture and label made before the switch, whatever the switch says by the time it runs; the nightly fan-out keeps the tenant due until the purge has finished, activity or not. A pooled set is assembled at read time from the organisations whose pooled switch is on at that moment (which needs own training on) and which are not private, and is never stored.
