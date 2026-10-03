// End-to-end over real localhost TCP: daemon-side ClaudeAdapter <-> plugin DaemonLink, and the
// plugin's MCP surface as Claude Code sees it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import net from 'net';
import http from 'http';
import path from 'path';
import { DaemonLink, createChannelServer, isMainSession, ancestorsOf, isClaudeProcess, sessionIdentity, pruneChannelLogs } from './server.mjs';
import { ClaudeAdapter } from '../../scripts/bridge/claude-adapter.mjs';
import { Bridge } from '../../scripts/bridge/daemon.mjs';
import { TelegramClient } from '../../scripts/bridge/telegram.mjs';

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); }
};

test('channel only emits one verdict for a valid forwarded request, and invalidates on disconnect', async () => {
  const out = [];
  const sent = [];
  const server = createChannelServer({ write: (m) => out.push(m), link: { request: async (...p) => sent.push(p) } });
  server.verdict({ request_id: 'missing', behavior: 'allow' });
  await server.onMessage({ method: 'notifications/claude/channel/permission_request', params: { request_id: '', tool_name: 'Bash' } });
  assert.equal(sent.length, 0);
  await server.onMessage({ method: 'notifications/claude/channel/permission_request', params: { request_id: 'p', tool_name: 'Bash' } });
  server.verdict({ request_id: 'p', behavior: 'invalid' });
  assert.equal(out.length, 0);
  server.verdict({ request_id: 'p', behavior: 'allow' });
  server.verdict({ request_id: 'p', behavior: 'deny' });
  assert.equal(out.length, 1);
  await server.onMessage({ method: 'notifications/claude/channel/permission_request', params: { request_id: 'q', tool_name: 'Bash' } });
  server.disconnected();
  server.verdict({ request_id: 'q', behavior: 'allow' });
  assert.equal(out.length, 1);
});

async function rig(configureHub = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
  const hub = new ClaudeAdapter();
  const port = await hub.listen(0);
  configureHub(hub);
  const runtimeFile = path.join(dir, 'runtime.json');
  fs.writeFileSync(runtimeFile, JSON.stringify({ port, token: hub.token }));
  const out = [];
  let server;
  const link = new DaemonLink({
    runtimeFile, session: { sessionId: 's1', cwd: '/repo' },
    onInbound: (p) => server.inbound(p), onVerdict: (p) => server.verdict(p),
    onDisconnect: () => server.disconnected(),
  });
  server = createChannelServer({ write: (m) => out.push(m), link });
  const ups = [];
  hub.on('up', (s) => ups.push(s));
  const cleanup = async () => { link.stop(); await hub.close(); fs.rmSync(dir, { recursive: true, force: true }); };
  try {
    link.start();
    await until(() => link.ready);
    return { hub, link, server, out, ups, cleanup };
  } catch (e) { await cleanup(); throw e; }
}

