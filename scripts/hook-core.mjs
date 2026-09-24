#!/usr/bin/env node
// The one hook pipeline, shared by every tool that can call a command
// on its own events.
//
// `hook.mjs` is still the Claude Code entry and hands its stdin JSON
// here unchanged; `hook-cli.mjs` (`teamflow hook --for <tool>`) puts
// every other tool's payload through `adapters.mjs` first, so what
// arrives here is always the same shape and `classifyTool` in core.mjs
// stays the only classifier. A stage that appears in Cursor and not in
// Claude Code would mean two classifiers, and two classifiers drift.

import path from 'node:path';

import {
  absorbRootActor,
  dataDir,
  writeJson,
  allActors,
  isPhantomAgent,
  purgePhantomAgents,
  supersededEnd,
  resolveActorKey,
  applyTransition,
  bindingRefusal,
  candidate,
  chooseBinding,
  claimLaunch,
  classifyTool,
  credentialKind,
  credentialRefusal,
  detectCandidates,
  enrichBinding,
  followKeyAliases,
  isAdHocKey,
  isAgentTool,
  launchFields,
  loadConfig,
  findLaunch,
  isLinkedWorktree,
  launchId,
  matchLaunch,
  organisationScope,
  parseAgentId,
  publishState,
  readJson,
  recordLaunch,
  readSoftRefusal,
  reportScope,
  refusalLine,
  reporterInfo,
  repositoryRoot,
  saveSession,
  sessionActors,
  pendingEndActors,
  serviceUrl,
  sessionPath,
  tenantId,
  trace,
  staleBuildNotice,
} from './core.mjs';
import { NO_PROJECT_SENTENCE, resolveProject } from './project.mjs';
import {
  clearPause, ensureHeartbeat, limitOf, markHandoff, markLimit, rotating, sessionLines, stopHeartbeat,
} from './heartbeat.mjs';
import { pruneSnapshots, resumeNotice, saveSnapshot } from './resume.mjs';
import { WORK_TOOLS, cardDirections, publishDirections } from './continue.mjs';
import {
  afterFindings, claimReview, findingsOf, lensOf, parseReview, reportReview, reviewCommandOf, reviewPayload, settleReview,
} from './review.mjs';
import { REVIEW_NEXT_MS, batchSize, changesFiles, reviewStartOf, stripMark, teamLeanOf } from './launch-role.mjs';
import {
  boundToTeamflow, closeDispatched, dispatchOf, launchesOf, planLaunch, publishOwed, replanUnbound, settle, withMint,
} from './dispatch.mjs';

/** Whether a launch in this session was claimed by this agent id. Local files only. */
function seenLaunch(sessionId, agentId) {
  return Boolean(agentId) && launchesOf(sessionId).some((launch) => launch.agentId === agentId);
}

// Events that must stay synchronous and fast, because the tool is
// waiting on them before it shows the developer anything.
const FAST = ['SessionStart', 'UserPromptSubmit'];
// A SessionEnd the person chose: the session is not moving anywhere.
const DELIBERATE_END = new Set(['clear', 'logout', 'prompt_input_exit']);
// Events Claude Code waits on, which spend nothing on the network. The
// fast events, plus the `Agent` tool's PreToolUse (MACLEOD-639 audit):
// it holds the dispatch until it exits, so it writes the local run and
// the launch and nothing else. Not in FAST itself, because FAST is also
// "may speak", and a PreToolUse that printed context would be read by
// the tool as something to act on.
const LOCAL_ONLY = [...FAST, 'PreToolUse'];
// Events that are work: a tool ran, or is about to.
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];

export function newSession(sessionId, cwd, agentKey = undefined) {
  return {
    sessionId,
    // Absent on the main actor, so its state file keeps the name it has
    // always had and an install that upgrades mid-session reads it back.
    ...(agentKey ? { agentKey } : {}),
    cwd,
    stage: 'BACKLOG',
    status: 'running',
    summary: 'Issue work detected',
    loopCount: 0,
    // When this actor first reported, which is what the board's session
    // row shows as "running for" (MACLEOD-574).
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// The additional context Claude Code injects into the turn. Only Claude
// Code asks for it; every other tool gets nothing on stdout, because
// stdout is how most of them are told to deny an action.
// A session with no ticket reports nothing at all, and nobody notices
// until the work is missing from the board. One sentence, because this
// is prepended to every turn until a ticket is bound.
const NO_ISSUE = 'TeamFlow: no issue is bound — run /teamflow:next '
  + '(the teamflow-next skill) to take the top-priority open ticket and bind it before editing.';

/**
 * The machine has no credential at all (MACLEOD-567).
 *
 * The quietest failure the plugin has. Reporting fails open, so an
 * install nobody signed in on classifies every event, saves every
 * session and posts nothing — for ever, with no error anywhere and a
 * board that simply stays empty. It looks exactly like a working
 * install until somebody goes looking, which is days later.
 *
 * Said on SessionStart only, like the stale-build notice and for the
 * same reason: signing in is a once-per-machine act and a line per turn
 * about it is the noise that teaches a reader to skip the notices.
 */
const NOT_SIGNED_IN = 'TeamFlow: nothing is reaching the board — this machine is not signed in. '
  + 'Run /teamflow:login (the teamflow-login skill) once; there is no key to copy.';

/**
 * The one line about the project, or nothing (MACLEOD-565).
 *
 * Said on SessionStart only, for the same reason the stale-build notice
 * is: a session's repository does not change under it, and a line per
 * turn about something the reader can act on once is noise. An
 * `unknown` answer — the service was not reachable, or nobody is signed
 * in — says nothing at all rather than worrying anybody: reporting is
 * unaffected either way, and the other surfaces name the real problem.
 */
function projectSentence(project) {
  if (!project?.known) return undefined;
  if (project.none) {
    return `TeamFlow: ${NO_PROJECT_SENTENCE}. `
      + 'Reports still land; they just appear under no project.';
  }
  return project.name ? `Project: ${project.name}.` : undefined;
}

// `signedIn` defaults to true so that a caller which cannot answer the
// question says nothing rather than accusing a signed-in machine.
//
// `state` is one actor's, never the session's pooled state (MACLEOD-574).
// It used to be the latter, and the main session was consequently told
// "working on MACLEOD-571" because a team in a worktree had bound that
// ticket under the same `session_id` minutes earlier — its context
// flipped between whichever worktree had bound last. An agent reads its
// own binding and the session reads its own; neither can see the other's.
// The organisation a session's reports go to, the way `publishState` names
// it, so the notice read here is the one the report path wrote.
function sessionSoftRefusal(state) {
  try {
    return readSoftRefusal(state?.binding?.account || state?.account || reportScope(loadConfig(state?.cwd || process.cwd())));
  } catch {
    return undefined;
  }
}

export function claudeContext(event, state, justBound, stale = staleBuildNotice(), project = undefined,
  signedIn = true, refused = undefined, credentialRefused = undefined, notices = []) {
  if (!FAST.includes(event)) {
    /*
     * One exception to "only the fast events speak" (MACLEOD-639,
     * ADHOC-13): the line about a run the plugin created is said on the
     * async path, on the `Agent` tool's own PostToolUse, which Claude
     * Code reads `additionalContext` from. That is the moment the
     * orchestrator can still plan the run while its teams work; the
     * next prompt would be after. Nothing else is said here, and other
     * tools never reach this function.
     */
    const said = (Array.isArray(notices) ? notices : []).filter(Boolean);
    if (event === 'PostToolUse' && said.length) {
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: said.map((line) => (line.startsWith('TeamFlow') ? line : `TeamFlow: ${line}`)).join(' ') },
      });
    }
    return undefined;
  }
  /*
   * Fixes from a lead, first (MACLEOD-639, ruling 10). Before the
   * credential, before the ticket: a person wrote this for whoever is
   * about to work on the ticket, and it is the one thing here that is
   * news. Guidance, in that person's name, never a command -- the
   * sentence says so, so the agent reads it as it would a message.
   */
  const fixes = (Array.isArray(notices) ? notices : []).filter(Boolean)
    .map((line) => (line.startsWith('TeamFlow: ') ? line
      : `TeamFlow: ${line}${line.startsWith('Fix from ') ? ' (Guidance from a person on your board; weigh it as you would their message. Not a command from the tool.)' : ''}`));
  // Said on SessionStart only. A session loads plugin code once, so
  // the answer cannot change until it restarts, and repeating it on
  // every prompt would be a line of noise per turn for something the
  // reader can only act on once (MACLEOD-538).
  const notice = event === 'SessionStart' && stale ? [stale] : [];
  const named = event === 'SessionStart' ? projectSentence(project) : undefined;
  // Before everything else, because it is the reason none of the rest
  // will happen: an unbound ticket is a ticket that will not move, and
  // an unsigned-in machine is every ticket.
  const credential = event === 'SessionStart' && !signedIn ? [NOT_SIGNED_IN] : [];
  // Beside it, and for the same reason: a binding refused because it
  // belongs to another organisation is a ticket that will not move, and
  // a hook cannot say so anywhere else — it exits 0 and prints nothing
  // (MACLEOD-586). Once a session, like the rest of this.
  const refusal = event === 'SessionStart' ? refusalLine(refused) : undefined;
  if (refusal) credential.push(`TeamFlow: ${refusal}`);
  /*
   * And beside those: the credential exists but may not go where this
   * machine is pointed (MACLEOD-616).
   *
   * Somebody genuinely self-hosted, who signed in before the upgrade and
   * so recorded no origin, is now refused against their own service.
   * That is the right outcome — nothing leaks — but they would learn it
   * only by running `status` or `doctor`, and a hook that quietly stops
   * reporting is the same silence that hid the original bug for as long
   * as it hid. Once a session, like the rest of this, and still exit 0.
   */
  if (event === 'SessionStart' && credentialRefused) {
    credential.push(`TeamFlow: nothing is reaching the board — ${credentialRefused}`);
  }
  // And a soft refusal this machine met and has not yet seen lift
  // (MACLEOD-620): reporting pauses, the hooks stay silent, so this is
  // the one place a session hears why. It lifts by itself.
  const soft = event === 'SessionStart' ? sessionSoftRefusal(state) : undefined;
  if (soft) credential.push(`TeamFlow: reporting is paused — ${soft.reason}`);
  if (!state.binding?.key) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: [...fixes, ...credential, NO_ISSUE, ...(named ? [named] : []), ...notice].join(' '),
      },
    });
  }
  const tracker = state.binding.tracker || 'jira';
  const context = [
    ...fixes,
    ...credential,
    `TeamFlow: working on ${tracker} issue ${state.binding.key}.`,
  ];
  // After the ticket, because the ticket is what the work is and the
  // project is only where it will be drawn.
  if (named) context.push(named);
  context.push(
    'Treat the issue as the work definition; continue normal development.',
    'TeamFlow reporting is automatic. Do not manually narrate tool calls for reporting.',
  );
  if (justBound) context.push(`Binding source: ${state.binding.source}.`);
  // Last, because it is about the tooling rather than the work, and
  // the ticket is what the reader needs first.
  context.push(...notice);
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: context.join(' ') },
  });
}

