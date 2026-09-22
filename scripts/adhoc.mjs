#!/usr/bin/env node
// `teamflow adhoc`: work that arrived without a ticket (MACLEOD-556).
//
// An ad hoc work item is an issue document whose key TeamFlow minted.
// Not a new kind of subject, not a new store, not a new event shape:
// the board already draws issue documents, the workflow pool already
// holds keys, `dependencies[]` already joins keys, and every hook
// already reports against a bound key. The one thing that changes is
// who owns the key.
//
// Two boundaries decide almost everything in this file.
//
// **The request does not travel.** The sentence somebody typed is a
// prompt, and docs/REPORTING_CONTRACT.md makes no exception for this
// one. What reaches the wire is a *derived* title: a short sentence
// saying what the work is, written by whoever is driving. There is no
// argument, flag or file on this command through which the request
// itself could enter — the only text it accepts is one line, capped at
// the summary cap — and nothing here ever puts a rejected value into
// an error message.
//
// **The key is minted by the service, not here.** Two sessions in one
// organisation would otherwise invent the same `ADHOC-1`. `POST
// /v1/adhoc` answers the next number for the caller's account, claimed
// atomically in the kit's ledger, and this module does not guess one
// when the service cannot be reached: an item under a made-up key is
// worse than no item.

import fs from 'node:fs';

import {
  bindingRefusalFor,
  credential,
  credentialKind,
  dataDirWritable,
  followKeyAliases,
  isAdHocKey,
  issuePayload,
  latestSessionForCwd,
  localBindingPath,
  organisationScope,
  publishState,
  readWorkflows,
  recordKeyAlias,
  reportScope,
  readJson,
  readUserBinding,
  refusalLine,
  saveSession,
  sendReport,
  serviceUrl,
  tenantId,
  usableBinding,
  userBindingPath,
  userBindingPaths,
  writeJson,
  writeLocalBinding,
  writeWorkflows,
} from './core.mjs';
import { refusalOf } from './refusal.mjs';

export { isAdHocKey };

/*
 * The cap is `SUMMARY_MAX` in adapters/teamflow/schema.py, not the 200
 * the `title` field allows.
 *
 * Deliberately the shorter of the two. A derived sentence saying what
 * the work is fits in well under 180 characters; a pasted request does
 * not. The cap is therefore also the guard — the one mechanical check
 * that can tell a sentence about the work from the words that asked
 * for it — which is why it is asserted by a test rather than left as a
 * convention in the skill's prose.
 */
export const TITLE_MAX = 180;

export const TRACKER = 'teamflow';

export const USAGE = `teamflow adhoc — work that arrived without a ticket

  teamflow adhoc start "<what the work is>"
      Mint an ad hoc key, publish the item and bind this project to it.
      The title is a short sentence saying what the work is — never the
      request that asked for it, which is a prompt and stays on this
      machine. At most ${TITLE_MAX} characters, on one line.

  teamflow adhoc title "<what the work is>"
      Rename the bound ad hoc item. Republished at once, like every
      other change to it.

  teamflow adhoc done [--summary <what was delivered>]
      Mark the bound ad hoc item done and unbind. An ad hoc item never
      reopens; the next request is a new item.

  teamflow adhoc convert [<ADHOC-n>] --project <project>
      Turn the item (the bound one when none is named) into a ticket in
      the organisation's tracker, in the state its gate maps to. The
      card becomes the ticket everywhere, with its history, and later
      reports from this project land on the ticket.

  teamflow adhoc convert [<ADHOC-n>] --to <KEY> [--merge]
      Link the item to a ticket created elsewhere (a tracker MCP, by
      hand) and do the same, without creating anything. A ticket that
      already has its own history on the board, or that another ad hoc
      item became, is refused unless --merge says to combine them.`;

/**
 * The derived title, or a refusal.
 *
 * Never echoes what it rejected. An error message is the one place a
 * rejected prompt could still escape, so the refusals here say the
 * rule and the length and nothing else.
 */
export function checkTitle(value) {
  const raw = String(value ?? '');
  if (/[\r\n]/.test(raw)) {
    throw new Error('An ad hoc title is one line: a short sentence saying what the work is. '
      + 'Several lines is the request, and the request stays on this machine.');
  }
  const title = raw.trim().replace(/\s+/g, ' ');
  if (!title) throw new Error('Usage: teamflow adhoc start "<what the work is>"');
  if (title.length > TITLE_MAX) {
    throw new Error(`An ad hoc title is at most ${TITLE_MAX} characters and this one is ${title.length}. `
      + 'Say what the work is, not what was asked for.');
  }
  return title;
}