test('real HTTP/TCP approval path binds final chunk, authenticates origin and submits once', async () => {
  const posts = [];
  let messageId = 10;
  const api = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      const method = req.url.split('/').at(-1);
      const p = JSON.parse(data);
      let result = true;
      if (method === 'createForumTopic') result = { message_thread_id: 77 };
      if (method === 'sendMessage') {
        result = { message_id: messageId++ };
        posts.push({ ...p, ...result });
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  let bridge, r;
  try {
    const telegram = new TelegramClient({ token: 'fixture', apiBase: `http://127.0.0.1:${api.address().port}` });
    r = await rig((hub) => {
      bridge = new Bridge({ telegram, adapters: [hub], machine: 'fixture',
        config: { projects: {}, fallbackChatId: -100, allowedUserIds: [42], approvalsFromTelegram: true },
        resolveContext: () => ({ project: 'fixture', branch: 'main' }),
      });
    });
    await r.server.onMessage({ method: 'notifications/claude/channel/permission_request',
      params: { request_id: 'native-request', tool_name: 'Write', description: 'x'.repeat(5000) } });
    const isApproval = p => p.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data?.startsWith('ap:');
    await until(() => posts.some(isApproval));
    const post = posts.find(isApproval);
    assert.ok(posts.filter((p) => p.text.includes('xxx')).length >= 2, 'actual client chunks permission details');
    assert.equal(posts.filter((p) => p.text.includes('xxx')).at(-1), post, 'buttons belong to the final approval chunk');
    const callback = (user = 42, chat = -100) => ({ callback_query: {
      id: 'fixture-callback', data: post.reply_markup.inline_keyboard[0][0].callback_data,
      from: { id: user }, message: { chat: { id: chat }, message_id: post.message_id,
        message_thread_id: post.message_thread_id, text: post.text },
    } });
    await bridge.handleUpdate(callback(666));
    await bridge.handleUpdate(callback(42, -200));
    for (const field of ['message_id', 'message_thread_id']) {
      const wrong = callback(); wrong.callback_query.message[field] = 999;
      await bridge.handleUpdate(wrong);
    }
    assert.equal(r.out.length, 0);
    await bridge.handleUpdate(callback());
    await until(() => r.out.length === 1);
    assert.deepEqual(r.out[0], { jsonrpc: '2.0', method: 'notifications/claude/channel/permission',
      params: { request_id: 'native-request', behavior: 'allow' } });
    await bridge.handleUpdate(callback());
    assert.equal(r.out.length, 1);
    r.link.stop();
    await until(() => !bridge.sessions.has('claude:s1'));
    assert.equal(bridge.approvals.size, 0);
  } finally {
    if (r) await r.cleanup();
    await new Promise((resolve) => api.close(resolve));
  }
});

test('initialize declares channel + permission capabilities and instructions', async () => {
  const out = [];
  const s = createChannelServer({ write: (m) => out.push(m), link: {} });
  await s.onMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const r = out[0].result;
  assert.deepEqual(r.capabilities.experimental, { 'claude/channel': {}, 'claude/channel/permission': {} });
  assert.deepEqual(r.capabilities.tools, {});
  assert.match(r.instructions, /reply tool/);
  assert.match(r.instructions, /mirrored automatically/);
  await s.onMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(out[1].result.tools.map((t) => t.name), ['reply', 'send_attachment']);
});

test('send_attachment forwards only explicit file arguments and reports delivery failures', async () => {
  const out = [], calls = [];
  let error;
  const server = createChannelServer({ write: (m) => out.push(m), link: { request: async (...args) => {
    calls.push(args);
    if (error) throw new Error(error);
  } } });
  const call = (arguments_) => server.onMessage({ id: out.length + 1, method: 'tools/call',
    params: { name: 'send_attachment', arguments: arguments_ } });
  await call({ path: '/repo/report.pdf', kind: 'document', caption: 'Report', chat_id: 123 });
  assert.deepEqual(calls, [['attachment', { path: '/repo/report.pdf', kind: 'document', caption: 'Report' }]]);
  assert.equal(out.at(-1).result.content[0].text, 'sent');
  await call({ path: '/repo/image.png' });
  assert.deepEqual(calls.at(-1), ['attachment', { path: '/repo/image.png', kind: 'document', caption: '' }]);
  for (const args of [{ path: 'relative.txt' }, { path: '' }, { path: '/repo/a', kind: 'invalid' },
    { path: '/repo/a', caption: 4 }]) {
    const count = calls.length;
    await call(args);
    assert.equal(calls.length, count);
    assert.equal(out.at(-1).result.isError, true);
  }
  error = 'upload outcome uncertain';
  await call({ path: '/repo/image.png', kind: 'photo' });
  assert.equal(out.at(-1).result.isError, true);
  assert.match(out.at(-1).result.content[0].text, /Delivery unconfirmed; check the Telegram Topic before retrying/);
});

test('register, inbound -> channel notification, reply tool -> hub, permission round trip', async () => {
  const r = await rig();
  try {
    assert.deepEqual(r.ups, [{ id: 's1', cwd: '/repo', backlog: [] }]);

    await r.hub.inject('s1', 'run the tests', 'alice');
    await until(() => r.out.length);
    assert.deepEqual(r.out.shift(), { jsonrpc: '2.0', method: 'notifications/claude/channel', params: { content: 'run the tests', meta: { user: 'alice' } } });

    const replies = [];
    r.hub.on('final', (x) => replies.push(x));
    await r.server.onMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'reply', arguments: { text: 'done' } } });
    assert.deepEqual(replies, [{ id: 's1', text: 'done' }]);
    assert.equal(r.out.shift().result.content[0].text, 'sent');

    const perms = [];
    r.hub.on('approval', (p) => perms.push(p));
    await r.server.onMessage({ jsonrpc: '2.0', method: 'notifications/claude/channel/permission_request',
      params: { request_id: 'abcde', tool_name: 'Bash', description: 'list', input_preview: '{"command":"ls"}' } });
    await until(() => perms.length);
    assert.deepEqual([perms[0].id, perms[0].ref, perms[0].answerable], ['s1', 'abcde', true]);
    assert.equal(r.hub.answerApproval('abcde', true, 's1'), true);
    await until(() => r.out.length);
    assert.deepEqual(r.out.shift(), { jsonrpc: '2.0', method: 'notifications/claude/channel/permission', params: { request_id: 'abcde', behavior: 'allow' } });
  } finally { await r.cleanup(); }
});

