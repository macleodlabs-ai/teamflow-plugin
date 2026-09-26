#!/usr/bin/env node
// Agent view (MACLEOD-793, docs/AGENT_VIEW.md): what every agent on this
// machine says and does, read from Claude Code's own transcripts and sent
// to the ticket the agent is bound to, so a lead can read it beside the
// card. The one opt-in exception to "derived facts only"
// (docs/REPORTING_CONTRACT.md, "Agent view").
//
// Two switches, both needed:
// - the person's, `teamflow agent-view on|off`, in the user's own config
//   (a repository cannot turn it on);
// - the organisation's, read from the settings route and from the
//   service's last refusal. Nothing is sent while it is unknown.
//
// The hook only starts this file as a detached background process
// (`kick`); reading, compressing and sending happen here, never on the
// hook's path. Every line passes `cleanLine` (redact.mjs) first: code
// blocks are folded to "[code, N lines]" and secrets to "[redacted]".
// A tool is its name, a one-line summary of its input and whether it
// worked; never its output, never file contents, never a diff.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as core from './core.mjs';
import { cleanLine, redactSecrets } from './redact.mjs';
import { askLines } from './asking.mjs';
import { twoWaySwitch } from './two-way.mjs';

const SCRIPT = fileURLToPath(import.meta.url);

/** A chunk's most compressed bytes. */
export const CHUNK_MAX = 256 * 1024;
// The detail layer (MACLEOD-793, "Sensitive detail"): sent only while the
// organisation allows it. Secrets are redacted here too, always.
export const DETAIL_CHUNK_MAX = 512 * 1024;
const DETAIL_TEXT_MAX = 64 * 1024;
/** How long a refusal holds before the organisation is asked again. */
export const WAIT_MS = 10 * 60 * 1000;
/** The spool's most bytes; the oldest go first. */
export const SPOOL_MAX = 5 * 1024 * 1024;
const TEXT_MAX = 4000;
const SUMMARY_MAX = 160;
const READ_MAX = 4 * 1024 * 1024;
const PENDING_MAX = 100;
const SPOOL_FLUSH = 20;
const LOCK_STALE_MS = 2 * 60 * 1000;
const OFF_CODES = new Set(['agent_view_off', 'plan_required']);
// The events that start a pass. A tool event starts one at most every
// 30 seconds per session; the end of a turn or an agent always does.
const KICK_EVENTS = new Set(['Stop', 'SubagentStop', 'SessionEnd', 'PreCompact', 'PostToolUse', 'PostToolUseFailure']);
const ALWAYS = new Set(['Stop', 'SubagentStop', 'SessionEnd', 'PreCompact']);
export const KICK_EVERY_MS = 30 * 1000;

const home = () => path.join(core.dataDir(), 'agent-view');
const slug = (value) => String(value || core.UNSCOPED).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 80) || core.UNSCOPED;

// --- the person's switch -----------------------------------------------------

/** `{ on, since }`: whether this person sends, and from when. */
export function personSwitch() {
  const value = core.readJson(core.globalConfigPath(), {})?.agentView;
  return { on: value?.on === true, since: typeof value?.since === 'string' ? value.since : undefined };
}

/** Turn this person's switch on or off. Only lines written after "on" are ever sent. */
export function setPersonSwitch(value, now = Date.now()) {
  if (value !== 'on' && value !== 'off') throw new Error('Usage: teamflow agent-view on|off|status');
  const file = core.globalConfigPath();
  const next = { ...(core.readJson(file, {}) || {}) };
  next.agentView = value === 'on' ? { on: true, since: new Date(now).toISOString() } : { on: false };
  core.writeJson(file, next);
  return value === 'on';
}

// --- the organisation's switch -----------------------------------------------

const orgPath = (config) => path.join(home(), `org-${slug(core.reportScope(config))}.json`);