/**
 * Who this actor is, if it is an agent (MACLEOD-574).
 *
 * Three jobs, none of which may throw and all of which are no-ops for a
 * payload that carries none of the fields — an older Claude Code, and
 * every other tool, which go on behaving exactly as they did.
 *
 * 1. In the parent, the `Agent` (formerly `Task`) tool's PreToolUse is
 *    the only place an agent's human-readable name and its one-line
 *    task exist, so they are written to a launch registry beside the
 *    session. Never the prompt, which sits in the same `tool_input`.
 * 2. Its PostToolUse sometimes answers with a line `agentId: <id>` for
 *    a background agent; where it does, that launch is claimed by id.
 * 3. On the agent's own `SubagentStart` the launch is matched — by the
 *    claimed id, else the oldest unmatched launch of the same type —
 *    and the identity is written onto the agent's own state. An agent
 *    nobody named is "Agent" and its type. `SubagentStop` ends it and
 *    keeps its last stage; `last_assistant_message`, which that event
 *    also carries, is model output and is never read.
 *
 * `launched` is what stops a person becoming an agent (audit finding 3).
 * A developer who `cd`s into a second repository, or opens a worktree by
 * hand, gets an actor of their own — two repositories must not overwrite
 * each other's stage, and that half was always right — but in a session
 * that has never launched an `Agent` there is no agent to name, so no
 * `agent` block is written and the row stays the person's own work.
 */
export function withAgentIdentity(event, input, state, sessionId, agentKey, launched = false) {
  const tool = input.tool_name || '';
  if (event === 'PreToolUse' && isAgentTool(tool) && !agentKey) {
    const launch = recordLaunch(sessionId, launchFields(tool, input.tool_input), undefined, state.represented, input.tool_use_id, input.prompt_id);
    // Remembered on the session's own state so a later worktree event
    // can tell "this session runs agents" from "this person opened a
    // second repository", without listing a directory per event.
    return launch ? { ...state, launched: true } : state;
  }
  if (event === 'PostToolUse' && isAgentTool(tool) && !agentKey) {
    // Planned just now because the PreToolUse recorded nothing (MACLEOD-640).
    if (state.represented) recordLaunch(sessionId, launchFields(tool, input.tool_input), undefined, state.represented, input.tool_use_id, input.prompt_id);
    claimLaunch(sessionId, parseAgentId(input.tool_response), input.tool_input?.subagent_type, input.tool_use_id);
    return { ...state, launched: true };
  }
  // An agent launching an agent (MACLEOD-639): recorded like the
  // session's own launches, with the launcher's id, so the nested one
  // is named and carries `parentAgent`.
  if (event === 'PreToolUse' && isAgentTool(tool) && agentKey && state.agent) {
    recordLaunch(sessionId, launchFields(tool, input.tool_input), state.agent.id, state.represented, input.tool_use_id, input.prompt_id);
    return state;
  }
  if (event === 'PostToolUse' && isAgentTool(tool) && agentKey && state.agent) {
    if (state.represented) recordLaunch(sessionId, launchFields(tool, input.tool_input), state.agent.id, state.represented, input.tool_use_id, input.prompt_id);
    claimLaunch(sessionId, parseAgentId(input.tool_response), input.tool_input?.subagent_type, input.tool_use_id);
    return state;
  }
  if (!agentKey) return state;

  const type = typeof input.agent_type === 'string' ? input.agent_type.slice(0, 40) : undefined;
  // An actor is an agent when its tool said so, or when the session it
  // belongs to has launched one. Neither, and this is somebody working
  // in a second repository.
  const isAgentActor = Boolean(input.agent_id || type || state.agent || launched
    || event === 'SubagentStart' || event === 'SubagentStop');
  if (!isAgentActor) return state;
  if (event === 'SubagentStart' || !state.agent) {
    const launch = event === 'SubagentStart' ? matchLaunch(sessionId, input.agent_id, type) : undefined;
    const name = launch?.name || state.agent?.name
      || (type ? `Agent ${type}` : 'Agent');
    state = {
      ...state,
      agent: {
        id: String(input.agent_id || agentKey).slice(0, 80),
        name,
        task: launch?.task || state.agent?.task,
        type: type || launch?.type || state.agent?.type,
        parent: sessionId,
        ...((launch?.launchedBy || state.agent?.parentAgent)
          ? { parentAgent: launch?.launchedBy || state.agent?.parentAgent } : {}),
        // What it was launched for (MACLEOD-722): enums and numbers only.
        ...((launch?.role || state.agent?.role) ? { role: launch?.role || state.agent.role } : {}),
        startedAt: state.agent?.startedAt || new Date().toISOString(),
      },
      // A reviewer of the step its session's ticket stands at (MACLEOD-714).
      ...(launch?.review && launch.under && !state.review
        ? { review: { key: launch.under, step: launch.review, lens: launch.lens || lensOf(stripMark(launch.task), launch.name) } } : {}),
      // The node minted for this agent when it was dispatched
      // (MACLEOD-639, ADHOC-13), for `handleEvent` to bind it to. Local
      // only; the launch file is where it came from.
      // `launchId` is how a node still owed is settled from here, and
      // `under` is the parent's node for a nested agent.
      ...(launch?.key || launch?.id ? {
        dispatch: {
          ...(launch.id ? { launchId: launch.id } : {}),
          ...(launch.key ? { key: launch.key, title: launch.title } : {}),
          // A nested agent is bound to its parent's node the way a
          // top-level one is bound to its own: no node is minted for it.
          ...(!launch.key && launch.launchedBy && launch.under ? { key: launch.under, nested: true } : {}),
        },
      } : {}),
    };
  }
  if (event === 'SubagentStop') {
    // The agent's end ends the actor (MACLEOD-641, audit K3): `ended` as
    // well as `agent.endedAt`, so the session block carries the end time
    // and nothing counts the agent as working any more.
    state = {
      ...state,
      status: 'idle',
      ended: true,
      agent: { ...(state.agent || {}), endedAt: new Date().toISOString() },
    };
  }
  return state;
}