test('session-down fires when the channel goes away', async () => {
  const r = await rig();
  const downs = [];
  r.hub.on('down', (d) => downs.push(d.id));
  r.link.stop();
  await until(() => downs.length);
  assert.deepEqual(downs, ['s1']);
  await r.cleanup();
});

test('wrong token is rejected and never registers', async () => {
  const hub = new ClaudeAdapter();
  const port = await hub.listen(0);
  const ups = [];
  hub.on('up', (s) => ups.push(s));
  const sock = net.connect({ host: '127.0.0.1', port });
  sock.resume();   // read to EOF so 'close' can fire
  await new Promise((r) => sock.once('connect', r));
  sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'register', params: { token: 'x'.repeat(48), sessionId: 'evil' } }) + '\n');
  await new Promise((r) => sock.once('close', r));
  assert.deepEqual(ups, []);
  await hub.close();
});

test('reply tool reports, not throws, when the daemon is down', async () => {
  const out = [];
  const link = new DaemonLink({ runtimeFile: path.join(os.tmpdir(), 'nope-runtime.json'), session: { sessionId: 'x' } });
  const s = createChannelServer({ write: (m) => out.push(m), link });
  await s.onMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'reply', arguments: { text: 'hi' } } });
  assert.equal(out[0].result.isError, true);
  assert.match(out[0].result.content[0].text, /not running/);
});

test('a runtime file with a bad port is retried, never thrown out of net.connect', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
  const runtimeFile = path.join(dir, 'runtime.json');
  fs.writeFileSync(runtimeFile, JSON.stringify({ port: 'oops', token: 't' }));
  const link = new DaemonLink({ runtimeFile, session: { sessionId: 'x' } });
  try {
    assert.doesNotThrow(() => link.start());
    assert.equal(link.socket, null);
  } finally { link.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the adapter binds loopback only', async () => {
  const hub = new ClaudeAdapter();
  await hub.listen(0);
  assert.equal(hub.server.address().address, '127.0.0.1');
  await hub.close();
});

test('a one-shot mirror call needs the token and a known kind', async () => {
  const hub = new ClaudeAdapter();
  const port = await hub.listen(0);
  const call = (params) => new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let buf = '';
    sock.on('data', (d) => { buf += d; if (buf.includes('\n')) { sock.destroy(); resolve(JSON.parse(buf)); } });
    sock.on('close', () => resolve(buf ? JSON.parse(buf) : null));
    sock.on('connect', () => sock.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'mirror', params }) + '\n'));
  });
  try {
    assert.equal((await call({ token: 'x'.repeat(hub.token.length), sessionIds: ['u'], kind: 'final', text: 'no' }))?.error?.code, 401);
    assert.deepEqual((await call({ token: hub.token, sessionIds: ['u'], kind: 'final', text: 'yes' })).result, { ok: true, routed: false });
    assert.ok((await call({ token: hub.token, sessionIds: ['u'], kind: 'other', text: 'x' })).error, 'unknown kind rejected');
  } finally { await hub.close(); }
});

test('isMainSession: a channel whose claude was started from inside another claude is nested', () => {
  const claude = { pid: 10, cmd: String.raw`C:\Users\u\.local\bin\claude.exe --dangerously-load-development-channels server:session-bridge` };
  const shell = { pid: 9, cmd: String.raw`C:\Program Files\Git\bin\bash.exe -c ccc -p hi` };
  const launcher = { pid: 8, cmd: String.raw`node C:\Users\u\.claude\scripts\runtime\cc.js` };
  const outer = { pid: 7, cmd: '/usr/local/bin/claude' };
  const term = { pid: 6, cmd: 'WindowsTerminal.exe' };
  // top level: no inherited CLAUDE_PID, no claude above our own
  assert.equal(isMainSession({ ppid: 10, claudePid: null, ancestors: [claude, launcher, term] }), true);
  assert.equal(isMainSession({ ppid: 10, claudePid: '10', ancestors: [claude, launcher, term] }), true, 'CLAUDE_PID naming our own parent');
  // nested: inherited CLAUDE_PID of an outer session
  assert.equal(isMainSession({ ppid: 10, claudePid: '7', ancestors: [] }), false);
  // nested without CLAUDE_PID (spawned by a plugin's MCP server): a claude further up
  assert.equal(isMainSession({ ppid: 10, claudePid: null, ancestors: [claude, shell, launcher, outer] }), false);
  assert.equal(isMainSession({ ppid: 10, claudePid: null, ancestors: [claude, { pid: 5, cmd: 'node /x/node_modules/@anthropic-ai/claude-code/cli.js' }] }), false);
  assert.equal(isMainSession({ ppid: 10, claudePid: null, ancestors: [claude, { pid: 5, cmd: String.raw`node C:\Users\u\.claude\scripts\hooks\x.js` }] }), true, '.claude paths are not claude');
});

