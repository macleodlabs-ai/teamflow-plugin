// `teamflow progress` (MACLEOD-726): the progress of all current and
// remaining work, as the Markdown table the dashboard's Progress view shows.
//
// Read-only. It reads the organisation's bundle with the credential a report
// goes out under (`fetchState`, the dashboard's own route) and runs the
// dashboard's own rules on it (`progress-core.mjs`, built from
// src/lib/progressCli.ts), so the numbers are the page's numbers. Nothing is
// written and nothing is sent anywhere else.
import { fetchState } from './core.mjs';
import { progressText } from './progress-core.mjs';

export const PROGRESS_USAGE = 'teamflow progress [--csv | --line]   the progress of all current and remaining work, as a table';

/**
 * Prints the table and returns the exit code: 0 with a table, 1 when the
 * bundle could not be read. `ctx.read` and `ctx.now` are for tests.
 */
export async function main(args = [], ctx = {}) {
  const { config = {} } = ctx;
  const print = ctx.print || ((value) => process.stdout.write(value));
  const fail = ctx.fail || ((value) => process.stderr.write(`${value}\n`));
  const read = ctx.read || fetchState;
  const format = args.includes('--csv') ? 'csv' : args.includes('--line') ? 'line' : 'markdown';

  // The whole board in one response is bigger than the one document the
  // default five seconds was set for.
  const result = await read('bundle', { ...config, serviceTimeoutMs: Math.max(Number(config.serviceTimeoutMs) || 0, 30000) });
  if (!result.ok || !result.document) {
    fail(`TeamFlow could not read your board: ${result.missing ? 'the service has nothing for this organisation yet' : result.reason}.`);
    fail('Run `teamflow doctor` to see why.');
    return 1;
  }
  print(progressText(result.document, ctx.now ?? Date.now(), format));
  return 0;
}

export default main;