function teamTasksPath(sessionId) {
  return path.join(dataDir(), 'sessions', `${sessionId}.team.json`);
}

/**
 * An agent-team task names what a teammate is for (MACLEOD-722).
 * `TaskCreated` and `TaskCompleted` carry `task_subject` and, when a
 * teammate is involved, `teammate_name`; the subject is read here and
 * only its lean (`reviewer` or `worker`) is kept, under the teammate's
 * name, in a local file the session's next launch of that name reads.
 * Never throws.
 */
export function recordTeamTask(sessionId, input = {}) {
  try {
    const name = typeof input.teammate_name === 'string' ? input.teammate_name.slice(0, 64) : '';
    const lean = name ? teamLeanOf(input.task_subject) : undefined;
    if (!lean) return undefined;
    const file = teamTasksPath(sessionId);
    const held = readJson(file, undefined) || {};
    const names = Object.keys(held);
    // A small map: the oldest names go first.
    if (!(name in held) && names.length >= 50) delete held[names[0]];
    held[name] = lean;
    writeJson(file, held);
    return lean;
  } catch {
    return undefined;
  }
}

/**
 * What the session knows about a launch it is making (MACLEOD-722): the
 * batch it is part of, a `teamflow review start` still waiting for its
 * launch, and whether the step's last round found problems. Local only.
 */
export function roleContext(sessionId, state = {}, cwd = undefined, promptId = undefined) {
  const out = { cwd };
  try {
    const team = readJson(teamTasksPath(sessionId), undefined);
    if (team && typeof team === 'object') out.teamTasks = team;
    // A batch ends at a prompt, and at any agent's end: a launch after
    // results came back is the supervisor's next move, not the same team.
    const ended = sessionActors(sessionId).map((a) => a.agent?.endedAt).filter(Boolean).sort().at(-1);
    const since = [state.promptAt, ended].filter(Boolean).sort().at(-1);
    out.batch = batchSize(launchesOf(sessionId), { promptAt: since, promptId });
    const next = state.reviewNext;
    if (next && Date.now() - Date.parse(next.at) < REVIEW_NEXT_MS) out.reviewNext = next;
    out.afterFindings = afterFindings(sessionId, state.binding?.key, state.stage);
  } catch { /* position decides, as before */ }
  return out;
}

/**
 * One reviewer's life on the card (MACLEOD-714): a slot claimed on its
 * first async event and reported `running`; `teamflow review done` in
 * its own shell states the result exactly; its end reports what its
 * last message says, read here by a local parser and dropped. Only the
 * enum and the counts go out. A stated result wins over the parser.
 * Returns the state to save. Never throws.
 */
export async function trackReview(event, input, state, sessionId, config) {
  try {
    let review = state.review;
    if (review.withdrawn) return state;
    // A "reviewer" that edits files or commits is doing the work
    // (MACLEOD-722): it is moved to worker once, and its slot is
    // withdrawn so the step's result no longer counts it. The withdrawn
    // report's sentence is the one History line.
    if (event === 'PostToolUse' && changesFiles(input, input.cwd)) {
      if (review.n) {
        await reportReview(reviewPayload(review, { result: 'withdrawn' }, state), config);
        settleReview(sessionId, review.key, review.n, 'withdrawn');
      }
      const role = { ...(state.agent?.role || {}), as: 'worker', by: 'moved', moved: true };
      delete role.ask;
      return { ...state, review: { ...review, withdrawn: true, done: true, result: 'withdrawn' }, agent: { ...state.agent, role } };
    }
    if (!review.n) {
      const claimed = claimReview(sessionId, { key: review.key, step: review.step, lens: review.lens, agentId: state.agent?.id });
      if (!claimed) return state;
      review = { ...review, n: claimed.n, round: claimed.round, startedAt: new Date().toISOString() };
      await reportReview(reviewPayload(review, { result: 'running' }, state), config);
    }
    const tool = event === 'PostToolUse' ? input.tool_name : undefined;
    const stated = tool === 'Bash' ? reviewCommandOf(input.tool_input?.command) : undefined;
    // Claude Code's structured findings (MACLEOD-722): stronger than any
    // words, weaker only than `teamflow review done`.
    const reported = tool === 'ReportFindings' && !review.stated ? findingsOf(input.tool_input) : undefined;
    // The words the agent ends on: its hand-back report when it made one
    // (`SubagentHandback`'s `tool_input.message`; its SubagentStop's last
    // message is then only closing text), else that last message.
    const words = tool === 'SubagentHandback' ? input.tool_input?.message
      : event === 'SubagentStop' ? (input.last_assistant_message ?? '') : undefined;
    let verdict;
    if (stated) {
      verdict = { ...stated, stated: true };
      review = { ...review, stated: verdict };
    } else if (reported) {
      verdict = reported;
      review = { ...review, reported: true };
    } else if (words !== undefined && !review.stated && !review.done) {
      const parsed = parseReview(words);
      // An agent that ended while its words still said "running" gave no answer.
      verdict = parsed.result === 'running' ? { result: 'failed' } : parsed;
    }
    if (verdict) {
      await reportReview(reviewPayload(review, verdict, state), config);
      settleReview(sessionId, review.key, review.n, verdict.result);
      review = { ...review, done: true, result: verdict.result };
    }
    return { ...state, review };
  } catch {
    return state;
  }
}

/**
 * Publish the ends `SessionEnd` could not (MACLEOD-574, audit finding 6).
 *
 * `SessionEnd` has 1.5 seconds and may not spend them on the network, so
 * it writes `pendingEnd` and stops. Until something carries that to the
 * service, a session that was killed — crash, `/clear`, kill -9 — leaves
 * its agents standing at `status: running` on the wire and the board
 * counts them for ever.
 *
 * Bounded on purpose: three per turn, so a machine with a backlog of
 * them drains over a few turns rather than making one hook slow. Fails
 * open like everything else here — an actor that cannot be published
 * keeps its flag and is tried again.
 */
