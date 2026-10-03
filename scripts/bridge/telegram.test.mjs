import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TelegramClient, chunkText, normalizeMath } from './telegram.mjs';

test('math projection preserves prose/code/currency and converts formulas', () => {
  assert.equal(normalizeMath('Inline $x^2$ and $$\\frac{1}{3}$$.'),
    'Inline <tg-math>x^2</tg-math> and \n\n<tg-math-block>\\frac{1}{3}</tg-math-block>\n\n.');
  for (const text of ['`$x$`', '```sh\necho "$HOME"\n```', '\\$5 and $10', '$5 and $10', '$USD', '$ unmatched', '$x', '$ x $']) {
    assert.equal(normalizeMath(text), text);
  }
  assert.equal(normalizeMath('$a<b & c>d$'), '<tg-math>a&lt;b &amp; c&gt;d</tg-math>');
  assert.equal(normalizeMath('$$\nx^2\n$$'), '\n\n<tg-math-block>x^2</tg-math-block>\n\n');
});

test('sendAttachment uploads explicit files with multipart topic and caption', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-attachment-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'answer.txt');
  fs.writeFileSync(file, 'the answer');
  const calls = [];
  const tg = new TelegramClient({ token: 'test', fetch: async (url, options) => {
    calls.push({ url, options });
    return { json: async () => ({ ok: true, result: { message_id: 12 } }) };
  } });
  assert.equal((await tg.sendAttachment(-100, file, { threadId: 7, caption: 'Result' })).message_id, 12);
  const { url, options } = calls[0];
  assert.ok(url.endsWith('/sendDocument'));
  assert.equal(options.headers, undefined, 'fetch supplies the multipart boundary');
  assert.equal(options.body.get('chat_id'), '-100');
  assert.equal(options.body.get('message_thread_id'), '7');
  assert.equal(options.body.get('caption'), 'Result');
  assert.equal(options.body.get('disable_notification'), 'true');
  assert.equal(options.body.get('document').name, 'answer.txt');
  assert.equal(await options.body.get('document').text(), 'the answer');
  await tg.sendAttachment(-100, file, { kind: 'photo' });
  assert.ok(calls[1].url.endsWith('/sendPhoto'));
  assert.ok(calls[1].options.body.get('photo'));
});

test('sendAttachment validates kind, regular files, caption and size before network access', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-attachment-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'large.bin');
  fs.closeSync(fs.openSync(file, 'w'));
  fs.truncateSync(file, 50 * 1024 * 1024 + 1);
  let calls = 0;
  const tg = new TelegramClient({ token: 'test', fetch: async () => { calls++; } });
  await assert.rejects(tg.sendAttachment(-100, file), /size limit/);
  fs.truncateSync(file, 10 * 1024 * 1024 + 1);
  await assert.rejects(tg.sendAttachment(-100, file, { kind: 'photo' }), /size limit/);
  await assert.rejects(tg.sendAttachment(-100, dir), /regular file/);
  await assert.rejects(tg.sendAttachment(-100, file, { kind: 'video' }), /kind/);
  await assert.rejects(tg.sendAttachment(-100, file, { caption: 'x'.repeat(1025) }), /caption/);
  assert.equal(calls, 0);
});

test('sendAttachment does not retry uncertain delivery or leak transport URLs', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-attachment-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'answer.txt');
  fs.writeFileSync(file, 'answer');
  let calls = 0;
  const tg = new TelegramClient({ token: 'PRIVATE_TOKEN', fetch: async (url) => {
    calls++; throw new Error(url);
  } });
  await assert.rejects(tg.sendAttachment(-100, file), (e) => e.uncertain && !e.message.includes('PRIVATE_TOKEN'));
  assert.equal(calls, 1);
});

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

test('downloadAttachment resolves metadata and bounds the streamed response', async () => {
  const calls = [];
  const tg = new TelegramClient({ token: 'test', fetch: async (url) => {
    calls.push(url);
    if (url.endsWith('/getFile')) return { json: async () => ({ ok: true, result: { file_path: 'documents/file.txt', file_size: 6 } }) };
    return new Response('answer');
  } });
  assert.equal((await tg.downloadAttachment('file-id')).toString(), 'answer');
  assert.equal(calls[1], 'https://api.telegram.org/file/bottest/documents/file.txt');
  await assert.rejects(tg.downloadAttachment('file-id', { maxBytes: 5 }), /size limit/);
});

test('downloadAttachment rejects unsafe metadata and oversized streams without leaking token', async () => {
  for (const filePath of ['../secret', '/absolute', 'https://example.test/x', 'file\\evil']) {
    const tg = new TelegramClient({ token: 'PRIVATE_TOKEN', fetch: async () => ({
      json: async () => ({ ok: true, result: { file_path: filePath } }),
    }) });
    await assert.rejects(tg.downloadAttachment('id'), /file path/);
  }
  const tg = new TelegramClient({ token: 'PRIVATE_TOKEN', fetch: async (url) => {
    if (url.endsWith('/getFile')) return { json: async () => ({ ok: true, result: { file_path: 'file.bin' } }) };
    return new Response('too big');
  } });
  await assert.rejects(tg.downloadAttachment('id', { maxBytes: 2 }), /size limit/);
  tg.fetch = async (url) => {
    if (url.endsWith('/getFile')) return { json: async () => ({ ok: true, result: { file_path: 'file.bin' } }) };
    throw new Error(url);
  };
  await assert.rejects(tg.downloadAttachment('id'), (e) => !e.message.includes('PRIVATE_TOKEN'));
});

