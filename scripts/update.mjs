// `teamflow update` and `/teamflow:update` (MACLEOD-770, MACLEOD-766 spec
// point 1): the Status update from the board, the words a manager pastes:
//
//   Live now  ->  Merged but not deployed yet  ->  Still being built  ->  Needs you
//
// Read-only, like `teamflow progress`: the organisation's bundle with the
// credential a report goes out under, and the dashboard's own code
// (`statusUpdateText`, bundled from src/lib/statusUpdate.ts into
// progress-core.mjs), so the groups and the words are the ones Home draws
// (MACLEOD-774). Each row's words are the card's plain line (`say.line`,
// written by the model doing the work), else its title made plain.

import { fetchState } from './core.mjs';
import { statusUpdateText } from './progress-core.mjs';

export const UPDATE_USAGE = 'teamflow update   the Status update: what is live, what is merged, what is being built and what needs you';

export function updateText(bundle, now = Date.now()) {
  return statusUpdateText(bundle, now);
}

/** Prints the update; 0 with one, 1 when the board could not be read. */
export async function main(args = [], ctx = {}) {
  const { config = {} } = ctx;
  const print = ctx.print || ((value) => process.stdout.write(value));
  const fail = ctx.fail || ((value) => process.stderr.write(`${value}\n`));
  const read = ctx.read || fetchState;
  const result = await read('bundle', { ...config, serviceTimeoutMs: Math.max(Number(config.serviceTimeoutMs) || 0, 30000) });
  if (!result.ok || !result.document) {
    fail(`TeamFlow could not read your board: ${result.missing ? 'the service has nothing for this organisation yet' : result.reason}.`);
    fail('Run `teamflow doctor` to see why.');
    return 1;
  }
  print(updateText(result.document, ctx.now ?? Date.now()));
  return 0;
}

export default main;
