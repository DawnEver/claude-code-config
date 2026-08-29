#!/usr/bin/env node
// migrate-host.mjs — migrate ONE machine off the cloud-synced working tree.
//
// Run this on each remaining host (G, WS1/duip622037). It is deliberately
// self-contained: it must run BEFORE the repo is cloned, so it imports nothing
// from the repo.
//
//   node migrate-host.mjs [--dry-run] [--target <path>]
//
// It locates everything relative to ITSELF. This script lives in the sync payload
// dir, so:
//     <payload>   = the directory holding this script
//     <old repo>  = ../claude   (the OneDrive working tree being retired)
// which means it needs no per-machine configuration and works regardless of the
// host's username or OS — the fleet has both `linxu` and `ezxmb14`, macOS and Windows.
//
// Background: OneDrive was replicating .git/ between machines, corrupting the index
// and destroying the reflog. See docs/sync-architecture.md in the repo.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const PAYLOAD_DIR = path.dirname(fileURLToPath(import.meta.url));
// Locate the retired cloud tree. These scripts normally run FROM the sync payload dir
// (so `<here>/../claude` is the old tree), but the canonical copy is committed in the
// repo at scripts/migration/ — from there that relative guess is wrong. Fall back to the
// machine-local sync-dir pointer, which always names the payload dir.
function resolveOldRoot(here) {
  const sibling = path.resolve(here, '..', 'claude');
  if (fs.existsSync(path.join(sibling, '.git'))) return sibling;
  try {
    const pointer = fs.readFileSync(path.join(os.homedir(), '.claude', 'sync-dir'), 'utf8').trim();
    if (pointer) {
      const viaPointer = path.resolve(pointer, '..', 'claude');
      if (fs.existsSync(path.join(viaPointer, '.git'))) return viaPointer;
    }
  } catch { /* no pointer yet */ }
  return sibling;   // report it as missing rather than guessing further
}
const OLD_REPO = resolveOldRoot(PAYLOAD_DIR);
const REPO_URL = 'https://github.com/DawnEver/claude-code-config.git';
const PAYLOAD_FILES = ['claude_settings.json', 'claude_env_settings.json', 'codex_config.toml'];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const targetFlag = args.indexOf('--target');
const TARGET = path.resolve(
  targetFlag !== -1 && args[targetFlag + 1]
    ? args[targetFlag + 1]
    : path.join(os.homedir(), 'Projects', 'claude-config'),
);

let failed = 0;
const say = (tag, msg) => console.log(`${tag.padEnd(6)}${msg}`);
const fail = (msg) => { say('ERR', msg); failed++; };
const run = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { encoding: 'utf8', stdio: 'pipe', ...opts });

console.log('claude-code-config — per-host migration');
console.log(`  payload : ${PAYLOAD_DIR}`);
console.log(`  old repo: ${OLD_REPO}`);
console.log(`  target  : ${TARGET}`);
if (dryRun) console.log('  MODE    : dry run, nothing will be written');
console.log('');

// ── 1. Preflight ─────────────────────────────────────────────────────────────
say('--', 'Preflight');

const major = Number(process.versions.node.split('.')[0]);
if (major < 18) fail(`node ${process.versions.node} is too old; need >= 18`);
else say('OK', `node ${process.versions.node}`);

try {
  say('OK', run('git', ['--version']).trim());
} catch {
  fail('git not found on PATH');
}

// The payload must be fully downloaded. Under OneDrive Files-On-Demand a dehydrated
// file satisfies existsSync but blocks or throws on first read, so READ each one
// rather than trusting a stat. A half-synced payload is the single most likely way
// this migration goes wrong.
for (const f of PAYLOAD_FILES) {
  const p = path.join(PAYLOAD_DIR, f);
  try {
    const body = fs.readFileSync(p, 'utf8');
    if (!body.trim()) throw new Error('file is empty');
    if (f.endsWith('.json')) JSON.parse(body);
    say('OK', `${f} (${body.length} bytes)`);
  } catch (err) {
    fail(`${f} — not readable/valid: ${err.message}`);
    fail('  the cloud client may still be downloading. Wait, then re-run.');
  }
}

