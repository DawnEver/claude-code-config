#!/usr/bin/env node
// settings-hooks.mjs — the template OWNS the payload's `hooks`: carry it into the live settings.
//
//   node ~/.claude/scripts/setup/settings-hooks.mjs           report which events drifted
//   node ~/.claude/scripts/setup/settings-hooks.mjs --apply   write the template's hooks into
//                                                             the sync dir's claude_settings.json
//
// claude_settings.json is the user's payload in the sync dir, seeded ONCE from the template by
// setup; nothing else rewrites it, so a hook rewiring merged into the template reached no
// workstation (the 2026-11-16 finding). The hooks are machine wiring, not a personal preference:
// the template is their one source, doctor reports a payload whose hooks differ
// (payload-hooks-drift) and this door applies them. Every other key of the payload is kept.
//
// The write is IN PLACE (no temp-and-rename): on a host without symlink rights
// ~/.claude holds the payload as a hard link (setup.js healSyncLink), and a rename would detach it. One
// apply serves every workstation, since they all link the same synced file, and it may land
// before a workstation has pulled: the SessionStart command pulls first when the entry it names
// is absent (claude-hook.mjs hookCommand).

import fs from 'fs';
import path from 'path';
import { isMain } from '../shared/is-main.mjs';
import { getSyncDir, sourceDir } from './setup.js';

/** Canonical JSON: key order never counts as drift. */
const canon = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

/** The hook events whose wiring differs between the live settings and the template, sorted. */
export function hooksDrift(live, template) {
  const a = live?.hooks ?? {}, b = template?.hooks ?? {};
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((e) => canon(a[e]) !== canon(b[e])).sort();
}

/**
 * Replace the `hooks` of the settings at `settingsPath` with the template's, in place.
 * -> {changed: boolean, events: [drifted event]}
 */
export function applyTemplateHooks({ settingsPath = path.join(getSyncDir(), 'claude_settings.json'),
  templatePath = path.join(sourceDir, 'claude_settings.template.json') } = {}) {
  const text = fs.readFileSync(settingsPath, 'utf8');
  const live = JSON.parse(text);
  const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
  const events = hooksDrift(live, template);
  if (!events.length) return { changed: false, events };
  const next = JSON.stringify({ ...live, hooks: template.hooks }, null, 4) + (text.endsWith('\n') ? '\n' : '');
  fs.writeFileSync(settingsPath, next);
  return { changed: true, events };
}

if (isMain(import.meta.url)) {
  const settingsPath = path.join(getSyncDir(), 'claude_settings.json');
  try {
    if (process.argv.includes('--apply')) {
      const { changed, events } = applyTemplateHooks({ settingsPath });
      console.log(changed ? `UPDATED ${settingsPath}: hooks of ${events.join(', ')} now match the template` : `OK    ${settingsPath}: hooks already match the template`);
    } else {
      const events = hooksDrift(JSON.parse(fs.readFileSync(settingsPath, 'utf8')),
        JSON.parse(fs.readFileSync(path.join(sourceDir, 'claude_settings.template.json'), 'utf8')));
      console.log(events.length ? `DRIFT ${settingsPath}: ${events.join(', ')} — apply with --apply` : `OK    ${settingsPath}: hooks match the template`);
      process.exitCode = events.length ? 1 : 0;
    }
  } catch (e) {
    console.error(`[settings-hooks] ${settingsPath}: ${e.message}`);
    process.exitCode = 1;
  }
}