/** What this machine last learned about the organisation's switch. */
export function orgState(config, now = Date.now()) {
  const saved = core.readJson(orgPath(config));
  if (!saved?.state || !saved.at) return { state: 'unknown' };
  const at = Date.parse(saved.at);
  return { ...saved, fresh: Number.isFinite(at) && now - at < WAIT_MS, askAt: new Date(at + WAIT_MS).toISOString() };
}

export function noteOrg(config, state, code = undefined, now = Date.now(), sensitive = undefined) {
  const was = core.readJson(orgPath(config)) || {};
  const keep = sensitive === undefined ? (state === 'on' && was.sensitive === true) : sensitive === true;
  core.writeJson(orgPath(config), { state, ...(code ? { code } : {}), sensitive: keep, at: new Date(now).toISOString() });
}

/** Whether the organisation allows the detail layer now. False when unknown. */
export function orgSensitive(config, now = Date.now()) {
  const known = orgState(config, now);
  return known.state === 'on' && known.sensitive === true;
}

/** The settings route's answer, as `on`, `off`, `plan` or undefined when it could not be read. */
export async function fetchOrgSetting(config) {
  const answer = await core.fetchAgentViewSetting(config);
  if (answer.status === 403 && answer.reasonCode === 'plan_required') return { state: 'plan', code: 'plan_required' };
  if (answer.status === 404) return { state: 'off', code: 'not_available' };
  if (!answer.ok) return undefined;
  const setting = answer.body?.agent_view || answer.body;
  return setting?.enabled === true ? { state: 'on', sensitive: setting?.sensitive === true } : { state: 'off', code: 'agent_view_off' };
}

/** Whether the organisation takes chunks now: asks the service at most every 10 minutes. */
async function orgOn(config, now, getSetting) {
  const known = orgState(config, now);
  if (known.fresh) return known.state === 'on' ? 'on' : 'off';
  const asked = await getSetting(config);
  if (!asked) return 'unknown';
  noteOrg(config, asked.state, asked.code, now, asked.sensitive);
  return asked.state === 'on' ? 'on' : 'off';
}

/** The one line `status` and `doctor` print: which switch is off, in plain words. */
export function agentViewLine(config, { setting = undefined, now = Date.now() } = {}) {
  const person = personSwitch();
  const org = setting || orgState(config, now);
  const orgWords = org.state === 'plan'
    ? "your organisation's plan does not include it (Team or above)"
    : org.state === 'off'
      ? (org.code === 'not_available' ? 'the service does not take it yet' : 'your organisation has not turned it on')
      : undefined;
  if (!person.on && orgWords) return `Off. Your switch is off, and ${orgWords}.`;
  if (!person.on) return 'Off. Your switch is off. `teamflow agent-view on` turns it on for this computer.';
  if (orgWords) {
    const when = org.askAt && !setting ? ` It asks again after ${org.askAt.slice(11, 16)} UTC.` : '';
    return `Off. Your switch is on, but ${orgWords}.${when}`;
  }
  if (org.state === 'on') return 'On. What your agents say goes to their tickets. Code and secrets are taken out first.';
  return 'Your switch is on. It sends when your organisation says it is on.';
}

// --- the transcript ----------------------------------------------------------

const oneLine = (value, max = SUMMARY_MAX) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

function shortPath(file, cwd) {
  const p = String(file || '');
  if (!p) return '';
  if (cwd && p.startsWith(`${cwd}/`)) return p.slice(cwd.length + 1);
  return path.basename(p);
}

/**
 * A tool's input in one line: what it did, never what it wrote. A path is
 * relative to the repository or only its name; an edit's old and new text,
 * a write's content and an agent's prompt are never read.
 */
