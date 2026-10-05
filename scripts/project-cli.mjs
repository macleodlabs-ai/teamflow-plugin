// `teamflow project`, `teamflow thread` and the old `teamflow task`
// (MACLEOD-982, docs/PROJECTS.md section 5).
//
//   teamflow project                         this session's project and its threads
//   teamflow project list [--mine]           open projects across the team, with badges
//   teamflow project create "<name>" [--link linear|jira|github[:"<name>"]]...
//   teamflow project use <id|name>
//   teamflow project link linear|jira|github ["<name>"] [--project <id|name>]
//   teamflow project unlink linear|jira|github "<name>"
//   teamflow project end [--close]
//   teamflow thread [new "<purpose>" | <id> | list]
//
// Every answer is one plain sentence; where the service gives a
// `message`, that is what is printed. A name that matches more than one
// project lists the matches and changes nothing.

import {
  isAdHocKey, latestSessionForCwd, localBindingPath, readJson, readUserBinding, saveSession, sessionPath, takesNoWork,
  publishState,
} from './core.mjs';
import { fetchProjects } from './project.mjs';
import {
  cachedProjects, clearPin, effectiveProject, findThread, newThreadId, noteThreadCard, openThreads, recentPins,
  recordThread, rememberProject, request, setPin, syncThreads,
} from './pin.mjs';
import { NAME_MAX, THREAD_ID, badge, cleanPin, cleanThread, isClosed, projectWords } from './pin-line.mjs';

export const PROJECT_USAGE = 'Usage: teamflow project [list [--mine] | create "<name>" [--link linear|jira|github[:"<name>"]]... '
  + '| use <id|name> | link linear|jira|github ["<name>"] [--project <id|name>] | unlink linear|jira|github "<name>" | end [--close]]';
export const THREAD_USAGE = 'Usage: teamflow thread [new "<purpose>" | <id> | list]';
const PROVIDERS = new Set(['linear', 'jira', 'github']);
const clean = (text, max = NAME_MAX) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
const said = (got, fallback) => clean(got?.body?.message, 300) || fallback;

function sessionOf({ sessionId, cwd, config, env = process.env }) {
  if (sessionId) return sessionId;
  if (env.TEAMFLOW_SESSION_ID) return env.TEAMFLOW_SESSION_ID;
  try { return latestSessionForCwd(cwd || process.cwd(), config)?.sessionId; } catch { return undefined; }
}

/** The team's projects, read fresh for a command; the cache when the service cannot be asked. */
async function projectsNow(config, fetchList) {
  const got = await (fetchList || ((c) => fetchProjects(c, { ttlMs: 0 })))(config);
  if (got?.ok) return got.projects || [];
  return cachedProjects(config).projects || [];
}

/** One project by id or name: `{project}`, `{matches}` for more than one, or `{}` for none. */
export function matchProject(projects = [], wanted = '') {
  const want = clean(wanted).toLowerCase();
  if (!want) return {};
  const open = projects.filter((p) => !isClosed(p));
  const byId = projects.find((p) => p.id === want);
  if (byId) return { project: byId };
  const exact = open.filter((p) => String(p.name || '').toLowerCase() === want);
  if (exact.length === 1) return { project: exact[0] };
  if (exact.length > 1) return { matches: exact };
  const part = open.filter((p) => String(p.name || '').toLowerCase().includes(want));
  if (part.length === 1) return { project: part[0] };
  return part.length ? { matches: part } : {};
}

const listed = (matches) => matches.slice(0, 8).map((p) => `${p.id} ${projectWords(p)}`).join(', ');

