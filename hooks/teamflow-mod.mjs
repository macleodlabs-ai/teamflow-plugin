// The TeamFlow mod (MACLEOD-941, MACLEOD-953): a Claude Code mod, loaded
// from hooks.json `modules` (https://code.claude.com/docs/en/plugins/mods/reference).
//
// On by default; `teamflow mod off` turns it off. At session start it asks
// `teamflow mod snapshot` once; off, the answer is `{on: false}` and the
// mod adds nothing: no line, no command, no timer.
//
// On, it draws one line above the prompt (this session's ticket and gate,
// the last check, its plan, the agents and Your turn) and adds
// `/teamflow-turn`, a pane with five tabs: Your turn, Plans and tracks,
// Agents, This ticket and Lately. Keys 1 to 5 switch the tab.
//
// It answers for this computer's own person (MACLEOD-954, the owner,
// 2026-10-02: "We should allow [the computer's login to answer], so that
// the mod etc can work", and "Actually allow permissions too."). In Your
// turn, a question with options, an approval, a check and a tool
// permission have buttons. A press runs `teamflow needs answer`, and the
// service takes it only for this person's own cards and sessions, never
// for the session the press comes from, and History says "from Claude
// Code on <machine>". Each press is one answer: nothing is chosen for the
// person, and nothing is allowed by itself. Free-text answers, close,
// cancel and reopen stay links to the card in TeamFlow.
//
// The processes it runs are fixed: node, the plugin's own cli.mjs, and
// either `mod snapshot --session <this session's id>` or `needs answer
// <id> [--session <id>] <one flag> [<n>]`, each built from checked ids
// and passed as an argument list. Nothing it reads goes to a shell. A mod has no Node.js, so it holds only drawing here;
// plugin/scripts/mod.mjs does the reading and the counting, with the app's
// own code (progress-core.mjs).

export const PANE = 'teamflow-turn';
/** How often the line and the pane read the snapshot again. The snapshot keeps its board for 45 s. */
export const EVERY_MS = 30_000;
/** After a turn ends, the session's own report goes out: read again this long after. */
export const AFTER_TURN_MS = 3_000;
export const TABS = [
  { id: 'turn', hotkey: '1', label: 'Your turn' },
  { id: 'plans', hotkey: '2', label: 'Plans' },
  { id: 'agents', hotkey: '3', label: 'Agents' },
  { id: 'ticket', hotkey: '4', label: 'This ticket' },
  { id: 'lately', hotkey: '5', label: 'Lately' },
];
const SESSION = /^[A-Za-z0-9_-]{1,80}$/;
const NEED_ID = /^need_[0-9a-f]{16}$/;
const ASK_ID = /^ask_[0-9a-f]{16,40}$/;
const ASK_SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FLAGS = new Set(['--choice', '--done', '--approve', '--decline', '--allow', '--deny']);
/** At most this many option buttons on one question. */
export const OPTIONS_MAX = 8;
const GATE_GLYPH = { passed: '✓', failed: '✕', here: '▶', later: '·' };

let snap = { on: false };
let session = '';
let tab = 'turn';
let reading;
/** What the last press came to, in the CLI's own plain words. */
let said = '';

/** The fixed argument list the mod runs. Exported for the test. */
export function snapshotArgv(root, id, fresh = false) {
  const argv = ['node', `${root}/scripts/cli.mjs`, 'mod', 'snapshot'];
  const out = SESSION.test(id || '') ? [...argv, '--session', id] : argv;
  return fresh ? [...out, '--fresh'] : out;
}

/**
 * The argument list one answer button runs, or undefined when anything in
 * it is not a checked id, a known flag or a small whole number.
 * `{ id, session?, flag, choice? }`.
 */
export function answerArgv(root, b = {}) {
  if (!FLAGS.has(b.flag)) return undefined;
  const isNeed = NEED_ID.test(String(b.id || ''));
  const isAsk = ASK_ID.test(String(b.id || '')) && ASK_SESSION.test(String(b.session || ''));
  if (!isNeed && !isAsk) return undefined;
  if (isNeed && ['--allow', '--deny'].includes(b.flag)) return undefined;
  if (isAsk && ['--done', '--approve', '--decline'].includes(b.flag)) return undefined;
  const argv = ['node', `${root}/scripts/cli.mjs`, 'needs', 'answer', b.id];
  if (isAsk) argv.push('--session', b.session);
  argv.push(b.flag);
  if (b.flag === '--choice') {
    if (!Number.isInteger(b.choice) || b.choice < 0 || b.choice >= OPTIONS_MAX) return undefined;
    argv.push(String(b.choice));
  }
  return argv;
}