export function toolSummary(name, input = {}, cwd = undefined) {
  const i = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'Bash': return oneLine(i.description || String(i.command || '').split('\n')[0]);
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': return shortPath(i.file_path, cwd);
    case 'NotebookEdit': return shortPath(i.notebook_path, cwd);
    case 'Grep': return oneLine(`${i.pattern || ''}${i.path ? ` in ${shortPath(i.path, cwd)}` : ''}`);
    case 'Glob': return oneLine(i.pattern);
    case 'WebFetch': return oneLine(i.url);
    case 'WebSearch': return oneLine(i.query);
    case 'Agent': case 'Task': return oneLine([i.description, i.subagent_type && `(${i.subagent_type})`].filter(Boolean).join(' '));
    case 'Skill': return oneLine(i.skill);
    case 'TodoWrite': return Array.isArray(i.todos) ? `${i.todos.length} items` : '';
    default: return '';
  }
}

const REMINDER = /<system-reminder>[\s\S]*?(?:<\/system-reminder>|$)/g;
const TAGGED = /<\/?(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr)>/g;

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n');
}

function line(t, role, text, tool = undefined) {
  let clean = cleanLine(text).trim();
  if (clean.length > TEXT_MAX) clean = `${clean.slice(0, TEXT_MAX - 1)}…`;
  return { t, role, ...(tool ? { tool } : {}), text: clean };
}

function capDetail(text) {
  let body = redactSecrets(String(text ?? ''));
  if (body.length <= DETAIL_TEXT_MAX) return body;
  const kept = body.slice(0, DETAIL_TEXT_MAX);
  const more = body.slice(DETAIL_TEXT_MAX).split('\n').length;
  return `${kept}\n[${more} more lines]`;
}

function detailLine(t, role, kind, text, tool = undefined) {
  return { t, role, kind, ...(tool ? { tool } : {}), text: capDetail(text) };
}

function outputOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n');
}

/** An edit as a unified diff, paths relative to the repository. */
export function diffOf(name, input = {}, cwd = undefined) {
  const file = shortPath(input.file_path || input.path || '', cwd) || 'file';
  const head = [`--- a/${file}`, `+++ b/${file}`];
  const minus = (text) => String(text ?? '').split('\n').map((l) => `-${l}`);
  const plus = (text) => String(text ?? '').split('\n').map((l) => `+${l}`);
  if (name === 'Write') return [...head, '@@', ...plus(input.content)].join('\n');
  if (name === 'Edit') return [...head, '@@', ...minus(input.old_string), ...plus(input.new_string)].join('\n');
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    return [...head, ...input.edits.flatMap((e) => ['@@', ...minus(e?.old_string), ...plus(e?.new_string)])].join('\n');
  }
  return undefined;
}

/**
 * The lines one transcript entry makes. `pending` holds tool calls waiting
 * for their result, so a tool line carries its outcome; it is the caller's
 * to keep between passes.
 */
export function entryLines(entry, pending = {}, cwd = undefined, detail = undefined) {
  const out = [];
  if (!entry || entry.isMeta) return out;
  const t = entry.timestamp || new Date().toISOString();
  const content = entry.message?.content;
  const where = entry.cwd || cwd;
  if (entry.type === 'user') {
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_result') continue;
        const call = pending[block.tool_use_id];
        if (!call) continue;
        delete pending[block.tool_use_id];
        const outcome = block.is_error ? 'failed' : 'done';
        out.push(line(t, 'tool', call.summary ? `${call.summary} → ${outcome}` : outcome, call.name));
        const body = outputOf(block.content);
        if (detail && body.trim()) detail.push(detailLine(t, 'tool', 'output', body, call.name));
      }
    }
    const said = textOf(content).replace(REMINDER, '').replace(TAGGED, ' ').trim();
    if (said) out.push(line(t, 'user', said));
    if (detail && said) detail.push(detailLine(t, 'user', 'text', said));
  } else if (entry.type === 'assistant' && Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'text' && String(block.text || '').trim()) {
        out.push(line(t, 'assistant', block.text));
        if (detail) detail.push(detailLine(t, 'assistant', 'text', block.text));
      }
      if (detail && block?.type === 'tool_use') {
        const diff = diffOf(block.name, block.input, where);
        if (diff) detail.push(detailLine(t, 'tool', 'diff', diff, oneLine(block.name, 80)));
      }
      if (block?.type === 'tool_use' && block.id) {
        pending[block.id] = { name: oneLine(block.name, 80), summary: toolSummary(block.name, block.input, where), t };
      }
    }
    // Bounded: a call whose result never came is sent without one.
    const waiting = Object.keys(pending);
    for (const id of waiting.slice(0, Math.max(0, waiting.length - PENDING_MAX))) {
      const call = pending[id];
      delete pending[id];
      out.push(line(call.t, 'tool', call.summary ? `${call.summary} → no result` : 'no result', call.name));
    }
  }
  return out.filter((l) => l.text);
}