/** `--link linear:"Payments"` → `{provider, name}`; a bare provider takes `fallback`. */
export function parseLink(value, fallback = {}) {
  const text = String(value || '').trim();
  const at = text.indexOf(':');
  const provider = (at >= 0 ? text.slice(0, at) : text).toLowerCase();
  if (!PROVIDERS.has(provider)) return undefined;
  const name = clean((at >= 0 ? text.slice(at + 1) : '').replace(/^["']|["']$/g, ''), 200) || fallback[provider];
  return name ? { provider, name } : { provider };
}

function take(args, flag) {
  const out = [];
  const rest = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && i + 1 < args.length) { out.push(args[i + 1]); i += 1; continue; }
    if (args[i].startsWith(`${flag}=`)) { out.push(args[i].slice(flag.length + 1)); continue; }
    rest.push(args[i]);
  }
  return { values: out, rest };
}

function linkedWords(linked = []) {
  const names = (Array.isArray(linked) ? linked : [linked]).filter(Boolean)
    .map((l) => `${l.name || l.id} (${{ linear: 'Linear', jira: 'Jira', github: 'GitHub' }[l.provider] || l.provider})`);
  return names.length ? ` Linked to ${names.join(', ')}.` : '';
}

/** The session's pin and threads, as `teamflow project` and `teamflow status` say it. */
export function pinWords(state = {}, { config = {}, repository } = {}) {
  const found = effectiveProject(state, { config, repository });
  if (!found) return { project: 'none', thread: undefined };
  const thread = cleanThread(state.thread);
  return {
    project: `${projectWords(found.project)}${found.viaRepo ? ", this repository's default" : ''} (${found.project.id})`,
    thread: thread ? `"${thread.name}" (${thread.id})` : undefined,
  };
}

// --- a thread's card (MACLEOD-970, MACLEOD-973) ----------------------------

/** A bind by hand this recent keeps the session from a new thread's card. */
export const KEEP_MANUAL_MS = 10 * 60 * 1000;

/**
 * The ticket `thread new` must not take the session from (MACLEOD-973), or
 * undefined: a key the person bound by hand in the last few minutes, or an
 * open tracker ticket the session is bound to. A finished ticket takes no
 * new work, so it keeps nothing.
 */
export function keptTicket(sessionId, { cwd, config = {}, now = Date.now() } = {}) {
  const recent = (b) => b?.source === 'manual' && now - (Date.parse(b.boundAt || '') || 0) <= KEEP_MANUAL_MS;
  const state = readJson(sessionPath(sessionId)) || {};
  const files = [];
  try {
    const dir = cwd || state.cwd;
    if (dir) files.push(readJson(localBindingPath(dir)), readUserBinding(dir, config));
  } catch { /* no binding file: the session's own binding decides */ }
  const fromFiles = files.filter((f) => f?.jiraKey)
    .map((f) => ({ key: f.jiraKey, source: 'manual', boundAt: f.boundAt }))
    .filter((b) => recent(b) && !takesNoWork(b))
    .sort((a, b) => String(b.boundAt).localeCompare(String(a.boundAt)))[0];
  if (fromFiles) return fromFiles.key;
  const b = state.binding;
  if (!b?.key || takesNoWork(b)) return undefined;
  if (recent(b)) return b.key;
  if (!isAdHocKey(b.key)) return b.key;
  return undefined;
}

/**
 * The thread's ad hoc card, bound to this session only. `adhoc start`
 * writes the working copy's binding, which would move every other session
 * in the repository onto this card; this writes the session's own state.
 * Source `task`: sticky against a branch key, never ended by the end of a
 * turn.
 */
export async function sessionThreadCard(title, sessionId, {
  config = {}, info = {}, now = Date.now(), mintKey, publish = publishState,
} = {}) {
  const state = readJson(sessionPath(sessionId));
  if (!state?.sessionId) throw new Error('TeamFlow has no record of this session yet');
  const adhoc = await import('./adhoc.mjs');
  const minted = await (mintKey || adhoc.mint)(config);
  if (!minted?.ok) throw new Error(minted?.reason || 'the service did not answer');
  const at = new Date(now).toISOString();
  state.binding = { key: minted.key, tracker: adhoc.TRACKER, confidence: 1000, source: 'task', sticky: true, boundAt: at };
  state.jira = { key: minted.key, title };
  state.status = 'running';
  state.summary = 'Ad hoc work started';
  state.updatedAt = at;
  saveSession(state);
  try { await publish(state, config, info, { force: true }); } catch { /* the next hook event reports it */ }
  return { key: minted.key, title };
}

// --- `teamflow project` -----------------------------------------------------

export async function projectMain(args = [], {
  config = {}, cwd, info = {}, sessionId, ask = request, fetchList, print = console.log, now = Date.now(), env = process.env,
} = {}) {
  const [verb, ...rest] = args;
  const session = sessionOf({ sessionId, cwd, config, env });
  const state = session ? readJson(sessionPath(session)) || {} : {};
  const needSession = () => {
    if (session) return true;
    print('TeamFlow cannot tell which session this is. Run the command from the session.');
    return false;
  };

  if (!verb || verb === 'show') {
    const words = pinWords(state, { config, repository: info.repository });
    if (words.project === 'none') {
      print('This session is in no project. Run `teamflow project use <id|name>`, or `teamflow project create "<name>"` for new work.');
      return 0;
    }
    const found = effectiveProject(state, { config, repository: info.repository });
    const current = cleanThread(state.thread)?.id;
    const threads = openThreads(found.project.id, { config, current, now });
    print(`This session is in project ${words.project}.`);
    print(threads.length
      ? `Threads: ${threads.map((t) => `${t.id} "${t.name}"${t.id === current ? ' (current)' : ''}`).join(', ')}.`
      : 'It has no threads yet. One starts with the next edit, agent or commit.');
    return 0;
  }

  if (verb === 'list') {
    const mine = rest.includes('--mine');
    const projects = (await projectsNow(config, fetchList)).filter((p) => !isClosed(p));
    let shown = projects;
    if (mine) {
      const recent = new Set(recentPins().map((e) => e.project));
      let email;
      try { email = (await import('./auth.mjs')).readSession()?.email; } catch { email = undefined; }
      shown = projects.filter((p) => recent.has(p.id) || (email && p.createdBy === email));
    }
    if (!shown.length) {
      print(mine ? 'You have no open projects.' : 'Your team has no open projects. Run `teamflow project create "<name>"` to make one.');
      return 0;
    }
    const pinned = cleanPin(state.project)?.id;
    for (const p of shown.slice(0, 50)) print(`${p.id}  ${p.name}${badge(p) ? ` ${badge(p)}` : ''}${p.id === pinned ? '  (this session)' : ''}`);
    return 0;
  }

  if (verb === 'create') {
    const { values, rest: words } = take(rest, '--link');
    const name = clean(words.filter((w) => !w.startsWith('--')).join(' '));
    if (!name) { print(PROJECT_USAGE); return 2; }
    const fallback = { linear: name, jira: name, github: info.repository };
    const links = values.map((v) => parseLink(v, fallback));
    if (links.some((l) => !l || !l.name)) {
      print('A link is linear, jira or github, with an optional name after a colon: --link linear:"Payments".');
      return 2;
    }
    const got = await ask('POST', '/projects', { name, ...(links.length ? { link: links } : {}) }, config);
    if (!got.ok || !got.body?.project?.id) {
      print(said(got, got.status === 0 ? 'TeamFlow could not reach the service, so it made no project.' : `TeamFlow could not make the project (${got.status}).`));
      return 1;
    }
    const project = got.body.project;
    rememberProject(project, config);
    if (session) setPin(session, project, { cwd, config, now });
    print(said(got, `New project "${project.name}".${linkedWords(got.body.linked)}`)
      + (session ? ' This session is in it now.' : ''));
    return 0;
  }

  if (verb === 'use') {
    if (!rest.length) { print(PROJECT_USAGE); return 2; }
    if (!needSession()) return 1;
    const found = matchProject(await projectsNow(config, fetchList), rest.join(' '));
    if (found.matches) {
      print(`More than one project matches. Run it again with the id: ${listed(found.matches)}.`);
      return 1;
    }
    if (!found.project) { print('TeamFlow has no open project with that id or name.'); return 1; }
    if (isClosed(found.project)) { print(`Project "${found.project.name}" is closed. Reopen it in TeamFlow first.`); return 1; }
    setPin(session, found.project, { cwd, config, now });
    print(`This session is now in project ${projectWords(found.project)}.`);
    return 0;
  }

  if (verb === 'link' || verb === 'unlink') {
    const { values, rest: words } = take(rest, '--project');
    const provider = String(words[0] || '').toLowerCase();
    if (!PROVIDERS.has(provider)) { print(PROJECT_USAGE); return 2; }
    const projects = await projectsNow(config, fetchList);
    let target;
    if (values.length) {
      const found = matchProject(projects, values[0]);
      if (found.matches) { print(`More than one project matches. Run it again with the id: ${listed(found.matches)}.`); return 1; }
      target = found.project;
    } else {
      const pin = cleanPin(state.project);
      target = pin ? projects.find((p) => p.id === pin.id) || pin : undefined;
    }
    if (!target) {
      print(values.length ? 'TeamFlow has no open project with that id or name.' : 'This session is in no project. Name one with --project <id|name>.');
      return 1;
    }
    const name = clean(words.slice(1).join(' '), 200) || (verb === 'link' ? { linear: target.name, jira: target.name, github: info.repository }[provider] : '');
    if (!name) { print(PROJECT_USAGE); return 2; }
    if (verb === 'unlink') {
      const refs = provider === 'github' ? (target.repos || []).map((r) => ({ id: r, name: r }))
        : (target[provider] || []).map((r) => ({ id: r.id || r.key, name: r.name || r.key || r.id }));
      const want = name.toLowerCase();
      const ref = refs.find((r) => String(r.id).toLowerCase() === want || String(r.name).toLowerCase() === want);
      const got = await ask('POST', `/projects/${target.id}/unlink`, { provider, id: ref?.id || name }, config);
      if (got.ok && got.body?.project) rememberProject(got.body.project, config);
      print(said(got, got.ok ? `Project "${target.name}" is no longer linked to ${name}.` : `TeamFlow could not unlink ${name} (${got.status || 'no answer'}).`));
      return got.ok ? 0 : 1;
    }
    // Ruling 3: a Linear project with no match is made only when the
    // organisation lets TeamFlow update its tracker. The service decides.
    const got = await ask('POST', `/projects/${target.id}/link`, { provider, name, ...(provider === 'linear' ? { create: true } : {}) }, config);
    if (got.ok) {
      if (got.body?.project) rememberProject(got.body.project, config);
      print(said(got, `Project "${target.name}" is linked to ${got.body?.linked?.name || name}.`));
      return 0;
    }
    const matches = Array.isArray(got.body?.matches) ? got.body.matches : [];
    if (got.status === 409 && matches.length) {
      print(`More than one ${provider} project matches "${name}". Run it again with one of these: ${matches.slice(0, 8).map((m) => `${m.id} "${m.name}"`).join(', ')}.`);
      return 1;
    }
    print(said(got, got.status === 404 ? `TeamFlow found no ${provider} project called "${name}".` : `TeamFlow could not link ${name} (${got.status || 'no answer'}).`));
    return 1;
  }

  if (verb === 'end') {
    if (!needSession()) return 1;
    const pin = cleanPin(state.project);
    if (!pin) { print('This session is in no project.'); return 0; }
    if (rest.includes('--close')) {
      const got = await ask('POST', `/projects/${pin.id}/close`, {}, config);
      if (!got.ok) {
        print(said(got, `TeamFlow could not close project "${pin.name}" (${got.status || 'no answer'}). The session stays in it.`));
        return 1;
      }
      if (got.body?.project) rememberProject(got.body.project, config);
      clearPin(session, { cwd, config, now });
      print(said(got, `Project "${pin.name}" is closed, and this session left it.`));
      return 0;
    }
    clearPin(session, { cwd, config, now });
    print(`This session left project "${pin.name}". A restart here will not bring it back.`);
    return 0;
  }

  print(PROJECT_USAGE);
  return 2;
}

// --- `teamflow thread` -------------------------------------------------------

export async function threadMain(args = [], {
  config = {}, cwd, info = {}, sessionId, ask = request, print = console.log, now = Date.now(), env = process.env,
  startCard, mintKey, publish,
} = {}) {
  const [verb, ...rest] = args;
  const session = sessionOf({ sessionId, cwd, config, env });
  if (!session) {
    print('TeamFlow cannot tell which session this is. Run the command from the session.');
    return 1;
  }
  const state = readJson(sessionPath(session)) || { sessionId: session, ...(cwd ? { cwd } : {}) };
  const found = effectiveProject(state, { config, repository: info.repository });
  if (!found) {
    print('This session is in no project. Run `teamflow project create "<name>"` or `teamflow project use <id|name>` first.');
    return 1;
  }
  const current = cleanThread(state.thread)?.id;

  if (!verb || verb === 'list') {
    const threads = openThreads(found.project.id, { config, current, now });
    print(threads.length
      ? `Threads in "${found.project.name}": ${threads.map((t) => `${t.id} "${t.name}"${t.id === current ? ' (current)' : ''}`).join(', ')}.`
      : `Project "${found.project.name}" has no threads yet.`);
    return 0;
  }

  if (verb === 'new') {
    const name = clean(rest.join(' '));
    if (!name) { print(THREAD_USAGE); return 2; }
    let card;
    let reason;
    // A ticket the person chose keeps the session (MACLEOD-973): no card
    // is minted and the binding stays; the thread works on that ticket.
    const kept = keptTicket(session, { cwd, config, now });
    try {
      card = kept ? { key: kept, kept: true }
        : await (startCard ? startCard(name) : sessionThreadCard(name, session, { config, info, now, mintKey, publish }));
    } catch (error) {
      reason = clean(error instanceof Error ? error.message : String(error), 200);
    }
    const fresh = readJson(sessionPath(session)) || state;
    if (!cleanPin(fresh.project)) fresh.project = cleanPin({ ...found.project, by: 'repo' });
    const thread = recordThread({ id: newThreadId(), name, project: fresh.project.id, key: card?.key, now });
    fresh.thread = { id: thread.id, name: thread.name };
    fresh.updatedAt = new Date(now).toISOString();
    saveSession(fresh);
    await syncThreads(config, { ask, only: thread.id }).catch(() => 0);
    if (card?.kept) print(`New thread "${name}" in project "${found.project.name}", on card ${card.key}.`);
    else if (card?.key) print(`New thread "${name}" in project "${found.project.name}". Card ${card.key} is on the board.`);
    else print(`New thread "${name}" in project "${found.project.name}". TeamFlow could not add its card: ${reason || 'no reason given'}.`);
    return 0;
  }

  if (THREAD_ID.test(verb) && !rest.length) {
    const known = findThread(verb, config);
    if (!known || (known.project && known.project !== found.project.id)) {
      print(`Project "${found.project.name}" has no thread ${verb}.`);
      return 1;
    }
    const fresh = readJson(sessionPath(session)) || state;
    if (!cleanPin(fresh.project)) fresh.project = cleanPin({ ...found.project, by: 'repo' });
    fresh.thread = { id: verb, name: clean(known.name) || verb };
    // Back to the thread's own card, when it has one and the session is on
    // a thread's card or none: a card a person chose stays.
    if (known.key && (!fresh.binding?.key || fresh.binding.source === 'task') && fresh.binding?.key !== known.key) {
      fresh.binding = { key: known.key, tracker: isAdHocKey(known.key) ? 'teamflow' : fresh.binding?.tracker, confidence: 1000, source: 'task', sticky: true, boundAt: new Date(now).toISOString() };
    }
    fresh.updatedAt = new Date(now).toISOString();
    saveSession(fresh);
    noteThreadCard(verb, known.key, now);
    print(`This session now works on thread "${fresh.thread.name}".`);
    return 0;
  }

  print(THREAD_USAGE);
  return 2;
}

// --- `teamflow task`: the old words, for two plugin versions ----------------

const ALIAS = { new: 'create', in: 'use', show: 'show' };

/** `task new|in|show` run `project create|use|show`, and say the new command once. */
export async function taskAlias(args = [], options = {}) {
  const [verb, ...rest] = args;
  const print = options.print || console.log;
  const to = ALIAS[verb || 'show'];
  if (!to) { print('Usage: teamflow task new "<name>" | in <id> | show. These are now `teamflow project create`, `use` and `project`.'); return 2; }
  const command = to === 'show' ? 'teamflow project' : `teamflow project ${to}`;
  print(`\`teamflow task ${verb || 'show'}\` is now \`${command}\`.`);
  return projectMain([to, ...rest], options);
}
