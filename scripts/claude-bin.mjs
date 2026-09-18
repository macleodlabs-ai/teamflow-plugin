// The one door to the real `claude` binary.
//
// A real `claude` started with HOME or CLAUDE_CONFIG_DIR pointing at a
// sandbox cannot reach the login keychain: macOS shows "A keychain cannot
// be found to store <user>" once per attempt and Claude Code writes a
// fallback credentials file into whatever config directory it was given.
// That happened twice. So nothing in this repository spawns `claude`
// directly; everything asks here, and here says no unless it is plainly
// a developer's own interactive environment or a test has pointed at a
// stub. `plugin/tests/claude-spawn-guard.test.mjs` fails the build on a
// spawn site that bypasses this file.
import os from 'node:os';
import path from 'node:path';

const TEMP_ROOTS = ['/tmp/', '/private/tmp/', '/var/folders/', '/private/var/folders/'];

function underTemp(p) {
  if (!p) return false;
  const resolved = path.resolve(p) + '/';
  const tmp = path.resolve(os.tmpdir()) + '/';
  return resolved.startsWith(tmp) || TEMP_ROOTS.some((root) => resolved.startsWith(root));
}

/**
 * Why the real binary is off limits right now, or null when it is fine.
 * Exported so `doctor` can say the reason instead of a bare "skipped".
 */
export function realClaudeBlockedReason(env = process.env) {
  if (env.TEAMFLOW_ALLOW_REAL_CLAUDE === '1') return null;
  if (env.NODE_TEST_CONTEXT || env.TEST_WORKER_INDEX || env.PLAYWRIGHT_TEST_BASE_URL || env.CI === 'true') {
    return 'running under a test runner';
  }
  let home;
  try { home = os.userInfo().homedir; } catch { home = undefined; }
  if (home && env.HOME && path.resolve(env.HOME) !== path.resolve(home)) {
    return `HOME is redirected to ${env.HOME}`;
  }
  if (underTemp(env.HOME)) return `HOME is a temporary directory (${env.HOME})`;
  if (underTemp(env.CLAUDE_CONFIG_DIR)) return `CLAUDE_CONFIG_DIR is a temporary directory (${env.CLAUDE_CONFIG_DIR})`;
  return null;
}

/**
 * The binary to spawn: a test's stub (TEAMFLOW_CLAUDE_BIN), the real
 * `claude` when this is plainly a developer's own environment, or null
 * with the reason on `reason` when it must not be started.
 */
export function claudeBinary(env = process.env) {
  if (env.TEAMFLOW_CLAUDE_BIN) return { bin: env.TEAMFLOW_CLAUDE_BIN, reason: null };
  const reason = realClaudeBlockedReason(env);
  return reason ? { bin: null, reason } : { bin: 'claude', reason: null };
}
