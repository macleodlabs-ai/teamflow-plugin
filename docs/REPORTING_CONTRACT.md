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
- an ad hoc item's `about`: one plain sentence (at most 200 characters) saying what the work is, made on the machine by the writer (`words.about`) from the agent's one-line task, the first commit subject naming the item, or the plan's name. Never the prompt (MACLEOD-646)
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

#### The CI gate's parts (MACLEOD-792)

The service reads the jobs and steps of each CI run the GitHub App hears about (`adapters/teamflow/ci_parts.py`), in the five-minute pass and never inside the webhook's request, and adds what they say to the same sidecar:

```text
"parts": [ { "kind": "build" | "lint" | "test" | "security_scan" | "deploy",
             "label": "Tests",
             "status": "passed" | "failed" | "running" | "not_run" | "skipped",
             "failurePoints": ["Run npx vitest run", "11 passed, 1 failed", "11/12"],   (≤ 5)
             "at": "<ISO>" } ]
"partsRuns": { "<workflow name>": { "id", "attempt", "finished", "parts" } }
"points": [ … ]  (points.py, gate "ci", key "part:<kind>", text "test: 11/12")
```

One part per kind, in the order the runner runs them. `failurePoints` are the failed step's **name**, the failed check run's output **title**, the **counts** in its summary (`11/12`, `3 failed`) and its annotations' **titles**, each one line of at most 120 characters. Never the summary's text, an annotation's message, the output's text, a log line, a script or code. A test part's annotation titles name tests, so they are dropped while `adapter.reporting.failingTests` is off. `parts` and `partsRuns` go with the commit they describe and are dropped when the head changes; `points` stay, because the next run is what checks them off.

Per repository, the gate's parts are published at `pipelines/ci-parts/<owner>--<name>.json` (`{repository, gate, parts: [{kind, label}], runs, disagreements}`) and on the bundle as `pipelines.parts[<owner/name>]`. A step's kind is cached at `ci/kinds/<owner>--<name>.json` by workflow and step name, so a known step is never asked about twice.

The App needs **Actions: read** (and Checks: read, which the check events already need) to list a run's jobs.

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

Derived state, on the same rule as everything above: a key and a title name an issue. A title is capped at 120 characters. No issue description, no comment, no link comment, and no issue body — GitHub's relations are the keys read out of a body that is then dropped, never the body. The acceptance criteria are read out of the description the same way (MACLEOD-646, below) and land in their own document, never on this sidecar.

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
- `directions[]` — what auto-continue told a session to do next (MACLEOD-726): `at`, `kind` (`fix`, `points`, `finish`, `next`, `waiting`; and for an agent told to wait, MACLEOD-733, `start` and `wait`), `key` (absent on `waiting`) and `said` (≤ 240), capped at 20. `said` is the plugin's own fixed words with keys, step names, counts and the run's name reduced to plain characters; never a title, a point's text, a note or anything else the service sent. `continued` is how many times the plugin kept a session going on this run. The Progress view reads both

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

### The heartbeat (MACLEOD-641)

`heartbeats/<sessionId>.json` is the fourth kind. A Claude Code session
says it is alive, from a small background process the plugin starts beside
it (`plugin/scripts/heartbeat.mjs`), so the service can tell a hang, a
stall, a crash or an orphaned agent from quiet work.

```text
{ "kind": "heartbeat", "payload": {
    "sessionId": "<12-hex digest>", "beatAt": "<ISO>", "sessionAlive": true,
    "endedReason": "process_gone" | "session_end" | "handoff",   (last beat only)
    "boundKey": "<issue key>",
    "continues": "<12-hex digest>",          (a successor after a hand-off)
    "repo": "<12-hex digest>",               (the repository's name, hashed)
    "paused": { "reason": "rate_limit" | "billing", "until": "<ISO>", "estimated": true | false },
    "agents": [ { "agentId", "name", "key", "stage", "status", "lastEventAt" } ] } }
```

- **One process per session.** The hook starts it on the session's first
  event and checks it on every other one (a small file read and a
  `kill(pid, 0)`). It is detached, runs no shell, ignores its output and
  never holds the tool open. It beats once at start and then every 120
  seconds.
- **It watches the session's own process**: the hook's parent, which is the
  Claude Code process (a shell in between is stepped over). When that
  process is gone and no `SessionEnd` was recorded, it sends one last beat
  with `sessionAlive: false, endedReason: "process_gone"` and exits. On
  `SessionEnd` the hook only leaves a mark, because that event may not use
  the network; the process sends the last beat with `endedReason:
  "session_end"` and exits. It never runs longer than 24 hours.
- **Derived state only.** `sessionId` is the digest `session.id` carries on
  an issue report, never the raw id. An agent is the `id` and `name` its
  `agent` block already carries, its bound key, its stage and status words
  and the time of its last hook event; at most 50 agents, newest first.
  No prompt, task line, path, command or text is a field, and the service's
  `HEARTBEAT` table in `adapters/teamflow/schema.py` drops anything else.
- **A usage limit is not a crash.** A turn that ends at a rate limit or a
  billing error is a `StopFailure` (`error_type` `rate_limit` or
  `billing_error`). The hook leaves two local marks. If the process then
  stops, because a tool such as cc-rotate moves the conversation to another
  account, the last beat says `endedReason: "handoff"`, even when a
  `SessionEnd` ran during the stop. cc-rotate's own signal counts too:
  `CC_ROTATE_ACTIVE=1` with `${CC_ROTATE_PIDFILE}.rotate` present. A
  resumed session with a new id, in the same repository within ten
  minutes, sends `continues`: the old session's digest, never its id or
  its path. If the process stays alive, every beat carries `paused` until
  the session's next hook event: the kind of limit and when it resets, from
  the event's `rate_limit_reset_time`, else five hours from the stop with
  `estimated: true`. Two minutes after the reset, with no event since, the
  heartbeat runs a delivery round and shows a desktop notice with fixed
  words ("ADHOC-24 is waiting. The usage limit has reset. Type continue in
  Claude Code."), through `osascript` or `notify-send` with no shell.
- **It delivers what was left for the machine.** After each beat the
  process runs the same intake round a `Stop` hook runs (the actions queued
  for this machine, by their typed kinds, under intake's done-marks and a
  machine-wide lock, so no action runs twice) and the plan's own gate
  deadlines with no reads. That is one request when nothing is queued.
- **The resume snapshot stays on the machine.** Each session keeps
  `<data>/resume/<digest>.json` (its key, its open plan runs and their
  nodes, its open agents with their task line, the last step per card, its
  pause), saved on Stop, SubagentStop, PreCompact and a limit's
  StopFailure, and read back once into a resumed, compacted or successor
  session's own context. No report or beat carries it. The only thing sent
  when a limit nears (`teamflow statusline-tap`, 80 % of a statusline
  `rate_limits` window or of the context window) is the workflow report the
  plugin already sends for its runs.
- **Several sessions on one project.** `repo` is a digest of the
  repository's name (`owner/name`), the same on every machine, never a
  path. The service stamps the credential's member as a digest
  (`memberId`), never an address. The oldest live session on a card holds
  it; when it ends, crashes or moves to another account, the next one holds
  it. The beat's reply carries `others: [{key, who, since}]` (who holds the
  cards this session works on and does not hold) and `holds: [key]`. The
  plugin keeps both in the local heartbeat record, tells the person once at
  a prompt ("ADHOC-24 is already being worked on in another session (Mad
  Scientist, since 10:02 UTC). Pick another ticket or coordinate first."),
  never blocks, and runs a card's queued actions only in the session that
  holds it. Two live sessions in one folder, from the local records alone,
  are each told once: "Another Claude Code session is working in this
  folder. Use a worktree so your changes do not collide."