export async function flushPendingEnds(config, limit = 3, sessionId = undefined) {
  let scope;
  try { scope = { tenantId: tenantId(config), serviceUrl: serviceUrl(config) }; } catch { return 0; }
  let flushed = 0;
  let everyone;
  for (const actor of pendingEndActors(sessionId, scope)) {
    if (flushed >= limit) break;
    /*
     * An end nobody should hear (MACLEOD-641, audit K4 and K5): a phantom
     * agent that never started, or an end older than a report this
     * machine has since made on the same key. Either one, sent now, puts
     * an old stage back on the card. The debt is cleared, not paid, and
     * costs no request.
     */
    everyone ??= allActors();
    if (isPhantomAgent(actor) || supersededEnd(actor, everyone)) {
      try { saveSession({ ...actor, pendingEnd: false }); } catch { /* next turn */ }
      continue;
    }
    flushed += 1;
    /*
     * Its OWN repository's configuration, never the caller's — and what
     * that is worth changed under this line (MACLEOD-616).
     *
     * `sessions/` is one directory per machine, shared by every
     * repository and every client on it, and `publishState` takes the
     * tenant and the credential from the config it is handed. Flushing
     * with the current event's config therefore posted one client's
     * ticket, stage, summary, repository and branch to another client's
     * service under another client's key — which is the one thing this
     * codebase exists not to do.
     *
     * A repository's own file can no longer carry a `serviceUrl` or an
     * `apiKey`, so `loadConfig(actor.cwd)` now differs from the caller's
     * config only in the project facts — `tenantId` above all. The
     * service and the credential come from the environment, which is the
     * same one for every actor in this process. So the tenant check
     * below still bites, and the serviceUrl check below it only bites
     * across processes; what actually keeps one organisation's end off
     * another's board within a process is the `actor.account` line after
     * them, and that one line is now the whole guard. It is worth
     * knowing that exactly one test stands behind it — "an agent working
     * under another account's credential is not flushed under the
     * caller's" in integration/agents.test.mjs — and that deleting the
     * line reproduces the 0.3.14/0.3.15 leak.
     */
    const own = loadConfig(actor.cwd);
    if (!credentialKind(own)) {
      // Nothing there can report, so the flag is a promise that cannot
      // be kept. Cleared rather than retried on every turn for ever.
      try { saveSession({ ...actor, pendingEnd: false }); } catch { /* next turn */ }
      continue;
    }
    /*
     * And only if that configuration is still the one the actor was
     * written under. A repository whose `.teamflow.json` now names a
     * different tenant is not a repository whose old ends may be posted
     * to the new one: the state is left pending, never rewritten, for
     * whoever can deliver it honestly.
     */
    let ownTenant;
    try { ownTenant = tenantId(own); } catch { continue; }
    if (actor.tenantId && ownTenant !== actor.tenantId) continue;
    if (actor.serviceUrl && serviceUrl(own) !== actor.serviceUrl) continue;
    /*
     * And not under another organisation's credential (MACLEOD-586).
     *
     * The tenant check above cannot see this: the tenant is `default` on
     * every service install, so a pending end written while signed in to
     * A passes it, and posting it now would put A's ticket, stage and
     * summary on whichever board the credential in hand names. Compared
     * only when the state records one — a state written before this
     * version behaves as it did — and left pending rather than cleared,
     * because the organisation it belongs to can still deliver it the
     * next time it does any work on this machine.
     */
    if (actor.account && actor.account !== organisationScope(own)) continue;
    try {
      /*
       * No git, and the actor's own tenant. `skipGit` because a `Stop`
       * hook may not run git against a directory this session has
       * nothing to do with; `keepTenant` because the state already
       * records whose it is and the check above is what earned the
       * right to send it at all.
       */
      await publishState(
        actor,
        own,
        { repository: actor.reportedRepository, branch: actor.reportedBranch ?? actor.git?.branch },
        { force: true, keepTenant: true, skipGit: true },
      );
      saveSession({ ...actor, pendingEnd: false });
    } catch {
      // Left flagged, tried again by the next turn.
    }
  }
  return flushed;
}

/**
 * The launch an `Agent` tool call's PostToolUse is about: by the call's
 * id, else the one it claimed by agent id, else the newest launch by
 * this actor still owed a node. Local files only.
 */
function dispatchedLaunch(sessionId, input, launchedBy) {
  const byId = input.tool_use_id ? findLaunch(sessionId, launchId(input.tool_use_id)) : undefined;
  if (byId) return byId;
  const agentId = parseAgentId(input.tool_response);
  const all = launchesOf(sessionId);
  const claimed = agentId ? all.find((l) => l.agentId === agentId) : undefined;
  if (claimed) return claimed;
  return all.filter((l) => l.pending && !l.key && l.id && (l.launchedBy || undefined) === launchedBy)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
}

// Everything between reading an event and having published it. Returns
// the state it saved and whether the binding is new, so a caller can
// decide what, if anything, to say on stdout.
/**
 * The ask for a card's plain line at dispatch, merge or deploy
 * (MACLEOD-770), or undefined. `keys` is a key or text naming keys. A
 * dispatch starts work, so a line older than it is about earlier work.
 * Local files only; never throws.
 */
export const SAY_LEADS = {
  dispatch: 'You sent an agent to work on it.',
  merge: 'The work is merged.',
  deploy: 'The work is going live.',
};

export async function sayAt(when, keys) {
  try {
    const { keysIn } = await import('./merged.mjs');
    const { noteWork, sayPrompt } = await import('./say.mjs');
    const found = [...keysIn(Array.isArray(keys) ? keys.join(' ') : keys)].slice(0, 3);
    if (!found.length) return undefined;
    if (when === 'dispatch') {
      const at = new Date().toISOString();
      for (const key of found) noteWork(key, at);
    }
    return sayPrompt(found, SAY_LEADS[when]);
  } catch {
    return undefined;
  }
}