/**
 * `POST /v1/adhoc`: the next key for this organisation.
 *
 * Never invents one locally. The whole reason the service mints it is
 * that two sessions must not collide, and a local fallback would be
 * exactly the collision it exists to prevent.
 */
export async function mint(config = {}) {
  if (!credentialKind(config)) {
    return { ok: false, reason: 'no service credential configured; run `teamflow login`' };
  }
  const cred = await credential(config);
  if (!cred) return { ok: false, reason: 'no service credential available; run `teamflow login`' };
  try {
    const response = await fetch(`${serviceUrl(config)}/v1/adhoc`, {
      method: 'POST',
      headers: { [cred.header]: cred.value, 'content-type': 'application/json' },
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 5000)),
    });
    let body;
    try { body = await response.json(); } catch { body = undefined; }
    if (!response.ok) {
      return { ok: false, status: response.status, ...refusalOf(body, `service returned ${response.status}`) };
    }
    if (!isAdHocKey(body?.key)) {
      return { ok: false, reason: 'the service did not answer an ad hoc key' };
    }
    return { ok: true, key: String(body.key).toUpperCase() };
  } catch (error) {
    return { ok: false, reason: `service unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Which binding file this project writes: the worktree's, or the user data directory's. */
function bindingFile(cwd, config) {
  return dataDirWritable() ? userBindingPath(cwd, config) : localBindingPath(cwd);
}

/**
 * The binding on disk, local first, because a worktree's own is the one
 * in force — and never one made under another organisation, which this
 * credential must not report under (MACLEOD-586).
 */
export function currentBinding(cwd, config = {}) {
  return usableBinding(readJson(localBindingPath(cwd)), config)
    || usableBinding(readUserBinding(cwd, config), config);
}

/** The bound ad hoc item, or undefined when the binding is a real ticket. */
export function boundAdHoc(cwd, config = {}) {
  const binding = currentBinding(cwd, config);
  return binding && isAdHocKey(binding.jiraKey) ? binding : undefined;
}

function bindingRecord(key, title, config, extra = {}) {
  return {
    jiraKey: key,
    tracker: TRACKER,
    title,
    // There is nothing to look up: TeamFlow is the system of record,
    // so the title is whatever was last derived for it.
    titleLookedUp: true,
    adhoc: true,
    tenantId: tenantId(config),
    // Whose item it is (MACLEOD-586), on the same terms as `teamflow bind`.
    ...(organisationScope(config) ? { account: organisationScope(config) } : {}),
    boundAt: new Date().toISOString(),
    ...extra,
  };
}

function writeBinding(cwd, config, record) {
  const file = bindingFile(cwd, config);
  if (file === localBindingPath(cwd)) writeLocalBinding(cwd, record);
  else writeJson(file, record);
  return file;
}

/**
 * Publish the item now.
 *
 * Every change to an ad hoc item -- its title, its state, the phase and
 * run it belongs to -- is a republish of the document that holds it,
 * the moment it changes (MACLEOD-556, the owner's addition). Nothing
 * waits for the end of a run.
 *
 * The session is the publisher when there is one, so the item carries
 * the same git, pull-request and workflow context every other report
 * from this session carries. With no session on disk -- a bare CLI run
 * -- the same payload is built from a state that is never saved, which
 * is a report and not a session.
 */
export async function republish(key, title, cwd, config = {}, info = {}, { status, summary } = {}) {
  const binding = { key, tracker: TRACKER, confidence: 1000, source: 'manual', sticky: true, boundAt: new Date().toISOString() };
  const session = latestSessionForCwd(cwd, config);
  if (session) {
    session.binding = binding;
    session.jira = { ...(session.jira || {}), key, title };
    if (status) session.status = status;
    if (summary) session.summary = summary;
    session.updatedAt = new Date().toISOString();
    const result = await publishState(session, config, info, { force: true });
    try { saveSession(session); } catch { /* the binding file is still on disk */ }
    return result.issueResult || result;
  }
  const state = {
    sessionId: `adhoc-${key.toLowerCase()}`,
    cwd,
    binding,
    jira: { key, title },
    stage: 'BACKLOG',
    status: status || 'running',
    summary: summary || 'Ad hoc work started',
    updatedAt: new Date().toISOString(),
  };
  // Through the organisation check, like every other publisher
  // (MACLEOD-586, MACLEOD-601 audit finding 3). An ad hoc key is
  // minted on this machine and is nobody else's, but the report that
  // carries it is still somebody's, and it must not go out on
  // another organisation's credential.
  return sendReport('issue', undefined, issuePayload(state, config, info), config, {
    account: reportScope(config),
  });
}

/** How a send went, in one line, because a refusal and a retry read differently. */
export function sentLine(sent) {
  if (sent?.ok) return 'It is on the board.';
  if (sent?.queued) return `It is on this machine and queued: ${sent.reason || 'the service did not answer'}.`;
  if (sent?.skipped) return `It is on this machine only: ${sent.reason}.`;
  return `It is on this machine only. The service refused it: ${sent?.reason || 'no reason given'}.`;
}

export async function start(title, cwd, config = {}, info = {}) {
  const clean = checkTitle(title);
  const minted = await mint(config);
  if (!minted.ok) {
    // No local fallback on purpose: a key this machine invented is the
    // collision the service mints to prevent.
    throw new Error(`TeamFlow could not mint an ad hoc key: ${minted.reason}. `
      + 'Nothing was bound, so nothing will be reported under a key another session may also be using.');
  }
  const record = bindingRecord(minted.key, clean, config);
  const file = writeBinding(cwd, config, record);
  const sent = await republish(minted.key, clean, cwd, config, info, {
    status: 'running', summary: 'Ad hoc work started',
  });
  return { key: minted.key, title: clean, file, sent };
}

export async function retitle(title, cwd, config = {}, info = {}) {
  const clean = checkTitle(title);
  const bound = boundAdHoc(cwd, config);
  // A refused binding is not "nothing bound": say which organisation it
  // belongs to rather than inviting a second item under this one
  // (MACLEOD-586). Loud here, because a CLI has somebody reading it.
  if (!bound) {
    throw new Error(refusalLine(bindingRefusalFor(cwd, config))
      || 'No ad hoc item is bound. `teamflow adhoc start "<what the work is>"` starts one.');
  }
  writeBinding(cwd, config, { ...bound, title: clean });
  const sent = await republish(bound.jiraKey, clean, cwd, config, info);
  return { key: bound.jiraKey, title: clean, sent };
}

/**
 * The item ends, and never reopens.
 *
 * Marking it done is a last publish and then forgetting the key: the
 * binding files go, and the session's binding with them, so the next
 * turn is attributed to whatever it is actually about rather than
 * continuing to report into finished work. A new request is a new item.
 */
export async function done(cwd, config = {}, info = {}, { summary, status = 'success' } = {}) {
  const bound = boundAdHoc(cwd, config);
  if (!bound) {
    throw new Error(refusalLine(bindingRefusalFor(cwd, config))
      || 'No ad hoc item is bound, so there is nothing to finish.');
  }
  const line = summary === undefined ? 'Ad hoc work done' : checkTitle(summary);
  const sent = await republish(bound.jiraKey, bound.title, cwd, config, info, { status, summary: line });
  clearBinding(cwd, config);
  return { key: bound.jiraKey, title: bound.title, sent };
}

/**
 * One call to the service as the signed-in member. `{ ok, status, body }`
 * or `{ ok: false, reason }`; never throws, never invents an answer.
 */
async function member(method, route, config = {}, body = undefined) {
  if (!credentialKind(config)) return { ok: false, reason: 'no service credential configured; run `teamflow login`' };
  const cred = await credential(config);
  if (!cred) return { ok: false, reason: 'no service credential available; run `teamflow login`' };
  try {
    const response = await fetch(`${serviceUrl(config)}${route}`, {
      method,
      headers: { [cred.header]: cred.value, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 20000)),
    });
    let answer;
    try { answer = await response.json(); } catch { answer = undefined; }
    if (!response.ok) return { ok: false, status: response.status, ...refusalOf(answer, `service returned ${response.status}`) };
    return { ok: true, status: response.status, body: answer };
  } catch (error) {
    return { ok: false, reason: `service unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

const PROJECT_ID = /^prj-[0-9a-f]{8}$/;

/** A project id, from an id or a project's name as the members page shows it. */
export async function projectId(wanted, config = {}) {
  const value = String(wanted ?? '').trim();
  if (!value) return undefined;
  if (PROJECT_ID.test(value)) return value;
  const listed = await member('GET', '/v1/members/projects', config);
  if (!listed.ok) throw new Error(`TeamFlow could not list this organisation's projects: ${listed.reason}`);
  const found = (listed.body?.projects || []).find((p) => String(p.name || '').trim().toLowerCase() === value.toLowerCase());
  if (!found) {
    const names = (listed.body?.projects || []).map((p) => p.name).join(', ') || 'none';
    throw new Error(`No project called "${value}" on this organisation. Its projects: ${names}.`);
  }
  return found.id;
}

/**
 * The ad hoc item becomes a ticket (MACLEOD-639, ADHOC-15).
 *
 * `--project` asks the service to create the ticket in the org's tracker;
 * `--to` links one created elsewhere (a tracker MCP, by hand) and creates
 * nothing. Either way the service moves the card, renames it in every
 * stored workflow and keeps the ADHOC key as an alias. Here, on this
 * machine: the alias is remembered, this directory's binding follows it,
 * and the local workflow copies are rewritten with the node renamed.
 */
export async function convertItem(key, { project, to, merge = false } = {}, cwd = process.cwd(), config = {}) {
  const bound = boundAdHoc(cwd, config);
  const wanted = String(key || bound?.jiraKey || '').trim().toUpperCase();
  if (!isAdHocKey(wanted)) {
    throw new Error('Usage: teamflow adhoc convert [<ADHOC-n>] --project <project> | --to <KEY>. '
      + 'Nothing ad hoc is bound here, so name the item.');
  }
  if (!project && !to) throw new Error('Say where the ticket goes: --project <project>, or --to <KEY> for one created elsewhere.');
  const body = to ? { to: String(to).trim(), ...(merge ? { merge: true } : {}) } : { project: await projectId(project, config) };
  const sent = await member('POST', `/v1/members/cards/${encodeURIComponent(wanted)}/convert`, config, body);
  if (!sent.ok) throw new Error(`TeamFlow did not convert ${wanted}: ${sent.reason}`);
  const answer = sent.body || {};
  recordKeyAlias(wanted, answer.key, config, { tracker: answer.provider });
  const state = { binding: bound ? { key: bound.jiraKey } : undefined };
  followKeyAliases(state, cwd, config);
  // Read applies the alias; writing persists it, so the file itself no
  // longer holds the ADHOC node for any older plugin to publish.
  try { writeWorkflows(readWorkflows(config), config); } catch { /* the next read renames it anyway */ }
  return { from: wanted, ...answer };
}

/**
 * Forget the ad hoc key, on disk and on the session.
 *
 * Synchronous and local, because the one other caller is the `Stop`
 * hook, which runs inside a lifecycle budget and must not spend it on
 * the network.
 */
export function clearBinding(cwd, config = {}) {
  for (const file of [localBindingPath(cwd), ...userBindingPaths(cwd, config)]) {
    const held = readJson(file);
    if (held && isAdHocKey(held.jiraKey)) {
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
  }
}

export async function main(args = [], ctx = {}) {
  const { config = {}, info = {}, cwd = process.cwd() } = ctx;
  const print = ctx.print || ((value) => process.stdout.write(`${value}\n`));
  const [sub = 'help', ...rest] = args;

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    print(USAGE);
    return 0;
  }

  const positional = rest.filter((a) => !a.startsWith('--'));
  const flagValue = (name) => {
    const at = rest.indexOf(`--${name}`);
    if (at < 0) return undefined;
    const value = rest[at + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`);
    return value;
  };

  if (sub === 'start') {
    const started = await start(positional.join(' '), cwd, config, info);
    print(`TeamFlow minted ${started.key} — ${started.title}. ${sentLine(started.sent)}`);
    print('Every hook from here on reports against it, exactly as it would a ticket.');
    return 0;
  }

  if (sub === 'title') {
    const renamed = await retitle(positional.join(' '), cwd, config, info);
    print(`${renamed.key} is now "${renamed.title}". ${sentLine(renamed.sent)}`);
    return 0;
  }

  if (sub === 'done') {
    const finished = await done(cwd, config, info, { summary: flagValue('summary') });
    print(`${finished.key} is done and unbound. ${sentLine(finished.sent)}`);
    return 0;
  }

  if (sub === 'convert') {
    // Flag values are not positional: `--project Core` names a project.
    const values = new Set(['--project', '--to'].filter((f) => rest.includes(f)).map((f) => rest[rest.indexOf(f) + 1]));
    const named = rest.find((a) => !a.startsWith('--') && !values.has(a));
    const done = await convertItem(named, { project: flagValue('project'), to: flagValue('to'), merge: rest.includes('--merge') }, cwd, config);
    const how = done.already ? 'was already' : done.created ? 'is now' : 'is linked to';
    print(`${done.from} ${how} ${done.key}${done.url ? ` (${done.url})` : ''}.`
      + (done.state ? ` Status: ${done.state}.` : ''));
    print('The card, its history and every plan that held it follow the ticket; later reports land on it.');
    return 0;
  }

  if (sub === 'show') {
    const bound = boundAdHoc(cwd, config);
    print(bound
      ? `${bound.jiraKey} — ${bound.title || 'no title'} (bound ${bound.boundAt})`
      : 'No ad hoc item is bound.');
    return 0;
  }

  throw new Error(`Unknown adhoc command: ${sub}\n\n${USAGE}`);
}

export default main;