- **Never queued, never retried.** A beat that fails is skipped; the next
  one is two minutes away, and an old beat delivered late would say a dead
  session was alive.
- **Not a report for billing.** A heartbeat is never billed and never
  counts as a report, on the usage line or in `reports_this_month`.
- `TEAMFLOW_HEARTBEAT=off` turns it off. `teamflow status` says whether this
  session's heartbeat is running.
- **What the service keeps and serves.** The stored document adds `known[]`
  (every agent the session showed, with `goneAt` once it left the beats),
  `firstSeenAt`, `receivedAt` and `handled` (what TeamFlow already said
  about each agent). It is never served. The bundle serves `liveness[]
  {sessionId, agentId|null, key|null, state, lastBeatAt, lastEventAt,
  reason}` instead, `state` one of `live | hung | crashed | quiet | ended`
  and `reason` one plain sentence (`adapters/teamflow/liveness.py`).

### The machine's inventory (MACLEOD-641)

`inventories/<machine>--<repo>.json` is the fifth kind. With a session's
first beat, and then every tenth (about every 20 minutes), the heartbeat
sends everything its machine holds open on the repository, so the service
can reconcile the board (`plugin/scripts/inventory.mjs`). It is its own
kind, not a field on the beat: a beat speaks for one session every two
minutes, and this lists every session's agents, the worktrees and the plan
runs.

```text
{ "kind": "inventory", "payload": {
    "machine": "<16-hex digest>", "repo": "<16-hex digest>", "at": "<ISO>",
    "agents":    [ { "agentId", "name", "key", "stage", "status", "lastEventAt" } ],   (≤ 100)
    "worktrees": [ { "path": "<digest>", "key", "branch": "<digest>", "dirty": true | false } ],   (≤ 30)
    "runs":      [ { "id", "status", "nodes": [ { "key", "state" } ] } ],   (≤ 30, ≤ 100 nodes)
    "sessions":  [ "<12-hex session digest>" ],   (≤ 50, those whose heartbeat runs)
    "finished":  [ { "id", "status": "done" | "cancelled" | "archived" } ] } }   (≤ 100, last 7 days)
```

- **Digests, never names.** The machine is a digest of its id, the
  repository a digest of its `owner/name` (else its root), a worktree a
  digest of its path and branch. `dirty` is one yes-or-no from `git status
  --porcelain`; no file name leaves. Only worktrees with a TeamFlow binding
  are listed. git runs with no shell and a short timeout.
- **Free and never queued**, like a heartbeat: never billed, never counted,
  and a failed one waits for the next.
- **What the service does with it** (`recover.reconcile`), only while it is
  under 25 minutes old and one of its sessions still beats: a node the board
  holds `running` that the machine lists done or skipped takes that state
  ("Its computer says this work is finished."); a run the board holds open
  that the machine finished takes its status ("Its computer closed this
  run."); a `running` run of one of those sessions, for an agent the machine
  no longer lists, ends ("The agent is no longer running on its computer.");
  an agent the machine lists that no row speaks for reads `live`; a bound
  worktree with uncommitted work and nobody on its card is noted once on the
  card. A change on the board newer than the inventory is never undone. The
  document keeps `handled` (the worktrees already noted) and is never served.

### What git proves merged (MACLEOD-726)

The sixth kind. Agents sent to worktrees often never report under their own
ticket key, so the board had no proof their work landed. The machine does:
right after each inventory the heartbeat asks its own repository which of
the keys the inventory holds open (open plan nodes, bound worktrees, open
agents) are merged into the default branch (`plugin/scripts/merged.mjs`).
`teamflow reconcile --merged` asks the same question once for every key the
board lists as open for the organisation.

```text
{ "kind": "merged", "payload": {
    "repo": "<16-hex digest>" (optional), "at": "<ISO>",
    "merged": [ { "key", "merged": true, "mergedAt": "<ISO>", "via": "branch" | "commit" } ] } }   (≤ 200)
```

- **One derived fact per key.** Never a branch name, a commit message, a
  commit id, an author or a diff. `mergedAt` is when the work arrived on the
  default branch (the first commit on its own line that holds it). `via`
  says which evidence: a branch whose name, worktree binding or dispatched
  agent's minted node carries the key and whose tip arrived through a merge, or a commit whose subject names
  the key and that arrived through a merge: reachable from the default
  branch but not on its first-parent line. A commit made straight on the
  default branch never counts, because work in progress names its key too. A branch only created
  from the default branch, with no work of its own, is not a merge.
- **Local only.** git runs with no shell, fixed arguments and a timeout. A
  key from the board is checked against a key pattern and only compared with
  text git printed; it is never an argument to git. Branch names pass a
  strict pattern before use.
- **The alias applies.** An ad hoc key that became a ticket reports as the
  ticket, on the machine and again on the service, so ADHOC-10's merge
  counts for MACLEOD-688.
- **Free and never queued**, like an inventory; stored under no path of its
  own.
- **What the service does with it** (`recover.apply_merged`): it finishes
  the card the way a Merge step does. A MERGE move at `mergedAt` goes on the
  card's history (the hygiene sidecar's `transitions`), its open plan nodes
  are set done, and the card gets one History line: "Its work is merged into
  main." Only when the card's current step then reads Done: a card already
  finished, one somebody still works on, or one with new work after the
  merge is left alone. Sent again, it writes nothing.

