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
} from './setup.js';

// Works from any cwd because ~/.claude/scripts is itself a link into the repo.
export const SETUP_FIX_CMD = 'node ~/.claude/scripts/setup/setup.js --replace';

export function checkLinks() {
  const repaired = [];
  const warnings = [];

  const check = (links, baseDir) => {
    for (const link of links) {
      const srcPath = path.join(sourceDir, link.src);
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
