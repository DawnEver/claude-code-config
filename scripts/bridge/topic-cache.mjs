// scripts/bridge/topic-cache.mjs — the daemon's topics.json: `chatId|sessionKey` ->
// {topicId, closedAt?}. A cache only (docs/bridge.md): it avoids recreating a Topic after a
// restart and records which Topics this bridge itself closed, which is the sole input to
// the closed-Topic sweep. A bare number is the pre-closedAt shape and is never swept.

import fs from 'fs';
import path from 'path';

export class TopicCache {
  constructor(file = null) {
    this.file = file;
    this.entries = {};
    try { this.entries = JSON.parse(fs.readFileSync(file, 'utf8')) ?? {}; } catch { /* empty cache */ }
  }

  static key(chatId, sessionKey) { return `${chatId}|${sessionKey}`; }

  static chatIdOf(k) { return Number(k.slice(0, k.indexOf('|'))); }

  /** Normalised entry, or null. */
  get(k) {
    const v = this.entries[k];
    if (typeof v === 'number') return { topicId: v };
    return v?.topicId ? v : null;
  }

  topicId(k) { return this.get(k)?.topicId ?? null; }

  set(k, entry) { this.entries[k] = entry; this.save(); }

  delete(k) { if (k in this.entries) { delete this.entries[k]; this.save(); } }

  /** Entries this bridge closed at least `hours` ago. `hours <= 0` disables the sweep. */
  due(now, hours) {
    if (!(hours > 0)) return [];
    const out = [];
    for (const k of Object.keys(this.entries)) {
      const e = this.get(k);
      if (typeof e?.closedAt === 'number' && now - e.closedAt >= hours * 3600000) out.push([k, e]);
    }
    return out;
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 2));
    } catch { /* cache only */ }
  }
}