### A card's plain line (MACLEOD-770)

The seventh kind. One line about what a PERSON gets from the piece of work,
written by the model doing the work in the user's own session (or by a
person), with `teamflow card say <KEY> "<line>" [--by model|person]`. The
plugin's hooks ask the session for it at dispatch, at merge and at deploy,
and when a `tidy` arrives, only for a card with no line on this machine or
one older than the work under way; they never block.

```text
{ "kind": "say", "payload": { "jiraKey": "<KEY>", "line": "<≤ 180 chars>",
                              "by": "model" | "person", "at": "<ISO>" } }
```

- **Checked twice with the same rules**: by the plugin before anything is
  sent (`sayCheck` in `plugin/scripts/words.mjs`) and by the service in
  preflight (`say_check` in `adapters/teamflow/words.py`), pinned to the same
  answers by `tests/fixtures/say-vectors.json`. The line must pass the plain
  words checker (at most 20 words a sentence, no internal words, active
  voice, common words), hold one or two sentences and at most 180
  characters, and carry no code, file name or path, link, email address,
  key or token. The service refuses anything else with `400
  say_not_plain` and plain words saying what to change; nothing is written.
- **Stored on the card itself**, as `say: { line, by, at }` on
  `issues/<KEY>.json` (an ad hoc key that became a ticket writes the
  ticket). So the board's first view, its pages, the bundle, the Status
  update and `teamflow update` read it with no reader of their own. An
  issue report cannot carry `say` (it is dropped as unknown), and every
  later report keeps the stored one, so a line is replaced only by a newer
  line; an older one is answered `said: "older"`. A key with no card yet is
  answered `said: "no_card"` and nothing is written.
- **History names who wrote it**: one row on the hygiene sidecar, `reason:
  "line"`, `role: "model"` or `"person"`, `by` the member whose credential
  sent it, and the line as the note.
- **Free**, like a merged fact: a sentence about the work, not work
  reported.

### What an open card is, and the `tidy` it may get (MACLEOD-770)

The classifier notices; the machine's model tidies. In the five-minute pass
(`delivery.live`, `adapters/teamflow/card_tidy.py`) the service asks one
watch question, `card_state`, of each open card (not Backlog, not finished)
whose facts changed since it was last asked, at most eight a pass, through
the decision seam (the classifier, rules standing in). It is shown fixed
features only — `stage`, `liveOwner`, `livenessState`, `mergeSeen`,
`prState`, `trackerClass`, `nodeState`, `waitingOn`, `hasLine`, `lineStale`,
`openLinks`, `closedLinks`, `minutesSinceEvent` — never a key, a title or a
line. The answer is one of `live_work`, `finished_not_closed`, `stuck`,
`waiting_outside`, `stale_link`, kept on the hygiene sidecar's
`watchAnswers[]` beside the rules' answer.

When the sure answer (at the confidence bar) is `finished_not_closed` or
`stale_link`, or the card has no plain line or one older than its last move,
the service queues ONE action of kind `tidy` for the card's developer, as
TeamFlow (`by: "teamflow"`), with no `args`: it carries its kind and its key
and nothing else. Never while another `tidy` is on its way, never on a card
a person switched TeamFlow off on, and each queue writes one History row by
TeamFlow in the `classifier` role, `reason: "tidy"`, saying why in plain
words. `tidy` is never a person's action: it is not in the card routes.

On the machine (`plugin/scripts/intake.mjs`) a `tidy` maps onto operations
the plugin already owns, decided from its own facts: (1) this repository's
own merge facts prove the work merged — they are sent as a `merged` report
and the run here that holds the key sets its node done; no proof, nothing is
closed; (2) a dependency whose other end is done or skipped in the run is
dropped (`undepend`); (3) the session's model is asked for the card's plain
line when this machine has none current. Each change is a row on the run's
`hygiene[]` by `classifier`; the outcome goes back as usual (`done` with the
plugin's own sentence, or `not_needed`), and `actions[]` on the issue
document may carry `kind: "tidy"`. Nothing received is run in a shell.

### The machine's map of its CI (MACLEOD-792)

The eighth kind. The service sees a CI run's step names; only the machine
can read what the workflow runs. `teamflow gates learn` reads the
repository's `.github/workflows/*.yml` (jobs, steps, the head of each
`run:`, each `uses:`), the `package.json` scripts and Makefile targets those
steps call, tox and nox environments and `sonar-project.properties`, and
drafts a map. When a repository has no map for its CI files as they are now,
the session's own Claude is asked once (a SessionStart notice, at most once a
day) to check the draft, explain what scripts such as `npm run verify` run
and write the quality gate's conditions. `teamflow gates map --file` checks
the result and sends it.

```text
{ "kind": "gatemap", "payload": {
    "repo": "owner/name",
    "gates": [ { "gate": "ci", "parts": [ { "kind", "label", "matches": ["<step or job name glob>"] } ] } ],   (≤ 6, ≤ 12 parts, ≤ 20 matches)
    "quality": [ { "condition": "Coverage on new code", "threshold": "80%" } ],   (≤ 20)
    "sourceHash": "<16 hex: a digest of the CI files>" } }
```

- **Names, kinds, order and thresholds only.** A label is plain words (the
  words checker, both ends) of at most 40 characters; a match is one line of
  at most 120. Never a script, a command's arguments, code or a log. What
  `learn` read to make the draft (command heads, script and target names,
  SonarQube setting keys) stays on the machine; SonarQube's token, host,
  project key and organisation are never read at all.
- **Refused on the machine first.** An unknown field, a kind outside the six,
  a label that is not plain, a match on two lines, or a `sourceHash` that no
  longer matches the CI files is refused before anything is sent. The
  service drops unknown fields and refuses the rest again.
- **Stored** at `pipelines/ci-map/<owner>--<name>.json`, one per repository;
  each replaces the last. Free and never queued.
- **What the service does with it** (`ci_parts.py`): a step or job whose name
  matches a part's glob takes that part's kind and label without asking the
  classifier. Observed runs still decide each part's status and the order;
  a run whose parts differ from the map is written down on the gate's parts
  document (`disagreements`), so the next `learn` can fix the map.

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

