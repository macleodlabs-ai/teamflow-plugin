// Which column each piece of work is in (MACLEOD-773).
//
// The owner: "the plugin needs to label each subagent or workflow or task
// with the column that it's in (its sdlc) to help us keep track of things."
// And: the plugin DOWNLOADS the columns from the organisation's or the
// project's pipeline, never a built-in list, custom columns included.
//
//   Local Test · Fixing plugin sign-in · MACLEOD-757
//
// The pipeline is read from the service (`GET /v1/members/pipeline`, the
// project's when this repository is in one) and kept on disk with its
// version. A hook never waits for the network: it reads the kept copy. The
// copy is refreshed by the commands and the heartbeat at most once per
// TTL_MS, and rewritten only when the version moved. Offline, the last copy
// is used, then the default. Which column a stage is in is decided by
// `gateFor` in progress-core.mjs, the board's own rule, built from src/lib.
//
// Nothing here is sent anywhere. The lines are printed for the person and
// given to the session's model as context.
import path from 'node:path';

import { accountScope, agentTaskWords, allActors, credential, dataDir, readJson, serviceUrl, writeJson } from './core.mjs';
import { pipelineOf, workLines } from './progress-core.mjs';
import { projectFor, projectsCachePath } from './project.mjs';

export const TTL_MS = 5 * 60 * 1000;
/** At most this many lines in a hook's context: it is read every turn. */
export const CONTEXT_MAX = 12;

/** The kept copy of this organisation's (and project's) pipeline. */
export function pipelineCachePath(config = {}, project = undefined) {
  const scope = `${accountScope(config)}${project ? `--${String(project).replace(/[^A-Za-z0-9_-]/g, '')}` : ''}`;
  return path.join(dataDir(), 'pipelines', `${scope}.json`);
}

/** The pipeline's version: when it was last changed, else what its columns are. */
export function pipelineVersion(pipeline = {}) {
  if (pipeline.updatedAt) return String(pipeline.updatedAt);
  return JSON.stringify((pipeline.gates || []).map((gate) => [gate.id, gate.label, gate.stages]));
}

/** The kept pipeline, else the default. Never the network: hooks read this. */
export function cachedPipeline(config = {}, project = undefined) {
  const held = readJson(pipelineCachePath(config, project)) || (project ? readJson(pipelineCachePath(config)) : undefined);
  return pipelineOf(held?.pipeline);
}

/**
 * The pipeline from the service when the kept copy is older than TTL_MS, else
 * the kept copy. Offline or refused: the kept copy, then the default. Returns
 * `{ pipeline, source, fetched, changed }`. Never throws.
 */
export async function loadPipeline(config = {}, { project, ttlMs = TTL_MS, now = Date.now(), fetcher = fetch, timeoutMs } = {}) {
  const file = pipelineCachePath(config, project);
  const held = readJson(file);
  if (held?.pipeline && Number(held.fetchedAt) + ttlMs > now) {
    return { pipeline: pipelineOf(held.pipeline), source: held.source || 'org', fetched: false, changed: false };
  }
  const kept = () => ({ pipeline: cachedPipeline(config, project), source: held?.source || 'default', fetched: false, changed: false });
  try {
    const cred = await credential(config);
    if (!cred) return kept();
    const query = project ? `?project=${encodeURIComponent(project)}` : '';
    const response = await fetcher(`${serviceUrl(config)}/v1/members/pipeline${query}`, {
      headers: { [cred.header]: cred.value },
      redirect: 'error',
      signal: AbortSignal.timeout(Number(timeoutMs || config.serviceTimeoutMs || 5000)),
    });
    if (!response.ok) return kept();
    const body = await response.json();
    const pipeline = pipelineOf(body?.pipeline);
    const changed = pipelineVersion(held?.pipeline || {}) !== pipelineVersion(body?.pipeline || {});
    // A copy that cannot be written is a slower answer, not a wrong one.
    try {
      writeJson(file, changed || !held
        ? { fetchedAt: now, version: pipelineVersion(body?.pipeline || {}), source: body?.source, pipeline: body?.pipeline }
        : { ...held, fetchedAt: now });
    } catch {}
    return { pipeline, source: body?.source || 'org', fetched: true, changed };
  } catch {
    return kept();
  }
}

/**
 * What this machine is working on, from its own actor files: each agent and
 * session with a ticket, its stage and its task in plain words. Ended ones
 * are left out unless `ended` is set. Local files only.
 */
export function localWork({ sessionId, actors = allActors(), ended = false } = {}) {
  const items = [];
  for (const actor of actors) {
    if (sessionId && actor.sessionId !== sessionId) continue;
    if (!ended && actor.ended) continue;
    const key = actor.binding?.key;
    if (!key) continue;
    const task = agentTaskWords([actor.agent?.task, actor.agent?.name, actor.jira?.title, actor.binding?.title]);
    items.push({ key, task, stage: actor.stage, reworkFrom: actor.reworkFrom, running: Boolean(actor.agentKey) });
  }
  return items;
}

/**
 * Every piece this session has: its own and its agents' tickets, ended ones
 * too, then each agent it dispatched that has not reported yet (in Backlog).
 */
export function sessionWork(sessionId, { actors, launches = [] } = {}) {
  const items = localWork({ sessionId, actors, ended: true });
  const held = new Set(items.map((item) => item.key));
  for (const launch of launches) {
    if (launch?.key && !held.has(launch.key)) items.push({ key: launch.key, task: launch.title, stage: 'BACKLOG' });
  }
  return items;
}

/** The newest stage this machine saw for each key, for a plan's items. */
export function stagesByKey(actors = allActors()) {
  const out = new Map();
  for (const actor of [...actors].sort((a, b) => String(a.updatedAt || '').localeCompare(String(b.updatedAt || '')))) {
    const key = actor.binding?.key;
    if (key && actor.stage) out.set(key, { stage: actor.stage, reworkFrom: actor.reworkFrom });
  }
  return out;
}

/** A plan's open items, each where this machine last saw it (Backlog when it never did). */
export function planWork(run = {}, { actors } = {}) {
  const stages = stagesByKey(actors);
  return (run.tickets || [])
    .filter((node) => node?.key && !['done', 'skipped'].includes(node.state))
    .map((node) => ({ key: node.key, task: node.title || node.summary, ...(stages.get(node.key) || { stage: 'BACKLOG' }) }));
}

/** The project this repository is in, from the kept list only (a hook never waits). */
export function cachedProjectId(config = {}, repository = undefined) {
  const held = readJson(projectsCachePath(config));
  return projectFor(repository, held?.projects)?.id;
}

/** `<column> · <plain task> · <KEY>` for each item, in column order. */
export function linesFor(items, pipeline) {
  return workLines(items, pipeline);
}

/**
 * The hook's line for the session's model (MACLEOD-773): where each running
 * agent's piece is, so it can say without asking. Undefined when no agent of
 * this session is running. Reads the kept pipeline only.
 */
export function contextLine(config = {}, sessionId = undefined, { actors, repository } = {}) {
  const project = cachedProjectId(config, repository);
  const running = localWork({ sessionId, actors }).filter((item) => item.running);
  if (!running.length) return undefined;
  const lines = linesFor(running, cachedPipeline(config, project)).slice(0, CONTEXT_MAX);
  return `TeamFlow: where each agent's work is: ${lines.join('; ')}.`;
}
