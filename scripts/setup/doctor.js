#!/usr/bin/env node
// doctor.js — turn this repo's documented invariants into checks that fail loudly.
//
// Every incident in .claude/memory/ has the same shape: an intended state and an
// actual state diverged, and nothing noticed. A hook was wired but its entry guard
// silently no-opped. The payload drifted from its template and a generator produced
// an empty catalogue. A doc described hooks the config no longer wired. An invariant
// the design explicitly named ("no absolute path in a shared file") was asserted in
// prose and enforced nowhere.
//
// Fixing those instances is a backlog. This file is the part that stops the class
// from recurring: each check below corresponds to a real, already-observed failure.
//
// Read-only. Never mutates anything. Exits 1 when a check FAILs.
//
//   node ~/.claude/scripts/setup/doctor.js          full report
//   node ~/.claude/scripts/setup/doctor.js --hook   SessionStart: silent unless something is wrong
//   node ~/.claude/scripts/setup/doctor.js --json   machine-readable
//   node ~/.claude/scripts/setup/doctor.js --public-hygiene   pre-commit gate (.githooks)

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import { isMain } from '../shared/is-main.mjs';
import { SYNC_PAYLOAD_FILES } from '../shared/sync-dir.mjs';
import { readMachineName, MACHINE_PATH, MACHINE_FIX_CMD } from '../shared/machine.mjs';
import { readBridgeConfig, bridgeSourceRevision, RUNTIME_FILE } from '../bridge/context.mjs';
import {
  sourceDir, claudeDir, codexDir, getSyncDir,
  CLAUDE_LINKS, getCodexLinks, linkSourceRoot,
} from './setup.js';

const HOME = os.homedir();