`actions[]` on the issue document: `id`, `kind` (`fix`, `bump`, `rerun_gate`, `resume_plan`, `skip_gate`, and TeamFlow's own `tidy`, MACLEOD-770), `by`, `at`, `outcome` (`done`, `refused`, `failed`, `not_needed`: a fix or re-run whose step passed, or whose card moved on or finished, before it was shown, MACLEOD-726), `reason` (≤ 120), capped at 16. A lead acts from the dashboard; the service holds the intent for the machine that has the ticket (`GET /v1/members/actions?for=<machineId>`, answered per action at `POST /v1/members/actions/{id}/outcome`); the plugin performs what it can and this is its record. **The action's text never travels back**: a `fix` is shown to the agent on the machine and what the report carries is that it was shown; `reason` is the plugin's own sentence ("deploy runs only from the main session"). Nothing here is a queued command, and nothing here is executed from text.

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
Deployed to dev by TeamFlow at <updatedAt>: <summary>
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
Audit found problems. Sent back for rework (round <n>). <the card's line 2>.

<summary>

- [x] <a failure point the round found fixed>
- [ ] <a failure point it raised, or one still open>
```

(`Tests failed.`, `Deploy failed.` and so on for the other gates). A failed
round ends its first line with the card's line 2 on the board as the comment
goes out (MACLEOD-766): `Waiting for someone to pick it up.` until somebody
does, then `<first name, or the running agent's task> · next: <step>.`, derived by
`card_face.rework_line` from the stage, the assignee or reporter, the
reported `agentTask` and the pipeline, and made inert like the summary. The
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
in its head: "TeamFlow did not add 2 more problems. The card holds 50 open
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

## Questions in the agent view stream (MACLEOD-852)

Agent view (opt-in, organisation and machine) may carry a pending question's words and its option labels, in a line marked `asks`, cleaned like every other line. Outside agent view nothing new leaves the machine: a report carries only `asks.kind` and, for a permission, a built-in tool name (MACLEOD-845).

With two-way on (MACLEOD-848, organisation and machine, off by default), a question's stream line adds `askId` (a hash, `ask_<hex>`) and `questions` (a count), and each safe chunk adds `machine` (this machine's random id). No new field reaches a report.

## Tracker comments, read on demand (MACLEOD-840)