test('chunkText splits at <=4096 preferring newlines', () => {
  const text = ('a'.repeat(3000) + '\n').repeat(3);
  const parts = chunkText(text);
  assert.ok(parts.every((p) => p.length <= 4096));
  assert.equal(parts.join('\n').replace(/\n+/g, ''), text.replace(/\n+/g, ''));
  assert.equal(chunkText('x'.repeat(9000)).length, 3);
});

test('rich replies preserve Markdown and topic without plain-text chunking', async () => {
  const api = await fakeApi(() => ({ ok: true, result: { message_id: 8 } }));
  try {
    const tg = new TelegramClient({ token: 'test', apiBase: api.base });
    const text = '# Result\n$$x^2$$\n' + 'x'.repeat(5000);
    assert.equal((await tg.sendMessage(-100, text, { threadId: 7, rich: true })).length, 1);
    assert.equal(api.calls[0].method, 'sendRichMessage');
    assert.deepEqual(api.calls[0].params.rich_message, { markdown: normalizeMath(text) });
    assert.equal(api.calls[0].params.message_thread_id, 7);
  } finally { api.close(); }
});

test('rich replies fall back only on definite formatting or unsupported rejection', async () => {
  const api = await fakeApi((method) => method === 'sendRichMessage'
    ? { ok: false, error_code: 400, description: "Bad Request: can't parse rich message" }
    : { ok: true, result: { message_id: 9 } });
  try {
    const tg = new TelegramClient({ token: 'test', apiBase: api.base });
    await tg.sendMessage(-100, '**answer**', { rich: true });
    assert.deepEqual(api.calls.map(c => c.method), ['sendRichMessage', 'sendMessage']);
  } finally { api.close(); }
});

test('uncertain rich delivery is neither retried nor downgraded', async () => {
  let calls = 0;
  const tg = new TelegramClient({ token: 'test', fetch: async () => { calls++; throw new Error('lost ack'); } });
  await assert.rejects(tg.sendMessage(-100, '# answer', { rich: true }), { uncertain: true });
  assert.equal(calls, 1);
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

test('sendMessage is silent unless it alerts; an alert mentions each user by id', async () => {
  const api = await fakeApi((m, p) => ({ ok: true, result: { message_id: 1, text: p.text } }));
  try {
    const tg = new TelegramClient({ token: '1:x', apiBase: api.base });
    await tg.sendMessage(-100, 'quiet');
    await tg.sendMessage(-100, 'look', { alert: [42] });
    assert.equal(api.calls[0].params.disable_notification, true);
    const loud = api.calls[1].params;
    assert.equal(loud.disable_notification, undefined);
    assert.equal(loud.text, '@you look');
    assert.deepEqual(loud.entities, [{ type: 'text_mention', offset: 0, length: 4, user: { id: 42 } }]);
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
    const r = await tg.createForumTopic(-1, 'host-a/codex/main');
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

test('uncertain Topic creation is not retried and transport errors do not leak tokens', async () => {
  let calls = 0;
  const tg = new TelegramClient({ token: 'PRIVATE_TOKEN', sleep: async () => {}, fetch: async (url) => {
    calls++; throw new Error(`failed ${url}`);
  } });
  await assert.rejects(tg.createForumTopic(-100, 'x'), (e) => /uncertain/.test(e.message) && !e.message.includes('PRIVATE_TOKEN'));
  assert.equal(calls, 1, 'a lost creation acknowledgement must not create duplicate Topics');
});

test('partial chunk delivery reports acknowledged count and unknown remaining outcome', async () => {
  let calls = 0;
  const tg = new TelegramClient({ token: 'x', maxRetries: 0, fetch: async () => {
    if (calls++ === 0) return { json: async () => ({ ok: true, result: { message_id: 1 } }) };
    throw new Error('network');
  } });
  await assert.rejects(tg.sendMessage(-100, 'x'.repeat(5000)), (e) => e.sentCount === 1 && e.totalChunks === 2 && e.uncertain === true);
});

test('alert prefix stays within Telegram length limit and unreadable acknowledgement is uncertain', async () => {
  const api = await fakeApi((m, p) => ({ ok: true, result: { message_id: 1, text: p.text } }));
  try {
    const tg = new TelegramClient({ token: 't', apiBase: api.base });
    await tg.sendMessage(-100, 'x'.repeat(4096), { alert: [42, 43] });
    assert.ok(api.calls.every((c) => c.params.text.length <= 4096));
  } finally { api.close(); }
  let calls = 0;
  const tg = new TelegramClient({ token: 't', fetch: async () => {
    calls++; return { json: async () => { throw new Error('invalid json'); } };
  } });
  await assert.rejects(tg.createForumTopic(-100, 'x'), (e) => e.uncertain === true);
  assert.equal(calls, 1);
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

test('deleteForumTopic targets the Topic', async () => {
  const api = await fakeApi(() => ({ ok: true, result: true }));
  try {
    const tg = new TelegramClient({ token: 't', apiBase: api.base });
    assert.equal(await tg.deleteForumTopic(-100, 7), true);
    assert.deepEqual([api.calls[0].method, api.calls[0].params], ['deleteForumTopic', { chat_id: -100, message_thread_id: 7 }]);
  } finally { api.close(); }
});

test('pre renders the whole text as one monospace entity on send and edit', async () => {
  const calls = [];
  const tg = new TelegramClient({ token: 'test', fetch: async (url, init) => {
    calls.push([url.split('/').pop(), JSON.parse(init.body)]);
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  } });
  await tg.sendMessage(-100, 'a █ b', { pre: true });
  await tg.editMessageText(-100, 1, 'c ░', { pre: true });
  assert.deepEqual(calls.map(([m, p]) => [m, p.entities]), [
    ['sendMessage', [{ type: 'pre', offset: 0, length: 5 }]],
    ['editMessageText', [{ type: 'pre', offset: 0, length: 3 }]],
  ]);
});