export async function handleEvent(input = {}) {
  const event = input.hook_event_name || 'Unknown';
  const sessionId = input.session_id || 'unknown-session';
  const given = input.cwd || process.cwd();
  /*
   * A usage limit (MACLEOD-641). A turn that ends at a rate limit or a
   * billing error is a StopFailure: the session either waits for the
   * reset or a tool such as cc-rotate moves it to another account. Both
   * start with two local files the heartbeat reads; nothing else runs.
   * Any later event means the session carried on here, so it drops the
   * pause, and a prompt the person typed drops the hand-off too.
   */
  if (event === 'StopFailure' || event === 'PreCompact') {
    if (!input.reporter_tool) {
      try { if (event === 'StopFailure') markLimit(sessionId, limitOf(input)); } catch { /* the heartbeat reads it as a crash */ }
      // Where the session was, before the limit or the compaction.
      try { saveSnapshot(sessionId, { config: loadConfig(readJson(sessionPath(sessionId))?.cwd || given) }); } catch { /* the last one stands */ }
    }
    return { state: readJson(sessionPath(sessionId)) ?? newSession(sessionId, given), justBound: false, event, signedIn: true, refused: undefined, notices: [] };
  }
  // An agent-team task (MACLEOD-722): its subject's lean, kept for the
  // teammate it names. A task being created is nothing more to report.
  if (event === 'TaskCreated' || event === 'TaskCompleted') recordTeamTask(sessionId, input);
  if (event === 'TaskCreated') {
    return { state: readJson(sessionPath(sessionId)) ?? newSession(sessionId, given), justBound: false, event, signedIn: true, refused: undefined, notices: [] };
  }
  if (!input.reporter_tool) {
    try {
      if (event === 'SessionEnd') {
        if (rotating()) markHandoff(sessionId);
        else if (DELIBERATE_END.has(input.reason)) clearPause(sessionId, { handoff: true });
      } else if (event !== 'SubagentStop') {
        clearPause(sessionId, { handoff: event === 'UserPromptSubmit' });
      }
    } catch { /* a mark left behind is read as fresh for ten minutes at most */ }
  }
  // The session's own actor, which is also how a worktree is recognised:
  // a repository root that is not this one is somebody else working
  // under the same `session_id` (MACLEOD-574).
  const main = readJson(sessionPath(sessionId));

  // The repository root, never the directory the tool happened to run
  // the hook from: the project id, the binding, `.teamflow.json` and
  // the report's repository and branch are all derived from this one
  // value, and a subdirectory in any of them is a ticket that stops
  // moving. SessionEnd is the exception, and only because its 1.5s
  // budget may not be spent on git: every earlier event in the session
  // resolved the root and saved it, so shutdown reuses that answer and
  // resolves only when there is no session on disk to reuse.
  const cwd = event === 'SessionEnd' && main?.cwd ? main.cwd : repositoryRoot(given);

  /*
   * An actor is (session, agent) — MACLEOD-574.
   *
   * A subagent's events carry the parent's `session_id`, so one state
   * per session meant the main session and every team in every worktree
   * rewrote each other's `cwd`, binding, stage and summary: whoever
   * fired last decided the ticket for everybody, and a team's stage
   * landed on another team's ticket. The key is the `agent_id` where the
   * payload has one, else an agent that has already claimed this
   * directory, else a digest of the directory when it is not the
   * session's own, else nothing at all — which is the main actor, whose
   * file name and behaviour are exactly what they were.
   *
   * A digest and never the directory: the path is an OS username, a
   * client's name and a repository's name, and the first cut of this put
   * all three on the wire through the execution id and `agent.id`.
   */
  const agentKey = resolveActorKey(input, cwd, main, sessionId);
  const saved = agentKey ? readJson(sessionPath(sessionId, agentKey)) : main;
  /*
   * An agent that has just named itself in a directory that was working
   * unnamed (MACLEOD-574, audit blocker A). Two agents that start before
   * either shows a worktree cannot be told apart by directory, so each
   * gets an unnamed actor; the first event carrying an `agent_id` is what
   * finally says which is which, and the work moves across here.
   */
  const absorbed = agentKey && input.agent_id && cwd !== main?.cwd
    ? absorbRootActor(sessionId, agentKey, cwd)
    : undefined;
  /*
   * An end with no agent behind it (MACLEOD-641, audit K4). A
   * `SubagentStop` for an actor this machine never saw start, with no
   * launch claimed under its id, made a new actor at BACKLOG and
   * published that as the ticket's latest word: thousands of zero-length
   * "Agent" files, and 22 cards sent back to Backlog at once. Such an
   * end is dropped here, before anything is written or sent.
   */
  if (event === 'SubagentStop' && agentKey && !saved && !absorbed && !seenLaunch(sessionId, input.agent_id)) {
    return { state: main ?? newSession(sessionId, cwd), justBound: false, event, signedIn: true, refused: undefined, notices: [] };
  }
  // The resolved root travels on the event, so anything reading the
  // event rather than this function's `cwd` sees the same directory.
  const resolved = { ...input, cwd };

  // Names and booleans only, off unless TEAMFLOW_HOOK_TRACE=1, never
  // sent anywhere. It exists to settle one undocumented question about
  // what Claude Code puts on a subagent's events (MACLEOD-573).
  trace(input, { sameRoot: main?.cwd ? cwd === main.cwd : undefined });

  const config = loadConfig(cwd);
  /*
   * The absorbed actor's work, under the named actor's identity. The
   * ticket, the stage, the loop and the rework are what that directory
   * did; the agent block, and the publish bookkeeping, are this actor's.
   */
  const previous = absorbed
    ? {
      ...absorbed,
      ...(saved ?? {}),
      agentKey,
      binding: absorbed.binding ?? saved?.binding,
      stage: absorbed.stage,
      status: absorbed.status,
      summary: absorbed.summary,
      evidence: absorbed.evidence,
      loopCount: absorbed.loopCount,
      rework: absorbed.rework,
      reworkFrom: absorbed.reworkFrom,
      // A new execution id, so the first report under it must go out
      // rather than be deduplicated against the old one's hash.
      lastPublishHash: undefined,
      lastPublishedAt: undefined,
      absorbedInto: undefined,
      pendingEnd: false,
      ended: false,
    }
    : saved ?? newSession(sessionId, cwd, agentKey);
  // What is reporting (MACLEOD-532). `reporter_tool` is set by hook-cli.mjs
  // from `--for`; Claude Code's own entry passes nothing, because its hook is
  // the one this plugin ships and there is no ambiguity about what ran it.
  let state = {
    ...previous,
    sessionId,
    ...(agentKey ? { agentKey } : {}),
    cwd,
    ended: false,
    tenantId: tenantId(config),
    // Which organisation this actor is working for (MACLEOD-586). Local
    // only — no report carries it — and it is what stops a pending end
    // written under one organisation being delivered under another.
    // Always this event's answer, never the saved one: a session that
    // switched organisation must not go on claiming the one it left.
    account: organisationScope(config),
    reporter: reporterInfo(input.reporter_tool),
  };

  // SessionEnd has a 1.5s default lifecycle budget. Keep it local and fast:
  // no git inspection, issue detection or S3 calls during shutdown.
  if (event === 'SessionEnd') {
    // Every actor of the session, not only the one the event names: a
    // session that stopped stopped its teams too, and an agent left
    // `running` is an agent the board counts forever. Still local and
    // still a handful of small writes, so the budget holds.
    const at = new Date().toISOString();
    const ending = sessionActors(sessionId).filter((one) => one.agentKey);
    for (const other of ending) {
      saveSession({
        ...other,
        ended: true,
        status: other.status === 'running' ? 'idle' : other.status,
        agent: other.agent ? { ...other.agent, endedAt: other.agent.endedAt || at } : other.agent,
        // The wire has not been told. It cannot be told here — this
        // event has 1.5s and no budget for a network call — so the end
        // is left for the next publish by anything on this machine to
        // carry (audit finding 6). Without it a killed session's agents
        // stand at `running` for ever and the board counts them.
        pendingEnd: Boolean(other.binding?.key),
        updatedAt: at,
      });
    }
    state.ended = true;
    if (state.status === 'running') state.status = 'idle';
    state.updatedAt = at;
    saveSession(state);
    // The heartbeat sends the last beat itself (MACLEOD-641): this only
    // leaves the mark, because this event may not use the network.
    if (!input.reporter_tool) {
      try { stopHeartbeat(sessionId); } catch { /* the process ends on its own */ }
    }
    return { state, justBound: false, event, signedIn: true, refused: undefined };
  }

  // Whether this machine has anything to report with. Local and cheap —
  // a session file and the configuration, no network — so the fast
  // events can carry the answer without costing the tool anything.
  const signedIn = Boolean(credentialKind(config));

  const beforeKey = state.binding?.key;
  /*
   * A binding made under another organisation does not speak here
   * (MACLEOD-586).
   *
   * The session's own binding is dropped before anything is detected,
   * rather than after: a sticky manual binding outranks every candidate
   * in `chooseBinding`, so leaving it in place would mean this session
   * went on reporting the ticket it was bound to under whichever
   * credential it now holds. With it gone the session falls back to
   * what the repository says about itself — a branch, a prompt — which
   * belongs to whoever is signed in now.
   *
   * Only a manual binding: an inferred one is not somebody's statement
   * about which organisation's work this is, and refusing it would stop
   * ordinary detection on any machine that has seen two organisations.
   */
  const staleOrg = state.binding?.source === 'manual' ? bindingRefusal(state.binding, config) : undefined;
  if (staleOrg) delete state.binding;
  // A converted ad hoc key (MACLEOD-639, ADHOC-15): the session and the
  // binding files follow it to the ticket before anything is detected,
  // so the manual candidate and the session's own agree on the new key.
  followKeyAliases(state, cwd, config);
  const { candidates, info, refused } = detectCandidates(resolved, cwd, state, config);
  state.binding = chooseBinding(state, candidates);
  const justBound = Boolean(state.binding?.key && state.binding.key !== beforeKey);
  state = enrichBinding(state, resolved);

  /*
   * Every plan and every dispatched agent is a node on the board
   * (MACLEOD-639, ADHOC-13). Before the launch is recorded, so the
   * registry says whether the agent is owed a node. The `Agent` tool's
   * PreToolUse is SYNCHRONOUS -- Claude Code holds the dispatch until it
   * exits -- so this half is local: the run is created or joined under a
   * lock and the launch is marked `pending`. The mint and every publish
   * happen in `settle`, on the async events below. Fails open: anything
   * refused is written on the launch as a reason and counted by
   * `teamflow status`, and the hook goes on.
   */
  delete state.represented;
  // Only an actor whose launch `withAgentIdentity` will record: the
  // session itself, or a named agent launching another. An unnamed
  // actor's launch is not recorded, so a node minted for it would be
  // nobody's.
  let dispatching = !agentKey || state.agent ? dispatchOf(event, resolved) : undefined;
  // An `Agent` PostToolUse is a dispatch only when its PreToolUse left no
  // launch for this tool call (MACLEOD-640); a payload with no call id
  // cannot be told from one that did, so it records nothing twice.
  if (dispatching?.kind === 'agent' && event === 'PostToolUse'
      && (!input.tool_use_id || findLaunch(sessionId, launchId(input.tool_use_id)))) {
    dispatching = undefined;
  }
  if (dispatching) {
    // What the launch is for (MACLEOD-722). The Agent tool's input goes
    // in whole so its prompt's opening lines can be scored in memory;
    // only the enum and a number come back out.
    const given = dispatching.kind === 'agent' ? (input.tool_input || {}) : {};
    const shown = planLaunch(config, {
      state, dispatch: dispatching, cwd, info, nested: Boolean(agentKey && state.agent),
      launch: { type: given.subagent_type, description: given.description, prompt: given.prompt, name: given.name },
      session: dispatching.kind === 'agent' && !agentKey ? roleContext(sessionId, state, cwd, input.prompt_id) : {},
    });
    // `teamflow review start` marks one launch, the next.
    if (shown.role && state.reviewNext) delete state.reviewNext;
    if (dispatching.kind === 'agent') state.represented = shown;
    if (shown.notice) state.dispatchNotice = shown.notice;
    // The card's plain line (MACLEOD-770): the session that sends an agent
    // knows what the work gives a person. Keys named in the launch's
    // name, description and opening lines, read in memory only.
    if (dispatching.kind === 'agent') {
      const ask = await sayAt('dispatch', [given.name, given.description, String(given.prompt || '').slice(0, 300)].join(' '));
      if (ask) state.sayNotice = ask;
    }
    // A shell dispatch has no launch to settle; its run is published here,
    // on the async path it already runs on.
    if (dispatching.kind !== 'agent' && shown.run) await settle(config, { sessionId, state, cwd, info, publishRun: true });
  }

  // The batch ends at a prompt (MACLEOD-722): agents launched after the
  // person spoke again are a new team.
  if (event === 'UserPromptSubmit' && !agentKey) state.promptAt = new Date().toISOString();
  // Work, for auto-continue's "nothing changed" guard (MACLEOD-726): an
  // edit, a command or a dispatch. A read is not a change.
  if ((event === 'PostToolUse' || event === 'PostToolUseFailure') && WORK_TOOLS.has(input.tool_name)) {
    state.workAt = new Date().toISOString();
  }
  // `teamflow review start --lens <name>` in the session's own shell: its
  // next launch is a reviewer with that lens.
  if (event === 'PostToolUse' && input.tool_name === 'Bash' && !agentKey) {
    const start = reviewStartOf(input.tool_input?.command);
    if (start) state.reviewNext = { ...start, at: new Date().toISOString() };
  }

  state = withAgentIdentity(event, input, state, sessionId, agentKey, Boolean(main?.launched));

  /*
   * The dispatching actor's half of the settle: the `Agent` tool's own
   * PostToolUse (async). Found by the tool call's id where the payload
   * has one, else the launch this event just claimed, else the newest
   * launch still owed a node.
   */
  if (event === 'PostToolUse' && isAgentTool(input.tool_name || '') && (!agentKey || state.agent)) {
    const launch = dispatchedLaunch(sessionId, input, agentKey ? state.agent?.id : undefined);
    if (launch) await settle(config, { sessionId, launch, state, cwd, info, publishRun: true });
  }

  /*
   * An agent binds to the node minted for it, once, the first time its
   * launch is matched; a session's own key is what an agent with no node
   * and no binding inherits. Both are candidates like any other: the
   * node at manual strength so a prompt naming the parent ticket does
   * not pull the agent off its own node, and a later `work-on` in the
   * worktree still wins because it is newer; the inherited key below a
   * branch name, so anything the agent's own repository says outranks
   * it. A person in a second repository has no `agent` block and is
   * never rebound by this.
   */
  if (agentKey && state.agent) {
    const at = new Date().toISOString();
    /*
     * The agent's half of the settle: a node owed and not yet had. Its
     * SubagentStart, or its first tool event, may come before the
     * dispatcher's PostToolUse -- a foreground agent's comes when it has
     * finished -- so whichever async event is first mints, and the mint
     * record makes sure only one of them does. Never on PreToolUse.
     */
    if (state.dispatch?.launchId && !state.dispatch.key && !state.dispatch.bound && !LOCAL_ONLY.includes(event)) {
      const launch = findLaunch(sessionId, state.dispatch.launchId);
      const got = launch?.pending ? await settle(config, { sessionId, launch, state, cwd, info }) : undefined;
      const known = withMint(sessionId, launch);
      if (got?.key || known?.key) {
        state.dispatch = { ...state.dispatch, key: got?.key || known.key, title: got?.title || known.title };
      }
    }
    if (state.dispatch?.key && !state.dispatch.bound) {
      const own = candidate(state.dispatch.key, 1000, 'dispatch', { tracker: 'teamflow', boundAt: at });
      if (own) {
        state.binding = { ...own, sticky: true };
        state.jira = { ...(state.jira || {}), key: own.key, title: state.dispatch.title };
        state.dispatch = { ...state.dispatch, bound: true };
      }
    } else if (!state.binding?.key && main?.binding?.key && TOOL_EVENTS.includes(event)) {
      // On a tool event only: that is work, and work with no key is what
      // reaches the board under nothing. A start or a prompt is not work
      // yet, and the agent's own prompt usually names its ticket first.
      const inherited = candidate(main.binding.key, 90, 'inherited', { tracker: main.binding.tracker, account: main.binding.account });
      if (inherited) state.binding = { ...inherited, sticky: false };
    }
  }

  // A reviewer's slot and result on the card (MACLEOD-714). Fails open.
  if (agentKey && state.review && !LOCAL_ONLY.includes(event)) state = await trackReview(event, input, state, sessionId, config);
  // The outcome label (MACLEOD-722): did this agent's end count as a
  // review (a pass or findings) or as work. The service keeps it beside
  // the rules' answer and the classifier's.
  if (event === 'SubagentStop' && state.agent?.role?.as) {
    const reviewed = ['pass', 'findings'].includes(state.review?.result);
    state.agent = { ...state.agent, role: { ...state.agent.role, outcome: reviewed ? 'review' : 'work' } };
  }

  const transition = classifyTool(resolved, state, config);
  state = applyTransition(state, transition);
  // A merge or a deploy of this session's work (MACLEOD-770): ask for the
  // card's plain line when it has none, or one older than the work.
  if (!agentKey && transition && transition.status !== 'failed' && ['MERGE', 'DEPLOY_DEV'].includes(transition.stage)) {
    const key = transition.forKey || state.binding?.key;
    const ask = key ? await sayAt(transition.stage === 'MERGE' ? 'merge' : 'deploy', key) : undefined;
    if (ask) state.sayNotice = ask;
  }

  /*
   * The rule goes into the project's own CLAUDE.md (MACLEOD-639, the
   * owner's word: "the TeamFlow plugin should add that to CLAUDE.md
   * too"). `/plugin install` runs nothing, so the first session is the
   * plugin's first chance. Only into a CLAUDE.md the project already
   * keeps, never a new file; only the session itself, never an agent in
   * a worktree, whose commit it would end up in; one file read, and a
   * write only when the block is missing or changed. Fails open.
   */
  if (event === 'SessionStart' && !agentKey && boundToTeamflow(cwd, config, state, info?.repository)
    && !isLinkedWorktree(cwd)) {
    try {
      const { installWorkflowRule } = await import('./hooks.mjs');
      installWorkflowRule({ root: cwd, onlyExisting: true });
    } catch { /* the skills installer and `hooks install` write it too */ }
  }

  if (event === 'SessionStart' && state.binding?.key) {
    state.summary = state.summary || 'Session started';
    state.status = state.status === 'idle' ? 'running' : state.status;
    state.updatedAt = new Date().toISOString();
  }
  if (event === 'Stop' && state.binding?.key && state.status === 'running') {
    state.status = 'idle';
    state.summary = state.summary || 'Claude session idle';
    state.updatedAt = new Date().toISOString();
  }
  /*
   * An ad hoc item ends when the session that owns it stops
   * (MACLEOD-556). An ad hoc item is one request's worth of work, and
   * `Stop` is the event that says that request has been answered, so
   * this is where it ends: the last publish below says so, and the
   * binding is forgotten afterwards.
   *
   * `teamflow adhoc done` has already cleared the binding, so an item
   * the skill finished is not ended twice; what this catches is the
   * session that stops without saying anything, which is the common
   * case and the one that would otherwise leave an item open forever.
   */
  const endingAdHoc = event === 'Stop' && isAdHocKey(state.binding?.key);
  if (endingAdHoc) {
    state.status = 'idle';
    state.summary = 'Ad hoc work ended';
    state.updatedAt = new Date().toISOString();
  }
  saveSession(state);

  // Synchronous SessionStart/UserPromptSubmit must stay fast so they never hold up the tool.
  // Async tool/task/stop hooks publish to the service (or legacy S3).
  if (!LOCAL_ONLY.includes(event) && state.binding?.key) {
    // What TeamFlow told this agent (MACLEOD-726/733), for the card's Progress line.
    const told = cardDirections(sessionId, agentKey, state.workAt);
    if (told.length) state.directions = told;
    await publishState(state, config, info, { force: event === 'Stop' });
    saveSession(state);
    // A repository check's verdict (ADHOC-20), after the issue report so
    // the card exists first. Its own slot, `check-<name>`; the service
    // places it where the organisation put the check. Fails open.
    if (transition?.check) await reportCheck(state.binding.key, transition.check, config);
    // A passing Playwright run's video, onto the ticket (MACLEOD-639), when
    // the organisation's step asks. In the background: an upload never holds
    // the session up, and what happened is said at the next session start.
    if (transition?.check?.name === 'playwright' && transition.check.passed) {
      try {
        const { attachWanted } = await import('./check-presets.mjs');
        const { dataDir } = await import('./core.mjs');
        if (attachWanted({ cwd, stampDir: dataDir() })) {
          const { spawn } = await import('node:child_process');
          const script = new URL('./video-evidence.mjs', import.meta.url).pathname;
          const since = String(Date.now() - 30 * 60 * 1000);
          spawn(process.execPath, [script, state.binding.key, cwd, since],
            { cwd, detached: true, stdio: 'ignore', shell: false }).unref();
        }
      } catch { /* the video stays on the machine */ }
    }
  }

  /*
   * The node minted for an agent closes when the agent ends, or when the
   * agent went to work on another key (MACLEOD-641, audit K1 and K7).
   * After the publish, so the card's last report is the agent's own.
   * Only the agent's own ad hoc node; `closeDispatched` never touches a
   * tracker ticket. Fails open.
   */
  if (agentKey && state.dispatch?.key && !state.dispatch.nested && !LOCAL_ONLY.includes(event)) {
    if (event === 'SubagentStop') {
      const failed = saved?.status === 'failed' || ['LOCAL_REWORK', 'DEV_REWORK'].includes(state.stage);
      await closeDispatched(config, { key: state.dispatch.key, was: state.dispatch.was, outcome: failed ? 'rework' : 'done' });
    } else if (state.dispatch.bound && !state.dispatch.moved && state.binding?.key
      && state.binding.key !== state.dispatch.key) {
      const moved = await closeDispatched(config, {
        key: state.dispatch.key, was: state.dispatch.was, outcome: 'skipped', note: `moved to ${state.binding.key}`, movedTo: state.binding.key,
      });
      if (moved) {
        state.dispatch = { ...state.dispatch, moved: true };
        saveSession(state);
      }
    }
  }

  // Once a turn, on the event that already forces a publish. Anything on
  // this machine flushes anything else's unreported ends, so a session
  // that was killed has its agents taken off the board by the next
  // session that does any work at all.
  // Once per data folder, before the first flush: the phantom agents an
  // older plugin wrote, and the ends they owed (MACLEOD-641, audit K4).
  if (event === 'Stop') purgePhantomAgents();
  if (event === 'Stop' || (absorbed && !LOCAL_ONLY.includes(event))) await flushPendingEnds(config, 3, sessionId);
  // A card minted for an agent whose first publish was lost (MACLEOD-641,
  // tracking gap 3): tried again once a turn, a few at a time.
  if (event === 'Stop' || event === 'SubagentStop') await publishOwed(config, { sessionId, state, cwd, info });
  // An agent sent before the repository was on TeamFlow gets its node now (MACLEOD-761).
  if (event === 'Stop' && !agentKey) await replanUnbound(config, { sessionId, state, cwd, info });
  // The directions auto-continue put on a run (MACLEOD-726): its hook
  // may not wait on the network, so this turn's end sends them.
  if (event === 'Stop' || event === 'SubagentStop') await publishDirections(config);

  /*
   * And a slice of the reconcile pass (MACLEOD-601).
   *
   * AFTER the publish above and never before it. Reconciliation must
   * never sit between a ticket and its own report: this whole module
   * runs inside `failOpen`, which swallows a throw and exits 0, so a
   * bug here would show up as tickets that silently stop advancing —
   * which is the failure mode the ticket exists to remove, not to add
   * a second source of.
   *
   * `reconcileOnHook` never throws and is bounded at two repairs. On
   * `Stop` the hook has already posted a report and already flushed
   * pending ends, so two more posts on the same warm connection is the
   * marginal cost. On `SessionStart` — which is on the fast path, where
   * the tool is waiting — it does no network at all: it closes runs
   * that have gone silent with file writes and posts nothing.
   */
  if (event === 'Stop' || event === 'SessionStart') {
    const { reconcileOnHook } = await import('./reconcile.mjs');
    /*
     * `sessionId` excludes this session's own actors (MACLEOD-601
     * audit, finding 11). A session being resumed has a row whose
     * `updatedAt` is from whenever it last did anything — yesterday,
     * for a `--resume` — so a `SessionStart` would otherwise close the
     * agent that is about to carry on working. It self-heals on the
     * next publish, and a board that flickers an agent to ended every
     * time somebody resumes is still wrong.
     */
    await reconcileOnHook(config, { network: event === 'Stop', sessionId });
  }

  /*
   * Check gates the plugin sets up itself (MACLEOD-639): a Lint column the
   * organisation added gets its command written into this repository's
   * `.teamflow/checks.json`, from the plugin's own table and never from the
   * service. On `Stop`, which may use the network; the main checkout only,
   * like the CLAUDE.md rule above; at most every six hours. Fails open.
   */
  if (event === 'Stop' && !agentKey && boundToTeamflow(cwd, config, state, info?.repository)
    && !isLinkedWorktree(cwd)) {
    const { fetchPipeline, syncPresets } = await import('./check-presets.mjs');
    const { dataDir } = await import('./core.mjs');
    let stampDir;
    try { stampDir = dataDir(); } catch { stampDir = undefined; }
    await syncPresets({
      cwd,
      config,
      stampDir,
      load: async (cfg, _project, timeoutMs) => {
        const project = await resolveProject(info?.repository, cfg, { timeoutMs: 1500 });
        return fetchPipeline(cfg, project?.id, timeoutMs);
      },
    });
  }

  // After the publish, never before: the board's last word on the item
  // is the state above, and forgetting the key first would have
  // published nothing at all. It never reopens -- a new request is a
  // new item -- so the next turn is attributed to whatever it is
  // actually about rather than to finished work.
  if (endingAdHoc) {
    const { clearBinding } = await import('./adhoc.mjs');
    clearBinding(cwd, config);
    delete state.binding;
    state.updatedAt = new Date().toISOString();
    saveSession(state);
  }

  /*
   * What a lead asked this machine to do, and what the plugin did by
   * itself (MACLEOD-639, rulings 4 and 10).
   *
   * On `Stop` -- the async path, where the tool is not waiting -- the
   * round runs: actions are fetched for this machine and performed, the
   * self-healing pass reads the gates and re-runs or resumes, and every
   * network call in both shares ONE budget. What the round has to say
   * waits on the session for the next prompt, because only the fast
   * events can speak to the agent.
   *
   * On `SessionStart` nothing touches the network (spec R-189): the
   * tool is waiting, and a service that has gone quiet would take the
   * credential and binding lines down with it. It prints what is
   * already local -- the fixes held for the key this session just
   * bound, and what the last round found -- and the next `Stop` tells
   * the service. What was done goes on the ticket's next report as
   * outcomes and the plugin's own sentence about each, never the text.
   * Fails open throughout.
   */
  let notices = [];
  if (event === 'Stop') {
    const { intakePass } = await import('./intake.mjs');
    const { budgetUntil, tick } = await import('./selfheal.mjs');
    const budget = budgetUntil(ROUND_BUDGET_MS);
    // A fix is shown at the next prompt, so it is answered then (MACLEOD-726).
    const got = await intakePass(config, { key: state.binding?.key, local: state, later: true, cwd, budget });
    const mine = got.performed.filter((row) => state.binding?.key && row.key === state.binding.key)
      .map(({ key: _key, ...row }) => row);
    if (mine.length) state.actions = [...(state.actions || []), ...mine].slice(-16);
    const healed = await tick(config, { budget }).catch(() => ({ lines: [] }));
    // The organisation's columns, kept fresh for the next prompt's line
    // (MACLEOD-773): at most one read per five minutes, on this async path.
    try {
      const { loadPipeline } = await import('./columns.mjs');
      const project = (await resolveProject(info?.repository, config, { timeoutMs: 1500 }))?.id;
      await loadPipeline(config, { project, timeoutMs: 1500 });
    } catch { /* the kept copy stands */ }
    const heard = [...got.notices, ...healed.lines];
    if (heard.length) state.intakePending = [...(state.intakePending || []), ...heard].slice(-8);
    if (got.later?.length) state.intakeFixes = [...(state.intakeFixes || []), ...got.later].slice(-8);
    if (mine.length || heard.length || got.later?.length) saveSession(state);
  }
  if (event === 'SessionStart') {
    const local = await sessionStartLines(config, state);
    if (local.performed.length) state.actions = [...(state.actions || []), ...local.performed].slice(-16);
    notices = local.notices;
    if (local.performed.length) saveSession(state);
    // The organisation's check columns (MACLEOD-639): the command that
    // counts and its note, in its own words, read from the cache the last
    // `Stop` sync wrote. File reads only: this is the fast path.
    try {
      const { columnLines } = await import('./check-presets.mjs');
      const { dataDir } = await import('./core.mjs');
      notices = [...notices, ...columnLines({ cwd, stampDir: dataDir() })];
      const { takeNotices } = await import('./video-evidence.mjs');
      notices = [...notices, ...takeNotices(dataDir())];
    } catch { /* nothing to say is said */ }
  }
  // Other sessions on this card or in this folder (MACLEOD-641): told,
  // never blocked. Local files only; the heartbeat keeps the service's word.
  if (FAST.includes(event) && !input.reporter_tool) {
    try { notices = [...notices, ...sessionLines(sessionId, cwd)]; } catch { /* nothing to say */ }
    // Where each running agent's work is, by the board's column names
    // (MACLEOD-773), so the model can say without asking. Kept copies only.
    try {
      const { contextLine } = await import('./columns.mjs');
      const line = contextLine(config, sessionId, { repository: info?.repository });
      if (line) notices = [...notices, line];
    } catch { /* nothing to say */ }
  }
  if (FAST.includes(event) && state.intakePending?.length) {
    notices = [...state.intakePending, ...notices];
    delete state.intakePending;
    saveSession(state);
  }
  /*
   * The fixes a round kept for this prompt (MACLEOD-726). Checked once
   * more against this session's own last result: a fix whose step has
   * passed since it was queued is dropped, never shown, and the service
   * is told it was not needed. The rest are shown once, first.
   */
  if (FAST.includes(event) && state.intakeFixes?.length) {
    const { showHeld } = await import('./intake.mjs');
    const shown = await showHeld(config, state.intakeFixes, state);
    const mine = shown.performed.filter((row) => row.key === state.binding?.key).map(({ key: _key, ...row }) => row);
    if (mine.length) state.actions = [...(state.actions || []), ...mine].slice(-16);
    notices = [...shown.notices, ...notices];
    delete state.intakeFixes;
    saveSession(state);
  }
  /*
   * The line about a run the plugin created (MACLEOD-639, ADHOC-13),
   * said once: on the dispatching tool's PostToolUse or the next prompt,
   * whichever comes first. Written on the dispatching event above and
   * carried here on the session's own state.
   */
  if (state.dispatchNotice && (event === 'PostToolUse' || FAST.includes(event))) {
    notices = [...notices, state.dispatchNotice];
    delete state.dispatchNotice;
    saveSession(state);
  }
  // The ask for a card's plain line (MACLEOD-770), said the same way; and
  // on a prompt, the merges the background pass saw since the last one.
  if (!agentKey && FAST.includes(event) && !input.reporter_tool) {
    try {
      const { takeOwed } = await import('./say.mjs');
      const owed = takeOwed();
      if (owed && owed !== state.sayNotice) notices = [...notices, owed];
    } catch { /* nothing to say is said */ }
  }
  if (state.sayNotice && (event === 'PostToolUse' || FAST.includes(event))) {
    notices = [...notices, state.sayNotice];
    delete state.sayNotice;
    saveSession(state);
  }

  // Asked once a session, and only on the event that is allowed to say
  // it. The cache in project.mjs means at most one request per five
  // minutes per organisation, and the timeout is far tighter than the
  // CLI's because a tool is waiting on this event: a service that does
  // not answer in a second and a half is answered as "unknown", which
  // prints nothing and costs the session nothing.
  const project = event === 'SessionStart'
    ? await resolveProject(info?.repository, config, { timeoutMs: 1500 })
    : undefined;

  /*
   * The live heartbeat (MACLEOD-641): one background process per Claude
   * Code session, started here and re-checked on every other event. The
   * check is a small read and a `kill(pid, 0)`. Claude Code only: a
   * repository hook's parent exits at once. Last, after the state above
   * is saved, so a resumed session is no longer marked ended when the
   * process first looks.
   */
  let started;
  if (!input.reporter_tool) {
    try { started = ensureHeartbeat(sessionId, { event, source: input.source, cwd }); } catch { /* no heartbeat this event */ }
  }

  /*
   * Where the session was (MACLEOD-641): saved when a turn or an agent
   * ends, and read back once when a session resumes, is compacted, or
   * carries on another after a hand-off. Local files only.
   */
  if (!input.reporter_tool) {
    try {
      if (event === 'Stop' || event === 'SubagentStop') saveSnapshot(sessionId, { config });
      if (event === 'SessionStart') {
        pruneSnapshots();
        const block = resumeNotice(state, { source: input.source, continues: started?.continues });
        if (block) {
          notices = [...(notices || []), block];
          saveSession(state);
        }
      }
    } catch { /* nothing to say is said */ }
  }

  return {
    state,
    justBound,
    event,
    project,
    notices,
    signedIn,
    refused: staleOrg || refused,
    // Local and cheap, like `signedIn` beside it: a session file and the
    // configuration, no network (MACLEOD-616).
    credentialRefused: credentialRefusal(config),
  };
}

