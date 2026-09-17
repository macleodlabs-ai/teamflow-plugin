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
  if (marked.test(before)) after = before.replace(marked, block);
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
