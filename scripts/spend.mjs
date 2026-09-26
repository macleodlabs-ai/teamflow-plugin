/*
 * Spend per session and ticket (MACLEOD-882).
 *
 * What the model used, as numbers: input, output, cache read and cache
 * write tokens, an estimated USD cost, and the model id. A report for
 * leads, never billing; credits stay the service's own abuse meter.
 *
 * The source is Claude Code's own session transcript, which every hook is
 * handed as `transcript_path`. Each assistant line carries the API's
 * `message.usage` object (`input_tokens`, `output_tokens`,
 * `cache_read_input_tokens`, `cache_creation_input_tokens`), the
 * `message.model` and the tool's `version`. That usage object is the public
 * Messages API shape, so it is the least fragile field in the file, and the
 * transcript is there on every Stop whether or not the person set up a
 * statusline. The statusline's input names a model and a session cost, but
 * only when a statusline command chains `teamflow statusline-tap`, and it
 * says nothing per ticket.
 *
 * Only numbers, a model id and a version leave this file. The line's
 * content, its prompt and its tool calls are never read into anything here.
 */
import * as core from './core.mjs';
import { readNew, transcriptFiles } from './agent-view.mjs';

/*
 * USD per million tokens. Anthropic's list prices on 2026-09-26: cache
 * write is the five-minute write, 1.25 times input; cache read is 0.1 times
 * input unless the price list says otherwise. First matching prefix wins,
 * so the longer ids come first. A model not in the table is counted in
 * tokens and gets no cost; nothing is guessed.
 */
export const PRICES_AT = '2026-09-26';
export const PRICES = [
  ['claude-fable-5-1', { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 }],
  ['claude-fable-5', { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 }],
  ['claude-mythos-5', { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 }],
  ['claude-opus-5-5', { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 }],
  ['claude-opus-5', { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }],
  ['claude-opus-4-8', { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }],
  ['claude-opus-4-7', { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }],
  ['claude-opus-4-6', { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 }],
  ['claude-sonnet-5', { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }],
  ['claude-sonnet-4-6', { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 }],
  ['claude-haiku-4-5', { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 }],
];

const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,63}$/;
const VERSION = /^\d+(\.\d+){0,3}$/;
const SEEN_MAX = 64;

/** A model id as the service takes it, or undefined. `claude-opus-4-8[1m]` stays as it is. */
export function modelId(value) {
  const text = String(value || '').trim();
  return MODEL.test(text) && text !== '<synthetic>' ? text : undefined;
}

/** The price row for a model id, or undefined. `us.anthropic.` and `anthropic.` prefixes are stepped over. */
export function priceOf(model) {
  const id = String(model || '').toLowerCase().replace(/^(us\.|eu\.|global\.)?anthropic\./, '');
  return PRICES.find(([prefix]) => id.startsWith(prefix))?.[1];
}

/** USD for one usage, or undefined when the model has no price. */
export function costOf(model, usage) {
  const price = priceOf(model);
  if (!price) return undefined;
  return (usage.input * price.input + usage.output * price.output
    + usage.cacheWrite * price.cacheWrite + usage.cacheRead * price.cacheRead) / 1e6;
}

const whole = (n) => (Number.isFinite(Number(n)) && Number(n) > 0 ? Math.round(Number(n)) : 0);

/** One transcript line's usage, or undefined. Numbers, the message id, the model and the tool's version only. */
export function usageOf(entry) {
  const message = entry?.message;
  const usage = message?.usage;
  if (entry?.type !== 'assistant' || !usage || typeof usage !== 'object') return undefined;
  const model = modelId(message.model);
  if (!model) return undefined;
  return {
    id: String(message.id || entry.requestId || entry.uuid || '').slice(0, 120),
    model,
    version: VERSION.test(String(entry.version || '')) ? String(entry.version) : undefined,
    input: whole(usage.input_tokens),
    output: whole(usage.output_tokens),
    cacheRead: whole(usage.cache_read_input_tokens),
    cacheWrite: whole(usage.cache_creation_input_tokens),
  };
}

/**
 * New usage in `entries`, one per message. Claude Code writes a line per
 * content block, each repeating the message's usage, so the last line of a
 * message is the one counted, and a message counted on an earlier read is
 * not counted again.
 */
export function newUsage(entries, seen = []) {
  const byId = new Map();
  for (const entry of entries) {
    const one = usageOf(entry);
    if (one && !seen.includes(one.id)) byId.set(one.id || `line-${byId.size}`, one);
  }
  return [...byId.values()];
}

/** Totals plus one usage. `usd` stays absent until a priced model is seen. */
export function add(total = {}, one) {
  const out = {
    input: (total.input || 0) + one.input,
    output: (total.output || 0) + one.output,
    cacheRead: (total.cacheRead || 0) + one.cacheRead,
    cacheWrite: (total.cacheWrite || 0) + one.cacheWrite,
  };
  const usd = costOf(one.model, one);
  if (total.usd !== undefined || usd !== undefined) out.usd = Math.round(((total.usd || 0) + (usd || 0)) * 1e6) / 1e6;
  return out;
}

/** Which transcript file this actor's event names: the session's own on Stop, the agent's on SubagentStop. */
export function actorFile(event, input = {}, sessionId = undefined) {
  if (event === 'SubagentStop') {
    if (input.agent_transcript_path) return String(input.agent_transcript_path);
    const files = transcriptFiles(sessionId, input.transcript_path);
    const mine = String(input.agent_id || '').slice(0, 80);
    return mine ? files.find((f) => f.agent === mine)?.file : undefined;
  }
  return event === 'Stop' ? transcriptFiles(sessionId, input.transcript_path)[0]?.file : undefined;
}

/**
 * Reads what is new in this actor's transcript and adds it to the ticket
 * the actor is bound to now. Mutates and returns `state.spend`:
 * `{ read: {<file digest>: offset}, seen[], keys: {<KEY>: totals}, model, claudeVersion }`.
 * Kept on the actor's own state file, never sent whole.
 */
export function tally(state, event, input = {}) {
  const key = state?.binding?.key;
  const file = actorFile(event, input, state?.sessionId || input.session_id);
  if (!key || !file) return state?.spend;
  const spend = (state.spend ||= { read: {}, seen: [], keys: {} });
  const mark = core.digest(file);
  const at = { offset: spend.read[mark] || 0 };
  const found = newUsage(readNew(file, at), spend.seen);
  spend.read[mark] = at.offset;
  for (const one of found) {
    spend.keys[key] = add(spend.keys[key], one);
    spend.model = one.model;
    if (one.version) spend.claudeVersion = one.version;
    if (one.id) spend.seen.push(one.id);
  }
  spend.seen = spend.seen.slice(-SEEN_MAX);
  return spend;
}

// The block a report carries is `spendBlock` in core.mjs, beside `issuePayload`.
