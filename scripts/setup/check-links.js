#!/usr/bin/env node
// Shared link-health check over the links setup.js maintains (both ~/.claude
// and ~/.codex). Used by the Claude Code SessionStart hook
// (scripts/hooks/setup-check-hook.js) and by the Codex launcher
// (scripts/runtime/codex.js — Codex has no session-start hook mechanism, so
// the launcher is its checkpoint).
//
// Auto-repairs the lossless cases (missing dest -> re-link; claude-hud config
// symlink -> hard link). A drifted plain file is reported, never touched —
// it may hold edits the repo never saw. See setup-check-hook.js header.
import path from 'path';
import {
  sourceDir,
  claudeDir,
  codexDir,
  CLAUDE_LINKS,
  getCodexLinks,
  ensureRealDir,
  linkEntry,
  getSyncDir,
  linkSourceRoot,
  composeCodexConfigFile,
} from './setup.js';
import { regenerateCodexArtifacts } from './inject-codex-providers.mjs';

// Works from any cwd because ~/.claude/scripts is itself a link into the repo.
export const SETUP_FIX_CMD = 'node ~/.claude/scripts/setup/setup.js --replace';

export function checkLinks() {
  const repaired = [];
  const warnings = [];

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
    // loop below cannot detect or repair it.
    composeCodexConfigFile({ syncDir, envSettingsPath: path.join(syncDir, 'claude_env_settings.json') });
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

  const check = (links, baseDir) => {
    const syncDir = getSyncDir();
    for (const link of links) {
      // `base: 'sync'` entries live in the payload dir, not the repo — resolving them
      // against sourceDir made the three most important links permanently unverifiable.
      const srcPath = path.join(linkSourceRoot(link, { repoRoot: sourceDir, syncDir }), link.src);
      const destPath = path.join(baseDir, link.dest);
      try {
        const r = linkEntry(srcPath, destPath, link, false);
        if (r.status === 'link') {
          repaired.push(`${link.dest} (${r.kind})`);
        } else if (r.status === 'skip' && !String(r.message).startsWith('source not found')) {
          // linkEntry's own hint ("re-run with --replace...") is dropped here;
          // callers append SETUP_FIX_CMD, which works from any cwd.
          warnings.push(`${link.dest}: ${String(r.message).replace(/ - re-run with --replace.*$/, '')}`);
        }
      } catch (err) {
        warnings.push(`${link.dest}: ${err.message}`);
      }
    }
  };

  check(CLAUDE_LINKS, claudeDir);
  ensureRealDir(path.join(codexDir, 'skills'));
  check(getCodexLinks(), codexDir);

  return { repaired, warnings };
}
