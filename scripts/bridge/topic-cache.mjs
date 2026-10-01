// scripts/bridge/topic-cache.mjs — topics.json: `chatId|sessionKey` -> {topicId, title,
// closedAt?}. A cache only (docs/bridge.md): it lets a session re-attach to its Topic after
// a daemon restart, and records which Topics this bridge closed, the sole input to the
// delete sweep. Entries of any other shape are ignored; deleting the file is always safe.

import fs from 'fs';
import path from 'path';

export class TopicCache {
  constructor(file = null) {
    this.file = file;
    this.entries = {};
    try {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')) ?? {})) {
        if (Number.isInteger(v?.topicId)) this.entries[k] = v;
      }
    } catch { /* empty cache */ }
  }

  static key(chatId, sessionKey) { return `${chatId}|${sessionKey}`; }

  static chatIdOf(k) { return Number(k.slice(0, k.indexOf('|'))); }

  get(k) { return this.entries[k] ?? null; }

  /** Write an entry; null removes it. */
  set(k, entry) {
    if (entry) this.entries[k] = entry; else delete this.entries[k];
    this.save();
  }

  /** Entries closed at least `hours` ago. `hours <= 0` disables the sweep. */
  due(now, hours) {
    if (!(hours > 0)) return [];
    return Object.entries(this.entries).filter(([, e]) => typeof e.closedAt === 'number' && now - e.closedAt >= hours * 3600000);
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 2));
    } catch { /* cache only */ }
  }
}
