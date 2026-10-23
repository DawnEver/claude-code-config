#!/usr/bin/env node
// Shared link-health check over the links setup.js maintains (both ~/.claude
// and ~/.codex). Used by the Claude Code SessionStart hook
// (scripts/hooks/setup-check-hook.js) and by the Codex launcher
// (scripts/runtime/codex.js — this repo uses the launcher as Codex's checkpoint;
// Claude's user hook settings are not projected into Codex).
//
// Auto-repairs the lossless cases (missing dest -> re-link; claude-hud config
// symlink -> hard link; a sync payload file whose link a cloud client broke, see
// healSyncLinks). A drifted plain file that may hold edits of its own is reported,
// never touched. See setup-check-hook.js header.
import fs from 'fs';
import path from 'path';
import { installCodexHooks } from './codex-hooks.mjs';
import {
  sourceDir,
  claudeDir,
  codexDir,
  CLAUDE_LINKS,
  SEAT_LINKS,
  localSeats,
  getCodexLinks,
  ensureClaudeHudConfig,
  linkEntry,
  getSyncDir,
  linkSourceRoot,
  composeCodexConfigFile,
  isHardLinked,
  sameVolume,
} from './setup.js';
import { regenerateCodexArtifacts } from './inject-codex-providers.mjs';

// Works from any cwd because ~/.claude/scripts is itself a link into the repo.
export const SETUP_FIX_CMD = 'node ~/.claude/scripts/setup/setup.js --replace';

/**
 * Re-link the sync payload files a cloud client detached (2026-10-18). Without symlink rights
 * setup hard-links them, and a cloud client replaces the synced file on every download, which breaks
 * the link: the host then reads a private copy and never sees another host's edit.
 *   - sync copy at least as new as the private one: the change came from the cloud and nothing
 *     was edited here since the break, so re-linking loses nothing (the copy is kept as
 *     .setup-bak when it differs).
 *   - private copy newer: edited here after the break, on top of a stale base. Both sides hold
 *     something; merging is a human's call, so it is reported (doctor: link-detached) and left.
 * -> {repaired: [dest], conflicts: [dest]}
 */
export function healSyncLinks({ syncDir = getSyncDir(), tables = [{ links: CLAUDE_LINKS, dir: claudeDir },
  ...localSeats().filter((x) => fs.existsSync(x.dir)).map((x) => ({ links: SEAT_LINKS, dir: x.dir }))] } = {}) {
  const repaired = [], conflicts = [];
  for (const { links, dir } of tables) {
    for (const link of links.filter((l) => l.base === 'sync' && l.type === 'file')) {
      const src = path.join(syncDir, link.src), dest = path.join(dir, link.dest);
      let st;
      try { st = fs.lstatSync(dest); } catch { continue; }   // missing: checkLinks re-links it
      if (!fs.existsSync(src) || st.isSymbolicLink() || !st.isFile() || isHardLinked(src, dest) || !sameVolume(src, dir)) continue;
      if (fs.statSync(src).mtimeMs >= st.mtimeMs) {
        try { if (linkEntry(src, dest, link, true).status === 'link') repaired.push(dest); } catch { conflicts.push(dest); }
      } else conflicts.push(dest);
    }
  }
  return { repaired, conflicts };
}

