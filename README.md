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

1. `SessionStart` restores/detects a tenant-scoped issue binding from a manual override, prompt, branch or recent commit.
2. The bundled Atlassian v2, Linear and GitHub MCP servers are available for issue context; authenticate the one you use once through `/mcp`.
3. `PostToolUse` / `PostToolUseFailure` derive local dev/test/audit, merge, dev deploy/test/audit and rework stages.
4. Meaningful state changes are deduplicated and published under the configured tenant prefix.
5. Reporting failures are queued locally and never block development.
6. `Stop` publishes an idle heartbeat; `SessionEnd` stays local-only.

## Manual escape hatches

- `/teamflow:login`
- `/teamflow:logout`
- `/teamflow:repos add owner/repo`
- `/teamflow:status`
- `/teamflow:bind DAEMON-142` (also `ENG-42`, `#123`, `owner/repo#123` or an issue URL)
- `/teamflow:unbind`
- `/teamflow:sync`
- `/teamflow:doctor`

All are manual-only skills.

## Configuration

`~/.config/teamflow/config.json`:

Install the plugin, then run `/teamflow:login` once. That is the whole of onboarding. Reporting then uses a one-hour access token refreshed in the background; only a revocable refresh token is stored, at `~/.config/teamflow/session.json`, and `/teamflow:logout` removes it. `/teamflow:doctor` shows who is signed in, the org and its remaining credits.

CI signs in per job with its GitHub Actions OIDC token and stores no secret. An owner registers each repository once with `/teamflow:repos add <owner/repo>`; until then that repository's exchange answers `repository_not_registered`.

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

`TEAMFLOW_API_KEY` is the last credential tried, for an environment that can neither open a browser nor mint an OIDC token. Legacy S3 reporting (`dataUri`, `tenantId`, `awsProfile`) still works when no service credential is available. See `docs/PLUGIN.md`.

A project may override config in `.teamflow.json`.

## Audit detection

TeamFlow treats audit as a first-class delivery gate:

```text
Local Test → Local Audit → Merge → CI → Deploy Dev → Dev Test → Dev Audit → Verified
                 │                                        │
                 └─ fail → rework/retest/re-audit         └─ fail → rework/redeploy/retest/re-audit
```

Common `audit`, `lint`, `typecheck`, Semgrep and CodeQL commands are recognized locally. Dev audit detection supports `audit-dev` / `dev-audit` style commands. Repositories can set custom `localAuditPattern`, `devTestPattern` and `devAuditPattern` regexes.

## Reporting from anything else

Claude Code is the only client where TeamFlow is automatic, because it is
the only one with a hook that fires on every tool call. Every other tool
gets the same skills, installed with one command:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin skills install --for cursor
```

`--for` takes `cursor`, `codex`, `gemini`, `copilot`, `windsurf`,
`cline`, `zed`, `jetbrains`, `claude-desktop` and `aider`. It writes the
skills where that tool discovers them, or generates the rules file it
reads from the same `SKILL.md` sources, and registers the MCP server in
that tool's own format. `--dry-run` shows the file list first. Per-tool
detail is in `docs/CLIENTS.md`.

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
