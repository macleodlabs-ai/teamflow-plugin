---
name: work-on
description: Bind this project to an issue (Jira, Linear or GitHub) — the form to use in a git worktree, where a sandbox may refuse a command whose text contains `bind`.
command: work-on
disable-model-invocation: true
---

Validate that "$ARGUMENTS" contains an issue reference in one of these forms, then run the command below:

- a Jira or Linear key such as `DAEMON-142` or `ENG-42`;
- a GitHub issue as `#123` (needs `githubRepo` or a GitHub origin remote) or `owner/repo#123`;
- a Jira browse URL, a `linear.app/<workspace>/issue/<KEY>` URL or a `github.com/<owner>/<repo>/issues/<n>` URL.

Every form is accepted whatever tracker the repository is configured for: an organisation runs several trackers at once, and the form of the argument names the provider. Pass the full issue URL when a bare `TEAM-123` could be either Jira's or Linear's.

```bash
npx -y github:macleodlabs-ai/teamflow-plugin work-on "$ARGUMENTS"
```

This is `bind`, under a name a worktree-isolation sandbox has no reason to refuse. Inside a git worktree it writes the binding into that worktree's own `.teamflow/binding.json`, exactly as `bind --local` does; outside a worktree it behaves exactly as `bind`. Return only the command result. The command rejects anything else with the accepted forms.

If no issue has been named and the session is about to start work, run the `next` skill instead: it picks the top-priority open ticket that is unassigned or already the user's, assigns it and binds it.

Inside Claude Code the plugin is already on disk, so
`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" work-on` is the same command without the npx round trip. Use it when `CLAUDE_PLUGIN_ROOT` is set.
