import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Bridge } from './daemon.mjs';

function fixture(t, agent = 'codex') {
  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-inbound-'));
  t.after(() => fs.rmSync(uploadsDir, { recursive: true, force: true }));
  const host = new EventEmitter(); host.agent = agent;
  const injected = [], downloads = [], sent = [];
  host.inject = async (...args) => injected.push(args);
  const telegram = {
    createForumTopic: async () => ({ message_thread_id: 100 }),
    sendMessage: async (...args) => { sent.push(args); return [{ message_id: 1 }]; },
    downloadAttachment: async (id) => { downloads.push(id); return Buffer.from('image fixture'); },
  };
  const bridge = new Bridge({ telegram, adapters: [host], machine: 'test', uploadsDir,
    config: { allowedUserIds: [42], projects: {}, fallbackChatId: -100 },
    resolveContext: () => ({ project: 'test', branch: 'main' }) });
  const message = (extra = {}) => ({ message: { chat: { id: -100 }, from: { id: 42 },
    is_topic_message: true, message_thread_id: 100, photo: [{ file_id: 'small' }, { file_id: 'large' }], ...extra } });
  // A Topic exists only after activity: bring the session up, then give it a turn.
  const up = async (a = agent) => { await bridge.sessionUp(a, { id: 's', cwd: '/fixture' }); await bridge.final(`${a}:s`, 'ready'); };
  return { bridge, telegram, injected, downloads, sent, uploadsDir, message, up };
}

for (const agent of ['codex', 'claude']) test(`${agent} receives authenticated Topic photo and caption`, async (t) => {
  const f = fixture(t, agent);
  await f.up(agent);
  await f.bridge.handleUpdate(f.message({ caption: 'describe this' }));
  assert.deepEqual(f.downloads, ['large']);
  assert.equal(f.injected.length, 1);
  assert.match(f.injected[0][1], /describe this/);
  const file = path.join(f.uploadsDir, fs.readdirSync(f.uploadsDir)[0]);
  assert.equal(fs.readFileSync(file, 'utf8'), 'image fixture');
  assert.deepEqual(f.injected[0][3], { images: [file] });
});

test('unauthorized or wrong Topic attachments never download', async (t) => {
  const f = fixture(t); await f.up('codex');
  for (const extra of [{ from: { id: 666 } }, { message_thread_id: 999 }, { chat: { id: -999 } }])
    await f.bridge.handleUpdate(f.message(extra));
  assert.deepEqual(f.downloads, []);
});

test('documents preserve safe extension but never user-controlled paths', async (t) => {
  const f = fixture(t); await f.up('codex');
  await f.bridge.handleUpdate(f.message({ photo: undefined, document: { file_id: 'doc', file_name: '../../evil.pdf' } }));
  const names = fs.readdirSync(f.uploadsDir);
  assert.equal(names.length, 1); assert.match(names[0], /^[a-f0-9]{32}\.pdf$/);
  assert.deepEqual(f.injected[0][3], { images: [] });
  assert.match(f.injected[0][1], /@/);
});

test('oversized metadata refuses download and gives bounded error', async (t) => {
  const f = fixture(t); await f.up('codex');
  await f.bridge.handleUpdate(f.message({ photo: [{ file_id: 'big', file_size: 21 * 1024 * 1024 }] }));
  assert.deepEqual(f.downloads, []); assert.equal(f.injected.length, 0);
  assert.match(f.sent.at(-1)[1], /attachment failed/);
});

test('session ending during download cannot receive the attachment', async (t) => {
  const f = fixture(t); await f.up('codex');
  f.telegram.downloadAttachment = async () => { f.bridge.sessions.delete('codex:s'); return Buffer.from('fixture'); };
  await f.bridge.handleUpdate(f.message());
  assert.equal(f.injected.length, 0); assert.deepEqual(fs.readdirSync(f.uploadsDir), []);
});

test('attachment cannot cross a changed Topic or ended lifecycle during download', async (t) => {
  for (const change of [s => { s.topicId = 200; }, s => { s.state = 'ended'; }]) {
    const f = fixture(t); await f.up('codex');
    f.telegram.downloadAttachment = async () => { change(f.bridge.sessions.get('codex:s')); return Buffer.from('fixture'); };
    await f.bridge.handleUpdate(f.message());
    assert.equal(f.injected.length, 0);
    assert.deepEqual(fs.readdirSync(f.uploadsDir), []);
  }
});
