// Which tests failed, out of a test run's output (ADHOC-19).
//
// The owner: "Each card that fails a gate ... should get sent back with a
// reason and failure points. Each subsequent rebuild/retest checks those
// points off in turn." For a test gate the points are the failing tests.
//
// What is kept is the test's IDENTIFIER and nothing else: its file and its
// name, as the runner printed them on its own FAIL line, with a pytest
// parameter part (`test_login[alice@example.com-pw]`) cut off. Never the
// assertion message, the diff, the stack trace or any other line of the
// output. Capped in count and length.
//
// Names do not leave the machine: the owner declined on 2026-09-22, for
// now. A failing run reports one point per test file with a count
// ("src/lib/save.test.ts: 2 tests failing") and no test name. The switch
// (`reporting.failingTests`) stays off; docs/REPORTING_CONTRACT.md says so.
//
// Pure, and it recognises only the runners' own summary lines: a line it
// does not know is ignored, so an unknown runner gives no points rather
// than wrong ones.

export const FAILING_TESTS_MAX = 20;
export const TEST_ID_MAX = 160;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|(?:^|\/)test_[^/]*\.py|_test\.(?:py|go))$/;

const PATTERNS = [
  // pytest: "FAILED tests/test_x.py::test_name[params] - AssertionError: ..."
  { re: /^FAILED\s+(\S+?::[^\s[]+)/, id: (m) => m[1] },
  // vitest: " FAIL  src/x.test.ts > group > name"
  { re: /^\s*FAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?\s+>\s.+?)\s*$/, id: (m) => m[1] },
  // jest: "  ● group › name"
  { re: /^\s*●\s+(.+›.+)$/, id: (m) => m[1] },
  // node:test and TAP: "not ok 3 - name", indented for a subtest
  { re: /^\s*not ok \d+ - (.+?)(?:\s+#\s.*)?$/, id: (m) => m[1] },
  // go test: "--- FAIL: TestName (0.00s)"
  { re: /^\s*--- FAIL: (\S+)/, id: (m) => m[1] },
];

function textOf(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    return ['stdout', 'stderr', 'output', 'content', 'error']
      .map((name) => (typeof value[name] === 'string' ? value[name] : ''))
      .join('\n');
  }
  return '';
}

function clean(name) {
  return Array.from(name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\ufeff]/g, '')
    // A parameter part in brackets is data, not a name.
    .replace(/\s*\[[^\]]*\]\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()).slice(0, TEST_ID_MAX).join('').trim();
}

/**
 * The failing tests' identifiers, in the order printed, de-duplicated, and
 * whether the list was cut at the cap. A cut list did not name every
 * failure, so nothing may be checked off on the strength of it.
 */
export function readFailingTests(value) {
  const names = [];
  let capped = false;
  for (const raw of textOf(value).replace(ANSI, '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    for (const { re, id } of PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      const name = clean(id(m));
      // A TAP parent that failed because its subtest did is not a second test.
      if (name && !names.includes(name) && !TEST_FILE.test(name)) {
        if (names.length >= FAILING_TESTS_MAX) capped = true;
        else names.push(name);
      }
      break;
    }
    if (capped) break;
  }
  return { names, capped };
}

/** The failing tests' identifiers, capped. */
export function failingTests(value) {
  return readFailingTests(value).names;
}

