// Claude Code UI preferences that live in each config dir's `.claude.json` (global config),
// not in settings.json, so the synced payload cannot carry them. The launcher re-applies them
// on every start, for the base dir and each seat; inside a session the user may still toggle
// (the CLI writes the key back), and the next launch resets it.
//
// diffSidebarOpen: false — the right-hand diff panel stays closed until `/diff` opens it.
// Unset, the CLI auto-opens it in any wide fullscreen terminal inside a git repo.
// (Not `diffTool`: that only chooses whether edits open as IDE diffs — "auto" | "terminal".)
import fs from 'fs';

export const GLOBAL_DEFAULTS = { diffSidebarOpen: false };

/** Apply GLOBAL_DEFAULTS to a `.claude.json`; true when written. Never creates or repairs one. */
export function applyGlobalDefaults(file) {
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  if (!config || typeof config !== 'object') return false;
  const stale = Object.entries(GLOBAL_DEFAULTS).filter(([k, v]) => config[k] !== v);
  if (!stale.length) return false;
  for (const [k, v] of stale) config[k] = v;
  // Write-then-rename: a running session may read this file at any moment.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, file);
  return true;
}
