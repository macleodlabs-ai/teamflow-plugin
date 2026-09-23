// Video evidence of a passing Playwright run, on the ticket (MACLEOD-639).
//
// The owner's ruling: the video goes straight from this machine to the
// tracker, and the service records only that one was attached. So this
// module is the only thing that ever touches a video file, and it sends it
// to one of two places the SERVICE names for the ticket:
//
//   * GitHub: the developer's own `gh`, `gh issue comment --attach`, as the
//     developer. gh 2.99 or later; an older one is said, never guessed at.
//   * Linear: a pre-signed upload link the service asked Linear for with the
//     organisation's connection, then one call so the service links it.
//
// Nothing received is run: gh's arguments are built here from the service's
// answer after checking their shape (an `owner/repo`, a whole number), with
// no shell. Only when the organisation's Playwright step asks for videos on
// tickets, and only for videos written by the run that just passed.
//
// Runs in the background (`node video-evidence.mjs <key> <cwd> <sinceMs>`),
// started by the hook after the passing run is reported, so an upload never
// holds up the session. What happened is left for the next session start.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const GH_MIN = [2, 99, 0];
export const MAX_FILES = 3;
const MAX_BYTES = 100 * 1024 * 1024;
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const NOTICES = 'video-notices.json';
const SENT = 'video-sent.json';

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return undefined; }
}

/** The run's videos: `.webm` under test-results, written since `sinceMs`, newest first. */
export function findVideos(root, sinceMs, { max = MAX_FILES } = {}) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 5) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name.endsWith('.webm')) {
        const stat = fs.statSync(full);
        if (stat.mtimeMs >= sinceMs && stat.size > 0 && stat.size <= MAX_BYTES) found.push({ file: full, mtimeMs: stat.mtimeMs, size: stat.size });
      }
    }
  };
  walk(path.join(root, 'test-results'), 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, max);
}

/** `gh version 2.99.0 (...)` -> is it new enough for --attach. */
export function ghNewEnough(versionText) {
  const got = /gh version (\d+)\.(\d+)\.(\d+)/.exec(String(versionText || ''));
  if (!got) return false;
  const [a, b, c] = got.slice(1).map(Number);
  for (const [have, want] of [[a, GH_MIN[0]], [b, GH_MIN[1]], [c, GH_MIN[2]]]) {
    if (have !== want) return have > want;
  }
  return true;
}

/** Run a program with arguments and no shell: { code, out }. */
export function run(bin, args, { cwd } = {}) {
  return new Promise((resolve) => {
    let out = '';
    try {
      const child = spawn(bin, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('error', () => resolve({ code: -1, out }));
      child.on('close', (code) => resolve({ code, out }));
    } catch { resolve({ code: -1, out }); }
  });
}

/** The gh arguments for one comment, from the service's answer, checked. */
export function ghArgs(answer, files) {
  if (!REPO.test(String(answer?.repo || ''))) throw new Error('not a GitHub repository');
  const number = Number(answer?.number);
  if (!Number.isInteger(number) || number <= 0) throw new Error('not a GitHub issue number');
  const body = String(answer?.sentence || 'Playwright tests passed.').slice(0, 300);
  return ['issue', 'comment', String(number), '--repo', answer.repo, '--body', body,
    ...files.flatMap((f) => ['--attach', f.file])];
}

/**
 * Attach the videos to `key`'s ticket. Answers one plain sentence for the
 * developer. `post(path, body)` calls the service as this machine;
 * `put(url, headers, file)` uploads; `gh(args)` runs gh.
 */
export async function attach({ key, files, post, put, gh }) {
  if (!files.length) return undefined;
  const first = files[0];
  const where = await post('/v1/evidence/video/start', {
    key, filename: path.basename(first.file), content_type: 'video/webm', size: first.size,
  });
  if (!where.ok) return `The Playwright video stayed on your machine: ${where.message}`;
  const answer = where.body;
  if (answer.provider === 'github') {
    const version = await gh(['--version']);
    if (version.code !== 0) return 'The Playwright video stayed on your machine: install the GitHub CLI and sign in to attach it.';
    if (!ghNewEnough(version.out)) return 'The Playwright video stayed on your machine: update the GitHub CLI to 2.99 or later to attach it.';
    const done = await gh(ghArgs(answer, files));
    return done.code === 0
      ? `The Playwright video is on ${key}.`
      : `The Playwright video stayed on your machine: GitHub refused it (${done.out.trim().slice(0, 120)}).`;
  }
  if (answer.provider === 'linear') {
    // One video: the newest. Each upload link is for one file of one size.
    const sent = await put(answer.upload_url, { ...answer.headers, 'Content-Type': 'video/webm' }, first.file);
    if (!sent) return 'The Playwright video stayed on your machine: Linear did not take the upload.';
    const linked = await post('/v1/evidence/video/done', { key, asset_url: answer.asset_url, receipt: answer.receipt, expires: answer.expires });
    return linked.ok ? `The Playwright video is on ${key}.` : `TeamFlow uploaded the Playwright video but could not link it: ${linked.message}`;
  }
  return undefined;
}

/** Leave a line for the next session start; read and cleared there. */
export function leaveNotice(dir, line) {
  if (!dir || !line) return;
  const file = path.join(dir, NOTICES);
  const held = readJson(file);
  const lines = Array.isArray(held) ? held : [];
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify([...lines, line].slice(-5))); } catch { /* said nowhere, then */ }
}