/** The file a test identifier names, or the whole identifier when it names none. */
export function testFile(id) {
  return String(id || '').split(/::| > /)[0].replace(/^\.\//, '');
}

/**
 * One point per test file with a count, for when names may not leave the
 * machine: "src/lib/save.test.ts: 2 tests failing". An identifier with no
 * file (jest, TAP, go) counts toward one "N tests failing" point.
 */
export function countedByFile(names) {
  const counts = new Map();
  for (const name of names) {
    const file = name.includes('::') || name.includes(' > ') ? testFile(name) : '';
    counts.set(file, (counts.get(file) || 0) + 1);
  }
  return [...counts].map(([file, n]) => {
    const said = `${n} ${n === 1 ? 'test' : 'tests'} failing`;
    return file ? { key: file, text: `${file}: ${said}` } : { key: 'tests', text: said };
  });
}

const RUNNER = /(?:^|\s)(?:pytest|vitest|jest|mocha|node\s+--test|go\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|npx\s+playwright\s+test)(?:\s|$|:)/;
// Flags that narrow a run to some test names inside the files it runs.
const NAME_FILTERS = new Set(['-k', '-t', '-g', '--grep', '--testNamePattern', '--test-name-pattern',
  '--testPathPattern', '--test-path-pattern', '-run', '--run', '--filter', '--test-name', '--match']);
// Flags that take a value which is not a test selection.
const VALUE_FLAGS = new Set(['-p', '-c', '-n', '-r', '--tb', '--reporter', '--maxfail', '--config', '--project',
  '--workers', '--pool', '--timeout', '--rootdir', '--test-reporter', '--test-reporter-destination']);
const COMMAND_WORDS = new Set(['npx', 'npm', 'pnpm', 'yarn', 'bun', 'run', 'test', 'python', 'python3', '-m',
  'pytest', 'vitest', 'jest', 'mocha', 'node', 'go', '--', './...', 'playwright', 'exec']);

/**
 * What a test command ran: the test files it named, and whether it ran
 * less than those files in full or less than the whole suite without
 * naming files. A directory, a bare filter word (`vitest run save`), a
 * pytest node id (`file::test`), a glob or a name filter (`-k`, `-t`,
 * `--grep`, `--testNamePattern`) all make it partial, and a partial run
 * checks nothing off: it cannot say which tests it left out.
 */
export function testScope(command) {
  const segment = String(command || '').split(/&&|\|\||;|\|/).find((part) => RUNNER.test(part)) || '';
  const words = segment.trim().split(/\s+/).filter(Boolean);
  const files = [];
  let partial = false;
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
    const [flag, inline] = word.split(/=(.*)/s);
    if (NAME_FILTERS.has(flag)) {
      partial = true;
      if (inline === undefined) i += 1;
      continue;
    }
    if (VALUE_FLAGS.has(flag)) {
      if (inline === undefined) i += 1;
      continue;
    }
    if (word.startsWith('-') || COMMAND_WORDS.has(word)) continue;
    const path = word.replace(/^\.\//, '');
    if (!/[*?{]/.test(path) && TEST_FILE.test(path.replace(/::.*$/, ''))) {
      files.push(path.replace(/::.*$/, ''));
      if (path.includes('::')) partial = true;
      continue;
    }
    // The top-level test directory is the whole suite (`pytest tests`).
    if (/^(?:tests?|spec|__tests__)\/?$/.test(path)) continue;
    partial = true;
  }
  return { files, partial };
}

// --- which runner's tests a run can judge -------------------------------
//
// Every runner reports into the one test gate, and a repository often runs
// two (this one runs pytest and vitest). A complete pytest run says nothing
// about a vitest test, so a run judges only the points of its own family:
// Python files for pytest, `_test.go` for go, JavaScript and TypeScript
// test files for vitest, jest, mocha and node:test. A point whose name
// carries no file keeps its family in its key (`js|group › name`).

/** The family of tests a command runs, or nothing when it cannot be told. */
export function runnerFamily(command) {
  const segment = String(command || '').split(/&&|\|\||;|\|/).find((part) => RUNNER.test(part)) || '';
  if (/(?:^|\s)pytest(?:\s|$)/.test(segment)) return 'py';
  if (/(?:^|\s)go\s+test(?:\s|$)/.test(segment)) return 'go';
  return segment ? 'js' : undefined;
}

/** The family a test file belongs to, or nothing. */
export function fileFamily(path) {
  const file = String(path || '');
  if (/\.py$/.test(file)) return 'py';
  if (/_test\.go$/.test(file)) return 'go';
  if (/\.[cm]?[jt]sx?$/.test(file)) return 'js';
  return undefined;
}

/** A failure with no file keeps its runner's family in its key. */
export function withFamily(failure, family) {
  const key = failure.key || failure.text;
  return fileFamily(testFile(key)) || !family ? failure : { ...failure, key: `${family}|${key}` };
}

/** The family of a stored test point. */
export function pointFamily(point) {
  const key = String(point?.key || point?.text || '');
  return fileFamily(testFile(key)) || (/^(py|go|js)\|/.exec(key) || [])[1];
}
