# TeamFlow reporting contract

The report store is a small tenant-scoped current-state store, not a database or event bus.

## Transport

A reporter posts one report at a time to the service:

```text
POST <serviceUrl>/v1/report
Authorization:   Bearer <access token>
Idempotency-Key: <sha256 of the report's content, excluding updatedAt>

{ "kind": "issue" | "runtime", "slot": "<slot>", "payload": { ... } }
```

A reporter authenticates with a short-lived access token: a developer's, from signing in once, or a CI job's, from exchanging its GitHub Actions OIDC token. `X-Api-Key` with a long-lived organisation key is the non-interactive fallback. The credential is resolved per request, so a queued report authenticates with whatever is valid when it is finally delivered.

`kind` is `issue` for a ticket's current state and `runtime` for one background sidecar; `slot` is present only for `runtime` and must be one of the slots below. The payload is a `TicketState` or a `RuntimeState` as defined in **Allowed current-state data**.

Three properties of this transport are load-bearing:

- **The tenant comes from the credential.** The account behind the token or key owns the tenant prefix. A `tenantId` in the payload is dropped, because a body that names a tenant is describing somebody else's data.
- **Unknown fields are dropped, not rejected.** The service answers 200 and lists what it dropped in `dropped_fields`. A reporter that grows a field, or is talked into attaching a prompt, a diff or a log line, cannot make that field reach the store by naming it something the service has never heard of.
- **The idempotency key is the report's content hash.** A heartbeat that repeats an unchanged report is the same request, replayed rather than charged again. Only real progress is a new report, and one accepted report costs one credit.

Answers: 2xx accepted (`replay: true` when it was a repeat); 402 the organisation is out of credits, which is logged once and never blocks; 429 rate limited, queued and retried after `Retry-After` or a capped backoff; any other 4xx the report was refused and is not retried; 5xx and network failures are queued and retried with the key they were queued with.

The legacy transport writes the same documents straight to S3 at the paths below with AWS credentials, and is selected when `dataUri` is configured and no service credential is available.

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
- the tracker webhook owns `tracker.json`, and the same webhook's pull request, review and check deliveries own `pr.json`; `/v1/report` refuses both slots by name, because the webhook proves who sent a delivery with an HMAC signature and a report only proves who holds the tenant's API key.

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
- `tickets[]`: `key`, `rank`, `phase`, `state`, `cycle`, `addedBy`, `updatedAt`. `state` is one of `waiting`, `running`, `done`, `blocked`, `skipped`, `rework` — the same six the plugin and the dashboard spell, and the enum refuses the whole document rather than the field, so a state missing from one of the three spellings is a run that stops reaching the board entirely (MACLEOD-601)
- `dependencies[]`: `from`, `on`, `reason`, `found` — which ticket waits on which, and whether planning or a team building found it
- `phases[]`: `n`, `state`, `tickets[]`

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