// An entry guard that compares a raw argv[1] against the module URL is always false
// in production, because every hook here is launched through the ~/.claude/scripts
// link and Node realpaths the module but not argv[1]. This is the bug that silently
// disabled loop-guard-hook.js for two days and made SETUP_FIX_CMD a no-op.
export function looksLikeBrokenGuard(line) {
  if (/^\s*(\/\/|#|\*|\/\*)/.test(line)) return false;   // prose about the idiom, not the idiom
  if (/realpath/.test(line)) return false;               // the correct form
  if (!/process\.argv\[1\]/.test(line)) return false;
  if (!/===|!==/.test(line)) return false;
  return /import\.meta\.url|__dirname|fileURLToPath/.test(line);
}

/** Absolute machine paths that must not appear in a file shared across hosts. */
export const ABSOLUTE_PATH_PATTERNS = [
  // A drive letter must be preceded by a boundary. Without that, `[A-Za-z]:[\/]`
  // matches the `v:/` in `env:/` and the `s:/` in `https://`, which is most of
  // what this check would otherwise report.
  { re: /(?:^|[\s"'(=:,])[A-Za-z]:[\\/]/, what: 'drive-letter path' },
  { re: /(?:^|[^\w])\/Users\/[A-Za-z0-9._-]+/, what: 'macOS home path' },
  { re: /(?:^|[^\w])\/home\/[A-Za-z0-9._-]+/, what: 'Linux home path' },
];

/** Which kinds of machine path this string holds, if any. */
export function absolutePathKinds(value) {
  if (typeof value !== 'string') return [];
  return ABSOLUTE_PATH_PATTERNS.filter(({ re }) => re.test(value)).map((p) => p.what);
}

/** Every string in a parsed JSON tree, with the key path that reaches it. */
export function walkStrings(node, keyPath = []) {
  if (typeof node === 'string') return [{ keyPath, value: node }];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) => walkStrings(v, [...keyPath, k]));
}

export function findAbsolutePaths(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/^\s*(?:\/\/|#)/.test(line)) return;            // a comment is not a value
    const kinds = absolutePathKinds(line);
    if (kinds.length) hits.push({ line: i + 1, what: kinds.join(' + '), text: line.trim().slice(0, 120) });
  });
  return hits;
}

/** Top-level key sets of two JSON objects, in both directions. */
export function compareKeySets(actual, template) {
  const a = Object.keys(actual ?? {});
  const t = Object.keys(template ?? {});
  return {
    onlyInActual: a.filter((k) => !t.includes(k)),
    onlyInTemplate: t.filter((k) => !a.includes(k)),
  };
}

/** `node ~/.claude/scripts/hooks/x.js --pull` -> [{ event, command, script }] */
export function parseHookCommands(settings, home = HOME) {
  const out = [];
  for (const [event, groups] of Object.entries(settings?.hooks ?? {})) {
    for (const group of [].concat(groups ?? [])) {
      for (const hook of group?.hooks ?? []) {
        if (hook?.type !== 'command' || typeof hook.command !== 'string') continue;
        const token = hook.command.split(/\s+/).find((t) => t.startsWith('~') || path.isAbsolute(t));
        if (!token) continue;
        out.push({ event, command: hook.command, script: token.startsWith('~') ? path.join(home, token.slice(1)) : token });
      }
    }
  }
  return out;
}

const finding = (level, id, title, detail) => ({ level, id, title, detail });

// ── checks ──

// A wired hook whose script is missing, or whose body is behind a broken guard, is
// indistinguishable from a healthy one at runtime: it exits 0 and says nothing.
export function checkHooks(settings, home = HOME) {
  const out = [];
  for (const { event, script } of parseHookCommands(settings, home)) {
    const label = path.basename(script);
    if (!fs.existsSync(script)) {
      out.push(finding('FAIL', 'hook-missing', `${event}: ${label} does not exist`, script));
      continue;
    }
    let text;
    try { text = fs.readFileSync(script, 'utf8'); } catch { continue; }
    const bad = text.split(/\r?\n/).findIndex(looksLikeBrokenGuard);
    if (bad >= 0) {
      out.push(finding('FAIL', 'hook-dead-guard', `${event}: ${label} has an entry guard that never fires`,
        `line ${bad + 1} compares raw argv[1] against the module URL; launched through the ~/.claude/scripts link this is always false, so the hook silently does nothing`));
    }
  }
  return out;
}

// The invariant docs/sync-architecture.md §2 states and §10 admits is unenforced.
export function checkPayloadPaths(syncDir, files = SYNC_PAYLOAD_FILES) {
  const out = [];
  for (const name of files) {
    const p = path.join(syncDir, name);
    if (!fs.existsSync(p)) continue;
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }

    // JSON payloads are inspected value-by-value rather than line-by-line, so a compact
    // file cannot hide a violation behind a formatting accident.
    if (name.endsWith('.json')) {
      let parsed;
      try { parsed = JSON.parse(text); } catch { continue; }   // reported by checkPayloadShape
      for (const { keyPath, value } of walkStrings(parsed)) {
        const kinds = absolutePathKinds(value);
        if (!kinds.length) continue;
        out.push(finding('FAIL', 'payload-abs-path', `${name} ${keyPath.join('.')} has a ${kinds.join(' + ')}`,
          `${value} — this file syncs to every host, so no host's path may appear in it`));
      }
      continue;
    }

    for (const hit of findAbsolutePaths(text)) {
      out.push(finding('FAIL', 'payload-abs-path', `${name}:${hit.line} has a ${hit.what}`,
        `${hit.text} — this file syncs to every host, so no host's path may appear in it`));
    }
  }
  return out;
}

// The 2026-08-29 incident: the payload kept an old shape, nothing compared it to the
// template, and the generator produced an empty catalogue instead of an error.
export function checkPayloadShape(syncDir, repoRoot = sourceDir, files = SYNC_PAYLOAD_FILES) {
  const out = [];
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    const templatePath = path.join(repoRoot, name.replace(/\.json$/, '.template.json'));
    const livePath = path.join(syncDir, name);
    if (!fs.existsSync(templatePath) || !fs.existsSync(livePath)) continue;
    let live, template;
    try { live = JSON.parse(fs.readFileSync(livePath, 'utf8')); } catch (e) {
      out.push(finding('FAIL', 'payload-unparsable', `${name} is not valid JSON`, e.message));
      continue;
    }
    try { template = JSON.parse(fs.readFileSync(templatePath, 'utf8')); } catch { continue; }
    if (name === 'claude_settings.json') {
      // /model writes a user preference; choosing Default can remove it. Neither is
      // template drift. Provider model IDs remain authoritative in providers.*.models.
      if (Object.hasOwn(live, 'model') && (typeof live.model !== 'string' || !live.model.trim())) {
        out.push(finding('FAIL', 'payload-invalid-model', 'claude_settings.json has an invalid model preference',
          'model must be a non-empty model alias or ID when present'));
      }
      live = { ...live }; template = { ...template };
      delete live.model; delete template.model;
    }
    const { onlyInActual, onlyInTemplate } = compareKeySets(live, template);
    if (onlyInTemplate.length) {
      out.push(finding('FAIL', 'payload-missing-key',
        `${name} is missing ${onlyInTemplate.length} key(s) its template declares`,
        `absent: ${onlyInTemplate.join(', ')} — code expecting the template's shape will not find them`));
    }
    if (onlyInActual.length) {
      out.push(finding('WARN', 'payload-extra-key',
        `${name} carries ${onlyInActual.length} key(s) the template lacks`,
        `${onlyInActual.join(', ')} — a fresh install seeded from the template will not get these`));
    }
  }
  return out;
}

