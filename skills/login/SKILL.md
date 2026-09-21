---
name: login
description: Authorize the TeamFlow plugin on this machine once, on the consent page, so reporting uses short-lived credentials instead of a stored key.
command: login
disable-model-invocation: true
---

Run this command with the shell tool:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin login
```

This authorizes the plugin; it is not a sign-in. It opens TeamFlow's consent page in the browser the user already has — the page says which tool and which computer are asking, shows a short code, and has Approve and Deny — and waits up to three minutes. Someone already signed in to TeamFlow in that browser presses Approve and the command finishes by itself; someone who is not signs in on that same page first and lands back on it. There is nothing to type and no key to copy. Tell the user to check that the code on the page matches the one the command printed, approve it, and then return the command's result.

When it succeeds the command prints three things, and all three belong in what you tell the user: the organisation it syncs to, the project this repository belongs to, and "Your next report will appear on the board". If the project line reads `none — this repository is in no project; add it from the header's project switcher`, say so: the work will still report, but it appears under no project and every board view filters by project, so nobody will see it until the repository is added. `unknown` there means only that the service could not be asked, and changes nothing about reporting.

When the browser cannot be opened here — no display, no browser installed, `--no-browser`, or a terminal on another machine — the command prints a short code, the consent page's address, and a link that carries the code. The browser can be **anywhere**: a laptop, a phone, another machine entirely. Give the user all three and wait: the command polls and finishes when they approve. The onboarding wizard's step 4 has a field for that code, so a person who is already there can approve it without leaving the page. `--device` is accepted and does the same thing.

If they press Deny the command stops and says so; nothing was issued and nothing needs undoing.

What this leaves on the machine is the plugin's authorization for this one computer, bound to the user's seat: a long-lived refresh token that is only ever sent to TeamFlow's token endpoint, and one-hour access tokens minted from it for the reports themselves. It stays authorized until somebody revokes it — `/teamflow:logout` revokes it at the service, and the user or an owner can revoke it from the Organisation page, which lists every connected computer. Which organisation it syncs to is chosen on the consent page, so `--org` does nothing here.

This is the whole of TeamFlow onboarding. It is also how TeamFlow's own MCP server — `teamflow` in `/mcp` — is authenticated: it connects with this same authorization, so after logging in tell the user to Reconnect `teamflow` in `/mcp` if it showed as not connected. There is no separate MCP sign-in.

If the command fails it prints the reason. "Could not reach" means the service did not answer and the thing to do is try again. A code that expired or was never approved needs a fresh one: run the command again.

`teamflow login --browser` is a different thing and is not how the plugin is authorized: it signs a *person* in for operator commands (`teamflow admin`, `teamflow org`) and nothing reports with it. Only suggest it when one of those commands asks for it.

Inside Claude Code the plugin is already on disk, so
`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" login` is the same command without the npx round trip. Use it when `CLAUDE_PLUGIN_ROOT` is set.