// ── 2. Refuse to clone into cloud storage ────────────────────────────────────
// This is the whole point of the migration; putting the tree back in a synced
// folder would silently reintroduce the .git corruption.
const CLOUD_MARKERS = ['onedrive', 'dropbox', 'cloudstorage', 'icloud', 'google drive', 'box sync'];
const hit = CLOUD_MARKERS.find(m => TARGET.toLowerCase().includes(m));
if (hit) {
  fail(`target path looks cloud-synced (matched "${hit}"): ${TARGET}`);
  fail('  pick a local path, e.g. --target "%USERPROFILE%\\Projects\\claude-config"');
}

if (failed) {
  console.log(`\n${failed} problem(s) — nothing was changed. Fix the above and re-run.`);
  process.exit(1);
}

// ── 3. Rescue unpushed work from the old cloud repo ──────────────────────────
console.log('');
say('--', 'Checking the old cloud working tree for unpushed work');

function reportRepo(dir, label) {
  if (!fs.existsSync(path.join(dir, '.git'))) { say('SKIP', `${label} — not present`); return; }
  try {
    const status = run('git', ['status', '--porcelain'], { cwd: dir }).trim();
    let ahead = '';
    try {
      ahead = run('git', ['log', '--oneline', '@{u}..HEAD'], { cwd: dir }).trim();
    } catch { /* no upstream configured */ }

    if (!status && !ahead) { say('OK', `${label} — clean and fully pushed`); return; }
    say('WARN', `${label} HAS UNPUSHED WORK:`);
    if (ahead) {
      say('', `  ${ahead.split('\n').length} unpushed commit(s):`);
      for (const l of ahead.split('\n').slice(0, 10)) say('', `    ${l}`);
    }
    if (status) {
      say('', `  ${status.split('\n').length} uncommitted file(s):`);
      for (const l of status.split('\n').slice(0, 10)) say('', `    ${l}`);
    }
    say('', '  Commit and push it from that directory BEFORE deleting the old tree.');
  } catch (err) {
    // Typically "read error while indexing ...: Operation timed out" — dozens of lines,
    // one per dehydrated Files-On-Demand file. git cannot read its own working tree
    // through the cloud client. Summarize rather than dumping it.
    const text = `${err.stderr?.toString() || ''}${err.message || ''}`;
    const timeouts = (text.match(/Operation timed out/g) || []).length;
    if (timeouts) {
      say('WARN', `${label} — git CANNOT READ this tree: ${timeouts}+ files timed out.`);
      say('', '  These are cloud placeholders that were never fully downloaded.');
      say('', '  Unpushed work here cannot be detected automatically. Before deleting it,');
      say('', '  right-click the folder -> "Always keep on this device", wait, then re-check.');
    } else {
      say('WARN', `${label} — could not inspect: ${text.split('\n')[0]}`);
    }
  }
}

reportRepo(OLD_REPO, 'old config repo');
// NOTE: cc-market gets a dedicated pass at the end (rescue-clone.mjs). `git status`
// is unreliable there — a cloud-desynced .git reports published content as "modified",
// and placeholders make it abort entirely.

// ── 4. Clone (or update) the working tree ────────────────────────────────────
console.log('');
say('--', 'Working tree');

if (dryRun) {
  say('DRY', fs.existsSync(path.join(TARGET, '.git'))
    ? `would git pull --ff-only in ${TARGET}`
    : `would clone ${REPO_URL} -> ${TARGET}`);
} else if (fs.existsSync(path.join(TARGET, '.git'))) {
  try {
    run('git', ['pull', '--ff-only'], { cwd: TARGET });
    say('OK', `pulled latest in ${TARGET}`);
  } catch (err) {
    fail(`could not fast-forward ${TARGET}: ${err.stderr?.toString().trim() || err.message}`);
  }
} else if (fs.existsSync(TARGET) && fs.readdirSync(TARGET).length) {
  fail(`${TARGET} exists and is not empty, but is not a git repo — move it aside first`);
} else {
  fs.mkdirSync(path.dirname(TARGET), { recursive: true });
  try {
    run('git', ['clone', REPO_URL, TARGET]);
    say('OK', `cloned -> ${TARGET}`);
  } catch (err) {
    fail(`clone failed: ${err.stderr?.toString().trim() || err.message}`);
  }
}

if (failed) {
  console.log(`\n${failed} problem(s). Stopping before setup.`);
  process.exit(1);
}

