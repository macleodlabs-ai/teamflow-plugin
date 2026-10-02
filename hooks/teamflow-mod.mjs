// The TeamFlow mod (MACLEOD-941): a Claude Code mod, loaded from
// hooks.json `modules` (https://code.claude.com/docs/en/plugins/mods/reference).
//
// On by default; `teamflow mod off` turns it off. At session start it asks `teamflow mod snapshot` once;
// while the person has not run `teamflow mod on`, the answer is
// `{on: false}` and the mod adds nothing: no line, no command, no timer.
//
// On, it draws one line above the prompt (this session's track and state,
// and the page's own "N need you") and adds `/teamflow-turn`, a pane with
// the person's tracks and Your turn. Every item links to its card in
// TeamFlow, where the person answers signed in as themselves. This mod
// never answers anything and never calls the service: the machine's
// device credential may not answer for a person (MACLEOD-946).
//
// The one process it runs is fixed: node, the plugin's own cli.mjs,
// `mod snapshot --session <this session's id>`. Nothing it reads goes
// to a shell. A mod has no Node.js, so this file holds no logic beyond
// drawing; plugin/scripts/mod.mjs does the reading and is tested there.

export const PANE = 'teamflow-turn';
export const EVERY_MS = 60_000;
const SESSION = /^[A-Za-z0-9_-]{1,80}$/;

let snap = { on: false };
let session = '';

/** The fixed argument list the mod runs. Exported for the test. */
export function snapshotArgv(root, id) {
  const argv = ['node', `${root}/scripts/cli.mjs`, 'mod', 'snapshot'];
  return SESSION.test(id || '') ? [...argv, '--session', id] : argv;
}

async function refresh($) {
  try {
    const out = await $.process.run(snapshotArgv($.plugin.root, session), { timeoutMs: 40_000 });
    const next = JSON.parse(String(out.stdout || '').trim() || '{}');
    if (next && typeof next === 'object') snap = next;
  } catch { /* keep the last snapshot */ }
}

/** The pane's rows, as plain data: what `ui.render` draws. Exported for the test. */
export function paneRows(s = snap) {
  const rows = [];
  if (s.offline) rows.push({ text: 'TeamFlow cannot read your board now. This shows what this computer knows.' });
  rows.push({ head: 'Your tracks' });
  if (!s.tracks?.length) rows.push({ text: 'No tracks yet. A track starts when two of your sessions work on one thing.' });
  for (const t of s.tracks || []) {
    const threads = t.threads === 1 ? '1 thread' : `${t.threads} threads`;
    rows.push({ text: `${t.name}: ${t.state}, ${threads}${t.keys?.length ? ` (${t.keys.join(', ')})` : ''}` });
  }
  rows.push({ head: 'Your turn' });
  if (s.turn) {
    rows.push({ text: s.turn.headline });
    for (const r of s.turn.rows || []) {
      rows.push({ text: `${r.word}: ${r.sentence}`, link: r.link, label: r.key ? `Open ${r.key} in TeamFlow` : 'Open in TeamFlow' });
      /* MACLEOD-951: Close and Cancel live in the card's menu in the app, as a link. Never a command here. */
      if (r.key) rows.push({ link: r.link, label: `Close or cancel ${r.key} in TeamFlow` });
    }
  }
  rows.push({ text: 'Answer in TeamFlow, signed in as yourself. Questions from this session stay here, in Claude Code.' });
  if (s.app) rows.push({ link: s.app, label: 'Open Your turn in TeamFlow' });
  return rows;
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try { session = await $.session.id(); } catch { session = ''; }
    await refresh($);
    if (snap.on) {
      $.clock.every(EVERY_MS, async () => { await refresh($); $.ui.invalidate('ui.render'); });
      try { await $.command.register({ name: PANE, description: 'Show your TeamFlow tracks and Your turn', immediate: true }); } catch { /* the name is taken: no command */ }
    }
    return next(e);
  });

  on('command.run', { command: PANE }, async ($) => {
    if (!snap.on) return { text: 'The TeamFlow mod is off. Run `teamflow mod on` to turn it on.' };
    await $.ui.open({ id: PANE, title: 'TeamFlow', focus: true, closeOnEscape: true });
    return {};
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!snap.on || !snap.line) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const theirs = await next(e);
    return Box({ flexDirection: 'column', children: [Text({ dimColor: true, wrap: 'truncate', children: [snap.line] }), ...(theirs ? [theirs] : [])] });
  });

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const { Box, Text, Link } = $.ui.resolve(e);
    const children = paneRows().map((row, i) => {
      if (row.head) return Text({ key: `h${i}`, bold: true, children: [row.head] });
      const parts = [];
      if (row.text) parts.push(Text({ key: `t${i}`, children: [row.text] }));
      if (row.link) parts.push(Link({ key: `l${i}`, href: row.link, label: row.label }));
      return Box({ key: `r${i}`, flexDirection: 'column', children: parts });
    });
    return Box({ flexDirection: 'column', children });
  });
}