/** New whole lines of `file` from `state.offset`, which moves past them. */
export function readNew(file, state) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < (state.offset || 0)) state.offset = 0;
    const offset = state.offset || 0;
    const length = Math.min(size - offset, READ_MAX);
    if (length <= 0) return [];
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, offset);
    const end = buffer.lastIndexOf(0x0a);
    if (end < 0) {
      // One line longer than a whole read: skipped, never half-sent.
      if (length === READ_MAX) state.offset = offset + length;
      return [];
    }
    state.offset = offset + end + 1;
    const entries = [];
    for (const text of buffer.subarray(0, end).toString('utf8').split('\n')) {
      if (!text.trim()) continue;
      try { entries.push(JSON.parse(text)); } catch { /* a line that is not JSON is skipped */ }
    }
    return entries;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

/**
 * The session's transcript files: the main one and one per subagent,
 * background agents included. Claude Code keeps an agent's transcript at
 * `<session>/subagents/agent-<id>.jsonl` beside `<session>.jsonl`; a
 * subagent's hook may name either, so both shapes resolve to the same set.
 */
export function transcriptFiles(sessionId, transcriptPath) {
  let main = String(transcriptPath || '');
  if (!main) return [];
  if (path.basename(path.dirname(main)) === 'subagents') {
    main = path.join(path.dirname(path.dirname(path.dirname(main))), `${path.basename(path.dirname(path.dirname(main)))}.jsonl`);
  }
  const files = [{ file: main, agent: 'main' }];
  const agents = path.join(path.dirname(main), path.basename(main, '.jsonl'), 'subagents');
  try {
    for (const name of fs.readdirSync(agents).sort()) {
      const match = /^agent-(.+)\.jsonl$/.exec(name);
      if (match) files.push({ file: path.join(agents, name), agent: match[1].slice(0, 80) });
    }
  } catch { /* no agents */ }
  return files;
}

// --- chunks ------------------------------------------------------------------

/** Lines as gzip+base64 chunks, each at most `cap` compressed bytes. A line alone over the cap is dropped. */
export function chunkLines(lines, cap = CHUNK_MAX) {
  if (!lines.length) return [];
  const packed = zlib.gzipSync(Buffer.from(`${lines.map((l) => JSON.stringify(l)).join('\n')}\n`));
  if (packed.length <= cap) return [packed.toString('base64')];
  if (lines.length === 1) return [];
  const mid = Math.ceil(lines.length / 2);
  return [...chunkLines(lines.slice(0, mid), cap), ...chunkLines(lines.slice(mid), cap)];
}

