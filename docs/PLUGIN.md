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

Onboarding is two steps: install the plugin, then run `/teamflow:login` once.

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
teamflow org switch <id>          # POST /v1/members/switch, per person not per session
```

`teamflow org` reads `GET /v1/members/me` with the ID token as the bearer — the access token names a seat, and this has to answer for the address, which is what the other organisations are found by. A switch moves the binding on the seat itself, so every signed-in dashboard and CLI on that address follows it; reports already published stay where they were published.

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

- Jira and Linear share the shape `[A-Z][A-Z0-9]{1,11}-\d+` and are stored upper case. The configured tracker decides how such a key is labelled and linked.
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

`/teamflow:bind` accepts `DAEMON-142`, `ENG-42`, `#123`, `owner/repo#123` or any of the three issue URL forms, normalises to the canonical key and records the tracker. A bare `#123` needs `githubRepo` or a GitHub origin remote. Anything else is rejected with the accepted forms.

`/teamflow:doctor` reports the transport, the service account and its credits, the configured tracker, the resolved issue source and whether that tracker's bundled MCP server is visible; authenticate it once through `/mcp`.

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
| `login`, `logout`, `status`, `bind`, `unbind`, `sync`, `doctor`, `repos` | the eight the plugin's skills wrap |
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

Every URL below was read on 2026-09-17.

| Tool | Level | Where the hooks go | Events TeamFlow subscribes to |
| --- | --- | --- | --- |
| Claude Code | hooks | in the plugin | `SessionStart`, `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `TaskCompleted`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd` |
| [Cursor](https://cursor.com/docs/agent/hooks) | hooks | `.cursor/hooks.json` | `afterFileEdit`, `postToolUse`, `postToolUseFailure`, `afterShellExecution`, `stop` |
| [VS Code + Copilot](https://code.visualstudio.com/docs/copilot/customization/hooks) and [Copilot CLI](https://docs.github.com/en/copilot/reference/hooks-configuration) | hooks | `.github/hooks/teamflow.json` | `PostToolUse`, `Stop` (VS Code); `postToolUse`, `postToolUseFailure`, `agentStop` (CLI) |
| [Windsurf](https://docs.devin.ai/desktop/cascade/hooks) | hooks | `.windsurf/hooks.json` | `post_write_code`, `post_run_command`, `post_cascade_response` |
| [Cline](https://cline.bot/blog/cline-v3-36-hooks) | hooks | `.clinerules/hooks/PostToolUse` | `PostToolUse` |
| [OpenAI Codex CLI](https://learn.chatgpt.com/docs/hooks) | hooks | `.codex/hooks.json` | `PostToolUse`, `Stop` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md) | hooks | `.gemini/settings.json` | `AfterTool`, `AfterAgent` |
| [JetBrains Junie](https://junie.jetbrains.com/docs/junie-cli-hooks.html) | hooks | `~/.junie/config.json` | `PreToolUse`, `Stop` |
| [Zed](https://zed.dev/docs/ai/agent-panel) | git hooks | `.git/hooks/` | `post-commit`, `post-merge`, `pre-push` |
| [Aider](https://aider.chat/docs/usage/lint-test.html) | git hooks | `.git/hooks/` | `post-commit`, `post-merge`, `pre-push` |
| [Claude Desktop](https://code.claude.com/docs/en/desktop) | rules | nothing on disk | none |

**Cursor** is the closest thing to Claude Code here: it has a distinct
`postToolUseFailure`, so a red test run reports `LOCAL_REWORK` rather
than a green gate. `afterShellExecution` documents `command`, `output`
and `duration` and no exit status, so TeamFlow only classifies it when
Cursor does supply an exit code; the definite signal comes from
`postToolUse` and `postToolUseFailure`.

**Copilot** reads `.github/hooks/*.json` from both the VS Code agent and
Copilot CLI, in two dialects of the same idea. One file registers both:
VS Code's PascalCase event names beside Copilot CLI's camelCase ones. A
tool never fires an event name it does not know, so the halves it does
not recognise cost nothing. Copilot CLI's payload names no event at all
and passes `toolArgs` as a JSON string, both of which the adapter
handles.

**Windsurf** puts everything under `tool_info` and, like Cursor,
documents no exit status for `post_run_command`. Writes are reported;
commands whose outcome is unknown are not.

**Cline** has no hooks config file: the hook is an executable named
exactly after the event, which is why the install writes
`.clinerules/hooks/PostToolUse` and nothing else. Hooks also have to be
switched on once in Settings → Features before Cline will run it.

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
