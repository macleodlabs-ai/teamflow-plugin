# TeamFlow Claude Code plugin

TeamFlow reports issue-led development progress automatically, against Jira, Linear or GitHub Issues. Normal use requires **zero TeamFlow commands**.

The plugin is self-contained: its Claude Code hooks, TeamFlow skills and the Atlassian, Linear and GitHub MCP declarations live inside the plugin package. Installing or uninstalling the plugin installs/removes those components together.

## Easy install / uninstall

From a TeamFlow checkout:

```bash
npm run plugin:install
npm run plugin:uninstall
```

Equivalent Claude Code commands:

```bash
claude plugin marketplace add macleodlabs-ai/teamflow-plugin
claude plugin install teamflow@macleodlabs --scope user

claude plugin uninstall teamflow@macleodlabs --scope user
```

Uninstall keeps TeamFlow-owned local state/config by default so reinstall is safe. Explicit cleanup:

```bash
node scripts/plugin-lifecycle.mjs uninstall --scope user --purge-data --purge-config --remove-marketplace
```

No hook files are separately injected into a developer repository, so there are no orphan TeamFlow hooks to manually remove.

## What happens automatically

In Claude Code, from the plugin's own hooks. In Cursor, Copilot,
Windsurf, Cline, Codex CLI, Gemini CLI and JetBrains Junie, from the
hooks `skills install --for <tool>` writes for them. See "Reporting from
anything else" below.

1. `SessionStart` restores/detects a tenant-scoped issue binding from a manual override, prompt, branch or recent commit.
2. The bundled Atlassian v2, Linear and GitHub MCP servers are available for issue context; authenticate the one you use once through `/mcp`.
3. `PostToolUse` / `PostToolUseFailure` derive local dev/test/audit, merge, dev deploy/test/audit and rework stages.
4. Meaningful state changes are deduplicated and published under the configured tenant prefix.
5. Reporting failures are queued locally and never block development.
6. Each Claude Code session runs a small heartbeat. Every two minutes it tells the service that the session is alive, which ticket it is on and what its agents are doing. When the session's process disappears without an end, the heartbeat says so once and stops. A usage limit leaves a pause, not a crash.
7. `SessionEnd` stays local-only.

## Manual escape hatches

- `/teamflow:login`
- `/teamflow:logout`
- `/teamflow:repos add owner/repo`
- `/teamflow:status`
- `/teamflow:bind DAEMON-142` (also `ENG-42`, `#123`, `owner/repo#123` or an issue URL)
- `/teamflow:work-on DAEMON-142` (the same bind, inside a git worktree)
- `/teamflow:unbind`
- `/teamflow:next` (take the top-priority open ticket, assign it in the tracker and bind it; `--dry-run` shows the order and the pick and changes nothing)
- `/teamflow:sync`
- `/teamflow:doctor`
- `/teamflow:org` (which organisation this machine reports to; `org switch <id>` changes it)
- `/teamflow:adhoc` (work with no ticket: mint an `ADHOC-` key, bind to it, and end it when the work is done)
- `/teamflow:build` (run a plan: a pool of tickets in priority order, on the board as one run with its phases)
- `/teamflow:admin-code` (superadmins only: `admin code create --email owner@acme.com --seats 5 --days 365`, `admin code list`, `admin code revoke TF-XXXX-XXXX`)

The agent may run `/teamflow:next`, `/teamflow:adhoc` and `/teamflow:build` by itself. A session with no ticket is told to run `/teamflow:next` before it starts editing. The rest are manual-only.

## Configuration

`~/.config/teamflow/config.json`:

Inside a Claude Code session: `/plugin marketplace add macleodlabs-ai/teamflow-plugin`, `/plugin install teamflow@macleodlabs`, then `/teamflow:login` once (a terminal install needs `/reload-plugins` in the open session): it opens the consent page, which names the tool and the machine, and one Approve authorizes the plugin until it is revoked. That is the whole of onboarding for Claude Code; the dashboard signs in on its own with your email. Turn on auto-update for the macleodlabs marketplace (`/plugin`, Marketplaces tab) and new versions arrive in the background; Claude Code asks you to run `/reload-plugins` when one lands. Reporting then uses a one-hour access token refreshed in the background; the long-lived refresh token, stored at `~/.config/teamflow/session.json` and sent only to the token endpoint, is bound to this machine's device record, which `/teamflow:logout` or the Organisation page revokes. `/teamflow:doctor` shows who is signed in, the org, and whether this machine can report.

