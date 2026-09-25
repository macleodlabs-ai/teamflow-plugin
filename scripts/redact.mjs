// What a line of free text loses before it leaves the machine (MACLEOD-793).
//
// Agent view is the one place the plugin sends words a person or a model
// wrote, so every line passes through two steps, in this order:
//
// 1. `stripCode`: source code never leaves the organisation. A fenced
//    block (``` or ~~~, closed or not) and a block of four or more lines
//    that looks like code become "[code, N lines]"; an inline span longer
//    than 60 characters becomes "[code]".
// 2. `redactSecrets`: keys, tokens, `.env` values, private keys and
//    credentials in URLs become "[redacted]".
//
// Before this file the plugin had no redaction at all: its reports carry
// derived facts only, so there was nothing to redact. The nearest thing
// is `SAY_SECRET` in words.mjs, which REFUSES a card line that looks like
// a secret rather than masking it, and is pinned to the service's twin by
// tests/fixtures/say-vectors.json. Its token prefixes are repeated below
// on purpose rather than imported, so that changing one never moves the
// other's answers.

const REDACTED = '[redacted]';

// --- code ------------------------------------------------------------------

const FENCE = /(`{3,}|~{3,})[^\n`~]*\n?([\s\S]*?)(?:\1|$)/g;
const INLINE = /`([^`\n]+)`/g;
const INLINE_MAX = 60;
const BLOCK_MIN = 4;
const INDENTED = /^(?: {4}|\t)/;
// One line that reads as code rather than prose: it ends like a statement
// or a block, opens like a declaration, or carries an operator prose
// rarely has.
const CODEY = /[;{}]\s*$|^\s*(?:def|class|import|from|return|const|let|var|function|export|if|for|while|elif|else|try|catch|except|public|private|func|fn|package|#include|SELECT|INSERT|UPDATE)\b|=>|:=|==|\)\s*[:{]\s*$|^\s*[}\])]+[;,]?\s*$|^\s*<\/?[a-zA-Z][\w-]*[^>]*>\s*$/;

const linesIn = (body) => {
  const trimmed = String(body).replace(/\n+$/, '');
  return trimmed ? trimmed.split('\n').length : 0;
};
const codeMark = (n) => `[code, ${n} line${n === 1 ? '' : 's'}]`;

/** Every run of four or more lines that looks like code, folded to one mark. */
function foldBlocks(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    // An indented run: every line indented or blank, at least half of the
    // non-blank ones code-shaped.
    let j = i;
    while (j < lines.length && (INDENTED.test(lines[j]) || (j > i && !lines[j].trim() && INDENTED.test(lines[j + 1] || '')))) j += 1;
    const indented = lines.slice(i, j).filter((l) => l.trim());
    if (indented.length >= BLOCK_MIN && indented.filter((l) => CODEY.test(l)).length * 2 >= indented.length) {
      out.push(codeMark(indented.length));
      i = j;
      continue;
    }
    // A run at any indent where every line is code-shaped: code pasted
    // without a fence.
    j = i;
    while (j < lines.length && lines[j].trim() && CODEY.test(lines[j])) j += 1;
    if (j - i >= BLOCK_MIN) {
      out.push(codeMark(j - i));
      i = j;
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  return out.join('\n');
}

/** Text with its source code taken out and counted. Prose around it stays. */
export function stripCode(text) {
  let s = String(text ?? '');
  s = s.replace(FENCE, (_m, _fence, body) => codeMark(Math.max(1, linesIn(body))));
  s = foldBlocks(s);
  s = s.replace(INLINE, (m, body) => (body.length > INLINE_MAX ? '[code]' : m));
  return s;
}

// --- secrets ---------------------------------------------------------------

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;
// scheme://user:password@host, and scheme://token@host.
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
const AUTH_SCHEME = /\b(Bearer|Basic|Token|token)\s+[A-Za-z0-9._~+/=-]{8,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g;
// A `.env` line or an environment variable given on a command line.
const ENV_VALUE = /\b((?:export\s+)?[A-Z][A-Z0-9_]{2,}\s*=\s*)("[^"\n]*"|'[^'\n]*'|[^\s"'`]+)/g;
// Anything named like a secret: api_key: x, "token": "x", password=x.
const NAMED = /(\b[\w.-]*(?:key|token|secret|passw(?:or)?d|pwd|credentials?)[\w.-]*["']?\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;}]+)/gi;
// Known token shapes: the prefixes SAY_SECRET knows, and a few more.
const PREFIXED = /\b(?:sk|pk|rk|dk|ghp|gho|ghs|ghu|ghr|github_pat|xox[abprs]|xapp|glpat|npm|whsec|shpat|hf)[-_][A-Za-z0-9_-]{8,}|\b(?:AKIA|ASIA)[A-Z0-9]{12,}|\bAIza[0-9A-Za-z_-]{20,}/g;
// A long opaque run with letters and digits in it. No `/` and no `.`,
// so a path or a file name survives; a git hash does not, which is the
// price of catching hex keys.
const OPAQUE = /\b(?=[A-Za-z0-9+=_-]*\d)(?=[A-Za-z0-9+=_-]*[A-Za-z])[A-Za-z0-9+=_-]{32,}/g;
// A base64 secret with `/` in it (an AWS secret key): upper, lower and a
// digit, and not part of a path, which never starts a run like this.
const BASE64 = /(?<![\w/.-])(?=[A-Za-z0-9+/=]*\d)(?=[A-Za-z0-9+/=]*[a-z])(?=[A-Za-z0-9+/=]*[A-Z])[A-Za-z0-9+/=]{30,}/g;

/** Text with every secret shape it holds replaced by "[redacted]". */
export function redactSecrets(text) {
  let s = String(text ?? '');
  s = s.replace(PRIVATE_KEY, REDACTED);
  s = s.replace(URL_CREDENTIALS, `$1${REDACTED}@`);
  s = s.replace(AUTH_SCHEME, `$1 ${REDACTED}`);
  s = s.replace(JWT, REDACTED);
  s = s.replace(ENV_VALUE, (m, name, value) => (value === REDACTED ? m : `${name}${REDACTED}`));
  s = s.replace(NAMED, (m, name, value) => (value.includes(REDACTED) ? m : `${name}${REDACTED}`));
  s = s.replace(PREFIXED, REDACTED);
  s = s.replace(OPAQUE, REDACTED);
  s = s.replace(BASE64, REDACTED);
  return s;
}

/** Both steps, code first: what every agent view line goes through. */
export function cleanLine(text) {
  return redactSecrets(stripCode(text));
}