/** What one `Stop` round may spend on the network, all calls together. */
export const ROUND_BUDGET_MS = 5000;

/**
 * What a session start says, from this machine alone (MACLEOD-639):
 * the fixes held for the key it just bound, then the plugin's own
 * self-healing state from the last round -- a gate it re-ran or gave up
 * on, a run it resumed -- in its own words. No network call is made:
 * nothing here can take longer than a file read. Never another member's
 * request, never a command for the reader to run. Nothing to say
 * prints nothing.
 */
export async function sessionStartLines(config, state = {}, { now = Date.now() } = {}) {
  try {
    const { intakeLocal } = await import('./intake.mjs');
    const { lastPassLines } = await import('./selfheal.mjs');
    const held = await intakeLocal(config, { key: state.binding?.key, local: state, now: new Date(now).toISOString() });
    return {
      notices: [...held.notices, ...lastPassLines({ now })],
      performed: held.performed.map(({ key: _key, ...row }) => row),
    };
  } catch {
    return { notices: [], performed: [] };
  }
}

/**
 * The plugin's own self-healing lines for a session start (WS-H). Kept
 * under this name for its tests; it reads what the last round left and
 * never the network.
 */
export async function selfhealLines(config, { now = Date.now() } = {}) {
  const { notices } = await sessionStartLines(config, {}, { now });
  return notices;
}

