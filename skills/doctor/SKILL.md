---
name: doctor
description: Diagnose TeamFlow reporting, the service account, and the issue tracker MCP setup.
command: doctor
disable-model-invocation: true
---

Run:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin doctor
```

Return the diagnostic output.

`credential` names what this machine is holding; `signedIn` and `identity` say who that is. If `signedIn` is "no", tell the user to run the login skill. `transport` is `service` when a credential is available, `s3` for a legacy direct-to-bucket install, and `none` when neither is. On the service transport `serviceAccess` and `account` come from `GET /v1/account`: if it reports the account cannot report, reports are being refused with 402, which does not block the session but does mean the dashboard is going stale. Seats are the account owner's to add, from Organisation settings.

`tracker` names the configured tracker and `trackerMcp` says whether its MCP server (Atlassian, Linear or GitHub) is visible to Claude Code. Outside Claude Code that line is about a server this tool does not manage, and can be ignored.

Inside Claude Code the plugin is already on disk, so
`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" doctor` is the same command without the npx round trip. Use it when `CLAUDE_PLUGIN_ROOT` is set.
