// Which project this session is in (MACLEOD-565).
//
// A session connects to exactly one project, and it does so by its
// repository: a repository belongs to at most one project per
// organisation, and the service enforces that. Nothing here stamps a
// project onto a report. A project's membership can change after a
// report was written, and the repository the report already carries is
// what decides — so the dashboard filters by project at read time and
// the plugin only ever *says* which project the work will appear under.
// That is the whole reason this module exists: work that lands outside
// every board view is invisible, and nothing else in the plugin says so.
//
// Everything fails open. No credential, no network, no projects module
// on the service: the answer is "unknown" and reporting is untouched.

import path from 'node:path';
import {
  accountScope,
  credential,
  dataDir,
  readJson,
  serviceUrl,
  writeJson,
} from './core.mjs';
import { refusalOf } from './refusal.mjs';

/**
 * The sentence, in one place, because three surfaces say it: `teamflow
 * status`, `teamflow doctor` as a finding, and the SessionStart hook
 * context. Three wordings would be three different problems to a reader.
 */
export const NO_PROJECT_SENTENCE =
  "this repository is in no project; add it from the header's project switcher";

/** What `status` and `doctor` print for a repository in no project. */
export const NO_PROJECT = `none — ${NO_PROJECT_SENTENCE}`;

/**
 * A session outside a repository. There is nothing to match on, so the
 * board it will appear on is whichever project the organisation opens
 * by default — which is a real answer, not a failure, and is why it is
 * not "unknown".
 */
export const NO_REPOSITORY = "the organisation's default";

/** The service could not be asked. Not the same as "in no project". */
export const UNKNOWN_PROJECT = 'unknown';

// Short: a repository is added to a project in the dashboard and the
// terminal should agree within a session, not within a day. A hook
// pays for at most one fetch per window.
const TTL_MS = 5 * 60 * 1000;

/** `macleodlabs-ai/teamflow` → `teamflow`. `src/lib/projectFilter.ts`'s `leaf`. */
function leaf(name) {
  const text = String(name);
  const slash = text.lastIndexOf('/');
  return slash >= 0 ? text.slice(slash + 1) : text;
}

/**
 * The project a repository belongs to, or undefined.
 *
 * Matching is `src/lib/projectFilter.ts`'s, deliberately: case-insensitive,
 * `owner/repo` first and the last path segment as a fallback, so a project
 * that lists `teamflow` still claims `macleodlabs-ai/teamflow`. The full
 * match is tried across *every* project before any fallback is, because
 * two owners may have a repository of the same name and the exact one is
 * the one that is certainly right.
 */
export function projectFor(repository, projects) {
  if (!repository || !Array.isArray(projects)) return undefined;
  const full = String(repository).toLowerCase();
  const tail = leaf(full);
  const has = (project, matches) => (project.repos ?? []).some(
    (repo) => matches(String(repo).toLowerCase()));
  return projects.find((project) => has(project, (repo) => repo === full))
    ?? projects.find((project) => has(project, (repo) => leaf(repo) === tail));
}

/**
 * Beside the workflows, and keyed by the organisation for the same
 * reason (MACLEOD-583).
 *
 * Not by `tenantId`, which is the S3 transport's tenant and is
 * `default` on every service install: one file for two organisations
 * meant a session on B could be told, out of A's cache, that this
 * repository is in one of A's projects — A's project names, read in B's
 * terminal.
 */
export function projectsCachePath(config = {}) {
  return path.join(dataDir(), 'projects', `${accountScope(config)}.json`);
}

/**
 * The organisation's projects, from the cache when it is fresh.
 *
 * A 404 is not a failure: it is a deployment whose service serves no
 * projects route, and an organisation with no projects looks the same
 * from here — both mean "this repository is in no project", which is
 * true and actionable. Anything else that goes wrong is reported as a
 * reason, never as an empty list, because "no projects" and "could not
 * ask" lead a reader to opposite conclusions.
 */
export async function fetchProjects(config = {}, { ttlMs = TTL_MS, timeoutMs, now = Date.now() } = {}) {
  const file = projectsCachePath(config);
  const cached = readJson(file);
  if (Array.isArray(cached?.projects) && Number(cached.fetchedAt) + ttlMs > now) {
    return { ok: true, projects: cached.projects, cached: true };
  }
  const cred = await credential(config);
  if (!cred) return { ok: false, reason: 'no service credential; run /teamflow:login' };
  try {
    const response = await fetch(`${serviceUrl(config)}/v1/members/projects`, {
      headers: { [cred.header]: cred.value },
      redirect: 'error',
      signal: AbortSignal.timeout(Number(timeoutMs || config.serviceTimeoutMs || 5000)),
    });
    let body;
    try { body = await response.json(); } catch { body = undefined; }
    if (response.status === 404) return { ok: true, projects: [] };
    if (!response.ok) {
      return {
        ok: false,
        ...refusalOf(body, `service returned ${response.status}`),
      };
    }
    const projects = Array.isArray(body?.projects) ? body.projects : [];
    // A cache that cannot be written is a slower answer, not a wrong
    // one: a sandboxed agent's data directory is read-only and it must
    // still be told which project it is reporting into.
    try { writeJson(file, { fetchedAt: now, projects }); } catch {}
    return { ok: true, projects };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * What to say about this session's project.
 *
 * `{ line }` is the one string every caller prints; `name` and the two
 * flags are for the caller that has to do something different about it
 * — doctor raises a finding on `none`, the hook stays silent on
 * `unknown`. Never throws.
 */
export async function resolveProject(repository, config = {}, options = {}) {
  // No repository is answered without asking anybody: there is nothing
  // to match, so the answer cannot depend on the service being up.
  if (!repository) return { known: true, line: NO_REPOSITORY };
  let listed;
  try {
    listed = await fetchProjects(config, options);
  } catch (error) {
    listed = { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (!listed.ok) return { known: false, line: UNKNOWN_PROJECT, reason: listed.reason };
  const found = projectFor(repository, listed.projects);
  if (found) return { known: true, id: found.id, name: found.name, line: found.name };
  return { known: true, none: true, line: NO_PROJECT };
}