export function checkLinks() {
  const repaired = [];
  const warnings = [];

  // The claude-hud config is gitignored and per-machine (see ensureClaudeHudConfig), so a
  // fresh clone or a cleaned working tree has no link source until it is materialised.
  // Doing it here means the SessionStart self-heal covers it without a full setup run.
  try {
    if (ensureClaudeHudConfig(sourceDir)) repaired.push('claude-hud config (from template)');
  } catch {
    // Non-fatal: the link pass below reports the missing source if it still is one.
  }

  // Regenerate the derivable codex artifacts BEFORE verifying links, so a repo
  // that synced without re-running setup (or that lost the gitignored
  // models.json) still heals: ~/.codex/models.json points at repo models.json,
  // which only exists if we generate it here. Idempotent — no write when the
  // generated content already matches. Never blocks the session: any failure is
  // surfaced as a warning, never thrown (setup-check-hook.js has no try/catch
  // around this call).
  try {
    const syncDir = getSyncDir();
    const artifacts = regenerateCodexArtifacts({
      settingsPath: path.join(syncDir, 'claude_env_settings.json'),
      // setup composes ~/.codex/config.toml; never write a generated block into the
      // shared head that lives in the cloud payload.
      codexConfigPath: null,
      modelsPath: path.join(sourceDir, 'models.json'),
    });
    // Heal ~/.codex/config.toml too: it is a composed real file, not a link, so the link
    // loop below cannot detect or repair it. composeCodexConfigFile writes only when the
    // content actually differs, so the common case is a no-op and does not race a running
    // Codex. Report the outcome instead of discarding it.
    const codex = composeCodexConfigFile({
      syncDir,
      envSettingsPath: path.join(syncDir, 'claude_env_settings.json'),
      codexDir,
    });
    if (codex.status === 'written' && codex.changed) repaired.push('~/.codex/config.toml (recomposed)');
    else if (codex.status === 'unreadable') warnings.push('codex_config.toml: sync payload not readable (cloud placeholder?)');
    else if (codex.status === 'unsafe') warnings.push(`codex_config.toml: ${codex.error.message}`);
    if (artifacts.cache !== 'ok') warnings.push(artifacts.cache);
    if (artifacts.settings === 'unparseable') {
      warnings.push(`claude_env_settings.json: unparseable JSON (${artifacts.error.message})`);
    } else if (artifacts.settings === 'ok' && artifacts.models.status === 'updated') {
      repaired.push('models.json (regenerated)');
    }
    // settings === 'missing': pre-setup state — the link loop below silently
    // skips the codex artifact sources ('source not found'), consistent with the
    // existing silent-skip behavior. providers.status 'no-change'/'no-config'/
    // 'empty' are also intentionally silent.
  } catch (err) {
    warnings.push(`codex artifact regeneration: ${err.message}`);
  }

  // Before the link pass: a detached payload file is a plain file the pass below would only
  // report as drifted.
  try {
    const healed = healSyncLinks();
    for (const d of healed.repaired) repaired.push(`${d} (re-linked to the sync dir after a cloud client broke the link)`);
    for (const d of healed.conflicts) warnings.push(`${d}: detached from the sync dir and edited here since — reconcile it with the sync copy`);
  } catch (err) {
    warnings.push(`sync link heal: ${err.message}`);
  }

  const check = (links, baseDir, label = '') => {
    const syncDir = getSyncDir();
    for (const link of links) {
      // `base: 'sync'` entries live in the payload dir, not the repo — resolving them
      // against sourceDir made the three most important links permanently unverifiable.
      const srcPath = path.join(linkSourceRoot(link, { repoRoot: sourceDir, syncDir }), link.src);
      const destPath = path.join(baseDir, link.dest);
      try {
        const r = linkEntry(srcPath, destPath, link, false);
        if (r.status === 'link') {
          repaired.push(`${label}${link.dest} (${r.kind})`);
        } else if (r.status === 'skip' && !String(r.message).startsWith('source not found')) {
          // linkEntry's own hint ("re-run with --replace...") is dropped here;
          // callers append SETUP_FIX_CMD, which works from any cwd.
          warnings.push(`${label}${link.dest}: ${String(r.message).replace(/ - re-run with --replace.*$/, '')}`);
        }
      } catch (err) {
        warnings.push(`${label}${link.dest}: ${err.message}`);
      }
    }
  };

  check(CLAUDE_LINKS, claudeDir);
  // A seat dir setup has not created yet is setup's job, not a link to heal.
  for (const { alias, dir } of localSeats()) if (fs.existsSync(dir)) check(SEAT_LINKS, dir, `seat ${alias}: `);
  fs.mkdirSync(path.join(codexDir, 'skills'), { recursive: true });
  check(getCodexLinks(), codexDir);

  try {
    const result = installCodexHooks({ codexDir, scriptsDir: path.join(claudeDir, 'scripts') });
    if (result.changed) {
      repaired.push('Codex native hooks');
      warnings.push('Codex hook definitions changed; review/trust them with /hooks');
    }
  } catch (error) { warnings.push(`Codex hooks: ${error.message}`); }

  return { repaired, warnings };
}
