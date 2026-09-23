// A refusal from the service, said in the plugin's own words
// (MACLEOD-613, moved here and widened by MACLEOD-615).
//
// Its own module because every route that talks to the service needs it
// — the report path in core.mjs, and sign-in, organisation switching,
// admin codes, ad hoc keys and projects — and several of those are
// modules core.mjs itself imports. No imports of its own, so nothing can
// make it circular.

/**
 * A refusal the kit names by `reason_code`, said in the plugin's own
 * words (MACLEOD-613, for MACLEOD-610).
 *
 * `reason_code` is the kit's own convention and the only name it uses:
 * `errors.py`'s `Reject`, `flow.py`'s `rate_limited` /
 * `insufficient_credits` / `wall_cap_exceeded`, `mcp_http.py`'s
 * `bad_json` / `input_too_large`, and `abuse.py`'s `reporting_paused`
 * all carry it. There is no field called `slug` anywhere in the kit —
 * the first cut of this read one, which made this table dead code that
 * nothing could notice, because the kit's own `message` is good enough
 * that the fall-through still read well.
 *
 * The table exists so the sentence is the plugin's, in the plugin's
 * vocabulary — the kit says "account", everything a TeamFlow user reads
 * says "organisation" — and so it survives the service rewording its
 * `message`. A code this table has never heard of falls through to that
 * message, which is what every refusal did before.
 */
// Null-prototyped, because the key is the service's to choose
// (MACLEOD-613 audit, finding 3; the same fix MACLEOD-605 made to
// `BY_ID`). On a plain object `reason_code: "toString"` looks up
// `Object.prototype.toString`, which is truthy, so `reason` becomes a
// Function — and `JSON.stringify` drops a Function, so the reason
// disappears from the state file and from `teamflow status` entirely.
// That is the exact failure this whole path exists to remove.
export const REFUSAL_REASONS = Object.assign(Object.create(null), {
  reporting_paused: 'reporting is paused for this organisation — contact support',
  // From the owner-controls team's payment pause: a pause like the one
  // above, which lifts by itself once the payment goes through.
  payment_failed: 'Reporting is paused because the organisation\'s payment did not go through. '
    + 'The board stays readable, and reporting resumes as soon as payment succeeds.',
  // MACLEOD-618: a trial that ended with nobody subscribed. Like the pause
  // above it lifts by itself — the moment somebody subscribes — and the
  // board they left is the board they get back, so the sentence says so.
  // MACLEOD-639: it points at the prices on the landing page, where the
  // owner chooses a plan.
  trial_ended: 'Your TeamFlow trial has ended. Choose a plan at https://codercat.io/#pricing. '
    + 'Your board stays readable and TeamFlow deleted nothing.',
  // MACLEOD-620's two soft refusals: the owner's exact sentences, each with
  // its remedy, and the fair use guide as a line of its own after them.
  usage_exceeds_plan: 'Usage on the credential exceeds the plan. Contact us to discuss Enterprise plans.'
    + '\nFair use: https://codercat.io/docs/fair-use/#usage-exceeds-plan',
  credential_in_use: 'This credential is already in use. Run /teamflow:login on this machine to give it its own.'
    + '\nFair use: https://codercat.io/docs/fair-use/#credential-in-use',
  // MACLEOD-615: the codes a person meets on the routes beside the report
  // path whose kit sentence names an account or a key, read out of
  // `orgs.py` (`_bad(...)` on /v1/members/*, /v1/repos and /v1/token).
  // Every other code there already reads well and falls through to it.
  account_suspended: 'that organisation is not active',
  repository_taken: 'that repository is registered to another organisation',
  unknown_repository: 'that repository is not registered to this organisation',
  sign_in_required: 'sign in first with `teamflow login`: moving between organisations is a person\'s '
    + 'decision, so the service needs to know which person',
});

/**
 * How much of the service's own words are worth keeping.
 *
 * `serviceUrl` is settable from a cloned repository's `.teamflow.json`,
 * so `message` is attacker-reachable and the session state file is the
 * target: the audit persisted 5,038 characters of it, with ESC and CR
 * in the middle. `JSON.stringify` escapes the control characters on the
 * way to a terminal, so this is not an injection — it is a state file
 * somebody else decides the size and shape of, which is reason enough.
 * A sentence a person can read is under two hundred characters.
 */
const REASON_MAX = 200;

export function readableReason(text) {
  // C0 and C1, which is every escape, newline and carriage return.
  const clean = String(text).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  // By code point, not by code unit: `slice` cuts an emoji that straddles
  // the limit in half and stores the lone high surrogate, which is a
  // broken string every reader of the state file then carries around.
  return [...clean].slice(0, REASON_MAX).join('');
}

/**
 * What the service said, in the shape the kit actually answers in.
 *
 * Two shapes, and both are the kit's own. The metered route answers
 * `{status, reason_code, message, billing}` — see `flow.py`, which builds
 * it from `errors.py`'s `Reject`, and `abuse.py`. Every other route answers
 * `orgs._bad`'s `{error, detail}`, where `error` is the stable slug and
 * `detail` the sentence (MACLEOD-615). So the code is `reason_code`, else
 * `error`; the sentence is `message`, else `detail`, else `error` — which
 * on a few operator routes is itself a short sentence.
 *
 * Read in one place so a new refusal is named wherever it arrives rather
 * than only on the branch somebody remembered, and so the reason never
 * degrades to an HTTP number while the service was telling us in words.
 * `reasonCode` comes back beside `reason` so a caller can branch on the
 * code instead of string-matching a sentence.
 */
export function refusalOf(body, fallback) {
  const text = (value) => (typeof value === 'string' && value.trim() ? value : undefined);
  const code = text(body?.reason_code) || text(body?.error);
  const named = code ? REFUSAL_REASONS[code] : undefined;
  const sentence = text(body?.message) || text(body?.detail) || text(body?.error);
  const said = sentence ? readableReason(sentence) : undefined;
  return {
    reasonCode: code,
    reason: named || said || fallback,
  };
}
