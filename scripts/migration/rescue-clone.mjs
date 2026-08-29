#!/usr/bin/env node
// rescue-clone.mjs — does an OLD cloud-resident clone hold anything not on GitHub?
//
//   node rescue-clone.mjs                 # check both repos, report only
//   node rescue-clone.mjs --delete        # delete the ones that come back SAFE
//   node rescue-clone.mjs --only cc-market
//   node rescue-clone.mjs --old <path> --repo <url>       # arbitrary target
//
// Checks, by default:
//   ../claude            DawnEver/claude-code-config   (the config repo)
//   ../claude/cc-market  DawnEver/cc-market            (the plugin marketplace)
//
// WHY `git status` IS NOT ENOUGH
//
// These clones lived in OneDrive, which replicated `.git` between machines. Git assumes it
// owns `.git` exclusively, so all three of the following can be true at once:
//
//   1. `.git/HEAD` sits at an OLD commit while the cloud client synced DOWN newer file
//      content from another machine. `git status` then reports dozens of "modified" files
//      that are simply published content from later commits.
//   2. Files this host never downloaded are Files-On-Demand placeholders. `git status`
//      aborts on them entirely — exit 128, no output. A clean-looking failure.
//   3. Windows hosts write CRLF; a Unix clone checks out LF. Every such file looks modified.
//
// On the macOS host all three fired. The honest question is not "does this differ from
// HEAD" but "does this content exist ANYWHERE in the published history" — so this script
// hashes each file and looks the blob up in a trusted reference clone.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
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
const OLD_ROOT = resolveOldRoot(HERE);

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : dflt;
};
const doDelete = args.includes('--delete');
const only = flag('--only', null);

const TARGETS = flag('--old', null)
  ? [{ name: 'custom', old: path.resolve(flag('--old')), repo: flag('--repo', ''), ref: flag('--new', null) }]
  : [
    {
      name: 'claude-config',
      old: OLD_ROOT,
      repo: 'https://github.com/DawnEver/claude-code-config.git',
      ref: path.join(os.homedir(), 'Projects', 'claude-config'),
      // The config repo's payload files are gitignored and are migrated separately by
      // migrate-host.mjs; ls-files --exclude-standard already leaves them out.
    },
    {
      name: 'cc-market',
      old: path.join(OLD_ROOT, 'cc-market'),
      repo: 'https://github.com/DawnEver/cc-market',
      ref: path.join(os.homedir(), 'Projects', 'claude-config', 'cc-market'),
    },
  ].filter(t => !only || t.name === only);

const say = (tag, msg) => console.log(`${tag.padEnd(8)}${msg}`);
const git = (dir, a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 * 1024 * 1024 });
const lf = (b) => b.toString('utf8').replace(/\r\n/g, '\n');

/**
 * A Files-On-Demand placeholder reports its logical size but occupies zero blocks. Reading
 * one blocks on a network fetch and only fails after a long timeout; `stat` is instant.
 */
function isDataless(full) {
  try {
    const s = fs.statSync(full);
    return s.size > 0 && s.blocks === 0;
  } catch {
    return false;
  }
}

