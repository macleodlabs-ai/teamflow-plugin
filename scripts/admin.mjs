// `teamflow admin ...`: the superadmin commands.
//
// Two of them. `code` issues invite codes; `launch` ends demo mode.
//
// An invite code lets an organisation sign up without paying: the
// holder opens /signup/?code=TF-XXXX-XXXX, names the org, and the
// service creates it with a complimentary period instead of a Stripe
// subscription. Issuing one is a superadmin act, so every route here
// sends the ID token rather than the access token -- the ID token is
// the only one carrying the verified email claim that the service
// matches against `admin.superadmins`. Everything else in the plugin
// keeps using the access token, which names a scope and not a person.
//
// Lazily imported from cli.mjs, like `report` and `skills`: a plugin
// hook that only ever reports should not pay to parse this.
import * as auth from './auth.mjs';
import { serviceUrl } from './core.mjs';

const USAGE = `teamflow admin \u2014 operator commands, for superadmins

  teamflow admin code create --email owner@acme.com --seats 5 --days 365 [--note "Acme pilot"]
  teamflow admin code list
  teamflow admin code revoke TF-XXXX-XXXX
  teamflow admin launch [--confirm]

--email is the organisation's admin. The service emails them the code and its
redeem link, and locks the code to that address: anyone else redeeming it is
turned away. --note is a reminder for the list, never shown to the recipient.

launch ends demo mode: every demo account loses its free credits, moves onto
the team plan and must subscribe to carry on. Nothing else is touched -- the
organisations, their members, keys, connections and boards all stay. Without
--confirm it only prints what it would do. Run it once, on the day Stripe goes
live, and never before.`;

// Exit codes, so a script can tell the two failures apart: 2 means "you
// are not allowed to do this, or you asked for something impossible",
// 1 means "the call did not get through". A 409 is a 2: the service has
// no mailer, so the code it would have emailed was never issued.
const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_REFUSED = 2;

const NOT_SIGNED_IN = 'TeamFlow is not signed in. Run `teamflow login` first, as a superadmin.';

function out(line) {
  process.stdout.write(`${line}\n`);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
}

// Flags with values, plus bare positionals. Small enough that a parser
// library would be more code than the thing it parses.
export function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s);
      const value = inline !== undefined ? inline : args[++i];
      if (value === undefined) return { error: `--${name} needs a value` };
      flags[name] = value;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function positiveInteger(value, name) {
  if (!/^\d+$/.test(String(value ?? '')) || Number(value) < 1) {
    return { error: `--${name} must be a whole number of at least 1` };
  }
  return { value: Number(value) };
}

// --- the wire -------------------------------------------------------

// One place that talks to /v1/admin/*, so the ID token is attached in
// exactly one place and a new subcommand cannot forget it.
export async function adminCall(config, method, route, payload) {
  const token = await auth.adminIdToken(config);
  if (!token.ok) {
    return { ok: false, signedOut: !auth.hasSession(), reason: token.reason };
  }
  let response;
  try {
    response = await fetch(`${serviceUrl(config)}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token.token}`,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(Number(config.serviceTimeoutMs || 10000)),
    });
  } catch (error) {
    return { ok: false, reason: `service unreachable: ${error instanceof Error ? error.message : String(error)}` };
  }
  let body;
  try { body = await response.json(); } catch { body = undefined; }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      // The service's own message, verbatim. On a 403 it is the one
      // that says which email is signed in and that it is not a
      // superadmin, which is the whole of the diagnosis.
      reason: body?.message || body?.detail || body?.error || `the service answered ${response.status}`,
    };
  }
  return { ok: true, status: response.status, body: body ?? {} };
}

// A failed call, turned into an exit code and one line on stderr.
function report(result) {
  if (result.signedOut) {
    fail(NOT_SIGNED_IN);
    return EXIT_FAILED;
  }
  fail(result.reason);
  if (result.status === 403 || result.status === 409) return EXIT_REFUSED;
  return EXIT_FAILED;
}

// --- rendering ------------------------------------------------------

// The service owns the redeem URL because the code's host is its
// business, not the reporter's. Deriving one is the fallback for a
// service that answers without it.
function redeemUrl(body, config) {
  return body.redeem_url || `${serviceUrl(config)}/signup/?code=${encodeURIComponent(body.code)}`;
}

function line(label, value) {
  out(`${label.padEnd(8)}${value}`);
}

const COLUMNS = [
  ['CODE', (row) => row.code || row.id],
  ['STATUS', (row) => row.status],
  ['SEATS', (row) => row.seats],
  ['DAYS', (row) => row.days],
  ['NOTE', (row) => row.note],
  ['EMAIL', (row) => row.email],
  ['CREATED', (row) => row.created_at || row.created],
  ['REDEEMED', (row) => row.account || row.redeemed_account],
];

function cell(value) {
  return value === undefined || value === null || value === '' ? '-' : String(value);
}

// Columns padded to their widest cell. Plain text on purpose: this gets
// read in a terminal and pasted into a message, and box drawing
// survives neither well.
export function renderTable(rows) {
  const body = rows.map((row) => COLUMNS.map(([, read]) => cell(read(row))));
  const widths = COLUMNS.map(([head], i) =>
    Math.max(head.length, ...body.map((cells) => cells[i].length)));
  const render = (cells) => cells
    .map((value, i) => (i === cells.length - 1 ? value : value.padEnd(widths[i])))
    .join('  ')
    .trimEnd();
  return [render(COLUMNS.map(([head]) => head)), ...body.map(render)].join('\n');
}