// A link entry whose source or destination is gone is a silent absence: the file the
// hook or launcher expects simply is not there.
export function checkLinks({ repoRoot = sourceDir, syncDir = getSyncDir() } = {}) {
  const out = [];
  const tables = [
    { label: 'claude', base: claudeDir, links: CLAUDE_LINKS },
    { label: 'codex', base: codexDir, links: getCodexLinks(repoRoot) },
  ];
  for (const { label, base, links } of tables) {
    for (const link of links) {
      const src = path.join(linkSourceRoot(link, { repoRoot, syncDir }), link.src);
      const dest = path.join(base, link.dest);
      if (!fs.existsSync(src)) {
        if (link.optional) continue;
        out.push(finding('FAIL', 'link-src-missing', `${label}: ${link.dest} -> missing source`,
          `expected at ${src}`));
      } else if (!fs.existsSync(dest)) {
        out.push(finding('FAIL', 'link-dest-missing', `${label}: ${link.dest} is not linked`,
          `${dest} does not exist — run ${'node ~/.claude/scripts/setup/setup.js --replace'}`));
      }
    }
  }
  return out;
}

// Enabled-but-absent breaks a session; installed-but-never-enabled and orphans whose
// marketplace no longer exists are the accumulation that made this repo's plugin list
// unreadable.
export function checkPlugins(settings, home = HOME) {
  const out = [];
  const registryPath = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(registryPath)) return out;
  let registry;
  try { registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch { return out; }

  const records = registry.plugins ?? registry;
  const installed = new Set(Object.keys(records).filter((k) => k.includes('@')));
  const enabled = settings?.enabledPlugins ?? {};
  const marketsDir = path.join(home, '.claude', 'plugins', 'marketplaces');

  for (const [id, on] of Object.entries(enabled)) {
    if (on && !installed.has(id)) {
      out.push(finding('FAIL', 'plugin-enabled-not-installed', `${id} is enabled but not installed`,
        'the session will not get it'));
    }
  }
  for (const id of installed) {
    if (id in enabled) continue;
    const installs = Array.isArray(records[id]) ? records[id] : [];
    // Project-scoped installs are intentionally activated by that project, not
    // by the user-wide enabledPlugins map. Reporting them as globally dormant
    // made a healthy watch/cc-latex setup look broken on every host.
    if (installs.length && installs.every((entry) => entry?.scope === 'project')) continue;
    const market = id.split('@')[1];
    const known = market === 'local' || fs.existsSync(path.join(marketsDir, market));
    out.push(finding(known ? 'WARN' : 'WARN', 'plugin-dormant',
      `${id} is installed but never enabled`,
      known ? 'either uninstall it or list it in enabledPlugins' : `its marketplace "${market}" does not exist — an orphan`));
  }
  return out;
}

// Codex does not expose a Claude-style installed_plugins.json. Its cache is the
// observable install inventory, so compare it with the configured marketplace clone.
// This catches retired plugins (for example takeover after it was absorbed by fabric)
// without treating disabled-but-still-available plugins as orphans.
export function checkCodexPluginCache(repoRoot = sourceDir, home = HOME) {
  const cache = path.join(home, '.codex', 'plugins', 'cache', 'cc-market');
  const manifest = path.join(repoRoot, 'cc-market', '.agents', 'plugins', 'marketplace.json');
  if (!fs.existsSync(cache) || !fs.existsSync(manifest)) return [];
  let known;
  try {
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    known = new Set((parsed.plugins ?? []).map((p) => p.name));
  } catch {
    return [];
  }
  return fs.readdirSync(cache, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !known.has(entry.name))
    .map((entry) => finding('WARN', 'codex-plugin-orphan-cache',
      `${entry.name}@cc-market remains in the Codex cache but is no longer in the marketplace`,
      `${path.join(cache, entry.name)} — remove it after confirming no Codex process is using it`));
}

