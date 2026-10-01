// scripts/bridge/telegram.mjs — minimal Telegram Bot API client over fetch.
//
// One bot per machine and one consumer per token (getUpdates is single-consumer), so the
// daemon is the only caller. The update offset is persisted purely as a cache: losing it
// only means Telegram re-delivers up to 24h of updates, which the in-memory dedupe set and
// the offset itself absorb. Nothing else about Telegram is stored — it is a stateless view.

import fs from 'fs';
import path from 'path';

export const MAX_MESSAGE = 4096;

const MDV2_SPECIAL = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** Escape text for parse_mode MarkdownV2. */
export function escapeMarkdownV2(text) {
  return String(text).replace(MDV2_SPECIAL, (c) => `\\${c}`);
}

/** Split text into <= max chunks, preferring newline then space boundaries. */
export function chunkText(text, max = MAX_MESSAGE) {
  const s = String(text ?? '');
  if (s.length <= max) return [s];
  const out = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TelegramError extends Error {
  constructor(method, body) {
    super(`telegram ${method}: ${body?.description ?? 'request failed'}`);
    this.code = body?.error_code;
    this.retryAfter = body?.parameters?.retry_after;
  }
}

export class TelegramClient {
  /**
   * @param {{ token: string, apiBase?: string, fetch?: typeof fetch, sleep?: (ms) => Promise,
   *           offsetFile?: string|null, maxRetries?: number }} opts
   */
  constructor({ token, apiBase = 'https://api.telegram.org', fetch: f = globalThis.fetch,
    sleep = realSleep, offsetFile = null, maxRetries = 5 }) {
    if (!token) throw new Error('telegram: bot token missing');
    this.base = `${apiBase.replace(/\/$/, '')}/bot${token}`;
    this.fetch = f;
    this.sleep = sleep;
    this.offsetFile = offsetFile;
    this.maxRetries = maxRetries;
    this.offset = this.#loadOffset();
    this.seen = new Set();
  }

  #loadOffset() {
    if (!this.offsetFile) return 0;
    try { return Number(JSON.parse(fs.readFileSync(this.offsetFile, 'utf8')).offset) || 0; } catch { return 0; }
  }

  #saveOffset() {
    if (!this.offsetFile) return;
    try {
      fs.mkdirSync(path.dirname(this.offsetFile), { recursive: true });
      fs.writeFileSync(this.offsetFile, JSON.stringify({ offset: this.offset }));
    } catch { /* cache only */ }
  }

  /** Call a Bot API method; honors 429 retry_after. Never logs the URL (it holds the token). */
  async call(method, params = {}, { signal } = {}) {
    for (let attempt = 0; ; attempt++) {
      let body;
      try {
        const res = await this.fetch(`${this.base}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
          signal,
        });
        body = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
      } catch (e) {
        if (signal?.aborted || attempt >= this.maxRetries) throw new Error(`telegram ${method}: ${e.message}`);
        await this.sleep(Math.min(30000, 1000 * 2 ** attempt));
        continue;
      }
      if (body.ok) return body.result;
      const err = new TelegramError(method, body);
      if (err.code === 429 && attempt < this.maxRetries) {
        await this.sleep((err.retryAfter ?? 1) * 1000);
        continue;
      }
      throw err;
    }
  }

  /** One long-poll. Returns new, deduplicated updates and advances the offset. */
  async getUpdates({ timeout = 50, signal } = {}) {
    const updates = await this.call('getUpdates', {
      offset: this.offset || undefined, timeout, allowed_updates: ['message', 'callback_query'],
    }, { signal });
    const fresh = [];
    for (const u of updates ?? []) {
      if (u.update_id >= this.offset) this.offset = u.update_id + 1;
      if (this.seen.has(u.update_id)) continue;
      this.seen.add(u.update_id);
      fresh.push(u);
    }
    if (this.seen.size > 1000) this.seen = new Set([...this.seen].slice(-500));
    if (updates?.length) this.#saveOffset();
    return fresh;
  }

  /**
   * Send text, chunked to 4096. Plain text by default; `markdown: true` escapes for
   * MarkdownV2. Returns the sent messages.
   */
  async sendMessage(chatId, text, { threadId, markdown = false, replyMarkup } = {}) {
    const sent = [];
    const parts = chunkText(text, markdown ? Math.floor(MAX_MESSAGE / 2) : MAX_MESSAGE);
    for (let i = 0; i < parts.length; i++) {
      const params = {
        chat_id: chatId,
        text: markdown ? escapeMarkdownV2(parts[i]) : parts[i],
        ...(threadId ? { message_thread_id: threadId } : {}),
        ...(markdown ? { parse_mode: 'MarkdownV2' } : {}),
        ...(replyMarkup && i === parts.length - 1 ? { reply_markup: replyMarkup } : {}),
        link_preview_options: { is_disabled: true },
      };
      sent.push(await this.call('sendMessage', params));
    }
    return sent;
  }

  editMessageText(chatId, messageId, text, { replyMarkup } = {}) {
    return this.call('editMessageText', {
      chat_id: chatId, message_id: messageId, text: chunkText(text)[0],
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  createForumTopic(chatId, name) {
    return this.call('createForumTopic', { chat_id: chatId, name: String(name).slice(0, 128) });
  }

  closeForumTopic(chatId, threadId) {
    return this.call('closeForumTopic', { chat_id: chatId, message_thread_id: threadId });
  }

  reopenForumTopic(chatId, threadId) {
    return this.call('reopenForumTopic', { chat_id: chatId, message_thread_id: threadId });
  }

  unpinAllForumTopicMessages(chatId, threadId) {
    return this.call('unpinAllForumTopicMessages', { chat_id: chatId, message_thread_id: threadId });
  }

  answerCallbackQuery(id, text) {
    return this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
  }
}
