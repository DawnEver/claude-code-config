// scripts/usage/scan.mjs — finds what this machine's transcripts hold that the usage store has
// not received yet (docs/usage.md). The transcripts are the source; the store is fed from them
// and nothing else, and this file's cursor is only a note of how far each file was sent.
//
// A transcript only grows, and only its last turn can still change, so the cursor keeps per
// file its size, mtime and how many rows were sent: a changed file is parsed again and its rows
// from the last one sent onwards go out again (the store upserts by key). A file the host has
// cleaned up is dropped from the cursor; its rows stay in the store, which is the long memory.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { claudeTranscript, codexTranscript } from './transcripts.mjs';
import { gitContext, repoNameFromUrl } from '../bridge/context.mjs';
import { aliasOf, baseDir, readAccount } from '../shared/seats.mjs';
import { claudeAccountKey, codexAccountKey } from '../bridge/quota.mjs';

const yieldNow = () => new Promise((r) => setImmediate(r));

async function* walk(dir, depth) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) yield* walk(p, depth - 1);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

/**
 * Every transcript source of this machine: each Claude config dir (the base dir and every
 * `~/.claude-<alias>` seat dir) and Codex's sessions. A projects dir reached twice (a seat dir
 * that links it back to the base) is read once.
 */
export function sources(home = os.homedir(), { codexEmail = () => null, machine = 'host' } = {}) {
  const out = [];
  const seen = new Set();
  const dirs = [baseDir(home)];
  try { for (const e of fs.readdirSync(home)) { const d = path.join(home, e); if (aliasOf(d, home)) dirs.push(d); } } catch { /* no home */ }
  for (const dir of dirs) {
    const projects = path.join(dir, 'projects');
    let real;
    try { real = fs.realpathSync(projects); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    const seat = aliasOf(dir, home);
    out.push({ agent: 'claude', root: projects, depth: 3, seat,
      account: () => claudeAccountKey(readAccount(dir, home), `${machine}/${seat ?? 'base'}`) });
  }
  for (const d of ['sessions', 'archived_sessions']) {
    out.push({ agent: 'codex', root: path.join(home, '.codex', d), depth: 4, seat: null, account: () => codexAccountKey(codexEmail(), machine) });
  }
  return out;
}

export class UsageScanner {
  /**
   * @param {{cursorFile: string, sources: () => Array, project?: (cwd) => string|null}} o
   *   project: a working tree's project name; cached per cwd in the cursor (a git call each).
   */
  constructor({ cursorFile, sources: list, project = (cwd) => gitContext(cwd, { branch: '-' }).project }) {
    Object.assign(this, { cursorFile, sources: list, project });
    try { this.cursor = JSON.parse(fs.readFileSync(cursorFile, 'utf8')); } catch { this.cursor = {}; }
    this.cursor.files ??= {};
    this.cursor.projects ??= {};
  }

  projectOf(cwd, repositoryUrl) {
    if (repositoryUrl) return repoNameFromUrl(repositoryUrl);
    if (!cwd) return null;
    // An agent worktree (`<repo>/.claude/worktrees/<name>`) is its repo's work, and is often gone by now.
    cwd = cwd.replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/, '');
    if (!(cwd in this.cursor.projects)) this.cursor.projects[cwd] = this.project(cwd);
    return this.cursor.projects[cwd];
  }

  /**
   * What is new, up to about `limit` rows (whole files): {turns, costs, commit}. `commit()`
   * records it as sent: call it once the store accepted all of it. Files the host deleted are
   * forgotten on commit.
   */
  async collect({ limit = 2000 } = {}) {
    const turns = [];
    const costs = [];
    const pending = {};
    const present = new Set();
    let full = false;
    for (const src of this.sources()) {
      for await (const file of walk(src.root, src.depth)) {
        present.add(file);
        if (full) continue;
        let st;
        try { st = await fs.promises.stat(file); } catch { continue; }
        const was = this.cursor.files[file];
        if (was && was.size === st.size && was.mtimeMs === st.mtimeMs) continue;
        let text;
        try { text = await fs.promises.readFile(file, 'utf8'); } catch { continue; }
        const subagent = src.agent === 'claude' && path.basename(path.dirname(file)) === 'subagents';
        const t = src.agent === 'claude' ? claudeTranscript(text, { subagent }) : codexTranscript(text);
        await yieldNow();   // a large file must not hold the daemon's event loop
        const mark = { size: st.size, mtimeMs: st.mtimeMs, sent: t.turns.length, costs: JSON.stringify(t.costs) };
        if (!t.session) { pending[file] = mark; continue; }
        const account = src.account();
        for (const r of t.turns.slice(Math.max(0, (was?.sent ?? 0) - 1))) {
          const { cwd, ...row } = r;
          turns.push({ ...row, agent: src.agent, session: t.session, account, seat: src.seat, project: this.projectOf(cwd, t.repositoryUrl) });
        }
        if (mark.costs !== was?.costs) for (const c of t.costs) costs.push({ agent: src.agent, session: t.session, ...c });
        pending[file] = mark;
        if (turns.length >= limit) full = true;
      }
    }
    return {
      turns, costs, more: full,
      commit: () => {
        Object.assign(this.cursor.files, pending);
        // Only a full walk saw every file: a cut-short one must not forget the rest.
        if (!full) for (const f of Object.keys(this.cursor.files)) if (!present.has(f)) delete this.cursor.files[f];
        fs.mkdirSync(path.dirname(this.cursorFile), { recursive: true });
        const tmp = `${this.cursorFile}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.cursor));
        fs.renameSync(tmp, this.cursorFile);
      },
    };
  }
}
