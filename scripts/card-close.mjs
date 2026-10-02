// Close, cancel or reopen a card from the command line (MACLEOD-951).
//
// The owner, 2026-10-02: "No way to cancel / close cards/tickets. Some
// things are no longer needed." And: "Should be everywhere."
//
//   teamflow card close <KEY> [--reason "<why>"]    it is done
//   teamflow card cancel <KEY> [--reason "<why>"]   it is no longer needed
//   teamflow card reopen <KEY>                      open it again (7 days)
//
// The same service route as the app (`POST /v1/members/cards/{key}/actions`),
// as the signed-in person or the machine's person. The service decides who
// may (the card's developer, an owner or admin, or the plan's owner) and
// whether the tracker moves ("TeamFlow updates your tracker"). Nothing here
// decides either, and nothing received is ever run.
//
// MACLEOD-954: with the machine's credential, the service lets the agent
// close or cancel only the card its own session works on, and reopen only
// what this machine closed. It knows the machine by the X-Machine-Id every
// report carries. Any other card is refused in plain words, and this prints
// the link to the card in TeamFlow, where a signed-in person can do it.

import * as core from './core.mjs';
import { serviceUrl } from './core.mjs';

export const VERBS = ['close', 'cancel', 'reopen'];
export const USAGE = 'Usage: teamflow card close|cancel <KEY> [--reason "<why>"], or teamflow card reopen <KEY>';
const KEY = /^(?:[A-Za-z][A-Za-z0-9]{0,19}-\d{1,9}|[\w.-]{1,80}\/[\w.-]{1,80}#\d{1,9}|#\d{1,9})$/;
const REASON_MAX = 120;

/** `{ verb, key, reason? }` or `{ error }`. */
export function parseClose(args = []) {
  const [verb, rawKey, ...rest] = args;
  if (!VERBS.includes(verb)) return { error: USAGE };
  const key = String(rawKey || '').trim();
  if (!KEY.test(key)) return { error: USAGE };
  let reason;
  for (let i = 0; i < rest.length; i += 1) {
    const eq = /^--reason=(.*)$/s.exec(rest[i]);
    if (eq) reason = eq[1];
    else if (rest[i] === '--reason' && rest[i + 1] !== undefined) { reason = rest[i + 1]; i += 1; }
    else return { error: USAGE };
  }
  if (reason !== undefined) {
    reason = String(reason).replace(/\s+/g, ' ').trim();
    if (!reason || verb === 'reopen') return { error: USAGE };
    if (reason.length > REASON_MAX) return { error: `Keep the reason to ${REASON_MAX} characters.` };
  }
  return { verb, key, ...(reason ? { reason } : {}) };
}

/** One call to the card's action route. */
export async function request(key, action, args, config = {}) {
  const cred = await core.credential(config);
  if (!cred) return { ok: false, reason: 'no service credential available; run `teamflow login`' };
  const machine = core.machineId();
  try {
    const response = await fetch(`${serviceUrl(config)}/v1/members/cards/${encodeURIComponent(key)}/actions`, {
      method: 'POST',
      headers: {
        [cred.header]: cred.value,
        'content-type': 'application/json',
        // An identifier, not content: the service matches it to this
        // machine's own session (docs/REPORTING_CONTRACT.md).
        ...(machine ? { 'X-Machine-Id': machine } : {}),
      },
      body: JSON.stringify({ action, args }),
      redirect: 'error',
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 20000)),
    });
    let parsed;
    try { parsed = await response.json(); } catch { parsed = undefined; }
    if (!response.ok) return { ok: false, status: response.status, reason: parsed?.message || `service returned ${response.status}` };
    return { ok: true, status: response.status, body: parsed };
  } catch (error) {
    return { ok: false, reason: core.unreachableReason(error, config) };
  }
}

const FAILED = { close: 'TeamFlow did not close it', cancel: 'TeamFlow did not cancel it', reopen: 'TeamFlow did not open it again' };

export async function closeMain(args = [], ctx = {}) {
  const print = ctx.print || ((line) => process.stdout.write(`${line}\n`));
  const fail = ctx.fail || ((line) => process.stderr.write(`${line}\n`));
  const send = ctx.request || request;
  const parsed = parseClose(args);
  if (parsed.error) { fail(parsed.error); return 2; }
  const out = await send(parsed.key, parsed.verb, parsed.reason ? { reason: parsed.reason } : {}, ctx.config || {});
  if (!out.ok) {
    fail(`${FAILED[parsed.verb]}: ${out.reason}`);
    // A card this machine may not change: a signed-in person can, there.
    if (out.status === 403) fail(`Open it in TeamFlow: ${core.issueUrl(parsed.key, 'teamflow', ctx.config || {})}`);
    return out.status === 403 || out.status === 409 ? 2 : 1;
  }
  print(out.body?.message || 'Done.');
  return 0;
}
