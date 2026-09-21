---
name: admin-code
description: Create, list or revoke a TeamFlow invite code so an organisation can sign up without paying. Superadmins only.
command: admin
disable-model-invocation: true
---

An invite code lets one organisation start on TeamFlow without a Stripe subscription: the holder opens the redeem link, names the organisation, and the service gives it the seats and the complimentary period the code carries. Only a superadmin can issue one, and the command sends the signed-in user's ID token because that is what names the verified email the service checks.

Take the action from "$ARGUMENTS". With no arguments, list.

**Create.** `--email` is the organisation's admin: the service emails them the code and its redeem link, and locks the code to that address, so anyone else redeeming it is turned away. It is required. Seats and the length of the complimentary period are required too. `--note` is a reminder that only shows in the list.

```bash
npx -y github:macleodlabs-ai/teamflow-plugin admin code create --email owner@acme.com --seats 5 --days 365 --note "Acme pilot"
```

It says the code was emailed to that address, then prints the code, the redeem link, the seats, the period and the expiry, one per line. The mail is what the recipient will use; the printed link is a fallback to paste into a message. If the service has no mailer configured it refuses and issues no code.

**List.** One row per code, with its status: `unredeemed`, `redeemed` with the account that used it, or `expired`.

```bash
npx -y github:macleodlabs-ai/teamflow-plugin admin code list
```

**Revoke.** Only an unredeemed code can be revoked.

```bash
npx -y github:macleodlabs-ai/teamflow-plugin admin code revoke TF-XXXX-XXXX
```

Return the command's result. If it says the signed-in user is not a superadmin, or that no code could be emailed, say so and stop; adding the address is a change to the service's configuration, not something this command can do. If it says TeamFlow is not signed in as a person, have the user run `teamflow login --browser` first: operator commands need a personal sign-in, and the plugin's own authorization (`/teamflow:login`) is a machine's, which they refuse.

Inside Claude Code the plugin is already on disk, so
`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" admin code list` is the same command without the npx round trip. Use it when `CLAUDE_PLUGIN_ROOT` is set.
