---
name: build
description: Run a workflow: take a pool of tickets in priority order, plan it into phases, and drive each ticket through build, test, audit and ticket status, deploying only if the workflow says so.
command: workflow
---

Use this when the user asks you to work through more than one ticket — "build
the backlog", "do the open bugs in order", "run the workflow" — or asks what a
running workflow is doing.

You are the orchestrator. You hold the plan, you dispatch the teams, and you
are the only one that deploys. The plugin's hooks report stages on their own
from whatever any team does, so **never report a stage by hand**; what you
record is the run's own account of where each ticket is, with
`teamflow workflow ticket`.

In Claude Code the plugin is on disk, so every command below is
`node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" workflow …`. Outside it, use
`npx -y github:macleodlabs-ai/teamflow-plugin workflow …`.

## 1. Get the workflow

`teamflow workflow show` prints the current one. If there is none, create it
from what the user asked for:

```bash
teamflow workflow create "Backlog sweep" \
  --tracker linear --project TeamFlow --state open --order priority \
  --order-text "<what the user actually said>"
```

Turning the user's sentence into flags is your job. "Everything in the backlog
but skip the auth work" is `--state open` plus a judgment you apply when you
select. `--order-text` keeps the sentence so `show` can say what was asked
for; it stays on this machine and is never published.

Pass `--deploy` only if the user asked for deployment. Without it, deploying is
out of scope for the run and you must not do it.

## 2. Fill the pool

List the tracker's open issues **in the tracker's own priority order**, apply
whatever the user's sentence excluded, then:

```bash
teamflow workflow plan --keys MACLEOD-539,MACLEOD-538,MACLEOD-534
```

The order of `--keys` is the order the run works in, so get it right here
rather than hoping to fix it later. For a GitHub project `teamflow workflow
plan` with no keys does the listing itself, with the same ordering rule as
`teamflow next`. For Linear and Jira the CLI cannot reach your MCP tools, so
you list them and pass them in.

## 3. Find the dependencies

Tickets almost never say what they depend on. Read the pool and record what
you find, before the first phase starts:

```bash
teamflow workflow depends MACLEOD-540 --on MACLEOD-538 \
  --reason "needs the reporter field that release adds" --found planning
```

Each edge re-levels the phases. An edge may point at a ticket outside the
pool; that is worth recording and it gates nothing, so if the run genuinely
needs that ticket, put it in: `teamflow workflow add <KEY>`.

If a cycle appears the phases come back blocked. Say so and ask the user
which edge to drop. Do not guess.

## 4. Run each phase

`teamflow workflow ready` names the phase and what in it is open. Work only
on those. Nothing from a later phase starts early — that is what phases are
for.

For each ticket, in the order `ready` gives them:

**Build.** Dispatch a team in its own git worktree. Its first command, before
any edit, is `teamflow bind <KEY> --local`: a worktree is its own repository
root, so nothing else attributes its hooks to the ticket, and unbound work
reaches the board under no key or a stale one. Mark the ticket as you go:

```bash
teamflow workflow ticket MACLEOD-538 --state running --cycle build
```

**Test.** The suite for what changed.

**Audit.** A separate reviewer, with the ticket and the diff. Not the team
that wrote it.

**Update the ticket status.** Move the tracker's own ticket with its MCP.
If the organisation has two-way writeback on, TeamFlow also writes back at
`DEV_VERIFIED`; doing both is harmless and doing neither leaves the tracker
lying about what shipped.

**Deploy** only if the workflow's scope says so, and only yourself — see
"What you never delegate" below.

Then `teamflow workflow ticket <KEY> --state done --cycle verified`. When the
phase's tickets are all done, `ready` moves to the next phase on its own.

### When a gate fails

Send the ticket back with the gate that failed:

```bash
teamflow workflow ticket MACLEOD-538 --state rework --cycle test
```

`ready` offers it again. The hooks already report the rework stage and the
board draws the loop from the gate that failed, so you do not report it.

### When a team finds a new dependency

A team that discovers mid-build that it needs another ticket first reports
the edge, and you record it as found while building:

```bash
teamflow workflow depends MACLEOD-538 --on MACLEOD-534 \
  --reason "needs the migration that ticket adds" --found build
```

The phases re-level immediately and the ticket moves. Work already done is
kept. `show` calls these out separately from the ones planning found,
because one is the plan and the other is news.

## 5. Finish

```bash
teamflow workflow status done
```

Then tell the user what shipped, what is still in rework and what is blocked,
naming the tickets.

## How much runs at once

A phase fans out for build and funnels for verification. Several teams may be
building at the same time; **one ticket at a time holds the test and audit
gate**.

This is not a tuning preference. Two agents plus the main session each running
a full gate took a developer's machine to a load average of 97 and crashed it.
`scripts/one-suite-at-a-time.mjs` now refuses rather than piling on, but a
schedule that relies on being refused deadlocks its own teams. Schedule around
it: hold the other teams at build until the gate is free.

## What you never delegate

**Deploying.** Never from a worktree, a subagent or a teammate — only from the
main session, which is you. `docs/DEPLOYMENT.md` is the procedure and it is not
optional reading.

**The plan.** A team reports what it found; you decide what that means for the
phases. A team that edits the workflow is a plan with two authors.

## When something is wrong

- A ticket stops moving on the board: `teamflow status` then `teamflow doctor`,
  before reading the dashboard and before debugging the UI.
- The workflow is not on the board at all: `teamflow workflow show` says
  whether the service took it. A refusal and a queued retry read differently,
  and a refusal will not fix itself.
- `teamflow workflow --help` lists every flag.
