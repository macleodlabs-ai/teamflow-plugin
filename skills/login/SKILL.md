---
name: login
description: Sign in to TeamFlow once so reporting uses short-lived credentials instead of a stored key.
command: login
disable-model-invocation: true
---

Run this command with the shell tool:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin login
```

It opens the TeamFlow sign-in page in the user's browser and waits up to three minutes for them to finish. Tell the user to complete sign-in in the browser tab that just opened, then return the command's result.

When the browser cannot be opened — no display, no browser installed, or `--no-browser` — one of two things happens, and the command's own output says which.

- It prints a sign-in URL and keeps waiting. Give the user that URL and tell them to open it in a browser **on the same machine**; the command finishes on its own when they do. Do not cancel the command to hand over the URL: the URL only works while it is still running.
- It prints a short code and a page to enter it on. That is the device sign-in, and the browser can be **anywhere** — a laptop, a phone, another machine entirely. Give the user both, and wait: the command polls and finishes when they approve.

If the user says their browser is on a different machine from the one this is running on, run `npx -y github:macleodlabs-ai/teamflow-plugin login --device`. That is the only path that works when the terminal and the browser are not on the same machine, because the ordinary sign-in redirects to `127.0.0.1`.

A device sign-in stores a revocable credential for this machine rather than a personal session. `/teamflow:logout` revokes it at the service, and the user can revoke it from the members page. Which organisation it reports to is chosen in the browser, so `--org` does nothing on a device sign-in.

This is the whole of TeamFlow onboarding. Reporting then uses a one-hour access token refreshed in the background, and only a revocable refresh token is stored on this machine.

If the address holds a seat on more than one organisation, the command asks which one on a terminal and prints the list with their ids anywhere else. When it prints the list and stops, ask the user which organisation they want, then run the same command with `--org <id>`. The org skill switches afterwards.

If the command fails it prints the reason. "Could not reach" means the service did not answer and the thing to do is try again; a message naming `TEAMFLOW_AUTH_ISSUER` means the service answered but publishes no sign-in configuration, which is not something the user can fix by retrying.

Inside Claude Code the plugin is already on disk, so
`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" login` is the same command without the npx round trip. Use it when `CLAUDE_PLUGIN_ROOT` is set.