function analyse(target) {
  const { old: OLD, repo, name } = target;
  console.log('');
  console.log(`═══ ${name}`);
  console.log(`  old (cloud): ${OLD}`);

  if (!fs.existsSync(path.join(OLD, '.git'))) {
    say('OK', 'not present — nothing to do.');
    return { name, verdict: 'absent' };
  }

  // ── reference clone ───────────────────────────────────────────────────────
  let NEW = target.ref;
  let temporary = false;
  if (!NEW || !fs.existsSync(path.join(NEW, '.git'))) {
    NEW = fs.mkdtempSync(path.join(os.tmpdir(), `ref-${name}-`));
    temporary = true;
    say('..', `cloning a reference copy of ${repo}`);
    execFileSync('git', ['clone', '--quiet', repo, NEW], { stdio: 'pipe' });
  }
  console.log(`  reference  : ${NEW}${temporary ? ' (temporary)' : ''}`);
  try { git(NEW, ['fetch', '--all', '--quiet', '--tags']); } catch { /* offline is survivable */ }

  // ── 1. unpushed commits (reads .git only; placeholders cannot hide these) ──
  let unpushed = '';
  try {
    unpushed = git(OLD, ['log', '--oneline', '@{u}..HEAD']).trim();
  } catch {
    try {
      const head = git(OLD, ['rev-parse', 'HEAD']).trim();
      git(NEW, ['cat-file', '-e', `${head}^{commit}`]);
    } catch {
      unpushed = '(could not determine — inspect by hand)';
    }
  }
  // Local branches other than the checked-out one can also hold work.
  const rescued = [], unrescued = [];
  let strayBranches = [];
  try {
    strayBranches = git(OLD, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
      .split('\n').map(s => s.trim()).filter(Boolean)
      .filter(b => {
        try { git(NEW, ['cat-file', '-e', `${git(OLD, ['rev-parse', b]).trim()}^{commit}`]); return false; }
        catch { return true; }
      });
  } catch { /* ignore */ }

  if (!unpushed) say('OK', 'no unpushed commits on the checked-out branch');
  else { say('WARN', 'UNPUSHED COMMITS:'); console.log(unpushed); }

  // Work hides on branches that are NOT checked out, so the working-tree scan below can
  // never see it. On the macOS host this found three such branches in cc-market — 13
  // unpushed commits from 2026-07-08 — after a checked-out-branch-only check said "clean".
  //
  // The rescue is a fetch, not an analysis: copy the objects OUT of the damaged cloud
  // repo into a healthy one, where they can be examined at leisure and cannot rot further.
  if (strayBranches.length) {
    say('WARN', `${strayBranches.length} local branch(es) whose tip is NOT on the remote:`);
    for (const b of strayBranches) say('', `  ${b}`);
    if (!temporary) {
      say('..', 'fetching them into the healthy clone as rescue/* (may be slow over a cloud FS)');
      try { git(NEW, ['remote', 'remove', 'rescue']); } catch { /* not present */ }
      try {
        git(NEW, ['remote', 'add', 'rescue', OLD]);
        for (const b of strayBranches) {
          try {
            git(NEW, ['fetch', '--no-tags', 'rescue', `refs/heads/${b}:refs/heads/rescue/${b}`]);
            say('OK', `  rescued -> rescue/${b}`);
            rescued.push(b);
          } catch (err) {
            say('ERR', `  could not fetch ${b} — objects unreadable or corrupt`);
            unrescued.push(b);
          }
        }
      } finally {
        try { git(NEW, ['remote', 'remove', 'rescue']); } catch { /* ignore */ }
      }
      if (rescued.length) {
        say('', `  Review with:  git -C "${NEW}" log --oneline origin/main..rescue/<branch>`);
        say('', `  Publish with: git -C "${NEW}" push origin rescue/<branch>`);
      }
    } else {
      say('NOTE', '  no persistent reference clone — re-run after migrating so they can be rescued.');
    }
  }

  // ── 2. working-tree content ───────────────────────────────────────────────
  const unreadable = [], orphans = [];
  let identical = 0, crlfOnly = 0, historical = 0;

  const list = (a) => { try { return git(OLD, a).split('\n').map(s => s.trim()).filter(Boolean); } catch { return []; } };
  // Tracked + untracked-but-not-ignored. NEVER a filesystem walk: walking counts .venv/,
  // __pycache__ and _meta.json, which produced 589 phantom "unpublished" files.
  const candidates = [...new Set([...list(['ls-files']), ...list(['ls-files', '--others', '--exclude-standard'])])];
  say('..', `checking ${candidates.length} tracked/untracked file(s)`);

  for (const rel of candidates) {
    const full = path.join(OLD, rel);
    if (!fs.existsSync(full)) continue;
    if (isDataless(full)) { unreadable.push(rel); continue; }

    let buf;
    try { buf = fs.readFileSync(full); } catch { unreadable.push(rel); continue; }

    const ref = path.join(NEW, rel);
    if (fs.existsSync(ref)) {
      try {
        const refBuf = fs.readFileSync(ref);
        if (refBuf.equals(buf)) { identical++; continue; }
        if (lf(refBuf) === lf(buf)) { crlfOnly++; continue; }
      } catch { /* fall through */ }
    }

    let found = false;
    for (const cand of [buf, Buffer.from(lf(buf)), Buffer.from(lf(buf).replace(/\n/g, '\r\n'))]) {
      let hash;
      try { hash = execFileSync('git', ['hash-object', '--stdin'], { input: cand, encoding: 'utf8', cwd: NEW }).trim(); }
      catch { continue; }
      try { git(NEW, ['cat-file', '-e', hash]); found = true; break; } catch { /* next */ }
    }
    if (found) historical++; else orphans.push(rel);
  }

  say('OK', `${identical} identical to remote HEAD`);
  if (crlfOnly) say('OK', `${crlfOnly} differ only in line endings (written by a Windows host)`);
  say('OK', `${historical} match an older published commit (stale cloud sync, not work)`);

  if (unreadable.length) {
    say('WARN', `${unreadable.length} UNREADABLE — cloud placeholders never downloaded here:`);
    for (const f of unreadable.slice(0, 8)) say('', `  ${f}`);
    if (unreadable.length > 8) say('', `  ... and ${unreadable.length - 8} more`);
    say('', '  Cannot have been edited on THIS machine, but only a host that HAS them can');
    say('', '  confirm what they hold. Pin the folder to "Always keep on this device" to check.');
  }
  if (orphans.length) {
    say('WARN', `${orphans.length} file(s) whose content is in NO published commit:`);
    for (const f of orphans.slice(0, 25)) say('', `  ${f}`);
    if (orphans.length > 25) say('', `  ... and ${orphans.length - 25} more`);
  }

  // A stray branch that was successfully copied into the healthy clone no longer
  // blocks deletion — its objects are safe. One that could not be fetched does.
  const safe = !unpushed && orphans.length === 0 && unrescued.length === 0
    && strayBranches.every(b => rescued.includes(b));
  console.log('');
  if (safe) {
    say('SAFE', 'everything here is already published on GitHub.');
    if (unreadable.length) say('NOTE', 'except the unreadable placeholders above — see the caveat.');
  } else {
    say('STOP', 'this clone may hold unique work. Do NOT delete it.');
    say('', `  Inspect:  git -C "${OLD}" log @{u}..HEAD`);
    say('', `            git -C "${OLD}" diff`);
    say('', `  Rescue :  git -C "${OLD}" push origin HEAD:refs/heads/rescue-${name}-$(hostname)`);
  }
  return { name, verdict: safe ? 'safe' : 'stop', old: OLD, unreadable: unreadable.length, rescued, unrescued };
}

console.log('rescue-clone — is anything in the old cloud tree unpublished?');
const results = TARGETS.map(analyse);

console.log('');
console.log('═══ Summary');
for (const r of results) say(r.verdict.toUpperCase(), r.name + (r.unreadable ? `  (${r.unreadable} unverifiable placeholder(s))` : ''));

if (!doDelete) {
  const safeOnes = results.filter(r => r.verdict === 'safe');
  if (safeOnes.length) {
    console.log('');
    console.log('Nothing was deleted. Delete order matters — cc-market FIRST, because');
    console.log('setup.js runs `git pull` inside it on every run:');
    console.log('');
    console.log('  node rescue-clone.mjs --delete');
  }
  process.exit(results.some(r => r.verdict === 'stop') ? 1 : 0);
}

// cc-market before the config repo: it is nested inside it.
for (const r of [...results].sort((a, b) => b.old.length - a.old.length)) {
  if (r.verdict !== 'safe') { say('SKIP', `${r.name} — not safe, left in place`); continue; }
  say('..', `deleting ${r.old}`);
  fs.rmSync(r.old, { recursive: true, force: true });
  say('OK', `${r.name} removed`);
}