// ── 5. Point this host at the payload and relink ─────────────────────────────
console.log('');
say('--', 'Running setup');

const setupArgs = [
  path.join(TARGET, 'scripts', 'setup', 'setup.js'),
  '--sync-dir', PAYLOAD_DIR,
  '--replace',
];

if (dryRun) {
  say('DRY', `would run: node ${setupArgs.join(' ')}`);
} else {
  try {
    // Inherit stdio: setup's own LINK/OK/ERR lines are the useful output here.
    execFileSync(process.execPath, setupArgs, { cwd: TARGET, stdio: 'inherit' });
  } catch {
    fail('setup.js exited non-zero — review its output above');
  }
}

// ── 6. Verify ────────────────────────────────────────────────────────────────
console.log('');
say('--', 'Verification');

if (!dryRun) {
  const claudeDir = path.join(os.homedir(), '.claude');

  const pointer = path.join(claudeDir, 'sync-dir');
  if (fs.existsSync(pointer) && fs.readFileSync(pointer, 'utf8').trim() === PAYLOAD_DIR) {
    say('OK', 'sync-dir pointer written');
  } else {
    fail('sync-dir pointer missing or wrong');
  }

  // API keys are machine-local and must have survived untouched.
  const localKeys = path.join(claudeDir, 'claude_env_settings.local.json');
  if (fs.existsSync(localKeys)) {
    try {
      const providers = Object.keys(JSON.parse(fs.readFileSync(localKeys, 'utf8')).providers || {});
      say(providers.length ? 'OK' : 'WARN',
        `local API keys: ${providers.length ? providers.join(', ') : 'NONE — this host has no keys configured'}`);
    } catch { fail('claude_env_settings.local.json is unparseable'); }
  } else {
    say('WARN', 'no claude_env_settings.local.json — add this host\'s API keys there');
  }

  // Nothing may still resolve into the retired tree.
  let stale = 0;
  for (const base of [claudeDir, path.join(os.homedir(), '.codex')]) {
    if (!fs.existsSync(base)) continue;
    for (const entry of fs.readdirSync(base)) {
      const full = path.join(base, entry);
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (!st.isSymbolicLink()) continue;
      const t = fs.readlinkSync(full);
      if (path.resolve(t).startsWith(OLD_REPO + path.sep)) {
        say('WARN', `still points into the old tree: ${full} -> ${t}`);
        stale++;
      }
    }
  }
  say(stale ? 'WARN' : 'OK', stale ? `${stale} stale link(s) — run: npm run migrate` : 'no links into the old tree');
}

// ── 7. cc-market ─────────────────────────────────────────────────────────────
// cc-market is a SEPARATE repo that setup clones into the working tree, so it moves out of
// cloud storage automatically. What does not move automatically is the old cloud copy —
// and setup runs `git pull` inside it on every run, which is git-inside-cloud-storage all
// over again. Verify it holds nothing unpublished, from THIS host (files this host never
// downloaded are placeholders that only the authoring host can check).
console.log('');
say('--', 'cc-market');
if (!dryRun) {
  try {
    execFileSync(process.execPath, [path.join(PAYLOAD_DIR, 'rescue-clone.mjs')], { stdio: 'inherit' });
  } catch {
    say('WARN', 'the old cc-market copy may hold unpublished work — see the output above.');
    say('', 'Do NOT delete the old tree until this is resolved.');
  }
} else {
  say('DRY', `would run: node ${path.join(PAYLOAD_DIR, 'rescue-clone.mjs')}`);
}

// ── Done ─────────────────────────────────────────────────────────────────────
console.log('');
if (failed) {
  console.log(`Finished with ${failed} problem(s).`);
  process.exit(1);
}
if (dryRun) {
  console.log('Dry run finished — nothing was changed. Re-run without --dry-run to migrate.');
  process.exit(0);
}
console.log('Migration complete on this host.');
console.log('');
console.log('Next:');
console.log(`  1. Smoke-test the launchers: ccc / ccds / cods`);
console.log(`  2. Push any unpushed work reported above from ${OLD_REPO}`);
console.log(`  3. Once EVERY host has migrated, delete ${path.join(OLD_REPO, 'cc-market')} first,`);
console.log(`     then ${OLD_REPO}. Until then setup keeps running git inside cloud storage there.`);