CI signs in per job with its GitHub Actions OIDC token and stores no secret. An owner registers each repository once with `/teamflow:repos add <owner/repo>`; until then that repository's exchange answers `repository_not_registered`.

A superadmin can invite an organisation to start without paying: `teamflow admin code create --email owner@acme.com --seats 5 --days 365` has the service email that address a code and a redeem link. Those commands send a person's ID token — from `teamflow login --browser`, a personal sign-in the plugin never reports with — because the service matches its superadmin list against the verified email claim that only the ID token carries, and a machine's device authorization must not satisfy it. See `docs/PLUGIN.md`.

The rest is about the tracker:

```json
{
  "actorId": "steve",
  "actorName": "Steve",
  "tracker": "jira",
  "jiraBaseUrl": "https://YOUR-SITE.atlassian.net"
}
```

`tracker` is `jira` (default), `linear` or `github`. Linear uses `linearWorkspace`; GitHub Issues uses `githubRepo` (`owner/repo`), derived from the origin remote when absent.

Environment equivalents include `TEAMFLOW_SERVICE_URL`, `TEAMFLOW_ACTOR_ID`, `TEAMFLOW_ACTOR_NAME`, `TEAMFLOW_TRACKER`, `TEAMFLOW_JIRA_BASE_URL`, `TEAMFLOW_LINEAR_WORKSPACE` and `TEAMFLOW_GITHUB_REPO`.

### Non-interactive fallback

`teamflow login --no-browser` prints the consent page's address and a code, for a machine that cannot open a browser. Legacy S3 reporting (`dataUri`, `tenantId`, `awsProfile`) still works when no service credential is available. See `docs/PLUGIN.md`.

A project may override config in `.teamflow.json` — but only the keys that
describe the project. A file inside a repository may not decide where a
credential goes or which one is used, so `serviceUrl`, `authIssuer`,
`authClientId`, `authScopes`, `authApiScope`, `apiKey`, `accessToken`,
`dataUri`, `awsProfile` and `oidcAudience` are ignored there and only the
environment or `~/.config/teamflow/config.json` set them. `teamflow status`
and `teamflow doctor` name any key they ignored and the variable that still
works.

A credential is also sent only to the service that issued it, only over
`https` unless the service is on `localhost`, and never across a redirect. A
handed-in access token records no origin of its own, so it goes
only to TeamFlow, to `localhost`, or to an origin listed as `trustedOrigins` in
`~/.config/teamflow/config.json` — the environment cannot add one, because
inside an editor the environment is not reliably yours.

To use your own TeamFlow, say so deliberately: `teamflow login --service <url>`
once, or `serviceUrl` in that same file. Either records the origin for you.
`teamflow login` refuses to start against a non-`localhost` address that only
an environment variable names, because a sign-in hands that address an
authorization code and your identity token.

## Audit detection

TeamFlow treats audit as a first-class delivery gate:

```text
Local Test → Local Audit → Merge → CI/CD → Dev Test → Dev Audit → Verified → Done
                 │                              │
                 └─ fail → rework/retest/…      └─ fail → rework/redeploy/retest/re-audit
```

Common `audit`, `lint`, `typecheck`, Semgrep and CodeQL commands are recognized locally. Dev audit detection supports `audit-dev` / `dev-audit` style commands. Repositories can set custom `localAuditPattern`, `devTestPattern` and `devAuditPattern` regexes.

When the agent looks the bound ticket up — the Atlassian MCP, the Linear
MCP, a GitHub MCP tool or `gh issue view` — its title and status go on
the board with no report typed by hand. One seam,
`enrichFromToolResult(tracker, result)`, one parser per tracker, and the
reporting contract unchanged: title and status only, never a body.

When nothing looked it up, the title is resolved once instead — at
`/teamflow:bind`, and again on the first report for a key whose binding
carries none. GitHub is asked through the developer's own `gh`, or the
public REST endpoint when `gh` is missing, and the answer is cached on
the binding. Jira and Linear are never asked: that would mean an API
token this plugin has never needed.

