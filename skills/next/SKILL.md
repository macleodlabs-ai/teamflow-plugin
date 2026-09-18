---
name: next
description: Take the next ticket: list the bound project's open issues in the tracker's priority order, pick the top one that is unassigned or already yours, assign it to yourself and bind it.
command: next
---

Use this when a session is about to start work and no issue is bound, or when the user asks what to work on next.

The rule is the same for every tracker: **the tracker's own priority first, then the issue's milestone or sprint, then age; the pick is the first issue in that order that is unassigned or already the user's.** An issue somebody else holds is skipped, never taken.

Follow the first of these the session can do.

**1. The Linear MCP is connected.** `list_issues` for the bound team or project with an open state, then order by `priority` (Urgent, High, Medium, Low, then No priority) and, within a priority, by the oldest `createdAt`. Pick per the rule, `save_issue` on it with `assignee: "me"`, then bind it:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin bind ENG-42
```

**2. The Atlassian MCP is connected.** The Jira equivalent: search the bound project's open issues, order by the priority field (Highest down to Lowest) then the oldest created date, assign the pick to the current user, then bind it the same way.

**3. Neither, but `gh` is installed and the project is a GitHub repository.** The command does the whole of it — order, pick, `gh issue edit --add-assignee @me`, bind:

```bash
npx -y github:macleodlabs-ai/teamflow-plugin next
```

Add `--dry-run` to see the ordered list and the pick without assigning or binding anything.

**4. None of those.** Show the ordered list, say which issue the rule picks, and ask the user to confirm before assigning anything. Never invent a tracker credential and never ask the user for a token: TeamFlow holds none by design.

Whichever route was taken, say what was picked and why on one line, naming the issue key, its title and the fields the order used — for example: `Picked ENG-42 "The board loses a column" — priority High, sprint 24, opened 2026-05-01, unassigned.` Then continue with the work; reporting from here on is automatic and attributed to that ticket.

Inside Claude Code the plugin is already on disk, so
`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" next` is the same command without the npx round trip. Use it when `CLAUDE_PLUGIN_ROOT` is set.