/** A chunk's lines back, as the service reads them. */
export function unpackChunk(data) {
  return zlib.gunzipSync(Buffer.from(data, 'base64')).toString('utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// --- the spool ---------------------------------------------------------------

const spoolDir = () => path.join(home(), 'spool');

let spoolCount = 0;

function spoolFiles() {
  try { return fs.readdirSync(spoolDir()).filter((n) => n.endsWith('.json')).sort(); } catch { return []; }
}

/** Keep a chunk the service could not be reached for. The oldest go past 5 MB. */
export function spool(body, max = SPOOL_MAX) {
  fs.mkdirSync(spoolDir(), { recursive: true });
  // Time, then this process's own count, so two in one millisecond keep their order.
  spoolCount += 1;
  const name = `${String(Date.now()).padStart(15, '0')}-${String(spoolCount).padStart(6, '0')}-${crypto.randomBytes(4).toString('hex')}.json`;
  fs.writeFileSync(path.join(spoolDir(), name), JSON.stringify(body), { mode: 0o600 });
  const files = spoolFiles();
  let total = files.reduce((sum, n) => sum + (fs.statSync(path.join(spoolDir(), n)).size || 0), 0);
  for (const n of files) {
    if (total <= max) break;
    const size = fs.statSync(path.join(spoolDir(), n)).size;
    fs.rmSync(path.join(spoolDir(), n), { force: true });
    total -= size;
  }
}

export function clearSpool() {
  fs.rmSync(spoolDir(), { recursive: true, force: true });
}

// --- one pass ----------------------------------------------------------------

const statePath = (sessionId) => path.join(home(), 'sessions', `${core.digest(sessionId, 16)}.json`);

function lock(sessionId, now) {
  const file = path.join(home(), 'locks', `${core.digest(sessionId, 16)}.lock`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
  } catch {
    try {
      if (now - fs.statSync(file).mtimeMs < LOCK_STALE_MS) return undefined;
      fs.rmSync(file, { force: true });
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
    } catch { return undefined; }
  }
  return () => fs.rmSync(file, { force: true });
}

function keyFor(sessionId, agent, mainKey) {
  if (agent === 'main') return mainKey;
  return core.readJson(core.sessionPath(sessionId, agent))?.binding?.key || mainKey;
}

// The detail layer alone refused: the safe layer goes on (MACLEOD-793).
const sensitiveOff = (result) => result?.status === 403 && result.reasonCode === 'sensitive_off';
const offCode = (result) => (result?.status === 403 && OFF_CODES.has(result.reasonCode) ? result.reasonCode
  : result?.status === 404 ? 'not_available' : undefined);

/**
 * A stream's session, in the key space of the board's rows (MACLEOD-793).
 * A report's `session.id` is `core.sessionBlock`'s digest of the session
 * id, and an agent's `agent.id` is the tool's `agent_id`, which is also
 * the name of its transcript file. The stream uses the same two values, so
 * a matrix row and its stream share one key, `<session>/<agent>`, and
 * nothing has to guess.
 */
export const streamSession = (sessionId) => core.sessionBlock({ sessionId }).id;

/**
 * Read what is new in one session's transcripts and send it.
 *
 * Nothing is read unless the person's switch is on. What is read while the
 * organisation's switch is off is dropped, never kept for later. A refusal
 * stops the pass at once and holds for ten minutes; there is no retry loop.
 */
export async function runPass({ sessionId, transcriptPath, cwd, config, now = Date.now(), post = core.sendAgentView, getSetting = fetchOrgSetting }) {
  const person = personSwitch();
  if (!person.on || !sessionId || !transcriptPath) return { skipped: 'person' };
  const release = lock(sessionId, now);
  if (!release) return { skipped: 'busy' };
  try {
    const file = statePath(sessionId);
    const state = core.readJson(file, {}) || {};
    state.files ||= {};
    state.seq ||= {};
    state.dseq ||= {};
    const since = person.since ? Date.parse(person.since) : 0;

    // Everything new, per agent. Offsets move whether or not it is sent.
    const byAgent = new Map();
    const detailBy = new Map();
    for (const { file: transcript, agent } of transcriptFiles(sessionId, transcriptPath)) {
      const id = core.digest(transcript, 16);
      const fileState = (state.files[id] ||= { offset: 0, pending: {} });
      for (const entry of readNew(transcript, fileState)) {
        const who = agent === 'main' && entry.isSidechain ? (entry.agentId ? String(entry.agentId).slice(0, 80) : undefined) : agent;
        if (!who) continue;
        const detail = [];
        for (const l of entryLines(entry, fileState.pending, cwd, detail)) {
          if (since && Date.parse(l.t) < since) continue;
          if (!byAgent.has(who)) byAgent.set(who, []);
          byAgent.get(who).push(l);
        }
        for (const l of detail) {
          if (since && Date.parse(l.t) < since) continue;
          if (!detailBy.has(who)) detailBy.set(who, []);
          detailBy.get(who).push(l);
        }
      }
    }
    // A question the session asks now (MACLEOD-852): after the transcript's
    // lines, so it is the newest line its reader sees.
    for (const held of takeAsks(sessionId)) {
      const who = held.agent;
      for (const l of held.lines) {
        if (since && Date.parse(l.t) < since) continue;
        if (!byAgent.has(who)) byAgent.set(who, []);
        byAgent.get(who).push(l);
      }
      for (const l of held.detail) {
        if (since && Date.parse(l.t) < since) continue;
        if (!detailBy.has(who)) detailBy.set(who, []);
        detailBy.get(who).push(l);
      }
    }

    const org = await orgOn(config, now, getSetting);
    if (org === 'off') {
      clearSpool();
      core.writeJson(file, state);
      return { dropped: [...byAgent.values()].reduce((n, l) => n + l.length, 0), org };
    }

    const mainKey = core.readJson(core.sessionPath(sessionId))?.binding?.key;
    const bodies = [];
    for (const [agent, lines] of byAgent) {
      const key = keyFor(sessionId, agent, mainKey);
      if (!key) continue;
      for (const data of chunkLines(lines)) {
        state.seq[agent] = (state.seq[agent] || 0) + 1;
        bodies.push({
          key, session: streamSession(sessionId), agent, seq: state.seq[agent],
          sent_at: new Date(now).toISOString(), encoding: 'gzip+base64', data,
          // MACLEOD-848: which machine asked, so an answer goes to it only.
          // Only while this machine takes answers from TeamFlow.
          ...(twoWaySwitch().on && core.machineId() ? { machine: core.machineId() } : {}),
        });
      }
    }
    // The detail layer only while the organisation allows it; otherwise it
    // is dropped here and never leaves the machine.
    if (orgSensitive(config, now)) {
      for (const [agent, lines] of detailBy) {
        const key = keyFor(sessionId, agent, mainKey);
        if (!key) continue;
        for (const data of chunkLines(lines, DETAIL_CHUNK_MAX)) {
          state.dseq[agent] = (state.dseq[agent] || 0) + 1;
          bodies.push({
            key, session: streamSession(sessionId), agent, seq: state.dseq[agent], layer: 'detail',
            sent_at: new Date(now).toISOString(), encoding: 'gzip+base64', data,
          });
        }
      }
    }
    core.writeJson(file, state);

    if (org === 'unknown') {
      for (const body of bodies) spool(body);
      return { spooled: bodies.length, org };
    }

    // The spool first, oldest first, so a ticket's lines arrive in order.
    let sent = 0;
    let spooled = 0;
    let reachable = true;
    for (const name of spoolFiles().slice(0, SPOOL_FLUSH)) {
      const full = path.join(spoolDir(), name);
      const body = core.readJson(full);
      if (!body) { fs.rmSync(full, { force: true }); continue; }
      const result = await post(body, config);
      if (sensitiveOff(result)) { noteOrg(config, 'on', undefined, now, false); fs.rmSync(full, { force: true }); continue; }
      const off = offCode(result);
      if (off) {
        noteOrg(config, off === 'plan_required' ? 'plan' : 'off', off, now);
        clearSpool();
        return { sent, stopped: off };
      }
      if (result?.retry) { reachable = false; break; }
      fs.rmSync(full, { force: true });
      if (result?.ok) sent += 1;
    }

    let detailOff = false;
    for (const body of bodies) {
      if (body.layer === 'detail' && detailOff) continue;
      if (!reachable) { spool(body); spooled += 1; continue; }
      const result = await post(body, config);
      if (sensitiveOff(result)) { noteOrg(config, 'on', undefined, now, false); detailOff = true; continue; }
      const off = offCode(result);
      if (off) {
        noteOrg(config, off === 'plan_required' ? 'plan' : 'off', off, now);
        clearSpool();
        return { sent, stopped: off };
      }
      if (result?.retry) { reachable = false; spool(body); spooled += 1; continue; }
      if (result?.ok) {
        sent += 1;
        noteOrg(config, 'on', undefined, now);
      }
    }
    return { sent, spooled };
  } finally {
    release();
  }
}

// --- the hook's part ---------------------------------------------------------

/**
 * Start a pass in the background. Called by the hook; returns at once.
 * Reads one config file and one stamp, and nothing when the person's
 * switch is off.
 */
export function kick(event, input = {}, sessionId = undefined, cwd = process.cwd(), { spawnImpl = spawn, now = Date.now(), force = false } = {}) {
  if ((!force && !KICK_EVENTS.has(event)) || !sessionId || !input.transcript_path) return false;
  if (!personSwitch().on) return false;
  const stamp = path.join(home(), 'kicks', `${core.digest(sessionId, 16)}`);
  if (!force && !ALWAYS.has(event)) {
    try { if (now - fs.statSync(stamp).mtimeMs < KICK_EVERY_MS) return false; } catch { /* first kick */ }
  }
  fs.mkdirSync(path.dirname(stamp), { recursive: true });
  fs.writeFileSync(stamp, '');
  const child = spawnImpl(process.execPath, [SCRIPT, 'run', String(sessionId), String(input.transcript_path), String(cwd)],
    { cwd, detached: true, stdio: 'ignore', shell: false });
  child?.unref?.();
  return true;
}

// --- a pending question (MACLEOD-852) ----------------------------------------

const asksPath = (sessionId) => path.join(home(), 'asks', `${core.digest(sessionId, 16)}.jsonl`);

/**
 * A question the session asks its person now, kept for the next pass and
 * sent at once. Only while this person's switch is on; the pass drops it
 * while the organisation's is off, as it drops every other line. Read-only
 * for the board: nothing here, or anywhere, takes an answer back.
 */
export function noteAsk(input = {}, sessionId = undefined, cwd = process.cwd(), { spawnImpl = spawn, now = Date.now() } = {}) {
  if (!sessionId || !input.transcript_path || !personSwitch().on) return false;
  const { lines, detail } = askLines(input, now);
  if (!lines.length) return false;
  const agent = input.agent_id ? String(input.agent_id).slice(0, 80) : 'main';
  const file = asksPath(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ agent, lines, detail })}\n`, { mode: 0o600 });
  return kick(input.hook_event_name, input, sessionId, cwd, { spawnImpl, now, force: true });
}

/** The questions kept since the last pass, removed as they are read. */
export function takeAsks(sessionId) {
  const file = asksPath(sessionId);
  const taking = `${file}.${process.pid}.taking`;
  try { fs.renameSync(file, taking); } catch { return []; }
  try {
    return fs.readFileSync(taking, 'utf8').split('\n').filter(Boolean).flatMap((text) => {
      try {
        const held = JSON.parse(text);
        return Array.isArray(held?.lines) ? [{ agent: String(held.agent || 'main'), lines: held.lines, detail: Array.isArray(held.detail) ? held.detail : [] }] : [];
      } catch { return []; }
    });
  } finally {
    fs.rmSync(taking, { force: true });
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(SCRIPT) && process.argv[2] === 'run') {
  const [, , , sessionId, transcriptPath, cwd] = process.argv;
  try {
    await runPass({ sessionId, transcriptPath, cwd, config: core.loadConfig(cwd || process.cwd()) });
  } catch { /* a background pass fails silently; the next one reads from the same offset */ }
  process.exit(0);
}
