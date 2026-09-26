// Answering an agent from TeamFlow (MACLEOD-848).
//
// The owner's ruling: "Treat this as a remote control session. Only the
// dev can make those choices." So this is as narrow as Claude's Remote
// Control. The session's own developer, signed in to TeamFlow, answers
// what the agent waits on, and nothing else:
//
// - `choice`: one of the options the agent offered (AskUserQuestion), or
//   free words where Claude Code allows them ("Other"), at most 500.
// - `permission`: allow or deny.
// - `question`: the turn ended with a question. Free words, or continue.
//
// Four switches, all off by default: the organisation's agent view, its
// two-way option (owners and admins), this person's `teamflow agent-view
// on` and this machine's `teamflow two-way on`. Without the last one no
// question carries an `askId`, so nothing here can be answered.
//
// How an answer reaches Claude. Claude Code takes a hook's decision only
// from that hook's own output (hooks reference, "PermissionRequest
// decision control": "Only the decision object can grant or deny the
// request"). A background process cannot answer a dialog that is on the
// screen. So:
//
// - a choice or a permission: `answer-hook.mjs` runs as a synchronous
//   PreToolUse (AskUserQuestion) and PermissionRequest hook. While this
//   machine's switch is on, it waits up to `waitSeconds` (30 by default)
//   for an answer and returns it as Claude Code's own decision:
//   `updatedInput.answers` for a choice, `decision.behavior` for a
//   permission. Then it stops waiting, tells the service so, and Claude
//   Code asks in the terminal as always. A later answer is refused.
// - an open question: the Stop watcher (checkin.mjs) looks for an answer
//   and wakes the session with asyncRewake, exit 2, and a fixed sentence.
//
// What is sent to Claude is always one of the fixed sentences below, with
// the option's label from this machine's own copy of the question, or the
// developer's words. Nothing received is ever passed to a shell or run.
import * as core from './core.mjs';

export const WAIT_DEFAULT_S = 30;
export const WAIT_MAX_S = 300;
export const POLL_MS = 2000;
export const OTHER_MAX = 500;
const ASK_ID = /^ask_[0-9a-f]{16,40}$/;

// --- the machine's switch -------------------------------------------------

/** `{ on, waitSeconds }` from the user's own config. Off by default. */
export function twoWaySwitch() {
  const held = core.readJson(core.globalConfigPath(), {})?.twoWay;
  const wait = Number(held?.waitSeconds);
  return {
    on: held?.on === true,
    waitSeconds: Number.isFinite(wait) ? Math.max(0, Math.min(WAIT_MAX_S, Math.round(wait))) : WAIT_DEFAULT_S,
  };
}

export function setTwoWay(value, { waitSeconds } = {}) {
  if (value !== 'on' && value !== 'off') throw new Error('Usage: teamflow two-way on|off|status [--wait <seconds>]');
  const file = core.globalConfigPath();
  const next = { ...(core.readJson(file, {}) || {}) };
  const was = twoWaySwitch();
  const wait = waitSeconds === undefined ? was.waitSeconds : Math.max(0, Math.min(WAIT_MAX_S, Math.round(Number(waitSeconds) || 0)));
  next.twoWay = value === 'on' ? { on: true, waitSeconds: wait } : { on: false, waitSeconds: wait };
  core.writeJson(file, next);
  return twoWaySwitch();
}

/** The `teamflow two-way status` line. */
export function twoWayLine(held = twoWaySwitch()) {
  if (!held.on) return 'off (the default). Your agents take answers only in Claude Code.';
  return `on. You can answer your agents from TeamFlow. Claude Code waits up to ${held.waitSeconds} seconds for an answer from TeamFlow, then asks here.`;
}

// --- the question's id -----------------------------------------------------

const stable = (value) => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
};

/**
 * The id of the question this event asks, the same in every hook process
 * that sees the event: the stream line and the waiting hook must agree
 * without talking to each other. Undefined for any other event.
 */
export function askIdOf(input = {}, held = undefined) {
  const session = String(input.session_id || '');
  if (!session) return undefined;
  const event = input.hook_event_name;
  let seed;
  if (event === 'PreToolUse' && input.tool_name === 'AskUserQuestion') seed = `choice|${input.tool_use_id || stable(input.tool_input)}`;
  else if (event === 'PermissionRequest') seed = `permission|${input.prompt_id || ''}|${input.tool_name || ''}|${stable(input.tool_input)}`;
  else if (event === 'Notification' && held?.kind === 'question' && held.at) seed = `question|${held.at}`;
  else return undefined;
  return `ask_${core.digest(`${session}|${seed}`, 24)}`;
}

export const validAskId = (id) => typeof id === 'string' && ASK_ID.test(id);

// --- what Claude is told -----------------------------------------------------

const oneLine = (text, max) => String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The option labels of an AskUserQuestion's only question. */
export function optionsOf(input = {}) {
  const questions = Array.isArray(input.tool_input?.questions) ? input.tool_input.questions : [];
  if (questions.length !== 1) return undefined;
  const q = questions[0];
  return {
    question: String(q?.question ?? ''),
    labels: (Array.isArray(q?.options) ? q.options : []).map((o) => String(typeof o === 'string' ? o : o?.label ?? '')),
  };
}

/** The fixed sentence for an answer. Undefined when the answer does not fit the question. */
export function answerSentence(answer = {}, { labels = [] } = {}) {
  if (Number.isInteger(answer.choice)) {
    const label = labels[answer.choice];
    if (label === undefined) return undefined;
    return `Your developer answered in TeamFlow: option ${answer.choice + 1}, ${oneLine(label, 200)}.`;
  }
  if (typeof answer.other === 'string' && oneLine(answer.other, OTHER_MAX)) {
    return `Your developer answered in TeamFlow: ${oneLine(answer.other, OTHER_MAX)}`;
  }
  if (answer.resume === true) return 'Your developer said continue.';
  return undefined;
}

