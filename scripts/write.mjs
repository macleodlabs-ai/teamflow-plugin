#!/usr/bin/env node
// The four ways TeamFlow is allowed to touch a developer's dotfiles,
// shared by the skills installer and the hooks installer.
//
// Every one of them is idempotent and every one of them leaves what it
// did not write alone: a file TeamFlow owns outright is written whole,
// a file the user also writes in gets a marked block, and a config file
// shared with other servers or other hooks is merged key by key.
// Installing twice must change nothing the second time, because it is
// the same command people run when they are not sure it worked.

import fs from 'node:fs';
import path from 'node:path';

export const BEGIN = '<!-- BEGIN teamflow -->';
export const END = '<!-- END teamflow -->';

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

export function writeFile(file, text, written, { mode } = {}) {
  ensureDir(file);
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  if (before === text) {
    if (mode !== undefined) fs.chmodSync(file, mode);
    written.push({ file, action: 'unchanged' });
    return;
  }
  fs.writeFileSync(file, text);
  if (mode !== undefined) fs.chmodSync(file, mode);
  written.push({ file, action: before === undefined ? 'created' : 'updated' });
}

// A marked block inside a file somebody else also writes to. Replaced in
// place on reinstall, so the user's own instructions above and below it
// survive and TeamFlow's half never doubles up.
export function writeBlock(file, text, written, { begin = BEGIN, end = END, header, mode } = {}) {
  ensureDir(file);
  const block = `${begin}\n${text.trim()}\n${end}\n`;
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const marked = new RegExp(`${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}\\n?`);
  let after;
  // A function, so a `$'` or `$&` in the block is text, not a pattern (MACLEOD-845).
  if (marked.test(before)) after = before.replace(marked, () => block);
  else if (before) after = `${before.replace(/\n*$/, '\n')}\n${block}`;
  else after = header ? `${header}\n${block}` : block;
  if (after === before) {
    if (mode !== undefined) fs.chmodSync(file, mode);
    written.push({ file, action: 'unchanged' });
    return;
  }
  fs.writeFileSync(file, after);
  if (mode !== undefined) fs.chmodSync(file, mode);
  written.push({ file, action: before ? 'updated' : 'created' });
}

function escapeRe(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Merge one entry into a config file the user shares with everything
// else they have configured. Never rewrites the file wholesale.
export function mergeJson(file, patch, written, { arrayUnion = false } = {}) {
  ensureDir(file);
  let current = {};
  let before;
  if (fs.existsSync(file)) {
    before = fs.readFileSync(file, 'utf8');
    try {
      current = JSON.parse(before);
    } catch {
      written.push({ file, action: 'skipped', reason: 'existing file is not valid JSON; merge it by hand' });
      return;
    }
  }
  const merged = deepMerge(current, patch, { arrayUnion });
  const text = `${JSON.stringify(merged, null, 2)}\n`;
  if (text === before) {
    written.push({ file, action: 'unchanged' });
    return;
  }
  fs.writeFileSync(file, text);
  written.push({ file, action: before === undefined ? 'created' : 'updated' });
}

// `arrayUnion` is for hook configuration, where the value under an
// event name is a list of everybody's hooks rather than one setting.
// Replacing that list would delete the user's own hooks; appending
// blindly would add TeamFlow's again on every reinstall. So entries are
// unioned by their exact content, which makes a reinstall a no-op and
// leaves anything already there alone.
export function deepMerge(base, patch, { arrayUnion = false } = {}) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    if (arrayUnion && Array.isArray(value) && Array.isArray(current)) {
      const seen = new Set(current.map((item) => JSON.stringify(item)));
      out[key] = [...current, ...value.filter((item) => !seen.has(JSON.stringify(item)))];
    } else if (value && typeof value === 'object' && !Array.isArray(value)
      && current && typeof current === 'object' && !Array.isArray(current)) {
      out[key] = deepMerge(current, value, { arrayUnion });
    } else {
      out[key] = value;
    }
  }
  return out;
}

// --- and the four ways back out --------------------------------------
//
// Uninstall is the inverse of the four writers above and nothing wider
// (MACLEOD-582). Each one removes exactly what its opposite number would
// add and leaves everything else where it is: a third-party entry in a
// shared config, a hook the customer wrote themselves into a file with
// the same name, their own instructions above and below a marked block.
// Removing something that is not there is not an error — `uninstall` is
// the command somebody runs when they are not sure what is installed.

// A file TeamFlow wrote whole. `marker` is the text every one of them
// carries; a file of that name without it belongs to somebody else —
// Cline's hook is `.clinerules/hooks/PostToolUse`, a name the customer
// may well have used first — and it is left exactly as it is.
export function removeFile(file, written, { marker } = {}) {
  if (!fs.existsSync(file)) {
    written.push({ file, action: 'absent' });
    return;
  }
  if (marker && !fs.readFileSync(file, 'utf8').includes(marker)) {
    written.push({ file, action: 'left alone', reason: 'not written by TeamFlow' });
    return;
  }
  fs.unlinkSync(file);
  written.push({ file, action: 'removed' });
}