/**
 * The buttons a question gets: its options, Approve and Decline, Done, or
 * Allow and Deny. A question that wants typed words gets none: it stays a
 * link into the app.
 */
export function answerButtons(q = {}) {
  const options = (q.options || []).slice(0, OPTIONS_MAX);
  if (NEED_ID.test(String(q.id || ''))) {
    const id = q.id;
    if (q.kind === 'decision') return options.map((label, choice) => ({ label, id, flag: '--choice', choice }));
    if (q.kind === 'approval') return [{ label: 'Approve', id, flag: '--approve' }, { label: 'Decline', id, flag: '--decline' }];
    if (q.kind === 'check') return [{ label: 'Done', id, flag: '--done' }];
    return [];
  }
  if (ASK_ID.test(String(q.askId || '')) && ASK_SESSION.test(String(q.session || ''))) {
    const base = { id: q.askId, session: q.session };
    if (q.kind === 'permission') return [{ label: 'Allow', ...base, flag: '--allow' }, { label: 'Deny', ...base, flag: '--deny' }];
    if (q.kind === 'choice' && (q.questions || 1) === 1) return options.map((label, choice) => ({ label, ...base, flag: '--choice', choice }));
  }
  return [];
}

/** One line of what a run printed. */
const firstLine = (text) => String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';

/** A press: run the one answer command, say what came of it, and read again. */
async function press($, b) {
  const argv = answerArgv($.plugin.root, b);
  if (!argv) return;
  said = 'Sending your answer to TeamFlow.';
  $.ui.invalidate('ui.render');
  try {
    const out = await $.process.run(argv, { timeoutMs: 30_000 });
    const code = out?.exitCode ?? out?.code ?? 0;
    said = code === 0
      ? firstLine(out.stdout) || 'TeamFlow took your answer.'
      : firstLine(out.stderr) || 'TeamFlow did not take the answer. Answer it in TeamFlow.';
  } catch {
    said = 'TeamFlow did not take the answer. Answer it in TeamFlow.';
  }
  await refresh($, true);
  $.ui.invalidate('ui.render');
}

/** One read at a time: a second ask while one runs waits for the same answer. Never awaited by a render. */
function refresh($, fresh = false) {
  if (reading) return reading;
  reading = (async () => {
    try {
      const out = await $.process.run(snapshotArgv($.plugin.root, session, fresh), { timeoutMs: 40_000 });
      const next = JSON.parse(String(out.stdout || '').trim() || '{}');
      if (next && typeof next === 'object') snap = next;
    } catch { /* keep the last snapshot */ }
  })().finally(() => { reading = undefined; });
  return reading;
}

/** For the preview and the tests: draw from this snapshot and this tab. */
export function useSnapshot(next, at = tab, words = '') {
  snap = next || { on: false };
  tab = TABS.some((t) => t.id === at) ? at : 'turn';
  said = words;
}

// --- the line above the prompt ------------------------------------------------

const width = (text) => [...String(text)].length;
const cut = (text, max) => (width(text) <= max ? text : `${[...text].slice(0, Math.max(1, max - 1)).join('')}…`);

/**
 * The line's parts. `order` is where a part sits; `rank` is how important
 * it is (1 is kept longest). Parts of one `group` join with a space.
 *
 * The order in which the line drops parts when it is narrow, first to last
 * (the owner's MACLEOD-953 list, ranked by "does the person need to act"):
 *   9 a passed check ("✓ passed": good news waits),
 *   8 the agents at work ("✽ 3 working": nobody acts on it),
 *   7 the plan and its progress ("Rethink 12 of 23"),
 *   6 the gate step ("Local Test"),
 *   5 broken agents ("✕ 1 broke"),
 *   4 a failed check with its failing part ("✕ test: 11/12"),
 *   3 agents that wait on a person ("✻ 2 wait on you"),
 *   2 the Your turn count ("2 need you"),
 *   1 this session's ticket key: the line says whose line it is.
 */
