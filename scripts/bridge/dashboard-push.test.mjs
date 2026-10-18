import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DashboardPush } from './dashboard-push.mjs';
import { readBridgeConfig } from './context.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

test('push: authenticated, ordered, never overlapping, failures logged once and never thrown', async () => {
  const calls = [], logs = [];
  const ok = () => ({ ok: true, status: 200, json: async () => ({ accepted: true }) });
  let respond = ok;
  const push = new DashboardPush({ url: 'https://gw.example', hostToken: 'tok', machine: 'host-a', log: (m) => logs.push(m),
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

test('config: dashboard needs url + hostToken, https unless loopback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
  const read = (shared, local = {}) => {
    fs.writeFileSync(path.join(dir, 's.json'), JSON.stringify({ bridge: shared }));
    fs.writeFileSync(path.join(dir, 'l.json'), JSON.stringify({ bridge: local }));
    const c = readBridgeConfig({ sharedPath: path.join(dir, 's.json'), localPath: path.join(dir, 'l.json') });
    return c.dashboard ?? c.dashboardError;
  };
  const local = { dashboard: { hostToken: 't' } };
  assert.equal(read({}), null, 'not configured: off, nothing to report');
  assert.match(read({ dashboard: { url: 'https://gw.example/' } }), /hostToken/);
  assert.match(read({ dashboard: { url: 'https://gw.example/', hostToken: 't' } }), /hostToken/, 'token in the synced layer is ignored');
  assert.deepEqual(read({ dashboard: { url: 'https://gw.example/' } }, local), { url: 'https://gw.example', hostToken: 't', everySeconds: 15 });
  assert.match(read({ dashboard: { url: 'https://gw.example/dashboard/' } }, local), /origin/, 'a subpath the gateway cannot serve');
  assert.match(read({ dashboard: { url: 'http://gw.example' } }, local), /https/, 'plain http off loopback');
  assert.match(read({ dashboard: { url: 'https://gw.example', everySeconds: 1e9 } }, local), /5\.\.3600/);
  assert.equal(read({ dashboard: { url: 'http://127.0.0.1:8787', everySeconds: 30 } }, local).everySeconds, 30);
});

test('push: alerts from the gateway go to onAlerts; a failing post never fails the push', async () => {
  const posted = [], logs = [];
  let throwOnPost = false;
  const push = new DashboardPush({ url: 'https://gw.example', hostToken: 'tok', machine: 'host-a', log: (m) => logs.push(m), sessions: () => [],
    onAlerts: async (texts) => { if (throwOnPost) throw new Error('telegram down'); posted.push(...texts); },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ accepted: true, alerts: ['a', 7, 'b'] }) }) });
  assert.equal(await push.tick(), true);
  await new Promise((done) => setTimeout(done, 5));
  assert.deepEqual(posted, ['a', 'b'], 'only strings');
  throwOnPost = true;
  assert.equal(await push.tick(), true);
  await new Promise((done) => setTimeout(done, 5));
  assert.match(logs.at(-1), /alert not posted \(telegram down\)/);
});

test('config summary: editable values and facts only — no token, no user id, no chat id', async () => {
  const { configSummary } = await import('./context.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-sum-'));
  try {
    const localPath = path.join(dir, 'l.json');
    fs.writeFileSync(localPath, JSON.stringify({ bridge: { idleCloseMinutes: 5 } }));
    const config = { botToken: '123456:SECRET-token-SECRET-token-SECRET', allowedUserIds: [424242], approvalsFromTelegram: false,
      idleCloseMinutes: 5, deleteClosedAfterHours: 24, codexSources: ['cli'], alerts: { chatId: -1001234567890, topicId: null },
      dashboard: { url: 'https://dashboard.example.com', hostToken: 'host-secret-value', everySeconds: 15 }, dashboardError: null,
      projects: { repo: { chatId: -1001234567890, projectInTitle: 'always' } } };
    const s = configSummary(config, { localPath });
    assert.deepEqual(s.editable, { 'bridge.idleCloseMinutes': 5, 'bridge.deleteClosedAfterHours': 24, 'bridge.dashboard.everySeconds': 15, 'bridge.projects.repo.projectInTitle': 'always' });
    assert.deepEqual(s.localOverrides, ['bridge.idleCloseMinutes'], 'a shared edit would not reach this host');
    assert.deepEqual(s.facts, { bridge: true, allowedUsers: 1, approvalsFromTelegram: false, alerts: true, codexSources: ['cli'], dashboardError: null });
    assert.doesNotMatch(JSON.stringify(s), /SECRET|424242|1234567890|host-secret|dashboard\.example/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('applyConfigChange: validated again on the host, written in place, nothing else touched', async () => {
  const { applyConfigChange } = await import('./context.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-apply-'));
  try {
    const sharedPath = path.join(dir, 's.json');
    const before = { providers: { a: 1 }, bridge: { idleCloseMinutes: 30, allowedUserIds: [1], projects: { repo: { chatId: -1 } } } };
    fs.writeFileSync(sharedPath, JSON.stringify(before));
    assert.deepEqual(applyConfigChange({ key: 'bridge.idleCloseMinutes', value: 45 }, { sharedPath }), { ok: true });
    assert.deepEqual(applyConfigChange({ key: 'bridge.projects.repo.projectInTitle', value: 'main' }, { sharedPath }), { ok: true });
    assert.equal(applyConfigChange({ key: 'bridge.projects.nope.projectInTitle', value: 'main' }, { sharedPath }).ok, false, 'no new project from a remote edit');
    assert.equal(applyConfigChange({ key: 'bridge.allowedUserIds', value: [666] }, { sharedPath }).ok, false);
    assert.equal(applyConfigChange({ key: 'bridge.idleCloseMinutes', value: 99999 }, { sharedPath }).ok, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(sharedPath, 'utf8')),
      { providers: { a: 1 }, bridge: { idleCloseMinutes: 45, allowedUserIds: [1], projects: { repo: { chatId: -1, projectInTitle: 'main' } } } });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('push: config changes from the reply are applied and reported on the next push; a failed push keeps the report', async () => {
  const bodies = [];
  let reply = { accepted: true, configChanges: [{ id: 'a'.repeat(24), key: 'bridge.idleCloseMinutes', value: 45 }] };
  let fail = false;
  const push = new DashboardPush({ url: 'https://gw.example', hostToken: 'tok', machine: 'host-a', sessions: () => [], config: () => ({ editable: {} }),
    onConfigChanges: (changes) => changes.map((c) => ({ id: c.id, ok: true })),
    fetch: async (url, init) => { bodies.push(JSON.parse(init.body)); if (fail) throw new Error('down'); return { ok: true, status: 200, json: async () => reply }; } });
  await push.tick();
  assert.deepEqual(bodies[0].configResults, []);
  reply = { accepted: true };
  fail = true;
  await push.tick();
  fail = false;
  await push.tick();
  assert.deepEqual(bodies[2].configResults, [{ id: 'a'.repeat(24), ok: true }], 'kept through a failed push');
  await push.tick();
  assert.deepEqual(bodies[3].configResults, [], 'reported once');
  assert.deepEqual(bodies[0].config, { editable: {} });
});
