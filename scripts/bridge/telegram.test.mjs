import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TelegramClient, chunkText, escapeMarkdownV2 } from './telegram.mjs';

/** Local fake Bot API. `handler(method, body)` returns the JSON envelope. */
async function fakeApi(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const params = JSON.parse(body || '{}');
      calls.push({ url: req.url, method, params });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(handler(method, params, calls)));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { calls, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('chunkText splits at <=4096 preferring newlines', () => {
  const text = ('a'.repeat(3000) + '\n').repeat(3);
  const parts = chunkText(text);
  assert.ok(parts.every((p) => p.length <= 4096));
  assert.equal(parts.join('\n').replace(/\n+/g, ''), text.replace(/\n+/g, ''));
  assert.equal(chunkText('x'.repeat(9000)).length, 3);
});

test('escapeMarkdownV2 escapes every reserved char', () => {
  assert.equal(escapeMarkdownV2('a_b*c[d](e)~`>#+-=|{}.!\\'), 'a\\_b\\*c\\[d\\]\\(e\\)\\~\\`\\>\\#\\+\\-\\=\\|\\{\\}\\.\\!\\\\');
});

test('sendMessage chunks, targets the topic, and puts the token only in the path', async () => {
  const api = await fakeApi((m, p) => ({ ok: true, result: { message_id: 1, text: p.text } }));
  try {
    const tg = new TelegramClient({ token: '123:SECRET', apiBase: api.base });
    const sent = await tg.sendMessage(-100, 'y'.repeat(5000), { threadId: 7 });
    assert.equal(sent.length, 2);
    assert.equal(api.calls[0].url, '/bot123:SECRET/sendMessage');
    assert.equal(api.calls[0].params.message_thread_id, 7);
    assert.equal(api.calls[0].params.parse_mode, undefined);
  } finally { api.close(); }
});

test('429 is retried after retry_after seconds', async () => {
  let n = 0;
  const api = await fakeApi(() => (n++ === 0
    ? { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } }
    : { ok: true, result: { message_thread_id: 55 } }));
  const sleeps = [];
  try {
    const tg = new TelegramClient({ token: 't', apiBase: api.base, sleep: async (ms) => sleeps.push(ms) });
    const r = await tg.createForumTopic(-1, 'WS1/codex/main');
    assert.equal(r.message_thread_id, 55);
    assert.deepEqual(sleeps, [3000]);
  } finally { api.close(); }
});

test('non-429 errors throw with code and description', async () => {
  const api = await fakeApi(() => ({ ok: false, error_code: 400, description: 'Bad Request: not enough rights' }));
  try {
    const tg = new TelegramClient({ token: 't', apiBase: api.base });
    await assert.rejects(tg.createForumTopic(-1, 'x'), (e) => e.code === 400 && /not enough rights/.test(e.message));
  } finally { api.close(); }
});

test('getUpdates advances, persists and dedupes the offset', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-'));
  const offsetFile = path.join(dir, 'offset.json');
  const api = await fakeApi((m, p) => ({ ok: true, result: [{ update_id: 10 }, { update_id: 11 }].filter((u) => u.update_id >= (p.offset ?? 0)) }));
  try {
    const tg = new TelegramClient({ token: 't', apiBase: api.base, offsetFile });
    assert.deepEqual((await tg.getUpdates({ timeout: 0 })).map((u) => u.update_id), [10, 11]);
    assert.equal(JSON.parse(fs.readFileSync(offsetFile, 'utf8')).offset, 12);
    const again = new TelegramClient({ token: 't', apiBase: api.base, offsetFile });
    assert.equal(again.offset, 12);
    assert.deepEqual(await again.getUpdates({ timeout: 0 }), []);
    assert.equal(api.calls.at(-1).params.offset, 12);
  } finally { api.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('closeForumTopic / reopenForumTopic target the Topic', async () => {
  const api = await fakeApi(() => ({ ok: true, result: true }));
  try {
    const tg = new TelegramClient({ token: 't', apiBase: api.base });
    assert.equal(await tg.closeForumTopic(-100, 7), true);
    assert.equal(await tg.reopenForumTopic(-100, 7), true);
    assert.deepEqual(api.calls.map((c) => [c.method, c.params]), [
      ['closeForumTopic', { chat_id: -100, message_thread_id: 7 }],
      ['reopenForumTopic', { chat_id: -100, message_thread_id: 7 }],
    ]);
  } finally { api.close(); }
});
