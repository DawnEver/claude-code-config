// scripts/setup/codex-config-file.mjs — the filesystem side of the codex config split.
//
// Kept apart from codex-config-compose.mjs (pure text) and from setup.js (which was
// already 600 lines mixing symlinks, user-data migration and TOML composition).
//
// Everything here touches either a CLOUD-SYNCED file or the live ~/.codex/config.toml,
// so every write is atomic (tmp + rename), validated before it happens, and backed up the
// first time content is discarded.

import fs from 'fs';
import path from 'path';

import {
  sharedHeadOf,
  localSectionsOf,
  splitCodexConfig,
  composeCodexConfig,
  assertLossless,
} from './codex-config-compose.mjs';
import { generateModelProvidersBlock } from './inject-codex-providers.mjs';

/**
 * Write atomically: a crash mid-write must not leave a truncated config, and a reader
 * (a running Codex) must never observe a partial file.
 */
export function writeFileAtomic(target, content) {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  try {
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Keep only the local sections whose project path still exists on THIS host.
 *
 * The pre-split `~/.codex/config.toml` was a symlink into the shared tree, so its
 * `[projects.*]` list is the whole fleet's — 30 entries across two usernames and three
 * drive letters. Importing all of them would spread dead paths; discarding all of them
 * (the previous behaviour) threw away this host's own trust decisions. Keep the ones that
 * resolve here, drop the rest.
 */
export function localSectionsForThisHost(text) {
  const { local } = splitCodexConfig(text);
  const kept = local.filter(section => {
    if (!section.header.startsWith('projects.')) return true; // hooks.state / notice
    const raw = section.header.slice('projects.'.length).trim();
    const p = raw.replace(/^["']|["']$/g, '');
    try { return fs.existsSync(p); } catch { return false; }
  });
  return {
    text: kept.map(s => s.text.trim()).filter(Boolean).join('\n\n'),
    kept: kept.length,
    dropped: local.length - kept.length,
  };
}

/**
 * Compose this host's `~/.codex/config.toml` and normalize the shared payload head.
 *
 * @param {{syncDir: string, envSettingsPath: string, codexDir: string}} opts
 * @returns {{status: string, [k: string]: any}}
 */
export function composeCodexConfigFile({ syncDir, envSettingsPath, codexDir }) {
  const payloadPath = path.join(syncDir, 'codex_config.toml');

  let payloadText;
  try {
    if (!fs.existsSync(payloadPath)) return { status: 'no-head' };
    payloadText = fs.readFileSync(payloadPath, 'utf8');
  } catch (err) {
    // A Files-On-Demand placeholder, an offline cloud client, or EACCES. Never abort
    // setup for this — the link phase still has useful work to do.
    return { status: 'unreadable', error: err };
  }

  try {
    assertLossless(payloadText);
  } catch (err) {
    return { status: 'unsafe', error: err };
  }

  const head = sharedHeadOf(payloadText);

  // Normalize the payload only when it still carries machine state, and keep a backup the
  // first time we discard anything from a cloud-synced file.
  const leaked = splitCodexConfig(payloadText).local.length;
  if (leaked > 0 && head !== payloadText) {
    const bak = `${payloadPath}.pre-split-bak`;
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, payloadText);
    writeFileAtomic(payloadPath, head);
  }

  let providersBlock = '';
  let providers = 0;
  try {
    const settings = JSON.parse(fs.readFileSync(envSettingsPath, 'utf8'));
    providersBlock = splitCodexConfig(generateModelProvidersBlock(settings)).generated;
    providers = (providersBlock.match(/^\[model_providers\./gm) || []).length;
  } catch {
    // Missing/malformed shared registry is reported by the caller.
  }

  const target = path.join(codexDir, 'config.toml');

  let localText = '';
  let importedFromFleet = 0;
  let droppedDeadPaths = 0;
  const before = fs.lstatSync(target, { throwIfNoEntry: false });
  if (before) {
    try {
      // A symlink still points at the pre-split shared file; read THROUGH it, then keep
      // only what belongs to this host.
      const existing = fs.readFileSync(target, 'utf8');
      assertLossless(existing);
      const filtered = localSectionsForThisHost(existing);
      localText = filtered.text;
      droppedDeadPaths = filtered.dropped;
      if (before.isSymbolicLink()) importedFromFleet = filtered.kept;
    } catch {
      localText = '';
    }
  }

  const next = composeCodexConfig({ head, providersBlock, localSections: localText });

  fs.mkdirSync(codexDir, { recursive: true });
  if (before && before.isSymbolicLink()) fs.unlinkSync(target);

  let current = null;
  try { current = fs.readFileSync(target, 'utf8'); } catch { current = null; }

  // Skip the write when nothing changed: check-links runs this on every SessionStart and
  // on every codex launch, and rewriting a file a running Codex may be reading is a race
  // worth not taking for a no-op.
  const changed = current !== next;
  if (changed) writeFileAtomic(target, next);

  return {
    status: 'written',
    changed,
    providers,
    localSections: splitCodexConfig(next).local.length,
    strippedFromPayload: leaked,
    importedFromFleet,
    droppedDeadPaths,
  };
}
