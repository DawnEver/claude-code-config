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

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { isMain } from '../shared/is-main.mjs';
import { SYNC_PAYLOAD_FILES } from '../shared/sync-dir.mjs';
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
    // file cannot hide a violation behind a formatting accident and a byHost exemption
    // cannot leak onto a neighbouring value that merely shares the line.
    if (name.endsWith('.json')) {
      let parsed;
      try { parsed = JSON.parse(text); } catch { continue; }   // reported by checkPayloadShape
      for (const { keyPath, value } of walkStrings(parsed)) {
        const kinds = absolutePathKinds(value);
        if (!kinds.length) continue;
        const exempt = keyPath.includes('byHost');
        out.push(finding(exempt ? 'WARN' : 'FAIL', exempt ? 'payload-host-keyed-path' : 'payload-abs-path',
          `${name} ${keyPath.join('.')} has a ${kinds.join(' + ')}${exempt ? ', under a byHost override' : ''}`,
          exempt
            ? `${value} — read only by the host it names, so it cannot be wrong elsewhere; move it to that host's claude_env_settings.local.json to get it out of the shared file`
            : `${value} — this file syncs to every host, so no host's path may appear in it`));
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

  const installed = new Set(Object.keys(registry.plugins ?? registry).filter((k) => k.includes('@')));
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
    const market = id.split('@')[1];
    const known = market === 'local' || fs.existsSync(path.join(marketsDir, market));
    out.push(finding(known ? 'WARN' : 'WARN', 'plugin-dormant',
      `${id} is installed but never enabled`,
      known ? 'either uninstall it or list it in enabledPlugins' : `its marketplace "${market}" does not exist — an orphan`));
  }
  return out;
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

/**
 * A `byHost` entry for THIS host, sitting in the shared payload.
 *
 * It is not a leak — only this host reads it — but it is in the wrong file. The shared
 * payload should carry no machine path at all, and each host's own
 * `~/.claude/claude_env_settings.local.json` is the designed home for per-machine values
 * (readers deep-merge local over shared). This check reports it on the host it names, so
 * each machine is told what to move and the shared file drains itself host by host, rather
 * than the cleanup living as a note in a design document that nobody acts on.
 */
export function checkHostKeyedPaths(syncDir, files = SYNC_PAYLOAD_FILES, hostname = os.hostname()) {
  const out = [];
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    const p = path.join(syncDir, name);
    if (!fs.existsSync(p)) continue;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }

    const visit = (node, keyPath) => {
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'byHost' && value && typeof value === 'object') {
          for (const [host, block] of Object.entries(value)) {
            if (host.toLowerCase() !== String(hostname).toLowerCase()) continue;
            for (const { keyPath: inner, value: v } of walkStrings(block)) {
              if (!absolutePathKinds(v).length) continue;
              out.push(finding('WARN', 'payload-own-host-path',
                `${name} ${[...keyPath, 'byHost', host, ...inner].join('.')} is this host's own path, in the shared file`,
                `${v} — move it to ~/.claude/claude_env_settings.local.json under the same key path; ` +
                'readers deep-merge local over shared, so the shared entry can then be deleted'));
            }
          }
        } else {
          visit(value, [...keyPath, key]);
        }
      }
    };
    visit(parsed, []);
  }
  return out;
}

// ── runner ──

export function runChecks({ syncDir = getSyncDir(), repoRoot = sourceDir, home = HOME } = {}) {
  const settingsPath = path.join(syncDir, 'claude_settings.json');
  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* reported by checkPayloadShape */ }

  return [
    ...checkHooks(settings, home),
    ...checkPayloadPaths(syncDir),
    ...checkHostKeyedPaths(syncDir),
    ...checkPayloadShape(syncDir, repoRoot),
    ...checkLinks({ repoRoot, syncDir }),
    ...checkPlugins(settings, home),
    ...checkHygiene(repoRoot),
  ];
}

const MARK = { FAIL: 'FAIL ', WARN: 'WARN ', OK: 'OK   ' };

function main() {
  const args = process.argv.slice(2);
  const findings = runChecks();
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