A tracker's comments are dropped at the connector and never stored. The one
exception is a read: when a signed-in member (viewers included, Team plan and
up) opens a card's About this card box or its dialog, the dashboard asks
`GET /v1/members/cards/{key}/comments`, and the service reads that issue's
newest ten comments from the tracker in the same request — Linear through
the organisation's authorised token, GitHub through the App installation's
minted token, Jira Cloud through its signed-in token — and hands back each
one's author name, time and text, cut at 1,000 characters. The organisation
comes from the credential and the tracker from the card's own tracker
record. Nothing of the answer is kept: no store document, board view,
bundle, report, Events row or log line holds it (the log names the key and a
count), the response says `Cache-Control: no-store`, and the dashboard holds
it only while the box is open. A connection made by pasting a webhook has no
token, so it answers in words that comments need a signed-in tracker.
`tests/test_tracker_comments.py` proves the route writes nothing and logs
neither the text nor the token.

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
| `asks` (MACLEOD-845) | `{kind, tool?}`: `kind` is one of `permission`, `question`, `choice`, `elicitation`; `tool` is a built-in tool's name matching `^[A-Z][A-Za-z]{0,29}$`, for a permission only | Sent only with `status: waiting` and `waitingOn: human`, so Needs you can show what the session asks. From PermissionRequest, the `permission_prompt`, `elicitation_dialog` and `elicitation_url_dialog` notifications, and AskUserQuestion. A question seen only in the turn's last words is sent after `idle_prompt` confirms nobody answered for a minute. Never the question, the tool's input, a command, a URL or a path. A typed prompt or a tool that ran clears it. |
| `rework[]` | `{gate, at, clearedAt?, summary, by}`, the latest 16 | Every loop the ticket has been round, so a card can say which gate sent it back and when, rather than `×69` with no reason. `clearedAt` is stamped when the gate passes again; an entry is never erased. `gate` is a `DeliveryStage`, `summary` is the classifier's own line (`Local tests failed`) capped at 120, `by` is the agent's name or the tool's. `loopCount` is redefined as the number of loops **this plan cycle** — it resets when the ticket is verified or done, or when a new `/teamflow:build` run picks it up — so the number a card shows is the number a reader can act on. |
| `lastFailure` | `{stage, at, summary}` | The most recent failed gate, kept after its loop is cleared. |
| `transitions[]` | `{stage, at, by}`, the latest 32 | When the ticket changed stage and who moved it, so "in CI/CD for 41 h" is a fact the plugin recorded, not a guess from `updatedAt`. Written on every stage change the plugin makes. Transitions the **service** observes — a tracker moving the issue, a pull request event — are written to the service-owned `hygiene` sidecar (WS-D) and the read side merges the two lists; nothing the service writes lives on this document, because every report replaces it whole. |
| `agent.parentAgent` | the launcher's capped id, same shape as `agent.id` | Emitted for an agent an agent launched, so the board can nest them. Absent when the session launched it. |
| `agent.agentTask`, `session.agentTask` (MACLEOD-773) | plain words, at most 60 characters, no path separator and never a worktree name | What the agent or session works on, for the board's row header ("Fixing plugin sign-in"). Made on the machine by the same writer an ad hoc card's title uses, from the agent's `name` and `task` (a session: its bound ticket's title or its ad hoc title). Never the prompt, a branch, a worktree or a repository path. |
| `verdicts[]` (ADHOC-19) | `{round, gate, verdict, at, by?, summary?, raised?, fixed?, open?, notAdded?}`, the latest 20 | Every gate verdict on **this** ticket: an audit pass, or a round a gate sent it back. `gate` is a workflow cycle (`audit`, `test`, `deploy`, …), `verdict` is `pass` or `fail`, `round` is the attempt at that gate, `by` is the orchestrating person's display name (the report's `actor`). `summary` is the words the orchestrator deliberately wrote with `teamflow workflow ticket <KEY> --findings <text>` (or `--note` on a rework), like a ticket's `note`: one line, whitespace collapsed, control characters stripped, at most 280 characters, never a prompt, diff, command or log. A rework with no words is a round with no `summary`. Published on the ticket's own card, keyed by `<KEY>` and never by the session's binding. Appended, never rewritten: the plugin keeps the last 20 and the service carries the stored list across every report that leaves it out (a hook's report replaces this document whole), unioned by `(gate, verdict, round, at)`. `raised`, `fixed` and `open` are point ids (below): the points this round raised, the open ones it found fixed, and the ones still open after it. |
| `points[]` (ADHOC-19) | `{id, gate, key?, text, from, rounds?, lastRound?, state, at, by?, doneAt?, doneRound?, doneBy?}`, 50 at most, open ones never dropped for the cap: a run that would push an open point out raises no point and counts it on its verdict as `notAdded` | Why a gate sent the card back, one line each, checked off by the runs that follow (one rule: `plugin/scripts/points.mjs`, mirrored in `adapters/teamflow/points.py`). A point failed again stays open and `rounds` goes up; a new failure is a new point in that round; a run that judged every point at its gate marks the ones it did not fail again `done` in that round. On this document the plugin writes two kinds. **Audit and recorded findings** (`F1`, `F2`, …): each `--finding <text>` a person gave to `teamflow workflow ticket <KEY> --state rework`, one line, at most 280 characters, the same sanitising as `note`, at most 20 in one round (more is refused with a sentence, never cut); `--done <ID>` and `--reopen <ID>` change `state`. Nothing is closed by omission: a failed audit only adds points, a second call at the same gate with no new rework in between adds to the same round, and only an audit given with `--rechecked` (a complete re-audit, or a pass that checked everything again) marks the open audit points it does not list `done`. A pass without `--rechecked` closes nothing. **Failing tests** (`T-<6 hex>`, gate `test`), see the next row. Points are never deleted. Carried by the service across reports that leave them out, merged by `id` with the report's copy winning. |
| `points[]` from a test run (ADHOC-19) | **Off. The owner declined on 2026-09-22 for now; cards get a per-file count instead:** one point per failing test file with a count, `<file>: 2 tests failing` (key: the file), or `2 tests failing` when the runner names no file, and no test name. The service drops any named test point it receives. The code still holds the switches (`reporting.failingTests` in the plugin, `adapter.reporting.failingTests` in the service), both off, and they stay off unless the owner decides otherwise. What a named point would carry, for that decision: a failing test's **identifier**, its file and name as the runner printed them on its own summary line (`FAILED tests/test_x.py::test_y`, vitest `FAIL a.test.ts > group > name`, jest `● group › name`, TAP `not ok N - name`, go `--- FAIL: TestName`), with a trailing `[...]` parameter part cut off, at most 20 per run, 160 characters each. Parameter values a runner expands into the name itself (jest's `it.each` with `%s`) cannot be told from the name and stay in it | So a card a test run sent back carries which tests failed, and the next run checks each one off when it passes. Only the identifier: never the assertion message, a diff, a stack trace or any other line of output (`plugin/scripts/failing-tests.mjs`; `plugin/tests/failing-tests.test.mjs` asserts a message printed beside the name never reaches the payload). Test names come from the customer's repository, which is why this row is listed apart. Only a whole-suite run, or named test files run in full, checks a point off; a run of one file judges exactly that file's points. A directory, a filter word, a node id, a glob or a name filter (`-k`, `-t`, `--grep`, `--testNamePattern`) makes a run partial and it checks nothing off, and so does a run with more than 20 failures, whose list was cut. A run judges only its own runner's points: pytest the Python files, go the `_test.go` files, vitest, jest, mocha and node:test the JavaScript and TypeScript ones; a point whose name carries no file keeps its runner in its key (`js|group › name`). |
| `testsPassed` (MACLEOD-646) | `{family, all, files?, at}` | What the newest **passing** test run covered, so the service can tick an acceptance criterion linked to a test file. `family` is `py`, `go` or `js` (the runner); `all` is true only for a run that named no file and no filter, so the whole family passed; `files` are the test files the command named, at most 20, each at most 160 characters -- the same class of identifier a failure point's `key` already carries. Never a test's name, the output or the command. Any failed test run clears it, so a pass is never read after a later failure. Scoped by `sanitizePayload`: `family`, `all`, `files` and `at` are allowed inside this block and nowhere else. |
| `directions` (MACLEOD-726, MACLEOD-733) | `[{at, text, next?}]`, at most 10 | What TeamFlow told this card's agent when it stopped, for the Progress view: "Told the agent to carry on with the plan", "Told the agent to start. What it waited for is done", or, with `next: true`, what it waits for ("Start when MACLEOD-701 is done"). `text` is the plugin's own fixed words with keys and branch names only, at most 120 characters. Scoped by `sanitizePayload`: `text` and `next` are allowed inside this block and nowhere else. |


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

### Reviewers of a check step (MACLEOD-714)

An agent started from a session bound to a ticket while that ticket
stands at a check step (Local Test, Local Audit, Dev Test, Dev Audit, or
a custom check reported at one of them) is a **reviewer** of that step.
The plugin no longer decides this by where the ticket is alone (see
MACLEOD-722 below), never by the agent's name, and mints no ad hoc card
for a reviewer. Each reviewer is one runtime
sidecar:

| Field | Value |
| --- | --- |
| slot | `review-<n>`, n from 1 to 8 (`schema.is_review_slot`). One per reviewer of one round |
| `kind`, `stage` | `audit` at an audit step, else `test`; the step's own stage |
| `label` | the lens: the agent's one-line description through the plain-words writer, at most 80 characters. Never the prompt |
| `status` | `running`, `success` (pass) or `failed` (findings or failed) |
| `summary` | the plugin's own sentence from the enum and counts only (`Security found 2 medium problems.`) |
| `agent` | the reviewer's `agent` block, so the board puts it under its person |
| `review.lens` | the same lens |
| `review.result` | `running`, `pass`, `findings`, `failed`, or `withdrawn` (MACLEOD-722: it changed files and was moved to worker) |
| `review.round` | ISO time the round began; the step is judged on the newest round |
| `review.findings`, `review.high`, `review.medium`, `review.low` | counts, 0 to 999, each optional |
| `review.stated` | `true` when the agent said the result with `teamflow review done` |

