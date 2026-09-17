---
name: repos
description: Register a repository so its CI can report to TeamFlow without a stored secret, or list the ones already registered.
command: repos
disable-model-invocation: true
---

With no arguments, or with `list`, show the repositories already registered and the OIDC audience their workflows must use:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin repos list
```

When "$ARGUMENTS" starts with `add`, take the rest as an `owner/repo` and run:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin repos add "<owner/repo>"
```

Registration is done once per repository, by the organisation's owner. Until it happens, that repository's workflows cannot trade their GitHub OIDC token for access and the exchange answers `repository_not_registered`.

Both commands need the caller to be signed in, and `add` needs them to be the owner. Return the command's result. If it reports `owner_only`, tell the user an owner has to run it. If it reports `repository_taken`, the repository is registered to a different organisation.

Inside Claude Code the plugin is already on disk, so
`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" repos` is the same command without the npx round trip. Use it when `CLAUDE_PLUGIN_ROOT` is set.