export function takeNotices(dir) {
  if (!dir) return [];
  const file = path.join(dir, NOTICES);
  const held = readJson(file);
  if (!Array.isArray(held) || !held.length) return [];
  try { fs.unlinkSync(file); } catch { /* read once anyway */ }
  return held.map((line) => `TeamFlow: ${line}`);
}

/** Files already sent, so a rerun of the same passing videos is not attached twice. */
function unsent(dir, files) {
  const file = path.join(dir || '', SENT);
  const held = (dir && readJson(file)) || {};
  const fresh = files.filter((f) => held[f.file] !== f.mtimeMs);
  return { fresh, remember: (sent) => {
    if (!dir) return;
    const next = { ...held };
    for (const f of sent) next[f.file] = f.mtimeMs;
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(next)); } catch { /* may send again */ }
  } };
}

async function main([key, cwd, since]) {
  const core = await import('./core.mjs');
  const { repoRoot } = await import('./check-presets.mjs');
  const config = core.loadConfig(cwd);
  const dir = (() => { try { return core.dataDir(); } catch { return undefined; } })();
  const root = repoRoot(cwd);
  if (!key || !root) return;
  const { fresh, remember } = unsent(dir, findVideos(root, Number(since) || 0));
  if (!fresh.length) return;
  const { credential, serviceUrl } = core;
  const post = async (route, body) => {
    const cred = await credential(config);
    if (!cred) return { ok: false, message: 'this machine is not signed in to TeamFlow' };
    try {
      const response = await fetch(`${serviceUrl(config)}${route}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { [cred.header]: cred.value, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const got = await response.json().catch(() => ({}));
      return response.ok ? { ok: true, body: got } : { ok: false, message: String(got.message || response.status) };
    } catch (error) {
      return { ok: false, message: 'TeamFlow could not be reached' };
    }
  };
  const put = async (url, headers, file) => {
    if (!/^https:\/\/[a-z0-9.-]+\//i.test(url)) return false;
    try {
      // Linear's own pre-signed link: no TeamFlow credential goes with it.
      const response = await fetch(url, { method: 'PUT', headers, body: fs.readFileSync(file), redirect: 'error', signal: AbortSignal.timeout(120_000) });
      return response.ok;
    } catch { return false; }
  };
  const gh = (args) => run('gh', args, { cwd: root });
  const line = await attach({ key, files: fresh, post, put, gh });
  if (line && line.startsWith('The Playwright video is on')) remember(fresh);
  leaveNotice(dir, line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {}).finally(() => process.exit(0));
}
