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
import { fileURLToPath } from 'url';
import { claudeTranscript, codexTranscript, agyTranscript } from './transcripts.mjs';
import { gitContext, repoNameFromUrl } from '../bridge/context.mjs';
import { aliasOf, baseDir, readAccount } from '../shared/seats.mjs';
import { claudeAccountKey, codexAccountKey, agyAccountKey, readAgyEmail } from '../bridge/quota.mjs';
import { readAgyCwds } from '../bridge/agy-adapter.mjs';
import { codexHomes as recordedCodexHomes, codexHomeKey, codexHomeLabel, codexHomesFile } from '../shared/codex-home.mjs';

const yieldNow = () => new Promise((r) => setImmediate(r));

/** Decode a `file://` URI (or plain path) from Antigravity's `WorkspaceURIs` into a filesystem path. */
export function fromWorkspaceUri(uri) {
  if (!uri || typeof uri !== 'string') return null;
  if (!uri.startsWith('file://')) return uri;
  try { return fileURLToPath(uri); } catch { return null; }
}

function readAgyMetaMap(agyDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(agyDir, 'cache', 'conversation_metadata.json'), 'utf8'));
    return raw?.conversations && typeof raw.conversations === 'object' ? raw.conversations : {};
  } catch { return {}; }
}

/** Each agent's transcript parser: text + the file it came from -> {session, turns, costs}. */
export const PARSERS = {
  claude: (text, file) => claudeTranscript(text, { subagent: path.basename(path.dirname(file)) === 'subagents' }),
  codex: (text) => codexTranscript(text),
  // `<brain>/<conversation>/.system_generated/logs/transcript.jsonl`: the conversation id is the brain dir.
  agy: (text, file, src) => {
    const session = path.basename(path.resolve(file, '..', '..', '..'));
    return agyTranscript(text, { session, subagent: Boolean(src?.isSubagent?.(session)) });
  },
};

async function* walk(dir, depth, only = null) {
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) yield* walk(p, depth - 1, only);
    else if (e.isFile() && e.name.endsWith('.jsonl') && (!only || e.name === only)) yield p;
  }
}

/**
 * Every transcript source of this machine: each Claude config dir (the base dir and every
 * `~/.claude-<alias>` seat dir) and each Codex home's sessions (codex-home.mjs codexHomes; its label is the row's seat). A projects dir reached twice (a seat dir
 * that links it back to the base) is read once.
 */
export function sources(home = os.homedir(), { machine = 'host', codexHomes = recordedCodexHomes({ home, file: codexHomesFile(home) }), agyDir = path.join(home, '.gemini', 'antigravity-cli') } = {}) {
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
  for (const codexHome of codexHomes) for (const d of ['sessions', 'archived_sessions']) {
    out.push({ agent: 'codex', root: path.join(codexHome, d), depth: 4, seat: codexHomeLabel(codexHome, home),
      // A current app-server login does not prove who owned a historical rollout.
      // The verified rollout schema has no authoritative account field: keep it unknown.
      account: () => codexAccountKey(null, `${machine}/home-${codexHomeKey(codexHome)}`) });
  }
  // Antigravity: only each conversation's compact transcript.jsonl (transcript_full.jsonl repeats it untruncated).
  let metaCache = null;
  const agyMeta = () => (metaCache ??= readAgyMetaMap(agyDir));
  let cwdsCache = null;
  const agyCwds = () => (cwdsCache ??= readAgyCwds());
  out.push({
    agent: 'agy', root: path.join(agyDir, 'brain'), depth: 3, only: 'transcript.jsonl', seat: null,
    account: () => agyAccountKey(readAgyEmail(agyDir), `${machine}/agy`),
    isSubagent: (session) => Boolean(agyMeta()[session]?.is_internal),
    cwdOf: (session) => agyCwds()[session] ?? fromWorkspaceUri(agyMeta()[session]?.summary?.WorkspaceURIs?.[0]) ?? null,
  });
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
    this.cursor.agySubagents ??= {};
  }

  projectOf(cwd, repositoryUrl) {
    if (repositoryUrl) return repoNameFromUrl(repositoryUrl);
    if (!cwd) return null;
    // An agent worktree (`<repo>/.claude/worktrees/<name>`) is its repo's work, and is often gone by now.
    cwd = cwd.replace(/[\\/]\.claude[\\/]worktrees[\\/].*$/, '');
    // An Antigravity subagent worktree (`~/.gemini/antigravity-cli/worktrees/<parentConversationId>/...`)
    // attributes to the parent conversation's workspace when known.
    const agyWt = /[\\/]\.gemini[\\/]antigravity[^\\/]*[\\/]worktrees[\\/]([0-9a-f-]{36})/i.exec(cwd);
    if (agyWt) cwd = this.cursor.agySubagents[agyWt[1]] ?? null;
    if (!cwd) return null;
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
    const deferredAgyProject = [];
    let full = false;
    for (const src of this.sources()) {
      for await (const file of walk(src.root, src.depth, src.only ?? null)) {
        present.add(file);
        if (full) continue;
        let st;
        try { st = await fs.promises.stat(file); } catch { continue; }
        const was = this.cursor.files[file];
        if (was && was.size === st.size && was.mtimeMs === st.mtimeMs) continue;
        let text;
        try { text = await fs.promises.readFile(file, 'utf8'); } catch { continue; }
        const t = PARSERS[src.agent](text, file, src);
        await yieldNow();   // a large file must not hold the daemon's event loop
        // A price goes with its session's last turn end: the report's range test (usage-store.mjs report).
        const lastAt = t.turns.reduce((m, r) => Math.max(m, r.ended_at), 0) || null;
        const mark = { size: st.size, mtimeMs: st.mtimeMs, sent: t.turns.length, costs: JSON.stringify([t.costs, lastAt]) };
        if (!t.session) { pending[file] = mark; continue; }
        const sessionCwd = src.cwdOf?.(t.session) ?? this.cursor.agySubagents[t.session]
          ?? (t.subagentParent ? (src.cwdOf?.(t.subagentParent) ?? this.cursor.agySubagents[t.subagentParent]) : null)
          ?? null;
        if (sessionCwd && src.agent === 'agy') this.cursor.agySubagents[t.session] = sessionCwd;
        if (t.subagents) {
          for (const [cid, uri] of Object.entries(t.subagents)) {
            const subCwd = fromWorkspaceUri(uri) ?? sessionCwd;
            if (subCwd) this.cursor.agySubagents[cid] = subCwd;
          }
        }
        const account = src.account();
        for (const r of t.turns.slice(Math.max(0, (was?.sent ?? 0) - 1))) {
          const { cwd: rowCwd, ...row } = r;
          const cwd = rowCwd ?? sessionCwd;
          const outRow = { ...row, agent: src.agent, session: t.session, account, seat: src.seat, project: this.projectOf(cwd, t.repositoryUrl) };
          turns.push(outRow);
          if (!outRow.project && src.agent === 'agy') deferredAgyProject.push({ row: outRow, session: t.session, parent: t.subagentParent });
        }
        if (mark.costs !== was?.costs) for (const c of t.costs) costs.push({ agent: src.agent, session: t.session, ...c, last_at: lastAt });
        pending[file] = mark;
        if (turns.length >= limit) full = true;
      }
    }
    for (const d of deferredAgyProject) {
      const resolvedCwd = this.cursor.agySubagents[d.session] ?? (d.parent ? this.cursor.agySubagents[d.parent] : null) ?? null;
      if (resolvedCwd) d.row.project = this.projectOf(resolvedCwd, null);
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