test('isClaudeProcess judges the program, not its arguments (real Windows shapes)', () => {
  assert.equal(isClaudeProcess(String.raw`"C:\Users\user\nodejs\\node_modules\@anthropic-ai\claude-code\bin\claude.exe"    `), true);
  assert.equal(isClaudeProcess('/usr/local/bin/claude --resume x'), true);
  assert.equal(isClaudeProcess('node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js -p hi'), true);
  assert.equal(isClaudeProcess(String.raw`C:\WINDOWS\system32\cmd.exe /d /s /c "C:\Users\user\nodejs\claude.CMD"`), false, 'npm shim');
  assert.equal(isClaudeProcess('node  "C:/Users/user/.claude/scripts/runtime/cc.js" claude'), false, 'ccc launcher');
  assert.equal(isClaudeProcess(String.raw`"C:\Program Files\Git\bin\bash.exe" -c "claude -p x"`), false);
});

test('a top-level ccc session (launcher, shim, claude) is main; one started from a session shell is not', () => {
  const own = { pid: 4, cmd: String.raw`"C:\n\node_modules\@anthropic-ai\claude-code\bin\claude.exe"` };
  const shim = { pid: 3, cmd: String.raw`C:\WINDOWS\system32\cmd.exe /d /s /c "C:\n\claude.CMD"` };
  const cc = { pid: 2, cmd: 'node  "C:/u/.claude/scripts/runtime/cc.js" claude' };
  const term = { pid: 1, cmd: 'cmd.exe' };
  assert.equal(isMainSession({ ppid: 4, claudePid: undefined, ancestors: [own, shim, cc, term] }), true);
  const outer = { pid: 0, cmd: String.raw`"C:\n\node_modules\@anthropic-ai\claude-code\bin\claude.exe"` };
  assert.equal(isMainSession({ ppid: 4, claudePid: undefined, ancestors: [own, shim, cc, { pid: 9, cmd: 'bash.exe' }, outer] }), false);
});

test('ancestorsOf walks a process table upward from a pid', () => {
  const table = new Map([[10, { ppid: 9, cmd: 'claude' }], [9, { ppid: 8, cmd: 'bash' }], [8, { ppid: 8, cmd: 'init' }]]);
  assert.deepEqual(ancestorsOf(10, table).map((a) => a.pid), [10, 9, 8]);
  assert.deepEqual(ancestorsOf(99, table), []);
});

test('sessionIdentity: CLAUDE_CODE_SESSION_ID, else a fallback whose inputs are spelled out for the log', () => {
  assert.deepEqual(sessionIdentity({ CLAUDE_CODE_SESSION_ID: 'u-1' }, { hostname: 'h', pid: 7, rand: 'ab' }),
    { sessionId: 'u-1', source: 'CLAUDE_CODE_SESSION_ID' });
  assert.deepEqual(sessionIdentity({}, { hostname: 'h', pid: 7, rand: 'ab' }),
    { sessionId: 'h-7-ab', source: 'fallback (CLAUDE_CODE_SESSION_ID unset; hostname=h pid=7 random=ab)' });
});

test('pruneChannelLogs: drops channel logs older than the cutoff, keeps fresh ones and others', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-logs-'));
  const now = Date.now();
  const make = (name, ageDays) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, 'x');
    const t = new Date(now - ageDays * 86400e3);
    fs.utimesSync(f, t, t);
  };
  make('channel-1.log', 8); make('channel-2.log', 1); make('daemon.log', 30);
  pruneChannelLogs(dir, { now, maxAgeDays: 7 });
  assert.deepEqual(fs.readdirSync(dir).sort(), ['channel-2.log', 'daemon.log']);
});
