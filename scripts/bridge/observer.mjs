// scripts/bridge/observer.mjs — the coordination view (docs/coordination.md). Observes and
// reports; never triggers anything.
//
// Every poll, for each repo a live main session on this machine works in: fetch origin
// (remote refs only), diff the remote-tracking tips against the last seen ones, and report
// a moved branch into the one session Topic that owns it; follow a reported tip until its
// lab/gate and lab/heavy statuses appear. Issues and repo activity are read on the forge.
// Statuses come from the repo's own `python -m lab_commons.dev.forge ... --json`;
// a repo without lab_commons in its venv gets the git part only.

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

const VERDICTS = ['lab/gate', 'lab/heavy'];
const VERDICT_WORD = { success: 'PASS', failure: 'FAIL' };
const PENDING_MAX = 20;
const short = (sha) => sha.slice(0, 7);

/** `Name (<machine>/<agent>)` -> {machine, agent}; null for a human (unprovenanced) commit. */
export function provenanceOf(committer) {
  const m = /\(([^/()\s]+)\/([^)\s]+)\)\s*$/.exec(String(committer ?? ''));
  return m ? { machine: m[1], agent: m[2] } : null;
}

/** Run git; resolves stdout trimmed, rejects on failure. Never touches the working tree here. */
export function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000 },
      (err, out) => (err ? reject(err) : resolve(out.trim())));
  });
}

/** The repo's own forge door, or null when its venv has no lab_commons. */
export function runForge(top, args) {
  const py = [path.join(top, '.venv', 'Scripts', 'python.exe'), path.join(top, '.venv', 'bin', 'python')].find((p) => fs.existsSync(p));
  if (!py) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile(py, ['-m', 'lab_commons.dev.forge', ...args, '--json'], { cwd: top, encoding: 'utf8', windowsHide: true, timeout: 60000 },
      (err, out) => { if (err) return resolve(null); try { resolve(JSON.parse(out)); } catch { resolve(null); } });
  });
}

export class Observer {
  /**
   * @param {{ sessions: () => {key, cwd, chatId, project}[],
   *           post: (key, text) => void, git?, forge?, exists?, cacheFile?: string|null, log? }} deps
   */
  constructor({ sessions, post, git = runGit, forge = runForge,
    exists = fs.existsSync, cacheFile = null, log = () => {} }) {
    Object.assign(this, { sessions, post, git, forge, exists, cacheFile, log });
    // top -> { tips: {branch: sha}, pending: [{sha, key, done}] }
    this.cache = {};
    try { this.cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) ?? {}; } catch { /* first run */ }
    this.busy = false;
  }

  #save() {
    if (!this.cacheFile) return;
    try { fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true }); fs.writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2)); } catch { /* cache only */ }
  }

  /** One pass over every observed repo. Overlapping calls are skipped. */
  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const repos = new Map();   // top -> { chatId, project, sessions: [{key, branch}] }
      for (const s of this.sessions()) {
        if (s.chatId === null || !s.cwd) continue;
        const top = await this.git(s.cwd, ['rev-parse', '--show-toplevel']).catch(() => null);
        if (!top) continue;
        const branch = await this.git(s.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null);
        const r = repos.get(top) ?? { chatId: s.chatId, project: s.project, sessions: [] };
        r.sessions.push({ key: s.key, branch });
        repos.set(top, r);
      }
      for (const [top, r] of repos) await this.#repo(top, r).catch((e) => this.log(`observe ${r.project}: ${e.message}`));
      this.#save();
    } finally { this.busy = false; }
  }

  async #repo(top, r) {
    const gitDir = path.resolve(top, await this.git(top, ['rev-parse', '--git-dir']));
    if (this.exists(path.join(gitDir, 'index.lock'))) return;   // someone is mid-operation
    await this.git(top, ['fetch', '--quiet', '--prune', 'origin']);
    const tips = {};
    for (const line of (await this.git(top, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/origin'])).split('\n')) {
      const [ref, sha] = line.split(' ');
      if (ref && sha && ref !== 'refs/remotes/origin/HEAD') tips[ref.replace('refs/remotes/origin/', '')] = sha;
    }
    const c = this.cache[top];
    if (!c) {   // first sight: remember, report nothing historic
      this.cache[top] = { tips, pending: [] };
      return;
    }
    for (const [branch, sha] of Object.entries(tips)) {
      const old = c.tips[branch];
      if (old === sha) continue;
      const range = old ? [`${old}..${sha}`] : [sha, '--not', ...Object.values(c.tips)];
      const commits = (await this.git(top, ['log', '--format=%H%x09%cn', ...range])).split('\n').filter(Boolean)
        .map((l) => ({ sha: l.split('\t')[0], who: provenanceOf(l.split('\t')[1]) }));
      if (commits.length) this.#report(r, c, branch, sha, commits);
    }
    c.tips = tips;
    await this.#statuses(top, c);
  }

  /** Into the one session on this machine on that branch, whoever pushed; else dropped. */
  #report(r, c, branch, sha, commits) {
    // Several sessions can share a branch (main, typically): narrow to the pushing agent's
    // host; still ambiguous -> drop rather than guess a Topic.
    let on = r.sessions.filter((s) => s.branch === branch);
    const agents = new Set(commits.map((x) => x.who?.agent).filter(Boolean));
    if (on.length > 1 && agents.size === 1) on = on.filter((s) => s.key.startsWith(`${[...agents][0]}:`));
    if (on.length !== 1) return;
    const { key } = on[0];
    this.post(key, `pushed ${short(sha)} → ${branch} (+${commits.length})`);
    c.pending = [...c.pending, { sha, key, done: [] }].slice(-PENDING_MAX);
  }

  async #statuses(top, c) {
    for (const p of c.pending) {
      const list = await this.forge(top, ['status', 'list', p.sha]);
      if (!Array.isArray(list)) continue;
      for (const st of list) {
        if (!VERDICTS.includes(st.context) || p.done.includes(st.context) || !VERDICT_WORD[st.state]) continue;
        p.done.push(st.context);
        this.post(p.key, `${st.context} ${VERDICT_WORD[st.state]} ${short(p.sha)}`);
      }
    }
    c.pending = c.pending.filter((p) => p.done.length < VERDICTS.length);
  }
}
