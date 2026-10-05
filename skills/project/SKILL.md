---
name: project
description: Choose the project this session works in, or make a new one. Shows your recent projects, the team's open projects and "New project…" as a picker, then puts the session in the one chosen until `teamflow project end`.
command: project
---

A session is in one project from the moment it is chosen until
`teamflow project end`. A restart, a resume or a compaction in the same
repository continues it. Agents and worktrees this session starts work in
it too. Use this skill to choose the project, or when the person asks to
switch.

## 1. Read the choices

```bash
npx -y github:macleodlabs-ai/teamflow-plugin project
npx -y github:macleodlabs-ai/teamflow-plugin project list
```

In Claude Code the plugin is already on disk, so use the fast path:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" project
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" project list
```

The first says which project this session is in now. The second lists
the team's open projects, one per line: the id, the name and its tracker
badge, such as `(Linear)`. Projects this computer used lately come first.

## 2. Ask with the question picker

Use Claude Code's own question tool (AskUserQuestion) with one question:
"Which project is this work for?". Offer, in this order:

- up to three recent projects from the top of the list, each labelled
  with its name and badge, and its id in the description;
- "New project…", whose description says "Make a project for this work";
- "Other team project…" when the list has more than three.

If the person picks "Other team project…", ask once more with the rest of
the list (at most four options; the picker adds its own "Other" for typed
text). If the person picks "New project…" or types a name, ask for the
name only if they gave none, and ask whether to link it to a Linear,
Jira or GitHub project. Never guess a name from the conversation.

## 3. Run the matching command

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" project use <id>
node "${CLAUDE_PLUGIN_ROOT}/scripts/cli.mjs" project create "<name>" [--link linear|jira|github[:"<tracker project>"]]
```

Outside Claude Code, `npx -y github:macleodlabs-ai/teamflow-plugin project use <id>` and
`... project create "<name>"` do the same.

- Use the id for `project use`, never the name: two projects may share a name.
- `--link` may be given more than once: `--link linear:"Payments" --link github:acme/pay`.
- A name that matches more than one project lists the matches and changes
  nothing. Show the person the list and ask again.

Return the command's one sentence to the person and nothing more. The
hooks do the rest: each prompt from now on names the project and its
threads.

## Rules

- The project name is what the work is, in a few words. Never the words of
  a prompt. Prompts never leave the machine.
- `teamflow project end` takes the session out of the project; add
  `--close` only when the person asks to close the project itself.