// The list route answers with a list; which key it hangs it off is the
// kind of thing that changes, and none of the shapes are ambiguous.
function rowsOf(body) {
  if (Array.isArray(body)) return body;
  for (const key of ['codes', 'items', 'results']) {
    if (Array.isArray(body?.[key])) return body[key];
  }
  return [];
}

// --- subcommands ----------------------------------------------------

async function create(config, flags) {
  // The email is the point of the command, not an option on it: the
  // service sends the code to that address and binds the code to it.
  // Asking for one without an address would have the service answer
  // 400 after issuing nothing.
  if (!flags.email) { fail(`--email is required; it is the address the code is sent to\n\n${USAGE}`); return EXIT_REFUSED; }
  const seats = positiveInteger(flags.seats, 'seats');
  if (seats.error) { fail(`${seats.error}\n\n${USAGE}`); return EXIT_REFUSED; }
  const days = positiveInteger(flags.days, 'days');
  if (days.error) { fail(`${days.error}\n\n${USAGE}`); return EXIT_REFUSED; }

  const result = await adminCall(config, 'POST', '/v1/admin/codes', {
    seats: seats.value,
    days: days.value,
    email: flags.email,
    ...(flags.note ? { note: flags.note } : {}),
  });
  if (!result.ok) return report(result);

  const body = result.body;
  // The email is what the recipient will actually use. The code and the
  // link are printed under it so they can be pasted into a message when
  // the mail does not arrive.
  out(`emailed to ${body.email || flags.email}`);
  line('code', body.code);
  line('redeem', redeemUrl(body, config));
  line('seats', body.seats ?? seats.value);
  line('period', `${body.days ?? days.value} days`);
  line('expires', body.expires_at || 'unknown');
  if (body.note) line('note', body.note);
  return EXIT_OK;
}

async function list(config) {
  const result = await adminCall(config, 'GET', '/v1/admin/codes');
  if (!result.ok) return report(result);
  const rows = rowsOf(result.body);
  if (!rows.length) {
    out('No invite codes have been issued.');
    return EXIT_OK;
  }
  out(renderTable(rows));
  return EXIT_OK;
}

async function revoke(config, code) {
  if (!code) { fail(`Give the code to revoke.\n\n${USAGE}`); return EXIT_REFUSED; }
  const result = await adminCall(config, 'DELETE', `/v1/admin/codes/${encodeURIComponent(code)}`);
  if (!result.ok) return report(result);
  out(`revoked ${result.body.code || code}`);
  return EXIT_OK;
}

// `teamflow admin launch`. The only command here that destroys
// anything, so it is a dry run unless it is told otherwise: typing it
// to see what it would do must not be the thing that does it.
export async function launch(config, { confirm = false } = {}) {
  const apply = Boolean(confirm);
  const result = await adminCall(config, 'POST', '/v1/admin/demo/launch', { apply });
  if (!result.ok) return report(result);
  const body = result.body;
  const rows = Array.isArray(body.accounts) ? body.accounts : [];
  if (!rows.length) {
    out('No account is still in demo mode. Nothing to launch.');
    return EXIT_OK;
  }
  out(apply
    ? `Launched ${rows.length} account${rows.length === 1 ? '' : 's'} onto ${body.plan}.`
    : `Would launch ${rows.length} account${rows.length === 1 ? '' : 's'} onto ${body.plan}. Re-run with --confirm.`);
  for (const row of rows) {
    out(`  ${cell(row.account)}  ${cell(row.name)}  ${cell(row.owner)}  ${cell(row.forfeited)} credits forfeited`);
  }
  return EXIT_OK;
}

// --- entry point ----------------------------------------------------

const HELP = new Set(['help', '--help', '-h']);

export async function main(args, config = {}) {
  const [group, action, ...rest] = args;
  if (HELP.has(group) || HELP.has(action)) {
    out(USAGE);
    return EXIT_OK;
  }
  if (group !== 'code' && group !== 'launch') {
    fail(`Unknown admin command: ${[group, action].filter(Boolean).join(' ') || '(none)'}\n\n${USAGE}`);
    return EXIT_REFUSED;
  }
  if (group === 'launch') {
    // `--confirm` carries no value, which the flag parser above would
    // read as a missing one, so it is matched here instead.
    const words = [action, ...rest].filter(Boolean);
    const unknown = words.filter((word) => word !== '--confirm');
    if (unknown.length) {
      fail(`launch takes no arguments but --confirm\n\n${USAGE}`);
      return EXIT_REFUSED;
    }
    return launch(config, { confirm: words.length > 0 });
  }
  const parsed = parseFlags(rest);
  if (parsed.error) { fail(`${parsed.error}\n\n${USAGE}`); return EXIT_REFUSED; }

  if (action === 'create') return create(config, parsed.flags);
  if (action === 'list' || action === undefined) return list(config);
  if (action === 'revoke') return revoke(config, parsed.positional[0]);
  fail(`Unknown invite-code action: ${action}\n\n${USAGE}`);
  return EXIT_REFUSED;
}
