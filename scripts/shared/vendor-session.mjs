// vendor-session.mjs — the vendor's own conversation id, read from the launch args, so LAB_SESSION survives a resume.
//
// LAB_SESSION is ONE id per agent session (machine.mjs sessionEnv). A launcher-issued UUID per launch gave a
// resumed conversation a NEW id: its PR's notices and ONE-SESSION-ONE-PR saw a stranger. So the id is the
// vendor's conversation id wherever the launcher can know it, and the UUID is only the fallback:
//
// Claude Code (https://code.claude.com/docs/en/cli-reference): `--resume <id>` keeps the original session id
// (only `--fork-session` issues a new one -- the fork still carries the ORIGINAL's LAB_SESSION, which is the
// chain to the first session); `--session-id <uuid>` names it; `--continue` takes the cwd's most recent
// transcript, `<config dir>/projects/<cwd slug>/<id>.jsonl`. A FRESH launch is pinned: the launcher passes
// `--session-id <LAB_SESSION>`, so Claude's id IS LAB_SESSION and a later `--resume <id>` finds it again.
// A bare `--resume` (the picker) cannot be known at launch: fallback.
//
// Codex: `codex resume <id>` names the thread; `codex resume --last` takes the newest rollout,
// `~/.codex/sessions/**/rollout-<stamp>-<id>.jsonl`. A fresh Codex launch has no id yet: fallback.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function valueOf(args, names) {
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name && args[i + 1] && !args[i + 1].startsWith('-')) return args[i + 1];
      if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1) || null;
    }
  }
  return null;
}

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

/**
 * Claude Code's conversation id for `args`: `{ id, pin }`. `id` is the resumed/named one, or null; `pin` is
 * true for a fresh launch, which the launcher pins with `--session-id`.
 */
export function claudeSession(args, { configDir, cwd }) {
  const named = valueOf(args, ['--session-id']) || valueOf(args, ['--resume', '-r']);
  if (named) return { id: named, pin: false };
  if (args.includes('--continue') || args.includes('-c')) {
    const dir = join(configDir, 'projects', claudeProjectSlug(cwd));
    return { id: newest(dir, (n) => (n.endsWith('.jsonl') && UUID.test(n.slice(0, -6)) ? n.slice(0, -6) : null), false), pin: false };
  }
  if (args.includes('--resume') || args.includes('-r')) return { id: null, pin: false };  // the picker
  return { id: null, pin: true };
}

/** Codex's thread id for `args`: `resume <id>`, or `resume --last` read from the sessions dir; else null. */
export function codexSession(args, { codexHome }) {
  if (args[0] !== 'resume') return null;
  const id = args.slice(1).find((a) => !a.startsWith('-'));
  if (id) return id;
  if (!args.includes('--last')) return null;
  const rollout = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
  return newest(join(codexHome, 'sessions'), (n) => n.match(rollout)?.[1] ?? null, true);
}
