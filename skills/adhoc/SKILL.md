---
name: adhoc
description: Work that arrived without a ticket. Mint an ADHOC key for it, publish it and bind to it, so it is on the board with its dependencies like any ticket, and end it when the work is done.
command: adhoc
---

Use this the moment a session is asked to do something real and there is
no ticket for it: a fix somebody mentioned in passing, a question that
turned into a change, a chore nobody raised. Until it has a key, the
work reaches the board under no key at all, and a board that is missing
the work is worse than no board.

An ad hoc work item **is an issue document whose key TeamFlow minted**.
It is not a new kind of thing. It sits in the same pool, joins the same
`dependencies[]`, moves through the same stages, and every hook reports
against it exactly as it would a ticket. The only difference is who owns
the key: `ADHOC-<n>`, minted by the service per organisation so two
sessions never invent the same one.

## Start it

```bash
npx -y github:macleodlabs-ai/teamflow-plugin adhoc start "Retry the Linear backfill on a 429"
```

In Claude Code the plugin is already on disk, so use the fast path:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" adhoc start "Retry the Linear backfill on a 429"
```

That mints the key, publishes the item and binds this project to it in
one go. From there, do nothing else for reporting: the hooks take over.

## The title is derived, and it is never the request

**Write a short sentence saying what the work is. Never the words that
asked for it.** This is the reporting contract
(`docs/REPORTING_CONTRACT.md`) at its sharpest: prompts never leave the
machine, and a title is the one field on an ad hoc item that a careless
session could fill with one.

- "Retry the Linear backfill on a 429" — what the work is.
- "can you look at why the linear import keeps dying, it's been broken
  since yesterday and I'm losing my mind" — the request. It never
  travels, not abbreviated, not paraphrased into a quote of itself.

Say it in the third person, about the change, in one line. The command
refuses more than one line and refuses anything over 180 characters,
which is the same cap a report's summary has — but the cap is a backstop,
not the rule. A title that fits and still quotes the request is still
wrong.

## Keep it current as the work goes

Every change to the item is published the moment it changes. Nothing
waits for the end of a run.

- The work turns out to be something else: `adhoc title "<the new
  sentence>"` and it is republished at once.
- It belongs to a run: `workflow add ADHOC-7` puts it in the pool, and
  `workflow ticket ADHOC-7 --state running --cycle build` moves it
  through the cycle like any ticket.
- It waits on something, or something waits on it: record the edge in
  the planning batch (`workflow depends --batch`) with the rest. An ad
  hoc key is an ordinary node — the phases level over it and the board
  draws its arrows the same way.

## End it

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" adhoc done
```

That publishes the item's final state and unbinds, so the next turn is
attributed to whatever it is actually about. If the session simply stops
first, the `Stop` hook ends the item on its own — an ad hoc item is one
request's worth of work, and the request has been answered.

**An ad hoc item never reopens.** A follow-up request is a new item with
a new key, even when it is about the same code. Reopening would make one
key mean two pieces of work and the board could no longer say when
either of them finished.

## What this is not for

- **Work that has a ticket.** Bind the ticket. `teamflow next` takes the
  top-priority open one.
- **A stage.** Ad hoc is where the key came from, not where the work is.
  The hooks decide the stage, here as everywhere; never report one by
  hand.
- **Splitting one request into a dozen items.** One item per piece of
  work somebody would recognise as a piece of work.