// The inverse of writeBlock. The markers make this exact: what is
// between them is ours and what is outside them is not. A file with
// nothing outside them but the `#!/bin/sh` writeBlock itself put there
// is a file the installer created, so it goes; a file with a line of the
// customer's own in it stays, minus our block.
export function removeBlock(file, written, { begin = BEGIN, end = END, header } = {}) {
  if (!fs.existsSync(file)) {
    written.push({ file, action: 'absent' });
    return;
  }
  const before = fs.readFileSync(file, 'utf8');
  // The newlines before the block are taken with it, because writeBlock
  // is what added them; that is what makes install-then-uninstall
  // byte-identical rather than merely equivalent.
  const marked = new RegExp(`\\n*${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}\\n?`);
  const match = before.match(marked);
  if (!match) {
    written.push({ file, action: 'left alone', reason: 'no TeamFlow block' });
    return;
  }
  const head = before.slice(0, match.index);
  const tail = before.slice(match.index + match[0].length);
  const after = tail ? `${head}\n${tail}` : (head ? `${head}\n` : '');
  const theirs = header ? after.replace(header, '') : after;
  if (!theirs.trim()) {
    fs.unlinkSync(file);
    written.push({ file, action: 'removed' });
    return;
  }
  fs.writeFileSync(file, after);
  written.push({ file, action: 'updated' });
}

// The inverse of mergeJson: take this patch's contribution back out of a
// file the user shares with everything else they have configured.
export function unmergeJson(file, patch, written, { arrayUnion = false } = {}) {
  if (!fs.existsSync(file)) {
    written.push({ file, action: 'absent' });
    return;
  }
  const before = fs.readFileSync(file, 'utf8');
  let current;
  try {
    current = JSON.parse(before);
  } catch {
    written.push({ file, action: 'skipped', reason: "existing file is not valid JSON; remove TeamFlow's entries by hand" });
    return;
  }
  const after = deepUnmerge(current, patch, { arrayUnion });
  // Nothing left at all: every key in this file was one the installer
  // put there, so the file is the installer's too and it goes. A config
  // the customer already had has something of theirs in it by
  // definition, and keeps it.
  if (!Object.keys(after).length) {
    fs.unlinkSync(file);
    written.push({ file, action: 'removed' });
    return;
  }
  const text = `${JSON.stringify(after, null, 2)}\n`;
  if (text === before) {
    written.push({ file, action: 'unchanged' });
    return;
  }
  fs.writeFileSync(file, text);
  written.push({ file, action: 'updated' });
}

// The exact inverse of deepMerge. An array entry goes when it is ours
// character for character, which is the same comparison the union used;
// an object goes when removing ours emptied it; a value the customer has
// since changed is theirs now and stays.
export function deepUnmerge(base, patch, { arrayUnion = false } = {}) {
  const out = { ...base };
  const scalars = [];
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    if (current === undefined) continue;
    if (arrayUnion && Array.isArray(value) && Array.isArray(current)) {
      const ours = new Set(value.map((item) => JSON.stringify(item)));
      const kept = current.filter((item) => !ours.has(JSON.stringify(item)));
      if (kept.length) out[key] = kept;
      else delete out[key];
    } else if (isPlain(value) && isPlain(current)) {
      const kept = deepUnmerge(current, value, { arrayUnion });
      if (Object.keys(kept).length) out[key] = kept;
      else delete out[key];
    } else if (JSON.stringify(current) === JSON.stringify(value)) {
      scalars.push(key);
    }
  }
  // A scalar the installer set is usually shared ground rather than
  // TeamFlow's: `version: 1` at the top of `.cursor/hooks.json` is as
  // much the customer's file format as ours, and removing it from a file
  // that still holds their hooks would break it. So it only goes when
  // nothing else is left, which is the case where the whole file was
  // ours anyway.
  if (Object.keys(out).every((key) => scalars.includes(key))) {
    for (const key of scalars) delete out[key];
  }
  return out;
}

function isPlain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// One level only, and only when it is empty. `.teamflow/hooks` with its
// last shim gone is ours to tidy; `.github` with `hooks` gone is the
// customer's directory and is left even if it is empty now.
export function removeEmptyDir(dir, written) {
  try {
    if (fs.readdirSync(dir).length) return;
    fs.rmdirSync(dir);
    written.push({ file: dir, action: 'removed' });
  } catch { /* not there, or not empty, or not ours to remove */ }
}

// TOML, for Codex's config. A table written as a marked block rather
// than parsed: a real TOML round trip would reformat the whole file and
// lose the user's comments.
export function writeTomlTable(file, table, body, written) {
  ensureDir(file);
  const block = `# BEGIN teamflow\n[${table}]\n${body.trim()}\n# END teamflow\n`;
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const marked = /# BEGIN teamflow\n[\s\S]*?# END teamflow\n?/;
  const after = marked.test(before)
    ? before.replace(marked, block)
    : (before ? `${before.replace(/\n*$/, '\n')}\n${block}` : block);
  if (after === before) {
    written.push({ file, action: 'unchanged' });
    return;
  }
  fs.writeFileSync(file, after);
  written.push({ file, action: before ? 'updated' : 'created' });
}
