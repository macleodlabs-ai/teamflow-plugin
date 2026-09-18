#!/usr/bin/env node
// `teamflow next`: which ticket comes next, and taking it.
//
// The ordering rule lives here as a pure function so the same rule can
// be printed, tested and followed. `teamflow next` follows it against
// GitHub, because `gh` is a credential the developer already has and
// the plugin does not have to hold. Linear and Jira are read through
// the MCP tools the session already has, which the CLI cannot reach:
// this command prints the workflow to run instead, and never asks for
// a token. Adding tracker API tokens to the plugin config would put a
// second credential on every developer's machine to answer a question
// their agent can already answer.
//
// The pick is stated with its reason, always, because a command that
// assigns somebody a ticket has to be arguable with.

import { resolveGithubRepo, safeExec, trackerOf } from './core.mjs';

// p0/p1/p2 and high/medium/low are the two spellings teams label with.
// Ranked together so a repository using both still has one order.
const PRIORITY_VALUES = {
  p0: 0, critical: 0, urgent: 0, highest: 0,
  p1: 1, high: 1,
  p2: 2, medium: 2, normal: 2,
  p3: 3, low: 3,
  p4: 4, lowest: 4,
};
const UNPRIORITISED = 9;
const PRIORITY_LABEL = /^priority\s*[:/_-]\s*(.+)$/i;

export const ORDERING_RULES = {
  github: 'GitHub: the `priority:*` labels first (p0/p1/p2, or high/medium/low), '
    + 'then an issue with a milestone before one without and the earlier due date first, '
    + 'then the oldest issue. The pick is the first one in that order that is unassigned or already yours.',
  linear: "Linear: the tracker's own priority field (Urgent, High, Medium, Low, then No priority), "
    + 'then the oldest created date. The pick is the first issue in that order that is unassigned or already yours.',
  jira: 'Jira: the priority field (Highest down to Lowest), then the oldest created date. '
    + 'The pick is the first issue in that order that is unassigned or already yours.',
};

export function orderingRule(tracker) {
  return ORDERING_RULES[String(tracker || '').toLowerCase()] || ORDERING_RULES.github;
}

/** How urgent a GitHub issue's labels say it is. Lower sorts first. */
export function priorityRank(labels = []) {
  let rank = UNPRIORITISED;
  for (const label of labels) {
    const match = PRIORITY_LABEL.exec(String(label?.name ?? label ?? '').trim());
    if (!match) continue;
    const value = PRIORITY_VALUES[match[1].trim().toLowerCase()];
    // Two labels on one issue read as the more urgent of the two: that
    // is the reading that cannot leave an urgent ticket behind a low one.
    if (value !== undefined && value < rank) rank = value;
  }
  return rank;
}

const milestoneRank = (issue) => (issue?.milestone ? 0 : 1);
// A milestone with no due date is a commitment with no date, so it sorts
// behind every dated one rather than in front of them.
const milestoneDue = (issue) => String(issue?.milestone?.dueOn || '9999-12-31');
const milestoneTitle = (issue) => String(issue?.milestone?.title || '');
const opened = (issue) => String(issue?.createdAt || '9999-12-31');

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The tracker's order, oldest-and-most-urgent first.
 *
 * Total, deliberately: two issues alike in every field would otherwise
 * come back in whatever order the tracker listed them, and the pick
 * would move under the team between two runs of the same command.
 */
export function orderIssues(issues = []) {
  return [...issues].sort((a, b) => compare(priorityRank(a.labels), priorityRank(b.labels))
    || compare(milestoneRank(a), milestoneRank(b))
    || compare(milestoneDue(a), milestoneDue(b))
    || compare(milestoneTitle(a), milestoneTitle(b))
    || compare(opened(a), opened(b))
    || compare(Number(a.number), Number(b.number)));
}

const logins = (issue) => (issue?.assignees || []).map((a) => String(a?.login ?? a ?? '').toLowerCase());

/** Why this one: the fields the order actually used, in the order it used them. */
function reasonFor(issue, mine) {
  const parts = [];
  const rank = priorityRank(issue.labels);
  const label = (issue.labels || []).find((l) => {
    const match = PRIORITY_LABEL.exec(String(l?.name ?? '').trim());
    return match && PRIORITY_VALUES[match[1].trim().toLowerCase()] === rank;
  });
  parts.push(label ? String(label.name) : 'no priority label');
  if (issue.milestone?.title) parts.push(`milestone ${issue.milestone.title}`);
  parts.push(`opened ${opened(issue).slice(0, 10)}`);
  parts.push(mine ? 'already yours' : 'unassigned');
  return parts.join(', ');
}

/**
 * The first issue in tracker order that nobody else is already on.
 *
 * An issue assigned to somebody else is skipped rather than reported as
 * a conflict: two people picking "next" a minute apart should get two
 * different tickets, not the same one twice.
 */
export function pickNext(issues = [], { login } = {}) {
  const me = String(login || '').toLowerCase();
  for (const issue of orderIssues(issues)) {
    const held = logins(issue);
    const mine = Boolean(me) && held.includes(me);
    if (held.length && !mine) continue;
    return { issue, alreadyMine: mine, reason: reasonFor(issue, mine) };
  }
  return undefined;
}