**The result is derived on the machine.** Claude Code's own
`ReportFindings` call, when the reviewer makes one, is the result: an
empty `findings` list is `pass`, else `findings` with the count
(findings a re-report marks `fixed` or `no_change_needed` are not
counted). That list has no severity, so no `high`, `medium` or `low` is
sent for it, and no finding's file, summary or scenario leaves the
machine. Otherwise the plugin reads the reviewer's report — its
`SubagentHandback` message when it made one, else its last message
(`last_assistant_message` on its `SubagentStop`) — with a small fixed parser (✅, PASS, ❌, FAIL, "2 medium", "3 findings")
and sends only the enum and the counts. The message itself never leaves
the machine. `teamflow review done --result pass|findings|failed
[--high N --medium N --low N]`, run by the reviewer, states the result
exactly and wins over `ReportFindings` and the parser; the hook reads those words from the
agent's own shell command and nothing else from it. A message the parser
cannot read is `failed`: a review with no clear answer is not a pass.

**The step's result** is folded by the dashboard, not stored: the step
passes when every reviewer of the newest round passes, reads running while
any is running, and goes back to rework when any found problems or
failed. The History line names the lenses (`Security found 2 medium
problems.`).

### What an agent was launched for (MACLEOD-722)

Position alone was wrong the moment a review found problems: the
supervisor sent a fix agent while the ticket still stood at the audit,
and it was counted as one more reviewer. Now the plugin answers
`reviewer | worker | adhoc` for each launch from signals read on the
machine, strongest first:

1. **An explicit mark.** A description that starts `Review:` or
   `Reviewer:` is a reviewer; `Fix:` or `Build:` is a worker;
   `teamflow review start --lens <name>` run in the session marks its
   next launch a reviewer with that lens. A mark decides.