/**
 * Claude Code's own hook output for an answer to the event that is
 * waiting, or undefined when the answer does not fit it. Never a shell
 * command: a label, a boolean, or the developer's words as a value.
 */
export function decisionFor(answer = {}, input = {}) {
  const event = input.hook_event_name;
  if (event === 'PermissionRequest' && answer.kind === 'permission' && typeof answer.approve === 'boolean') {
    const decision = answer.approve
      ? { behavior: 'allow' }
      : { behavior: 'deny', message: 'Your developer said no in TeamFlow.' };
    return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
  }
  if (event === 'PreToolUse' && input.tool_name === 'AskUserQuestion' && answer.kind === 'choice') {
    const asked = optionsOf(input);
    if (!asked) return undefined;
    let value;
    if (Number.isInteger(answer.choice)) value = asked.labels[answer.choice];
    else if (typeof answer.other === 'string') value = oneLine(answer.other, OTHER_MAX) || undefined;
    if (value === undefined) return undefined;
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: 'Your developer answered in TeamFlow.',
        updatedInput: { ...input.tool_input, answers: { [asked.question]: value } },
      },
    };
  }
  return undefined;
}

// --- the service -----------------------------------------------------------------

/** `GET /v1/members/answers?for=&session=&ask=[&close=1]`. Every failure is an empty list. */
export async function fetchAnswers(config = {}, session, askId, { close = false, timeoutMs = 4000, fetchImpl = fetch } = {}) {
  const machine = core.machineId();
  const cred = await core.credential(config);
  if (!machine || !cred || !session || !validAskId(askId)) return [];
  const query = `for=${encodeURIComponent(machine)}&session=${encodeURIComponent(session)}&ask=${encodeURIComponent(askId)}${close ? '&close=1' : ''}`;
  try {
    const response = await fetchImpl(`${core.serviceUrl(config)}/v1/members/answers?${query}`, {
      headers: { [cred.header]: cred.value }, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    if (!response.ok) return [];
    const body = await response.json().catch(() => ({}));
    return (Array.isArray(body?.answers) ? body.answers : []).filter((a) => a && a.askId === askId && typeof a.id === 'string');
  } catch {
    return [];
  }
}

/** `POST /v1/members/answers/{id}/outcome {session, outcome}`. */
export async function answerOutcome(config = {}, session, id, outcome, { timeoutMs = 4000, fetchImpl = fetch } = {}) {
  const cred = await core.credential(config);
  if (!cred) return false;
  try {
    const response = await fetchImpl(`${core.serviceUrl(config)}/v1/members/answers/${encodeURIComponent(id)}/outcome`, {
      method: 'POST',
      headers: { [cred.header]: cred.value, 'content-type': 'application/json' },
      body: JSON.stringify({ session, outcome }),
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export const streamSessionOf = (sessionId) => core.sessionBlock({ sessionId })?.id;

// --- the waiting hook -------------------------------------------------------------

/**
 * Wait for the developer's answer to the question this event asks, up to
 * this machine's `waitSeconds`. Returns Claude Code's hook output, or
 * undefined: the switch is off, nothing came, or it did not fit. Whatever
 * came is marked done or expired on the service.
 */
export async function waitForAnswer(input = {}, {
  config, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchImpl = fetch, held = twoWaySwitch(), personOn,
} = {}) {
  if (!held.on || held.waitSeconds <= 0) return undefined;
  if (input.reporter_tool) return undefined;              // Claude Code only
  const agentViewOn = personOn ?? (await import('./agent-view.mjs')).personSwitch().on;
  if (!agentViewOn) return undefined;
  const askId = askIdOf(input);
  const session = streamSessionOf(input.session_id);
  if (!askId || !session) return undefined;
  const cfg = config || core.loadConfig(input.cwd || process.cwd());
  const end = now() + held.waitSeconds * 1000;
  for (;;) {
    const last = now() + POLL_MS >= end;
    const got = await fetchAnswers(cfg, session, askId, { close: last, fetchImpl });
    for (const answer of got) {
      const output = decisionFor(answer, input);
      await answerOutcome(cfg, session, answer.id, output ? 'done' : 'expired', { fetchImpl });
      if (output) return output;
    }
    if (last) return undefined;
    await sleep(POLL_MS);
  }
}

// --- the open question, for the Stop watcher -----------------------------------------

/**
 * The wake words for an answer to the open question this session waits
 * on, or undefined. Only while this machine's switch is on.
 */
export async function questionAnswer(sessionId, { config, fetchImpl = fetch, held = twoWaySwitch(), asking } = {}) {
  if (!held.on) return undefined;
  const mark = asking ?? (await import('./asking.mjs')).askingOf(sessionId);
  if (mark?.kind !== 'question' || !validAskId(mark.askId)) return undefined;
  const session = streamSessionOf(sessionId);
  const cfg = config || core.loadConfig(core.readJson(core.sessionPath(sessionId))?.cwd || process.cwd());
  for (const answer of await fetchAnswers(cfg, session, mark.askId, { fetchImpl })) {
    const words = answer.kind === 'question' ? answerSentence(answer) : undefined;
    await answerOutcome(cfg, session, answer.id, words ? 'done' : 'expired', { fetchImpl });
    if (words) {
      // Answered: the session no longer waits on it.
      (await import('./asking.mjs')).clearAsking(sessionId);
      return words;
    }
  }
  return undefined;
}