// Every hook entry runs inside this. Reporting must never break the
// tool or the developer's workflow, so nothing here can exit non-zero
// and nothing can throw past it.
/**
 * Send one check verdict (ADHOC-20). Never throws: a verdict that does not
 * arrive is a card that says the check has not run, never a broken hook.
 */
export async function reportCheck(key, check, config) {
  try {
    const { checkPayload } = await import('./checks.mjs');
    const core = await import('./core.mjs');
    const document = { ...checkPayload(key, check.name, check.passed, { evidence: check.evidence || [] }), tenantId: tenantId(config) };
    return core.transportOf(config) === 'service'
      ? await core.sendReport('runtime', document.slot, document, config, { account: reportScope(config) })
      : await core.putReport(core.tenantPath(config, `runtime/${key}/${document.slot}.json`), document, config);
  } catch {
    return undefined;
  }
}

export async function failOpen(fn) {
  try {
    await fn();
  } catch (error) {
    try {
      process.stderr.write(`TeamFlow reporter ignored error: ${error instanceof Error ? error.message : String(error)}\n`);
    } catch {}
  }
  process.exit(0);
}

// Malformed JSON throws, and failOpen turns that into a silent exit 0.
// Nothing is reported from an event that could not be read, which is
// the right answer: a guess would move somebody's ticket.
export async function readStdin(stream = process.stdin) {
  let text = '';
  for await (const chunk of stream) text += chunk;
  return text.trim() ? JSON.parse(text) : {};
}
