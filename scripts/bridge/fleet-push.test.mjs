import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetPush } from './fleet-push.mjs';
import { readBridgeConfig } from './context.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

test('push: authenticated, ordered, never overlapping, failures logged once and never thrown', async () => {
  const calls = [], logs = [];
  const ok = () => ({ ok: true, status: 200, json: async () => ({ accepted: true }) });
  let respond = ok;
  const push = new FleetPush({ url: 'https://gw.example', hostToken: 'tok', machine: 'host-a', log: (m) => logs.push(m),
    sessions: () => [{ id: 's1' }], fetch: async (url, init) => { calls.push({ url, init }); return respond(); } });
  assert.equal(await push.tick(), true);
  assert.equal(calls[0].url, 'https://gw.example/api/hosts/host-a/snapshot');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual([body.schemaVersion, body.seq, body.sessions], [1, 1, [{ id: 's1' }]]);
  respond = () => { throw new Error('ECONNREFUSED'); };
  assert.equal(await push.tick(), false);
  assert.equal(await push.tick(), false);
  assert.equal(logs.length, 1, 'one log per distinct failure');
  assert.doesNotMatch(logs[0], /tok/);
  respond = () => ({ ok: true, status: 200, json: async () => ({ accepted: false }) });
  assert.equal(await push.tick(), false, 'a refused push is not a success');
  assert.match(logs.at(-1), /refused/);
  respond = ok;
  await push.tick();
  assert.equal(JSON.parse(calls.at(-1).init.body).seq, 5);
  let release;
  respond = () => new Promise((r) => { release = () => r(ok()); });
  const first = push.tick();
  assert.equal(await push.tick(), false, 'skipped while one is in flight');
  release();
  assert.equal(await first, true);
});

test('config: fleetGateway needs url + hostToken, https unless loopback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fgw-'));
  const read = (shared, local = {}) => {
    fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify({ bridge: shared }));
    fs.writeFileSync(path.join(dir, 'l.json'), JSON.stringify({ bridge: local }));
    const c = readBridgeConfig({ sharedPath: path.join(dir, 's.json'), localPath: path.join(dir, 'l.json') });
    return c.fleetGateway ?? c.fleetGatewayError;
  };
  const local = { fleetGateway: { hostToken: 't' } };
  assert.equal(read({}), null, 'not configured: off, nothing to report');
  assert.match(read({ fleetGateway: { url: 'https://gw.example/' } }), /hostToken/);
  assert.match(read({ fleetGateway: { url: 'https://gw.example/', hostToken: 't' } }), /hostToken/, 'token in the synced layer is ignored');
  assert.deepEqual(read({ fleetGateway: { url: 'https://gw.example/' } }, local), { url: 'https://gw.example', hostToken: 't', everySeconds: 15 });
  assert.match(read({ fleetGateway: { url: 'https://gw.example/fleet/' } }, local), /origin/, 'a subpath the gateway cannot serve');
  assert.match(read({ fleetGateway: { url: 'http://gw.example' } }, local), /https/, 'plain http off loopback');
  assert.match(read({ fleetGateway: { url: 'https://gw.example', everySeconds: 1e9 } }, local), /5\.\.3600/);
  assert.equal(read({ fleetGateway: { url: 'http://127.0.0.1:8787', everySeconds: 30 } }, local).everySeconds, 30);
});