Every report also carries where the branch stands and what its pull
request is doing — branch, head commit, commits since the default
branch, ahead, behind, pushed, dirty, and for the PR its number, link,
state, mergeability, check counts and review decision. The branch half
is local `git`; the PR half is `gh pr view` and is simply absent when
there is no `gh` or no pull request. Counts, flags and enumerated
verdicts only: never a diff, a commit body or a file list.

## Reporting from anything else

Claude Code was automatic for as long as it was the only tool with a
hook. It is not any more, and one command installs the same thing
everywhere:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin skills install --for cursor
```

`--for` takes `cursor`, `codex`, `gemini`, `copilot`, `windsurf`,
`cline`, `zed`, `jetbrains`, `claude-desktop` and `aider`. It writes the
skills where that tool discovers them, or generates the rules file it
reads from the same `SKILL.md` sources; registers the MCP server in that
tool's own format; and, where the tool has a hook system, writes its
hook configuration too. `--dry-run` shows the file list first. Per-tool
detail is in `docs/CLIENTS.md`.

Eight of the eleven clients report automatically:

| Level | Tools |
| --- | --- |
| Hooks, per tool call | Claude Code, Cursor, VS Code + Copilot and Copilot CLI, Windsurf, Cline, Codex CLI, Gemini CLI, JetBrains Junie |
| Git hooks, per commit | Zed, Aider, and anything else |
| Rules only | Claude Desktop's chat side |

The hooks call `teamflow hook --for <tool>`, which translates that
tool's payload into the one shape `classifyTool` reads. There is one
classifier, so a `LOCAL_TEST` from Cursor is the same report as a
`LOCAL_TEST` from Claude Code. Every hook exits 0 and prints nothing
that its tool could read as a denial: reporting can never block an edit,
a command or a turn.

Two tools deliberately report less than they could. Cursor's
`afterShellExecution` and Windsurf's `post_run_command` document no exit
status, and JetBrains Junie fires no `PostToolUse` at all, so a test run
whose outcome is unknown is dropped rather than guessed at. A green
`LOCAL_TEST` for a red suite would be worse than no report.

A repository is shared between Macs and Windows machines, so a tool that
documents a Windows form of a hook gets a second shim,
`.teamflow/hooks/<tool>.ps1`, calling the same entry with the same
fail-open rules. Copilot CLI and Windsurf each take a `powershell` field
beside `command`; Cursor has no such field and runs `command` through
the platform shell, so both shims are registered and the `.ps1` execs
`true` under a POSIX shell so only one of the two ever reports. See
"Windows and PowerShell" in `docs/PLUGIN.md`.

For a tool with no hooks, and for a team that would rather not depend on
one:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin hooks install --git
```

`post-commit` reports `LOCAL_DEV`, `post-merge` reports `MERGE`, and
`pre-push` runs the `testCommand` named in `.teamflow.json` and reports
`LOCAL_TEST` or `LOCAL_REWORK`. Reporting is then on commit rather than
per tool call. No block TeamFlow writes can fail a git operation.

`teamflow hooks status` says what is installed in the current repository
and what it covers.

From a shell, with no model involved:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin report --issue DAEMON-142 \
  --stage LOCAL_TEST --status success --summary "42 tests, 0 failing"
```

Same envelope, same transport, same credential. A bad argument exits 2;
a service that is down, broke or unreachable exits 0 and queues, so a
git hook using it can never block a push.

## This directory is an npm package

`@macleodlabs/teamflow`, whose `teamflow` bin is `scripts/cli.mjs`. That
is the same script the skills here call, which is what lets one skill
file work in Claude Code and in every other tool.

It is installed from git, not from a registry: this directory is
mirrored flat to the public repository
[macleodlabs-ai/teamflow-plugin](https://github.com/macleodlabs-ai/teamflow-plugin),
which is what `npx -y github:macleodlabs-ai/teamflow-plugin` and
`claude plugin marketplace add macleodlabs-ai/teamflow-plugin` both
read.

## Data policy

Hooks may inspect tool metadata locally, but the reporting allowlist excludes prompts, transcripts, source code, diffs, raw commands/tool output, secrets, issue descriptions/comments and raw CI logs. The service enforces the same allowlist again on arrival and drops anything it does not recognise.
