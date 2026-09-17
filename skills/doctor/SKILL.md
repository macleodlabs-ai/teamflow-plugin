---
name: doctor
description: Diagnose TeamFlow reporting, the service account and credits, and the issue tracker MCP setup.
command: doctor
disable-model-invocation: true
---

Run:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin doctor
```

Return the diagnostic output.

`credential` is `bearer` for a signed-in session or a CI token and `api_key` for the non-interactive fallback; `signedIn` and `identity` say who that is. If `signedIn` is "no", tell the user to run the login skill. `transport` is `service` when either credential is available, `s3` for a legacy direct-to-bucket install, and `none` when neither is. On the service transport `serviceAccess`, `account` and `credits` come from `GET /v1/account`: if `credits` is 0 the account is out of credits and reports are being refused with 402, which does not block the session but does mean the dashboard is going stale.

`tracker` names the configured tracker and `trackerMcp` says whether its MCP server (Atlassian, Linear or GitHub) is visible to Claude Code. Outside Claude Code that line is about a server this tool does not manage, and can be ignored.

Inside Claude Code the plugin is already on disk, so
`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" doctor` is the same command without the npx round trip. Use it when `CLAUDE_PLUGIN_ROOT` is set.
