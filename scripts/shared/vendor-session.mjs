// vendor-session.mjs — resolve a continuation the launch args name without an id, so LAB_SESSION survives it.
//
// LAB_SESSION is ONE id per agent session, minted or inherited by ai-lab's `ai_lab.session` launcher, which every
// launch path runs the agent through (PLAN-a-short-robust-toolchain P4). It reads the vendor's conversation id from
// the args it is handed (`--resume <id>`, `--session-id <id>`, `codex resume <id>`) and pins a fresh Claude
// conversation itself. What it cannot read is a continuation with no id, so the launcher resolves it first:
//
// Claude Code (https://code.claude.com/docs/en/cli-reference): `--continue` takes the cwd's most recent transcript,
// `<config dir>/projects/<cwd slug>/<id>.jsonl`; it is handed on as `--resume <id>`.
// Codex: `codex resume --last` takes the newest rollout, `~/.codex/sessions/**/rollout-<stamp>-<id>.jsonl`; it is
// handed on as `codex resume <id>`. Nothing found: the args pass through unchanged.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTINUE = new Set(['--continue', '-c']);

/** Claude's project dir name for `cwd`: every character outside [A-Za-z0-9] becomes `-`. */
export function claudeProjectSlug(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** The newest `<uuid>.jsonl` (by mtime) under `dir`, recursively when `deep`; its uuid, or null. */
function newest(dir, pick, deep) {
  if (!existsSync(dir)) return null;
  let best = null;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (entry.isDirectory()) { if (deep) walk(path); continue; }
      const id = pick(entry.name);
      if (!id) continue;
      const at = statSync(path).mtimeMs;
      if (!best || at > best.at) best = { id, at };
    }
  };
  try { walk(dir); } catch { return null; }
  return best?.id ?? null;
}

/** `args` with `--continue` / `-c` replaced by `--resume <the cwd's newest transcript id>`; unchanged when none. */
export function claudeResumeArgs(args, { configDir, cwd }) {
  const at = args.findIndex((a) => CONTINUE.has(a));
  if (at < 0) return args;
  const dir = join(configDir, 'projects', claudeProjectSlug(cwd));
  const id = newest(dir, (n) => (n.endsWith('.jsonl') && UUID.test(n.slice(0, -6)) ? n.slice(0, -6) : null), false);
  return id ? [...args.slice(0, at), '--resume', id, ...args.slice(at + 1)] : args;
}

/** The thread id a rollout file name carries, or null. */
export function codexRolloutId(file) {
  const name = String(file ?? '').split(/[\\/]/).at(-1);
  return /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name)?.[1] ?? null;
}

/** `args` with `resume --last` replaced by `resume <the newest rollout's thread id>`; unchanged when none. */
export function codexResumeArgs(args, { codexHome }) {
  if (args[0] !== 'resume' || !args.includes('--last')) return args;
  const id = newest(join(codexHome, 'sessions'), codexRolloutId, true);
  return id ? ['resume', id, ...args.slice(1).filter((a) => a !== '--last')] : args;
}