// Code hygiene that made a file unreadable to tools: a NUL byte makes git call a file
// binary (unreviewable diffs) and ripgrep skip it entirely.
export function checkHygiene(root = sourceDir) {
  const out = [];
  const roots = ['scripts', 'system-prompt', 'skills', 'output-styles'].map((d) => path.join(root, d));
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(mjs|js|cjs)$/.test(e.name)) continue;
      let buf;
      try { buf = fs.readFileSync(p); } catch { continue; }
      const rel = path.relative(root, p).replace(/\\/g, '/');
      if (buf.includes(0)) {
        out.push(finding('FAIL', 'hygiene-nul', `${rel} contains a NUL byte`,
          'git treats the file as binary (diffs unreviewable) and ripgrep skips it'));
      }
      const text = buf.toString('utf8');
      // Test files are excluded from both scans below: they are not entry points, and
      // they legitimately quote the very patterns being hunted (a fixture listing the
      // broken spellings, a fleet-shaped path in a fixture). This check's own test
      // file is the first thing a naive version reports.
      const isTest = /\.test\.mjs$/.test(e.name);
      if (isTest) continue;

      const bad = text.split(/\r?\n/).findIndex(looksLikeBrokenGuard);
      if (bad >= 0) {
        out.push(finding('FAIL', 'hygiene-guard', `${rel}:${bad + 1} uses the broken entry-guard idiom`,
          'use scripts/shared/is-main.mjs — a raw argv[1] comparison never fires through a link'));
      }
      // Same invariant as the payload, but for tracked code. WARN, not FAIL: a
      // hardcoded path in a script with a fallback is bounded, whereas one in the
      // payload breaks another host outright.
      for (const hit of findAbsolutePaths(text)) {
        out.push(finding('WARN', 'hygiene-abs-path', `${rel}:${hit.line} has a ${hit.what}`,
          `${hit.text} — prefers ~/... or a value resolved at runtime`));
      }
    }
  };
  for (const r of roots) walk(r);
  return out;
}

// ── public hygiene ──
// This repo is published. A tracked file must not name the owner's machines, accounts,
// hosts, chat ids or private projects. Two layers: generic shapes of personal data
// (below), plus a PRIVATE denylist at ~/.claude/private-markers (linked from the sync payload) —
// never tracked — because the concrete names are themselves the secret.
// A justified exception carries the inline marker `public-hygiene: allow (<reason>)`.

export const PRIVATE_MARKERS_PATH = path.join(HOME, '.claude', 'private-markers');

// Path segments that are obviously placeholders, not someone's account.
// A segment starting with `<` (`<user>`) never matches the patterns at all.
const NEUTRAL_USER = /^(?:user\d*|username|u|x|me|you|someone|other|name|example|runner|test|\.\.\.|…)$/i;
// RFC 2606 / 6761 reserved names, plus GitHub's privacy address.
const NEUTRAL_MAIL_DOMAINS = /(?:^|\.)(?:example\.(?:com|org|net)|users\.noreply\.github\.com|example|invalid|test|localhost)$/i;
const PLACEHOLDER_CHAT = /^-100(?:1234567890|(\d)\1{9,})$/;
const homeUser = (m) => !NEUTRAL_USER.test(m[1]);

