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

```text
/data/index.json
/data/tenants/<tenant>/team.json
/data/tenants/<tenant>/actors/<actor>.json
/data/tenants/<tenant>/issues/<ISSUE-KEY>.json
/data/tenants/<tenant>/runtime/<ISSUE-KEY>/ci.json
/data/tenants/<tenant>/runtime/<ISSUE-KEY>/audit-local.json
/data/tenants/<tenant>/runtime/<ISSUE-KEY>/deploy.json
/data/tenants/<tenant>/runtime/<ISSUE-KEY>/dev-test.json
/data/tenants/<tenant>/runtime/<ISSUE-KEY>/audit-dev.json
/data/tenants/<tenant>/runtime/<ISSUE-KEY>/security.json
/data/tenants/<tenant>/runtime/<ISSUE-KEY>/tracker.json
/data/tenants/<tenant>/runtime/<ISSUE-KEY>/pr.json
```

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

## Allowed current-state data

- `tenantId`
- `tracker` (`jira`, `linear` or `github`)
- issue key/link and short title/status, carried in the `jiraKey` / `jiraUrl` / `jiraStatus` fields, named for history
- parent/related keys
- actor, repository and branch
- `git`: `branch`, `head.sha` and `head.subject`, `commitsSinceMain`, `ahead`, `behind`, `pushed`, `dirty` — where the branch stands, as counts and flags. Derived state: a count of commits is not the commits, and the subject line is capped at one line's length so a hunk cannot ride in as prose.
- `pr`: `number`, `url`, `state`, `mergeable`, `checks.{passing,failing,pending}`, `review` — what the forge already publishes about the pull request. Derived state: how many checks are in each state, never which ones and never their output.

### The `pr` sidecar

`runtime/<KEY>/pr.json` is the same `pr` block as above, written by the connector webhook instead of by a reporter, and it is an **execution**: `id`, `kind`, `label`, `stage`, `status` and `summary` beside the block, so the dashboard merges it with `ci.json` and `deploy.json` rather than down a path of its own. It also carries `occurredAt` (the forge's clock for the delivery it last applied), `updatedAt`, `deliveryId`, `provider`, `repository`, `headSha`, `checkRuns` and a `history` of the last twenty deliveries.

`checkRuns` maps a runner to its verdict — `passing`, `failing` or `pending` — keyed by the numeric id GitHub gives the workflow or the app that owns the check suite, never by a name and never with a log, an annotation or a step. It exists so the counts are a tally of runners rather than of deliveries: a flaky job that reran four times is one check, and a green rerun cannot clear a different job's genuine failure. It is dropped whole when the head commit changes, because a run that passed against a commit nobody is on says nothing about the code on screen.

`history` rows are `event`, `action`, `occurredAt`, `state` and `deliveryId`. No title, no branch, no body, no review comment.

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
- normalized stage/status
- `reworkFrom` and loop count
- concise derived summary
- compact evidence counts/references
- execution IDs/kinds
- timestamps

Never persist prompts/transcripts, source contents/diffs, raw shell commands/tool output, secrets, issue descriptions/comments/attachments, or raw CI/test logs.

## Caching

Static assets: long/content-hashed caching. Current state: short TTL plus ETag / `If-None-Match`. Missing runtime sidecars are normal.

## The push channel

A dashboard may be told that its tenant moved rather than asking every five seconds (MACLEOD-517). What travels on that channel is a pointer and never a document: the tenant's `updatedAt` watermark and the issue keys that changed, and nothing else. The dashboard then reads `GET /v1/state/tenants/<account>/bundle` exactly as a poll would, so every byte of state still leaves through the one route this allowlist governs. A second way out would be a second allowlist to keep in step with this one, and there is no reason to have one: the reader has to make that request anyway to see the change.

The subscription key is the account the credential resolved to, never one the client named, so a connection only ever hears about its own tenant.
