// Failure points: why a gate sent a card back, one line each, checked off
// in turn by the runs that follow (MACLEOD-639, ADHOC-19).
//
// The owner, verbatim: "Each card that fails a gate. Test/audit/sonarqube
// etc should get sent back with a reason and failure points. Each
// subsequent rebuild/retest checks those points off in turn."
//
// One rule for every gate, here and in adapters/teamflow/points.py, which
// mirrors it line for line (the service applies it to SonarQube and to CI
// and deploy steps; the plugin to audits, to anything a person records, and
// to failing tests). A point is {id, gate, key?, text, from, rounds,
// lastRound, state, at, by?, doneAt?, doneRound?, doneBy?}:
//
//   - a failure that matches a point at the same gate is that point: it
//     stays open (or opens again) and `rounds` goes up;
//   - a new failure is a new point, raised in this round;
//   - when the run judged everything (a test run, an analysis, a job, an
//     audit that lists its findings), an open point it did not fail again
//     is done in this round. A run that says nothing about points closes
//     nothing.
//
// Derived state only: a test's file and name, a condition in plain words,
// a step's name, or a sentence a person wrote. Never output, a message, a
// stack trace or a log line.

import crypto from 'node:crypto';

export const POINT_TEXT_MAX = 280;
export const POINT_KEY_MAX = 160;
export const POINTS_MAX = 50;
export const POINTS_PER_ROUND_MAX = 20;

/**
 * One line, every control character gone (U+FEFF too), whitespace
 * collapsed, capped in code points. points.py does exactly the same, and
 * tests/fixtures/points-vectors.json proves the two agree.
 */
export function pointLine(text, cap = POINT_TEXT_MAX) {
  const line = String(text ?? '')
    .replace(/[\r\n\t\v\f\u2028\u2029]+/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\ufeff]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return Array.from(line).slice(0, cap).join('').trim();
}

/** A stable id for a machine-found point: the same test is the same point in every session. */
export function stableId(prefix, gate, key) {
  return `${prefix}-${crypto.createHash('sha256').update(`${gate}\u0000${key}`).digest('hex').slice(0, 6)}`;
}

/**
 * The list capped: the oldest fixed points go first. When only open points
 * are left, the newest go, which advance() never lets happen -- it raises
 * no point past the cap and says how many it did not add.
 */
export function capPoints(points, max = POINTS_MAX) {
  const out = [...points];
  while (out.length > max) {
    const at = out.findIndex((point) => point.state === 'done');
    out.splice(at >= 0 ? at : out.length - 1, 1);
  }
  return out;
}

/**
 * Apply one run of one gate to a card's points.
 *
 * `failing` is what the run failed on, as `{key?, text}` (the key is what
 * makes two runs' failures the same point; it is the text when absent).
 * `judgedAll` says the run checked every point at this gate, so the open
 * points it did not fail again are fixed; `judges(point)` narrows that to
 * the points the run actually covered (a test run of one file judges that
 * file's tests and no others). `idFor(point, index)` names a new
 * point. Returns the new list, the ids raised, fixed and still open, and
 * how many failures were not added because the card holds 50 open points.
 */
export function advance(points = [], {
  gate, round, at, by, failing = [], judgedAll = false, judges = () => true, idFor,
} = {}) {
  const out = points.map((point) => ({ ...point }));
  const seen = new Set();
  const raised = [];
  const fixed = [];
  const clean = [];
  let notAdded = 0;
  for (const one of failing) {
    const text = pointLine(one?.text);
    const key = pointLine(one?.key || text, POINT_KEY_MAX);
    if (!text || !key || seen.has(key)) continue;
    seen.add(key);
    clean.push({ key, text });
  }
  // First the failures this card already knows: each stays open, or
  // opens again, and counts the round.
  const fresh = [];
  for (const { key, text } of clean) {
    const known = out.find((point) => point.gate === gate && (point.key || point.text) === key);
    if (!known) {
      fresh.push({ key, text });
      continue;
    }
    if (known.state === 'done') {
      known.state = 'open';
      delete known.doneAt;
      delete known.doneRound;
      delete known.doneBy;
    }
    if (known.lastRound !== round) known.rounds = (Number(known.rounds) || 1) + 1;
    known.lastRound = round;
    known.text = text;
  }
  // Then what the run found fixed, so the room it frees is room.
  if (judgedAll) {
    for (const point of out) {
      if (point.gate !== gate || point.state !== 'open' || seen.has(point.key || point.text) || !judges(point)) continue;
      point.state = 'done';
      point.doneAt = at;
      point.doneRound = round;
      if (by) point.doneBy = String(by).slice(0, 64);
      fixed.push(point.id);
    }
  }
  // Then the new failures, never past the cap on open work: a point that
  // cannot be added without dropping an open one is counted, not raised.
  for (const { key, text } of fresh) {
    const room = POINTS_MAX - out.filter((point) => point.state === 'open').length;
    if (raised.length >= POINTS_PER_ROUND_MAX || room <= 0) {
      notAdded += 1;
      continue;
    }
    const point = { id: idFor({ key, text }, raised.length), gate, text, from: round, rounds: 1, lastRound: round, state: 'open', at };
    if (key !== text) point.key = key;
    if (by) point.by = String(by).slice(0, 64);
    out.push(point);
    raised.push(point.id);
  }
  const kept = capPoints(out);
  return {
    points: kept,
    raised,
    fixed,
    open: kept.filter((point) => point.gate === gate && point.state === 'open').map((point) => point.id),
    notAdded,
  };
}

/** "3 of 5 points fixed" for one gate, or nothing when it has none. */
export function fixedLine(points = [], gate) {
  const here = points.filter((point) => point.gate === gate);
  if (!here.length) return '';
  const done = here.filter((point) => point.state === 'done').length;
  return `${done} of ${here.length} ${here.length === 1 ? 'point' : 'points'} fixed`;
}