export function lineParts(s = snap) {
  const parts = [];
  const t = s.ticket;
  if (t?.key) parts.push({ order: 1, rank: 1, group: 'ticket', text: t.key });
  if (t?.gate) parts.push({ order: 2, rank: 6, group: 'ticket', text: t.gate });
  if (t?.check) {
    parts.push(t.check.ok
      ? { order: 3, rank: 9, text: '✓ passed' }
      : { order: 3, rank: 4, text: `✕ ${cut(t.check.part || t.check.gate, 28)}` });
  }
  const plan = (s.plans || []).find((p) => p.holds);
  if (plan) parts.push({ order: 4, rank: 7, text: `${cut(plan.name, 22)} ${plan.done} of ${plan.total}` });
  else if (s.track) parts.push({ order: 4, rank: 7, text: `${cut(s.track.name, 22)}, ${s.track.state}` });
  const n = s.agents?.counts || {};
  if (n.waits) parts.push({ order: 5, rank: 3, group: 'agents', text: `✻ ${n.waits} ${n.waits === 1 ? 'waits' : 'wait'} on you` });
  if (n.working) parts.push({ order: 6, rank: 8, group: 'agents', text: `✽ ${n.working} working` });
  if (n.broke) parts.push({ order: 7, rank: 5, group: 'agents', text: `✕ ${n.broke} broke` });
  if (s.turn) parts.push({ order: 8, rank: 2, text: s.turn.count ? `${s.turn.count} need you` : 'nothing needs you' });
  return parts.sort((a, b) => a.order - b.order);
}

function joinParts(parts) {
  let out = 'TF';
  let last;
  for (const part of parts) {
    out += last && part.group && last.group === part.group ? ` ${part.text}` : `${last ? ' ·' : ''} ${part.text}`;
    last = part;
  }
  return out;
}

/** One line that fits `columns`: the least important part goes first, then the line is cut. */
export function fitLine(parts, columns = 80) {
  const max = Math.max(10, Number(columns) || 80);
  let shown = [...parts];
  while (shown.length > 1 && width(joinParts(shown)) > max) {
    const drop = shown.reduce((a, b) => (b.rank > a.rank ? b : a));
    shown = shown.filter((p) => p !== drop);
  }
  const line = shown.length ? joinParts(shown) : '';
  return line ? cut(line, max) : '';
}

/** The line for a width, or the snapshot's own line when it has no parts (an older snapshot). */
export function bandText(s = snap, columns = 80) {
  const parts = lineParts(s);
  return parts.length ? fitLine(parts, columns) : cut(String(s.line || ''), Math.max(10, Number(columns) || 80));
}

// --- the pane -----------------------------------------------------------------

/** A text bar: "█████░░░░░". */
export function bar(done, total, cells = 20) {
  const filled = total > 0 ? Math.round((Math.min(done, total) / total) * cells) : 0;
  return `${'█'.repeat(filled)}${'░'.repeat(cells - filled)}`;
}

const closeLink = (s, key) => (key && s.app ? { link: `${s.app}#delivery?issue=${encodeURIComponent(key)}`, label: `Close or cancel ${key} in TeamFlow` } : undefined);

function turnRows(s) {
  const rows = [];
  if (!s.turn) {
    rows.push({ text: 'TeamFlow cannot read Your turn now.' });
    return rows;
  }
  rows.push({ head: s.turn.headline });
  if (said) rows.push({ text: said, bold: true });
  for (const r of s.turn.rows || []) {
    rows.push({ text: `${r.word}${r.key ? ` ${r.key}` : ''}`, bold: true, gap: true });
    const q = r.question;
    if (q) {
      rows.push({ text: `${q.plan ? `Plan ${q.plan}. ` : ''}${q.by === 'teamflow' ? 'TeamFlow' : q.by} asks: "${q.text}"` });
      const buttons = answerButtons(q);
      if (buttons.length) rows.push({ buttons });
      else if (q.options?.length) rows.push({ text: `Options: ${q.options.join(' / ')}` });
      if (q.defaultWords) rows.push({ text: q.defaultWords, dim: true });
    } else {
      rows.push({ text: r.sentence });
    }
    rows.push({ link: r.link, label: `${r.word} in TeamFlow` });
    /* MACLEOD-951: Close and Cancel live in the card's menu in the app. A link, never a command. */
    const close = closeLink(s, r.key);
    if (close) rows.push(close);
  }
  for (const a of s.asks || []) {
    const who = `${a.agent === 'main' ? 'An agent' : a.agent}${a.key ? ` on ${a.key}` : ''}`;
    rows.push({ text: `${who} waits`, bold: true, gap: true });
    rows.push({ text: a.kind === 'permission' ? `It asks to use ${a.tool || 'a tool'}. ${a.text}`.trim() : `It asks: "${a.text}"` });
    const buttons = answerButtons(a);
    if (buttons.length) rows.push({ buttons });
    else if (s.app) rows.push({ link: a.key ? `${s.app}#delivery?issue=${encodeURIComponent(a.key)}` : `${s.app}#agents`, label: 'Answer in TeamFlow' });
  }
  rows.push({ text: 'A button answers from this computer, and History says so. Typed answers are in TeamFlow. Questions from this session stay here, in Claude Code.', dim: true, gap: true });
  if (s.app) rows.push({ link: s.app, label: 'Open Your turn in TeamFlow' });
  return rows;
}