export const PUBLIC_PATTERNS = [
  { what: 'Windows home path', re: /[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"'`<>*),;]+)/gi, bad: homeUser },
  { what: 'macOS home path', re: /(?<![\w.:])\/Users\/([^\\/\s"'`<>*),;]+)/g, bad: homeUser },
  { what: 'Linux home path', re: /(?<![\w.:])\/home\/([^\\/\s"'`<>*),;]+)/g, bad: homeUser },
  { what: 'email address', re: /\b([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g,
    bad: (m) => m[1] !== 'git' && !NEUTRAL_MAIL_DOMAINS.test(m[2]) },
  { what: 'Telegram chat id', re: /-100\d{9,}/g, bad: (m) => !PLACEHOLDER_CHAT.test(m[0]) },
  { what: 'org cloud folder', re: /OneDrive - [A-Za-z]/g, bad: () => true },
];

/** Parse private-markers text: one literal or /regex/flags per line, # comments. */
export function parseMarkers(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const rx = /^\/(.+)\/([a-z]*)$/.exec(line);
    try {
      out.push(rx
        ? new RegExp(rx[1], rx[2].includes('i') ? rx[2] : `${rx[2]}i`)
        : new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    } catch { /* an unparsable marker is skipped, not fatal */ }
  }
  return out;
}

/** Lines of `text` that carry personal data; `markers` are the private denylist. */
export function scanPublicHygiene(text, markers = []) {
  const hits = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    if (/public-hygiene: allow/.test(line)) return;
    const kinds = [];
    for (const p of PUBLIC_PATTERNS) {
      for (const m of line.matchAll(p.re)) if (p.bad(m)) { kinds.push(p.what); break; }
    }
    if (markers.some((re) => re.test(line))) kinds.push('private marker');
    if (kinds.length) hits.push({ line: i + 1, what: kinds.join(' + ') });
  });
  return hits;
}

function trackedFiles(root) {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter(Boolean);
  } catch { return []; }
}

export function checkPublicHygiene({ root = sourceDir, files = trackedFiles(root), markersFile = PRIVATE_MARKERS_PATH, requireMarkers = false } = {}) {
  let markers = [];
  const out = [];
  try { markers = parseMarkers(fs.readFileSync(markersFile, 'utf8')); } catch {
    // A plain clone has no denylist and that is fine. A fleet host (sync dir configured)
    // without one guards only the generic shapes and lets every private name through.
    if (requireMarkers) out.push(finding('WARN', 'private-markers-missing',
      '~/.claude/private-markers is missing; the public-hygiene guards cannot see private names',
      'put `private-markers` in the sync dir, then run node ~/.claude/scripts/setup/setup.js'));
  }
  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(root, rel)); } catch { continue; }
    if (buf.subarray(0, 8000).includes(0)) continue;          // binary
    for (const hit of scanPublicHygiene(buf.toString('utf8'), markers)) {
      // The matched text is deliberately not echoed: the report may itself be shared.
      out.push(finding('FAIL', 'public-hygiene', `${rel}:${hit.line} has a ${hit.what}`,
        'replace with a placeholder (<machine>, <chat-id>, <project>, ~/...) or mark `public-hygiene: allow (<reason>)`'));
    }
  }
  return out;
}

// Provenance (docs/harness-architecture.md §8b) fails silent by design: with no
// machine.json the launchers inject nothing, so agent commits on this host look
// exactly like manual ones and nobody notices the fleet name was never set. WARN,
// not FAIL — a host without a name still works, it just loses attribution.
export function checkMachineName(file = MACHINE_PATH) {
  if (readMachineName(file)) return [];
  const why = fs.existsSync(file) ? 'is not valid ({"name": "[A-Za-z0-9-]+"})' : 'is missing';
  return [finding('WARN', 'machine-name', `~/.claude/machine.json ${why}; agent commits carry no machine/agent provenance`,
    `fix: ${MACHINE_FIX_CMD}`)];
}

// Codex provenance rides ~/.codex/config.toml [shell_environment_policy.set], composed by
// setup (Codex may run commands in a shared daemon no launcher env reaches). A host that
// was named after its last setup run silently tags nothing, so check the composed file
// actually carries this machine's name. No config file = no Codex here = nothing to check.
export function checkCodexShellEnv({ machine = readMachineName(), configPath = path.join(HOME, '.codex', 'config.toml') } = {}) {
  if (!machine) return [];
  let text;
  try { text = fs.readFileSync(configPath, 'utf8'); } catch { return []; }
  if (text.includes(`HARNESS_MACHINE = ${JSON.stringify(machine)}`)) return [];
  return [finding('FAIL', 'codex-provenance',
    `~/.codex/config.toml lacks shell_environment_policy.set HARNESS_MACHINE = "${machine}"; Codex commits carry no provenance`,
    'fix: node scripts/setup/setup.js')];
}

// The fleet's bridge config is shared, but each host needs its OWN bot (one getUpdates
// consumer per token). A host that never got one is silently absent from Telegram.
export function checkBridgeHost({ sharedPath = path.join(HOME, '.claude', 'claude_env_settings.json'),
  localPath = path.join(HOME, '.claude', 'claude_env_settings.local.json') } = {}) {
  const b = readBridgeConfig({ sharedPath, localPath });
  const fleetBridged = b.fallbackChatId || Object.keys(b.projects).length;
  if (!fleetBridged || b.botToken) return [];
  return [finding('WARN', 'bridge-host', 'the fleet runs a session bridge but this host has no bot token; its sessions are not in Telegram',
    'create a bot for this machine and set bridge.botToken in ~/.claude/claude_env_settings.local.json, then run setup (docs/bridge.md § Setup)')];
}

/** Compare only a live daemon's startup fingerprint; never restart or rewrite it. */
export function checkBridgeRevision({ runtimeFile = RUNTIME_FILE, repoRoot = sourceDir,
  isAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } },
  revision = bridgeSourceRevision } = {}) {
  let runtime;
  try { runtime = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')); } catch { return []; }
  if (!Number.isInteger(runtime.pid) || runtime.pid <= 0 || !isAlive(runtime.pid)) return [];
  const fix = 'confirm and restart the bridge service to load current source; this check never restarts it (docs/bridge.md)';
  if (!runtime.sourceRevision) return [finding('WARN', 'bridge-revision', 'live bridge source revision is unknown (started before revision reporting)', fix)];
  try {
    if (runtime.sourceRevision === revision(repoRoot)) return [];
    return [finding('WARN', 'bridge-revision', 'live bridge source differs from current installed source; disk edits are not active', fix)];
  } catch {
    return [finding('WARN', 'bridge-revision', 'cannot compare live bridge source with installed source', 'check bridge source readability before any approved restart')];
  }
}

// ── runner ──

export function runChecks({ syncDir = getSyncDir(), repoRoot = sourceDir, home = HOME } = {}) {
  const settingsPath = path.join(syncDir, 'claude_settings.json');
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* reported by checkPayloadShape */ }

  return [
    ...checkHooks(settings, home),
    ...checkPayloadPaths(syncDir),
    ...checkPayloadShape(syncDir, repoRoot),
    ...checkLinks({ repoRoot, syncDir }),
    ...checkPlugins(settings, home),
    ...checkCodexPluginCache(repoRoot, home),
    ...checkHygiene(repoRoot),
    ...checkPublicHygiene({ root: repoRoot, markersFile: path.join(home, '.claude', 'private-markers'),
      requireMarkers: path.resolve(syncDir) !== path.resolve(repoRoot) }),
    ...checkMachineName(path.join(home, '.claude', 'machine.json')),
    ...checkBridgeRevision({ runtimeFile: path.join(home, '.claude', 'bridge', 'runtime.json'), repoRoot }),
    ...checkBridgeHost({ sharedPath: path.join(home, '.claude', 'claude_env_settings.json'),
      localPath: path.join(home, '.claude', 'claude_env_settings.local.json') }),
    ...checkCodexShellEnv({ machine: readMachineName(path.join(home, '.claude', 'machine.json')),
      configPath: path.join(home, '.codex', 'config.toml') }),
  ];
}

const MARK = { FAIL: 'FAIL ', WARN: 'WARN ', OK: 'OK   ' };

function main() {
  const args = process.argv.slice(2);
  // --public-hygiene: the pre-commit gate (.githooks/pre-commit) — that check alone.
  const findings = args.includes('--public-hygiene') ? checkPublicHygiene() : runChecks();
  const failed = findings.filter((f) => f.level === 'FAIL');
  const warned = findings.filter((f) => f.level === 'WARN');

  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify({ findings, failed: failed.length, warned: warned.length }, null, 2));
    process.exitCode = failed.length ? 1 : 0;
    return;
  }

  if (args.includes('--hook')) {
    // FAILs only, and silent when there are none. WARNs are informational — the
    // dormant-plugin inventory is always non-empty — and a notice that shows up
    // every session regardless teaches the reader to ignore all of them.
    if (!failed.length) return;
    const first = failed.slice(0, 2).map((f) => f.title);
    process.stdout.write(JSON.stringify({
      systemMessage: `[doctor] ${failed.length} failing invariant(s) — ${first.join('; ')}${failed.length > 2 ? ` (+${failed.length - 2} more)` : ''} — run: npm run doctor`,
    }));
    return;
  }

  for (const f of findings) {
    console.log(`${MARK[f.level]} [${f.id}] ${f.title}`);
    if (f.detail) console.log(`      ${f.detail}`);
  }
  if (!findings.length) console.log('OK    all invariants hold');
  else console.log(`\n${failed.length} failing, ${warned.length} warning — see above`);
  process.exitCode = failed.length ? 1 : 0;
}

if (isMain(import.meta.url)) main();