/** The pick and its reason, on one line, because that is what gets read. */
export function pickLine(picked, repo) {
  if (!picked) return 'No open issue is unassigned or already yours.';
  const where = repo ? `${repo}#${picked.issue.number}` : `#${picked.issue.number}`;
  return `${where} ${picked.issue.title} — ${picked.reason}`;
}

// The workflow that reads Linear or Jira. The CLI holds no tracker
// credential and must not ask for one, so this is the whole answer for
// those two, and the answer for GitHub when `gh` is missing.
function skillInstruction(tracker) {
  return `TeamFlow holds no ${tracker} credential and will not ask for one. `
    + 'Run the TeamFlow next workflow in your agent instead '
    + '(/teamflow:next in Claude Code, the teamflow-next skill elsewhere): it lists the open issues '
    + `through the ${tracker === 'jira' ? 'Atlassian' : tracker} MCP tools the session already has, `
    + 'picks by the rule below, assigns the issue to you and runs `teamflow bind <key>`.';
}

function ghIssues(repo) {
  const listed = safeExec('gh', ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '100',
    '--json', 'number,title,labels,assignees,milestone,createdAt'], { timeout: 15000 });
  if (!listed.ok) return { ok: false, reason: listed.stderr || `gh issue list exited ${listed.status}` };
  try {
    const issues = JSON.parse(listed.stdout || '[]');
    return { ok: true, issues: Array.isArray(issues) ? issues : [] };
  } catch (error) {
    return { ok: false, reason: `gh issue list did not return JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * `teamflow next [--dry-run]`.
 *
 * Owns its exit code: 0 whenever it had something useful to say, even
 * when it could not read the tracker, because the useful thing to say
 * is which workflow to run instead. 1 is reserved for a repository it
 * cannot identify and a `gh` call that failed.
 */
export async function main(args = [], ctx = {}) {
  const { config = {}, info = {}, bind } = ctx;
  const print = ctx.print || ((value) => process.stdout.write(`${value}\n`));
  const fail = ctx.fail || ((value) => process.stderr.write(`${value}\n`));
  const dryRun = args.includes('--dry-run');
  const tracker = trackerOf(config);
  const rule = orderingRule(tracker);

  if (tracker !== 'github') {
    print(skillInstruction(tracker));
    if (dryRun) print(`Ordering rule — ${rule}`);
    return 0;
  }

  const repo = resolveGithubRepo(config, info);
  if (!repo) {
    fail('TeamFlow could not tell which GitHub repository this is. '
      + 'Set `githubRepo` in .teamflow.json, or run this in a checkout with a GitHub origin remote.');
    return 1;
  }
  if (!safeExec('gh', ['--version'], { timeout: 5000 }).ok) {
    print(skillInstruction('github'));
    print(`Ordering rule — ${rule}`);
    return 0;
  }

  const listed = ghIssues(repo);
  if (!listed.ok) {
    fail(`TeamFlow could not list the open issues of ${repo}: ${listed.reason}`);
    return 1;
  }
  // `gh api user` is the only way to know which of the assignees is the
  // person running this. It can fail on a token without the scope; the
  // pick then falls back to unassigned issues only, which is the safe
  // half of the rule rather than no answer at all.
  const who = safeExec('gh', ['api', 'user', '--jq', '.login'], { timeout: 10000 });
  const login = who.ok ? who.stdout.split('\n').pop().trim() : undefined;

  const ordered = orderIssues(listed.issues);
  const picked = pickNext(listed.issues, { login });

  if (dryRun) {
    print(`Ordering rule — ${rule}`);
    print(`${repo}: ${ordered.length} open issue${ordered.length === 1 ? '' : 's'}, in order:`);
    for (const issue of ordered.slice(0, 10)) {
      const held = (issue.assignees || []).map((a) => a.login).join(', ');
      print(`  #${issue.number} ${issue.title} — ${reasonFor(issue, false).replace('unassigned', held ? `assigned to ${held}` : 'unassigned')}`);
    }
    print(picked
      ? `Would pick ${pickLine(picked, repo)}. Nothing assigned and nothing bound: this was --dry-run.`
      : 'Would pick nothing: every open issue is assigned to somebody else.');
    return 0;
  }

  if (!picked) {
    print(`No open issue in ${repo} is unassigned or already yours, so TeamFlow picked nothing. Ordering rule — ${rule}`);
    return 0;
  }

  if (!picked.alreadyMine) {
    const assigned = safeExec('gh', ['issue', 'edit', String(picked.issue.number), '--repo', repo,
      '--add-assignee', '@me'], { timeout: 15000 });
    if (!assigned.ok) {
      fail(`TeamFlow picked ${pickLine(picked, repo)} but could not assign it: ${assigned.stderr || `gh issue edit exited ${assigned.status}`}`);
      return 1;
    }
  }

  print(`TeamFlow picked ${pickLine(picked, repo)}.`);
  // Binding is what makes every hook from here on attribute to this
  // ticket, so the pick is not finished until it is bound.
  const reference = `${repo}#${picked.issue.number}`;
  if (bind) await bind(reference);
  else print(`Run \`teamflow bind ${reference}\` to attribute this session's work to it.`);
  return 0;
}

export default main;