function planRows(s, columns) {
  const rows = [];
  const cells = Math.max(10, Math.min(30, columns - 24));
  if (!s.plans?.length) rows.push({ text: 'No plan runs now.' });
  for (const p of s.plans || []) {
    rows.push({ text: `${p.name} (${p.kind === 'track' ? 'track' : 'plan'}) · ${p.state}${p.holds ? ' · this session' : ''}`, bold: true, gap: true });
    rows.push({ text: `${bar(p.done, p.total, cells)} ${p.done} of ${p.total}` });
    rows.push({ text: p.forecast });
    if (p.next) rows.push({ text: `Next: ${p.next.key} ${p.next.title}, at ${p.next.step}`, dim: true });
  }
  rows.push({ head: 'On this computer', gap: true });
  if (!s.tracks?.length) rows.push({ text: 'No tracks yet. A track starts when two of your sessions work on one thing.' });
  for (const t of s.tracks || []) {
    const threads = t.threads === 1 ? '1 thread' : `${t.threads} threads`;
    rows.push({ text: `${t.name}: ${t.state}, ${threads}${t.keys?.length ? ` (${t.keys.join(', ')})` : ''}` });
  }
  if (s.app) rows.push({ link: `${s.app}#plans`, label: 'Open Plans in TeamFlow', gap: true });
  return rows;
}

function agentRows(s) {
  const rows = [];
  const a = s.agents;
  rows.push({ head: a?.words ? a.words : 'No agent waits, works or broke now.' });
  for (const r of a?.rows || []) {
    rows.push({ text: `${r.glyph} ${r.word} · ${r.person} · ${r.agent}${r.key ? ` · ${r.key}` : ''}` });
    if (r.task) rows.push({ text: r.task, dim: true, indent: true });
  }
  if (s.app) rows.push({ link: `${s.app}#agents`, label: 'Open Agents in TeamFlow', gap: true });
  return rows;
}

function ticketRows(s) {
  const t = s.ticket;
  if (!t) {
    return [
      { text: 'This session has no ticket yet.' },
      { text: 'Run `teamflow work-on <KEY>` to name it.', dim: true },
    ];
  }
  const rows = [{ head: `${t.key}${t.title ? ` ${t.title}` : ''}` }];
  /* No-break spaces inside a gate, so a narrow pane wraps between gates, never inside one. */
  rows.push({ text: (t.strip || []).map((g) => `${GATE_GLYPH[g.mark] || '·'} ${g.label}`.replace(/ /g, ' ')).join('  ') });
  rows.push({ text: t.step, dim: true });
  rows.push({ text: `What is wrong: ${t.wrong}`, gap: true });
  rows.push({ text: `What is next: ${t.next}` });
  rows.push({ text: `Who acts: ${t.who}` });
  if (t.check) rows.push({ text: t.check.ok ? `Last check: ${t.check.gate} passed.` : `Last check: ${t.check.gate} failed: ${t.check.part}.`, gap: true });
  if (t.parts) rows.push({ text: t.parts, dim: true });
  if (s.app) {
    rows.push({ link: `${s.app}#delivery?issue=${encodeURIComponent(t.key)}`, label: `Open ${t.key} in TeamFlow`, gap: true });
    rows.push(closeLink(s, t.key));
  }
  return rows;
}