2. **Claude Code's own word.** An agent-team task (`TaskCreated` or
   `TaskCompleted`, with `teammate_name` and `task_subject`) whose
   subject says review or build, for the teammate a launch's `name`
   names, decides just below a mark (`by: claude`). Only the lean is
   kept, on the machine; the subject never leaves it. Else the
   `subagent_type` names an agent
   definition (the project's `.claude/agents/<name>.md`, the user's, or a
   plugin's `<plugin>:<name>`). A definition that may not edit files
   (its `tools` list has no Edit, Write, MultiEdit or NotebookEdit, or
   `disallowedTools` names all four), or whose name and description say
   it reviews, leans reviewer; one that says it builds leans worker. The
   definition is read and dropped.
3. **The batch.** Agents one parent launched in one burst (within five
   seconds, under one `prompt_id`, with no prompt and no agent's end
   between them) are a team; a team at a check step leans reviewer. The
   prompt id is kept on the machine only.
4. **Intent.** `subagent_type`, the description and the prompt's first
   three lines, scored by a fixed word rule (review, audit, verify,
   check, assess, inspect and lens names; fix, implement, build, write,
   refactor, add, change; research words). **The prompt never leaves the
   machine**: only `intent` and `confidence` do.
5. **Position.** At a check step, one signal. Right after a round that
   found problems, one agent alone leans worker: that is the fix.

Strong signals that agree decide. Weak or disagreeing signals still
decide at once by the rules, and the agent's `role` block says `ask:
true`. A reviewer away from a check step reviews `LOCAL_AUDIT`, and only
on a clear lean. A reviewer with no ticket bound is `adhoc`.

**The `role` block** rides inside `agent` on the agent's own runs and on
its `review-<n>` sidecar (whose `agent` block now reaches the wire, as
the table above always said):

| Field | Value |
| --- | --- |
| `as` | `reviewer`, `worker` or `adhoc` |
| `by` | `mark`, `claude`, `batch`, `intent`, `position`, `rules` (signals disagreed) or `moved` |
| `intent`, `confidence` | `review`, `build`, `research` or `other`; 0 to 1 |
| `batch` | 1 to 50, the launches in its burst |
| `bound`, `position`, `claude`, `step` | a ticket was bound; `check_step` or `other`; the definition's lean `reviewer`, `worker` or `none`; the step |
| `ask` | the classifier is asked too |
| `moved`, `outcome` | it was moved to worker; at its end, `review` (a pass or findings) or `work` |

**Correcting.** A reviewer that edits a file in its repository or runs
`git commit` is moved to worker once: its `review-<n>` sidecar is sent
with `review.result: withdrawn`, `status: idle` and the one History line
`<lens> changed files, so it counts as work, not a review.` The step's
result no longer counts it.

**The classifier, watch-only.** A report carrying `role.ask` marks the
key like any other decision; the decide job asks one `launch_role`
question per agent, showing the decider only `step`, `batch`,
`subagentType`, `intent`, `confidence`, `bound`, `position` and `claude`,
with the answers `reviewer`, `worker` and `adhoc`. The answer is kept on
the hygiene sidecar's `launchRoles[]` (at most 16 rows of `{agent, at,
question, mode: watch, features, rules, rulesBy, chosen, confidence, by,
decider_version, outcome?, outcomeAt?, moved?}`) and nothing acts on it.
The agent's `outcome`, when it arrives, is added to the same row, so both
answers can be graded. Acting on the answer is MACLEOD-648's.

**How a quiet card's work ended (MACLEOD-726, L10).** No report carries
anything new for this. The five-minute repair pass marks a card that a
plan still holds open, that no fact finished and that nobody has worked on
for the idle band; the decide job then asks one `work_outcome` question in
the organisation's own slice. The decider is shown only fixed features the
service derives: `stage`, `prevStage`, `mergeSeen` (a flag),
`prState` (`none`, `open`, `merged`, `closed`), `trackerClass` (`none`,
`todo`, `in_progress`, `done`), `nodeState` and `aliasNodeState` (a plan
node's state, or `none`), `endKind` (`none`, `ended`, `crashed`, `quiet`),
`minutesSinceEvent` (0 to 10080) and `rework` (the open rework count).
Never a key, a name, a title or any text. The answers are `done`, `rework`,
`unfinished` and `still_working`. The row is kept on the hygiene sidecar's
`workOutcomes[]` (at most 8 rows of `{at, question, mode, digest, features,
rules, chosen, confidence, by, decider_version?, acted?}`); `digest` is the
features without the clock, so the same facts are asked once. At the bar
(0.7), `done` and `rework` set the plan node and write one History line;
below it the row is `mode: watch` and nothing moves. A card's
`autonomy_off` wins over any answer.

**Thinking or stuck, and show or keep (MACLEOD-726, L1 and S10).** No
report carries anything new for these either. Both questions are on watch:
the answer is kept and graded, and nothing acts on it. The repair pass
marks a card a live agent holds that has said nothing for the idle band,
and the decide job asks `progress_kind` (`thinking`, `stuck`,
`waiting_outside`) from `status`, `gateKind` (`none` or the running gate's
kind), `deadlineClass` (`none`, `ci`, `deploy`, `test`, `audit`),
`livenessState` (`none` or the liveness row's state), `minutesSinceEvent`,
`minutesSinceBeat` (0 to 10080), `eventsLastWindow` (moves and runs in the
idle band, 0 to 1000) and `retry` (the gate's attempt, 0 to 100). Every card
the decide job decides on that had something to decide is asked
`should_show` (`show_now`, `keep_in_history`, `fold_into_day`) from
`criticality`, `status`, `rework` (the open rework count), `liveOwner` and
`autonomyOn` (flags), `workOutcome` (the last `work_outcome` answer, or
`none`) and `minutesSinceEvent`. Never a key, a name, a title or any text;
one organisation per slice. The rows are kept on the hygiene sidecar's
`watchAnswers[]` (at most 12 rows of `{at, question, digest, features,
rules, chosen, confidence, by, decider_version?}`); `digest` is the question
and its features without the clocks, so the same facts are asked once.

### What the SERVICE writes beside a card (MACLEOD-639, WS-D)

Three service-owned files, none of which a reporter can write. Each names its writer.

**`issues/<KEY>/hygiene.json` — the reserved `hygiene` slot.** In `RESERVED_SLOTS` beside `tracker` and `pr`, so `POST /v1/report` refuses it (`reserved_slot`). Written by the nightly sweep (`delivery.sweep`, adapters/teamflow/hygiene.py) and by the card routes below, always under the ETag that was read, so a report or a delivery that lands in between makes the write a refused row rather than a lost update. It holds, per key:

- `hygiene[] {at, action, by, role, reason, note?, kind?}` capped at 20. `action` and `note` are plain words for people and may be reworded; code matches `reason` and `kind` (`closed`: a run was stopped; absent on rows stored before MACLEOD-640, which read "closed …"). A run the sweep stopped for want of an answer carries `closedReason: "no_result"` beside its summary "No result after N". `by` is a member's address or `teamflow` for the sweep; `role` is `owner`, `member`, `viewer` or `service`; `reason` is one of `no_verdict | superseded | owner_request | deadline | tracker_done | snooze | ping | action | note | refused | agent_stopped | agent_hung | plan_fixed` (the last three MACLEOD-641: an agent on the card stopped or hung, or its plan node was set from the card); `note` is ≤ 120 characters through the one-line sanitiser. Recent Activity and a card's History print these rows.
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
"`<step>` failed again with the same error: "`<words>`". Try a different
fix before the next run.", where `<step>` is the step in plain words
(`words.step`, "Local tests"; a rework stage names the step that failed)
and `<words>` is
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

## Acceptance criteria (MACLEOD-646)

`criteria/<KEY>.json` — one per card, **service-written**, its own subject
kind under the one path rule. No report writes it: `criteria` is not in
`schema.KINDS`, and the report path never creates one. Shape
(`schema.CRITERIA`):

`{jiraKey, updatedAt, proposed?, criteria[] {id, text, source, evidence?
{kind, ref?, auto?}, state, at, by?}, history[] {at, by?, text}, audit? {at,
gate, total, uncovered}}`

- `text` is one line, at most 120 characters, at most 20 criteria.
  `source` is `tracker`, `proposed` or `board`. `state` is `open`, `met` or
  `failed`. `evidence.kind` is `test` (a test file path), `check` (a
  repository check's gate id), `audit` (`local` or `dev`) or `person`.
  `by` is the member's address when a person changed or ticked it.
- **Where the texts come from, and nowhere else.** (a) The ticket's own
  description, read when a verified webhook or an import stores the issue:
  a task list (`- [ ]`, `- [x]`) anywhere, or the bullets under an
  "Acceptance criteria", "Done when" or "Definition of done" heading, in
  Linear and GitHub markdown, Jira wiki text or Atlassian's document
  format. The normaliser carries only `criteria [{text ≤ 120, ticked}]` (at
  most 20) on the event and drops the description; `adapter.connector_event`
  pops that off before any writer sees the event. To read it the Linear
  import now asks for `description` and the Jira import for the
  `description` field; GitHub's issue already carried its body. (b) When
  the tracker gives none, fixed templates chosen by words in the title,
  marked `proposed` until a member accepts them. (c) A member on the board.
- **Nothing from a prompt.** No report field becomes a criterion: not the
  legacy `acceptance[]` list, not a summary, not a title, not a failure
  point's text. A report only moves the `state` of criteria that exist.
- **What moves a state.** A passing test file (`testsPassed.files`, or
  `testsPassed.all` for its family) or a fixed failure point with that file
  as its key ticks a `test` criterion; an open failure point for the file
  unticks it. A `check-<id>` sidecar's `success` or `failed`, an
  `audit-local` or `audit-dev` sidecar's verdict, or the issue at
  `LOCAL_AUDIT`/`DEV_AUDIT` `success` (or back in rework from it) does the
  same for `check` and `audit` criteria. Idempotent: the same report twice
  writes nothing. A criterion with no link is linked to a test file by one
  fixed rule (every word of the file's own name is a word of the
  criterion, and exactly one file matches), marked `auto`.
- **The audit's line.** An audit pass while criteria have no test, check
  or audit behind them sets `audit {gate, total, uncovered}` and one History
  row: "The audit passed. 2 of 5 criteria have no test."
- `history[]` — the newest 50 changes, one plain sentence each ("Tests for
  'Sign-in works with Jira' passed."), `by` when a person made it.

| Route | Who |
| --- | --- |
| `POST /v1/members/cards/{key}/criteria {op, id?, text?, evidence?}` | any active member, never a viewer (403 `viewer`). `op` is `add`, `edit`, `remove`, `accept`, `link`, `tick`, `untick` or `propose`. A pipeline token is refused: every change is attributed to a person |

The bundle serves the documents as `criteria {KEY: {…}}`. An ad hoc card's
criteria follow it when it is converted into a ticket.

**Not yet:** writing criteria back to the tracker as a checklist. Listed as
a follow-up on MACLEOD-646.

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

## Agent view (MACLEOD-793)

Agent view is the one opt-in exception to "derived facts only". It sends
what agents say and do, so a lead can read a conversation beside its card.
`docs/AGENT_VIEW.md` is the full contract; this section is what may cross
the wire.

It is sent only when two switches are both on: the organisation's (an
owner or admin, Team plan or above) and the person's own
(`teamflow agent-view on`, kept in `~/.config/teamflow/config.json`, which
a repository cannot write). The plugin reads the organisation's switch
from `GET /v1/members/settings/agent-view` and from the service's last
refusal, and sends nothing while it does not know. Only lines written
after the person switched on are sent. After `403 agent_view_off` or
`403 plan_required` it stops and asks again after 10 minutes; what was
said in between is dropped, never kept for later.

`POST /v1/agent-view/chunks` carries
`{key, session, agent, seq, sent_at, encoding: "gzip+base64", data}`:

- `key`: the ticket the agent is bound to.
- `session`: the first 12 hex characters of sha256 of the Claude Code
  session id, never the id itself. It is the same value a report's
  `session.id` carries (`core.digest`, `streamSession` in
  `plugin/scripts/agent-view.mjs`), so a board row and its stream share
  one key, `<session>/<agent>`.
- `agent`: `main`, or the subagent's id. Background agents are subagents.
- `seq`: counts up per session and agent.
- `data`: gzip-compressed JSON lines, at most 256 KB compressed per chunk.

Each line is `{t, role, tool?, text}`:

- `t`: when it was said, from the transcript.
- `role`: `user`, `assistant` or `tool`.
- `user` and `assistant` text: what the person typed and what the agent
  answered, after the two steps below, at most 4,000 characters.
- `tool`: the tool's name in `tool`, and in `text` a one-line summary of
  its input and its outcome (`done`, `failed` or `no result`). The summary
  is a command's own description (or its first line), a path relative to
  the repository (or only the file name), a search pattern, a URL or a
  query, or an agent's description and type.

Every line passes two steps on the machine, in this order
(`plugin/scripts/redact.mjs`):

1. **Code out.** It never carries source code: a fenced block (``` or
   `~~~`, closed or not) and a run of four or more lines that looks like
   code become `[code, N lines]`; an inline code span longer than 60
   characters becomes `[code]`.
