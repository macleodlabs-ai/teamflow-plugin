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

import {
  absorbRootActor,
  resolveActorKey,
  applyTransition,
  bindingRefusal,
  chooseBinding,
  claimLaunch,
  classifyTool,
  credentialKind,
  credentialRefusal,
  detectCandidates,
  enrichBinding,
  isAdHocKey,
  isAgentTool,
  loadConfig,
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

// Events that must stay synchronous and fast, because the tool is
// waiting on them before it shows the developer anything.
const FAST = ['SessionStart', 'UserPromptSubmit'];

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
  signedIn = true, refused = undefined, credentialRefused = undefined) {
  if (!FAST.includes(event)) return undefined;
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
        additionalContext: [...credential, NO_ISSUE, ...(named ? [named] : []), ...notice].join(' '),
      },
    });
  }
  const tracker = state.binding.tracker || 'jira';
  const context = [
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
    const launch = recordLaunch(sessionId, input.tool_input || {});
    // Remembered on the session's own state so a later worktree event
    // can tell "this session runs agents" from "this person opened a
    // second repository", without listing a directory per event.
    return launch ? { ...state, launched: true } : state;
  }
  if (event === 'PostToolUse' && isAgentTool(tool) && !agentKey) {
    claimLaunch(sessionId, parseAgentId(input.tool_response), input.tool_input?.subagent_type);
    return { ...state, launched: true };
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
        startedAt: state.agent?.startedAt || new Date().toISOString(),
      },
    };
  }
  if (event === 'SubagentStop') {
    state = {
      ...state,
      status: 'idle',
      agent: { ...(state.agent || {}), endedAt: new Date().toISOString() },
    };
  }
  return state;
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
  for (const actor of pendingEndActors(sessionId, scope)) {
    if (flushed >= limit) break;
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

// Everything between reading an event and having published it. Returns
// the state it saved and whether the binding is new, so a caller can
// decide what, if anything, to say on stdout.
export async function handleEvent(input = {}) {
  const event = input.hook_event_name || 'Unknown';
  const sessionId = input.session_id || 'unknown-session';
  const given = input.cwd || process.cwd();
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
  const { candidates, info, refused } = detectCandidates(resolved, cwd, state, config);
  state.binding = chooseBinding(state, candidates);
  const justBound = Boolean(state.binding?.key && state.binding.key !== beforeKey);
  state = enrichBinding(state, resolved);

  state = withAgentIdentity(event, input, state, sessionId, agentKey, Boolean(main?.launched));

  const transition = classifyTool(resolved, state, config);
  state = applyTransition(state, transition);

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
  if (!FAST.includes(event) && state.binding?.key) {
    await publishState(state, config, info, { force: event === 'Stop' });
    saveSession(state);
  }

  // Once a turn, on the event that already forces a publish. Anything on
  // this machine flushes anything else's unreported ends, so a session
  // that was killed has its agents taken off the board by the next
  // session that does any work at all.
  if (event === 'Stop' || absorbed) await flushPendingEnds(config, 3, sessionId);

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

  // Asked once a session, and only on the event that is allowed to say
  // it. The cache in project.mjs means at most one request per five
  // minutes per organisation, and the timeout is far tighter than the
  // CLI's because a tool is waiting on this event: a service that does
  // not answer in a second and a half is answered as "unknown", which
  // prints nothing and costs the session nothing.
  const project = event === 'SessionStart'
    ? await resolveProject(info?.repository, config, { timeoutMs: 1500 })
    : undefined;

  return {
    state,
    justBound,
    event,
    project,
    signedIn,
    refused: staleOrg || refused,
    // Local and cheap, like `signedIn` beside it: a session file and the
    // configuration, no network (MACLEOD-616).
    credentialRefused: credentialRefusal(config),
  };
}

// Every hook entry runs inside this. Reporting must never break the
// tool or the developer's workflow, so nothing here can exit non-zero
// and nothing can throw past it.
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
