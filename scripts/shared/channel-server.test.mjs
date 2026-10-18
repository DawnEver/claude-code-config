import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CHANNEL_SERVER, channelServerState, ensureChannelServer } from './channel-server.mjs';

function fixture(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-server-'));
  const server = path.join(dir, 'server.mjs');
  fs.writeFileSync(server, '');
  const file = path.join(dir, '.claude.json');
  if (config !== undefined) fs.writeFileSync(file, JSON.stringify(config));
  return { file, server, read: () => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('a config without the server is missing, and ensure registers it keeping other keys', () => {
  const f = fixture({ numStartups: 4, mcpServers: { other: { command: 'x' } } });
  assert.equal(channelServerState(f.file, f.server), 'missing');
  assert.equal(ensureChannelServer(f.file, f.server), true);
  const c = f.read();
  assert.equal(c.numStartups, 4);
  assert.deepEqual(c.mcpServers.other, { command: 'x' });
  assert.deepEqual(c.mcpServers[CHANNEL_SERVER], { type: 'stdio', command: 'node', args: [f.server], env: {} });
  assert.equal(channelServerState(f.file, f.server), 'ok');
  assert.equal(ensureChannelServer(f.file, f.server), false);
});

test('a registration pointing at another path is stale and is rewritten', () => {
  const f = fixture({ mcpServers: { [CHANNEL_SERVER]: { command: 'node', args: ['/gone/server.mjs'] } } });
  assert.equal(channelServerState(f.file, f.server), 'stale');
  assert.equal(ensureChannelServer(f.file, f.server), true);
  assert.deepEqual(f.read().mcpServers[CHANNEL_SERVER].args, [f.server]);
});

test('an absent or unreadable config is never created or repaired', () => {
  const absent = fixture();
  assert.equal(channelServerState(absent.file, absent.server), 'no-config');
  assert.equal(ensureChannelServer(absent.file, absent.server), false);
  assert.equal(fs.existsSync(absent.file), false);
  const broken = fixture();
  fs.writeFileSync(broken.file, '{not json');
  assert.equal(ensureChannelServer(broken.file, broken.server), false);
  assert.equal(fs.readFileSync(broken.file, 'utf8'), '{not json');
});