function latelyRows(s) {
  const rows = [{ text: s.receipt || 'TeamFlow has nothing new to say.' }];
  if (s.turn) rows.push({ text: s.turn.headline, gap: true });
  if (s.app) rows.push({ link: s.app, label: 'Open Your turn in TeamFlow', gap: true });
  return rows;
}

/** The pane's rows for one tab, as plain data: what `ui.render` draws. Exported for the test and the preview. */
export function paneRows(s = snap, at = tab, columns = 80) {
  const rows = [];
  if (s.offline) rows.push({ text: 'TeamFlow cannot read your board now. This shows what this computer knows.' });
  const pick = { turn: turnRows, plans: planRows, agents: agentRows, ticket: ticketRows, lately: latelyRows }[at] || turnRows;
  return [...rows, ...pick(s, columns)];
}

// --- the hooks ----------------------------------------------------------------

export function register(on) {
  on('session.start', async ($, e, next) => {
    try { session = await $.session.id(); } catch { session = ''; }
    await refresh($);
    if (snap.on) {
      $.clock.every(EVERY_MS, async () => { await refresh($); $.ui.invalidate('ui.render'); });
      try { await $.command.register({ name: PANE, description: 'Show Your turn, plans, agents and this ticket from TeamFlow', immediate: true }); } catch { /* the name is taken: no command */ }
    }
    return next(e);
  });

  /* The session's own report goes out as a turn ends: read again soon after, without holding the turn. */
  on('turn.complete', async ($, e, next) => {
    if (snap.on) {
      try { $.clock.after(AFTER_TURN_MS, async () => { await refresh($); $.ui.invalidate('ui.render'); }); } catch { /* no timer: the 30 s one reads it */ }
    }
    return next(e);
  });

  on('command.run', { command: PANE }, async ($) => {
    if (!snap.on) return { text: 'The TeamFlow mod is off. Run `teamflow mod on` to turn it on.' };
    await $.ui.open({ id: PANE, title: 'TeamFlow', focus: true, closeOnEscape: true });
    return {};
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!snap.on) return next(e);
    const line = bandText(snap, e.props?.bodyColumns ?? e.viewport?.columns ?? 80);
    if (!line) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    const theirs = await next(e);
    return Box({ flexDirection: 'column', children: [Text({ dimColor: true, wrap: 'truncate', children: [line] }), ...(theirs ? [theirs] : [])] });
  });

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e);
    const { Box, Text, Link, Button } = $.ui.resolve(e);
    const columns = e.props?.bodyColumns ?? e.viewport?.columns ?? 80;
    const tabs = Box({
      key: 'tabs',
      flexDirection: 'row',
      columnGap: 2,
      children: TABS.map((t) => Button({
        key: `tab-${t.id}`,
        label: t.label,
        hotkey: t.hotkey,
        plain: true,
        ...(t.id === tab ? {} : { dimColor: true }),
        onPress: () => { tab = t.id; $.ui.invalidate('ui.render'); },
      })),
    });
    const children = paneRows(snap, tab, columns).map((row, i) => {
      const top = row.gap && i > 0 ? { marginTop: 1 } : {};
      if (row.indent) top.paddingLeft = 2;
      if (row.head) return Box({ key: `h${i}`, ...top, children: [Text({ bold: true, children: [row.head] })] });
      if (row.buttons) {
        return Box({
          key: `b${i}`,
          flexDirection: 'row',
          columnGap: 2,
          flexWrap: 'wrap',
          ...top,
          children: row.buttons.map((b, j) => Button({ key: `answer-${i}-${j}`, label: b.label, onPress: () => press($, b) })),
        });
      }
      const parts = [];
      if (row.text) parts.push(Text({ key: `t${i}`, wrap: 'wrap', ...(row.bold ? { bold: true } : {}), ...(row.dim ? { dimColor: true } : {}), children: [row.text] }));
      if (row.link) parts.push(Link({ key: `l${i}`, href: row.link, label: row.label }));
      return Box({ key: `r${i}`, flexDirection: 'column', ...top, children: parts });
    });
    return Box({ flexDirection: 'column', children: [tabs, Box({ key: 'body', flexDirection: 'column', marginTop: 1, children })] });
  });
}
