// End-to-end over real localhost TCP: daemon-side ClaudeAdapter <-> plugin DaemonLink, and the
// plugin's MCP surface as Claude Code sees it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';
import { DaemonLink, createChannelServer, isMainSession, ancestorsOf, isClaudeProcess } from './server.mjs';
import { ClaudeAdapter } from '../../scripts/bridge/claude-adapter.mjs';

const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); }
};

async function rig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
  const hub = new ClaudeAdapter();
  const port = await hub.listen(0);
  const runtimeFile = path.join(dir, 'runtime.json');
  fs.writeFileSync(runtimeFile, JSON.stringify({ port, token: hub.token }));
  const out = [];
  let server;
  const link = new DaemonLink({
    runtimeFile, session: { sessionId: 's1', cwd: '/repo' },
    onInbound: (p) => server.inbound(p), onVerdict: (p) => server.verdict(p),
  });
  server = createChannelServer({ write: (m) => out.push(m), link });
  const ups = [];
  hub.on('up', (s) => ups.push(s));
  link.start();
  await until(() => link.ready);
  return { hub, link, server, out, ups, cleanup: async () => { link.stop(); await hub.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

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
  assert.deepEqual(out[1].result.tools.map((t) => t.name), ['reply']);
});

test('register, inbound -> channel notification, reply tool -> hub, permission round trip', async () => {
  const r = await rig();
  try {
    assert.deepEqual(r.ups, [{ id: 's1', cwd: '/repo', preexisting: false, backlog: [] }]);

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
    assert.deepEqual((await call({ token: hub.token, sessionIds: ['u'], kind: 'final', text: 'yes' })).result, { ok: true });
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
  assert.equal(isClaudeProcess(String.raw`"C:\Users\linxu\nodejs\\node_modules\@anthropic-ai\claude-code\bin\claude.exe"    `), true);
  assert.equal(isClaudeProcess('/usr/local/bin/claude --resume x'), true);
  assert.equal(isClaudeProcess('node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js -p hi'), true);
  assert.equal(isClaudeProcess(String.raw`C:\WINDOWS\system32\cmd.exe /d /s /c "C:\Users\linxu\nodejs\claude.CMD"`), false, 'npm shim');
  assert.equal(isClaudeProcess('node  "C:/Users/linxu/.claude/scripts/runtime/cc.js" claude'), false, 'ccc launcher');
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