2. **Secrets out.** Private key blocks, credentials in URLs, `Bearer` and
   `Basic` values, JWTs, `.env` and environment assignments
   (`NAME=value`), anything named like a secret (`api_key: …`,
   `"password": "…"`), known token shapes (`sk_`, `pk_`, `ghp_`, `gho_`,
   `github_pat_`, `xox?-`, `glpat-`, `npm_`, `whsec_`, `AKIA…`, `AIza…`
   and others) and long opaque runs of letters and digits become
   `[redacted]`.

Never in the safe layer:

- a tool's output or result body, an error's text, or a log;
- file contents: a write's content, an edit's old and new text, a diff,
  or anything a read returned;
- source code, as above.

Never sent at all, in either layer and whatever the switches say:

- secrets: every line of both layers passes `redactSecrets`;
- an agent's prompt;
- thinking, system reminders, CLAUDE.md or memory text, and meta entries;
- anything a read returned (a file's contents as the agent read it);
- the Claude Code session id, or an absolute path outside the repository.

### The detail layer (sensitive detail)

A second layer, sent only while the organisation's `agent_view.sensitive`
is on. That setting is a ceiling an owner or admin controls, off by
default; while it is off, or unknown to the machine, nothing below leaves.

- Chunks carry `layer: "detail"`, the same `key`, `session` and `agent`,
  their own `seq`, and at most 512 KB compressed.
- Each line is `{t, role, kind, tool?, text}`. `kind` is `text` (what was
  typed or said, code kept), `output` (a tool's output, its terminal
  colours kept as ANSI codes) or `diff` (an Edit, Write or MultiEdit as a
  unified diff, paths relative to the repository).
- A line's text is at most 64 KB; the rest becomes "[N more lines]".
- `redactSecrets` runs on every detail line, code and output included.
  Only `stripCode` is skipped.
- A `403 sensitive_off` stops the detail layer at once; the safe layer
  goes on.

A chunk the service could not be reached for waits in a spool on the
machine, at most about 5 MB, oldest dropped first. The service keeps
chunks apart from the board, under `agentview/<account>/`, for 7 days,
and never reads them into a report, a digest, the classifier or the
board's views.

What the service does with a chunk (checked against
`adapters/teamflow/agent_view.py` on 2026-09-25):

- It seals every chunk with the organisation's own `agent_view` data key
  (the kit's `tenant_crypto`, MACLEOD-811), separate from the key that
  seals the board. Turning agent view off shreds that key, so no stored
  copy opens again.
- A superadmin reads chunks only through break glass (the kit's
  `mcpkit.break_glass`, MACLEOD-813): a reason, one hour, one
  organisation. Every open and every read is on the organisation's
  events feed and on agent view's History.

## Feedback screenshots and recordings (MACLEOD-828, not on main yet)

Feedback is not a report. A person writes it in the dashboard's
Feedback form and chooses what to attach. The plugin sends nothing here.
This section says what may cross the wire once branch
`MACLEOD-828-feedback-media` and its kit half merge.

- `POST /v1/feedback` takes `{message, page?, email?, image?,
  attachments?}`, with no credential, as it does today. `image` is one
  inline picture of at most 2 MB.
- A screenshot or a screen recording goes first to storage:
  `POST /v1/feedback/uploads {contentType, bytes}` returns a presigned
  `PUT`, and the note names the upload by its `ref`.
- Only `image/png`, `image/jpeg`, `video/webm` and `video/mp4`. A
  recording stops at 2 minutes or 50 MB. The microphone is off unless
  the person turns it on.
- The browser's own picker chooses what is captured: a screen, a window
  or a tab. Nothing is captured before the person clicks.
- Uploads land under `feedback-media/pending/` and move to
  `feedback-media/linked/` when a note names them. Pending uploads are
  deleted after one day; linked ones after `demo.feedback_media_days`.
- Only a superadmin's Feedback tab can read them, through links that
  expire in minutes. The person who sent them cannot read them back.

A recording can show anything on the person's screen, code included. So
this is a second exception to "derived facts only", made by the person
for one message, never by the plugin.
