// scripts/bridge/telegram.mjs — minimal Telegram Bot API client over fetch.
//
// One bot per machine and one consumer per token (getUpdates is single-consumer), so the
// daemon is the only caller. The update offset is persisted purely as a cache: losing it
// only means Telegram re-delivers up to 24h of updates, which the in-memory dedupe set and
// the offset itself absorb. Nothing else about Telegram is stored — it is a stateless view.

import fs from 'fs';
import path from 'path';

export const MAX_MESSAGE = 4096;
export const ATTACHMENT_LIMITS = Object.freeze({
  photo: 10 * 1024 * 1024, document: 50 * 1024 * 1024,
  download: 20 * 1024 * 1024, caption: 1024,
});

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

/** Project math to Telegram's explicit tags without interpreting code or currency. */
export function normalizeMath(value) {
  const text = String(value ?? '');
  const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let out = '';
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\' && i + 1 < text.length) { out += text.slice(i, i + 2); i += 2; continue; }
    if (text[i] === '`' || (text[i] === '~' && text.startsWith('~~~', i))) {
      const run = text.slice(i).match(/^(`+|~+)/)[0];
      const end = text.indexOf(run, i + run.length);
      const next = end < 0 ? text.length : end + run.length;
      out += text.slice(i, next); i = next; continue;
    }
    if (text[i] === '$') {
      const block = text[i + 1] === '$';
      const delimiter = block ? '$$' : '$';
      const start = i + delimiter.length;
      let end = start;
      for (; end < text.length; end++) {
        if (text[end] === '\\') { end++; continue; }
        if (!block && text[end] === '\n') break;
        if (text.startsWith(delimiter, end)) break;
      }
      const expression = text.slice(start, end);
      if (text.startsWith(delimiter, end) && expression.trim() &&
          (block || (!/^\s|\s$/.test(expression) && !/\d/.test(text[end + 1] ?? '')))) {
        const tag = block ? 'tg-math-block' : 'tg-math';
        const math = `<${tag}>${escape(expression.trim())}</${tag}>`;
        out += block ? `\n\n${math}\n\n` : math;
        i = end + delimiter.length; continue;
      }
    }
    out += text[i++];
  }
  return out;
}

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
        body = await res.json();   // unreadable acknowledgement leaves the write outcome unknown
      } catch (e) {
        // A transport error may contain the request URL/token or follow a successful write.
        // Never blindly repeat Topic creation after a lost acknowledgement.
        if (signal?.aborted || attempt >= this.maxRetries || ['createForumTopic', 'sendRichMessage', 'sendMessage'].includes(method)) {
          throw Object.assign(new Error(`telegram ${method}: transport failed (outcome uncertain)`), { uncertain: true });
        }
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
   * Send plain text, chunked to 4096. Returns the sent messages. Silent by default; `alert`
   * (user ids) makes it notify and mentions each user — a mention gets through a muted chat.
   */
  async sendMessage(chatId, text, { threadId, replyMarkup, alert, rich = false } = {}) {
    // Preserve structural Markdown as one message; never split a formula or code fence.
    // Alerts and approval controls remain on the independently tested plain-text path.
    if (rich && !alert?.length && !replyMarkup) {
      try {
        return [await this.call('sendRichMessage', {
          chat_id: chatId, rich_message: { markdown: normalizeMath(text) },
          disable_notification: true,
          ...(threadId ? { message_thread_id: threadId } : {}),
        })];
      } catch (e) {
        const unsupported = e.code === 404;
        const invalidFormat = e.code === 400 && /parse|format|too long|length|size|unsupported/i.test(e.message);
        if (!unsupported && !invalidFormat) throw e;
        // Confirmed rejection only: uncertain delivery must not generate a duplicate.
      }
    }
    const sent = [];
    const prefixLength = (alert?.length ?? 0) * 5;
    if (prefixLength >= MAX_MESSAGE) throw new Error('telegram sendMessage: too many alert recipients');
    const parts = chunkText(text, MAX_MESSAGE - prefixLength);
    for (let i = 0; i < parts.length; i++) {
      const loud = alert?.length && i === 0;
      const params = {
        chat_id: chatId,
        text: loud ? `${alert.map(() => '@you').join(' ')} ${parts[i]}` : parts[i],
        ...(loud ? { entities: alert.map((id, k) => ({ type: 'text_mention', offset: k * 5, length: 4, user: { id } })) }
          : { disable_notification: true }),
        ...(threadId ? { message_thread_id: threadId } : {}),
        ...(replyMarkup && i === parts.length - 1 ? { reply_markup: replyMarkup } : {}),
        link_preview_options: { is_disabled: true },
      };
      try { sent.push(await this.call('sendMessage', params)); }
      catch (e) {
        e.sentCount = sent.length;
        e.totalChunks = parts.length;
        e.message += ` (${sent.length}/${parts.length} chunks acknowledged)`;
        throw e;
      }
    }
    return sent;
  }

  /** Explicit local-file upload. A lost acknowledgement is never retried. */
  async sendAttachment(chatId, filePath, { kind = 'document', threadId, caption, signal, workspaceRoot } = {}) {
    if (!['document', 'photo'].includes(kind)) throw new Error('telegram attachment: invalid kind');
    if (caption !== undefined && (typeof caption !== 'string' || caption.length > ATTACHMENT_LIMITS.caption)) {
      throw new Error('telegram attachment: caption must be at most 1024 characters');
    }
    const limit = ATTACHMENT_LIMITS[kind];
    const handle = await fs.promises.open(filePath, 'r');
    let data;
    try {
      const stat = await handle.stat();
      if (workspaceRoot) {
        const canonical = await fs.promises.realpath(filePath);
        const relative = path.relative(workspaceRoot, canonical);
        const current = await fs.promises.stat(canonical);
        if (canonical !== path.resolve(filePath) || !relative || relative === '..' ||
            relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
            current.ino !== stat.ino || current.dev !== stat.dev) {
          throw new Error('telegram attachment: file identity or workspace changed');
        }
      }
      if (!stat.isFile()) throw new Error('telegram attachment: expected a regular file');
      if (!stat.size || stat.size > limit) throw new Error('telegram attachment: file exceeds size limit or is empty');
      // Bound allocation/read even if a writer grows the file after stat().
      const buffer = Buffer.alloc(stat.size + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size !== stat.size) throw new Error('telegram attachment: file changed during read');
      data = buffer.subarray(0, size);
    } finally { await handle.close(); }
    const form = new FormData();
    form.set('chat_id', String(chatId));
    form.set('disable_notification', 'true');
    if (threadId) form.set('message_thread_id', String(threadId));
    if (caption !== undefined) form.set('caption', caption);
    form.set(kind, new Blob([data]), path.basename(filePath));
    const method = kind === 'photo' ? 'sendPhoto' : 'sendDocument';
    for (let attempt = 0; ; attempt++) {
      let body;
      try {
        const response = await this.fetch(`${this.base}/${method}`, { method: 'POST', body: form, signal, redirect: 'error' });
        body = await response.json();
      } catch {
        throw Object.assign(new Error(`telegram ${method}: transport failed (outcome uncertain)`), { uncertain: true });
      }
      if (body.ok) return body.result;
      const error = new TelegramError(method, body);
      if (error.code !== 429 || attempt >= this.maxRetries || signal?.aborted) throw error;
      await this.sleep((error.retryAfter ?? 1) * 1000);
    }
  }

  /** Download one explicitly selected Telegram file; caller owns local storage. */
  async downloadAttachment(fileId, { maxBytes = ATTACHMENT_LIMITS.download, signal } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > ATTACHMENT_LIMITS.download) {
      throw new Error('telegram attachment: invalid download size limit');
    }
    const info = await this.call('getFile', { file_id: fileId }, { signal });
    const relative = info?.file_path;
    if (typeof relative !== 'string' || !relative || relative.split('/').some(p => !p || p === '.' || p === '..')
      || /[\\\\?#:\x00-\x20]/.test(relative)) {
      throw new Error('telegram attachment: invalid file path');
    }
    if (info.file_size > maxBytes) throw new Error('telegram attachment: download exceeds size limit');
    let response;
    try {
      const url = new URL(this.base);
      url.pathname = url.pathname.replace(/\/bot([^/]+)$/, '/file/bot$1') + '/' + relative;
      response = await this.fetch(url.href, { signal, redirect: 'error' });
    } catch { throw new Error('telegram attachment: download transport failed'); }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error('telegram attachment: download rejected');
    }
    const length = Number(response.headers.get('content-length'));
    if (length > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error('telegram attachment: download exceeds size limit');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('telegram attachment: download body missing');
    const chunks = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error('telegram attachment: download exceeds size limit');
        }
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      if (error.message === 'telegram attachment: download exceeds size limit') throw error;
      throw new Error('telegram attachment: download transport failed');
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, size);
  }

  editMessageText(chatId, messageId, text, { replyMarkup } = {}) {
    return this.call('editMessageText', {
      chat_id: chatId, message_id: messageId, text: chunkText(text)[0],
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  createForumTopic(chatId, name) {
    if (!name || Array.from(String(name)).length > 128) throw new Error('telegram: Topic name must be 1-128 characters');
    return this.call('createForumTopic', { chat_id: chatId, name: String(name) });
  }

  closeForumTopic(chatId, threadId) {
    return this.call('closeForumTopic', { chat_id: chatId, message_thread_id: threadId });
  }

  editForumTopic(chatId, threadId, name) {
    return this.call('editForumTopic', { chat_id: chatId, message_thread_id: threadId, name });
  }

  pinChatMessage(chatId, messageId) {
    return this.call('pinChatMessage', { chat_id: chatId, message_id: messageId, disable_notification: true });
  }

  reopenForumTopic(chatId, threadId) {
    return this.call('reopenForumTopic', { chat_id: chatId, message_thread_id: threadId });
  }

  deleteForumTopic(chatId, threadId) {
    return this.call('deleteForumTopic', { chat_id: chatId, message_thread_id: threadId });
  }

  answerCallbackQuery(id, text) {
    return this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) });
  }
}
