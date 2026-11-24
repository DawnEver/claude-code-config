import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installAgyConfig, inspectAgyConfig, managedAgyHook, hookDefinitionId, hookScriptRef, smokeRunCommand,
  installAgyStatusLine, AGY_DIR, AGY_SETTINGS, HOOK_NAME,
} from './agy-config.mjs';
import { tempDir } from '../shared/temp-dir.mjs';

const REAL_SCRIPTS = fileURLToPath(new URL('..', import.meta.url));
const ok = () => ({ ok: true });

function fixture(t) {
  const root = tempDir('agy-config-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const repoRoot = path.join(root, 'repo');
  const marketDir = path.join(repoRoot, 'cc-market');
  for (const p of ['rem', 'sharp-review', 'evolve', 'fabric', 'watch', 'cc-latex']) fs.mkdirSync(path.join(marketDir, p), { recursive: true });
  fs.mkdirSync(path.join(marketDir, 'cc-latex', '.antigravity-plugin'));
  fs.writeFileSync(path.join(marketDir, 'cc-latex', '.antigravity-plugin', 'plugin.json'), '{"disabled":true}');
  const agyDir = path.join(home, '.gemini', 'config');
  return { root, agyDir, home, repoRoot, marketDir, scriptsDir: path.join(home, '.claude', 'scripts'), smoke: ok };
}

test('merges managed hooks/plugins, cleans legacy session-bridge MCP, and preserves user entries', t => {
  const o = fixture(t);
  fs.mkdirSync(o.agyDir, { recursive: true });
  fs.writeFileSync(path.join(o.agyDir, 'hooks.json'), JSON.stringify({ mine: { Stop: [{ command: 'x' }] } }));
  fs.writeFileSync(path.join(o.agyDir, 'mcp_config.json'), JSON.stringify({
    mcpServers: {
      'user-mcp': { command: 'npx', args: ['some-mcp'] },
      'session-bridge': { command: 'node', args: ['C:/repo/claude_plugins/session-bridge/server.mjs'] },
    },
  }));
  fs.writeFileSync(path.join(o.agyDir, 'plugins.json'), JSON.stringify({ entries: [{ path: '~/own' }, { path: 'C:/old/cc-market' }] }));
  assert.equal(installAgyConfig(o).changed, true);
  const hooks = JSON.parse(fs.readFileSync(path.join(o.agyDir, 'hooks.json'), 'utf8'));
  assert.deepEqual(hooks.mine, { Stop: [{ command: 'x' }] });
  assert.equal(hooks[HOOK_NAME].PreToolUse[0].matcher, '*');
  // The home is expanded, never `~/...`; a `~` inside a Windows 8.3 short name (RUNNER~1) is a real path.
  const expanded = /^node "(?!~)[^"]+\/hooks\/agy-hook\.mjs" --event Stop --definition [a-f0-9]{64}$/;
  assert.match(hooks[HOOK_NAME].Stop[0].command, expanded);
  assert.match(`node "D:/a/RUNNER~1/x/hooks/agy-hook.mjs" --event Stop --definition ${'a'.repeat(64)}`, expanded);
  assert.doesNotMatch(`node "~/.claude/scripts/hooks/agy-hook.mjs" --event Stop --definition ${'a'.repeat(64)}`, expanded, 'planted: an unexpanded home fails');
  const mcp = JSON.parse(fs.readFileSync(path.join(o.agyDir, 'mcp_config.json'), 'utf8'));
  assert.equal(mcp.mcpServers['session-bridge'], undefined, 'legacy managed session-bridge removed per Option A');
  assert.deepEqual(mcp.mcpServers['user-mcp'], { command: 'npx', args: ['some-mcp'] }, 'user MCP server preserved');
  const plugins = JSON.parse(fs.readFileSync(path.join(o.agyDir, 'plugins.json'), 'utf8'));
  assert.equal(plugins.entries.length, 2, 'stale cc-market entry replaced, own kept');
  assert.deepEqual(plugins.entries[0], { path: '~/own' });
  assert.deepEqual(plugins.entries[1].include_only, ['rem', 'sharp-review', 'evolve', 'fabric', 'cc-latex']);
  let probed = 0;
  assert.equal(installAgyConfig({ ...o, smoke: () => { probed++; return { ok: true }; } }).changed, false, 'idempotent');
  assert.equal(probed, 0, 'an unchanged hook spawns no smoke run');
  const state = inspectAgyConfig(o);
  assert.equal(state.installed && state.mcpClean && state.plugins, true);
  assert.equal(state.executed, false);
});

test('a cc-market folder beside the repo is never used unless it is the declared checkout', t => {
  const o = fixture(t);
  installAgyConfig({ ...o, marketDir: null });
  const plugins = JSON.parse(fs.readFileSync(path.join(o.agyDir, 'plugins.json'), 'utf8'));
  assert.deepEqual(plugins.entries ?? [], [], 'undeclared: no plugin entry, though repo/cc-market exists');
  assert.equal(fs.existsSync(path.join(o.repoRoot, 'cc-market')), true, 'planted: the nested folder is there');
  installAgyConfig({ ...o });
  const declared = JSON.parse(fs.readFileSync(path.join(o.agyDir, 'plugins.json'), 'utf8'));
  assert.equal(declared.entries.length, 1, 'control: the declared checkout is listed');
});

test('every managed command is absolute, has no ~, and names an existing script that answers valid JSON', t => {
  const o = fixture(t);
  const hook = managedAgyHook({ scriptsDir: REAL_SCRIPTS });
  assert.equal(hook.PreToolUse[0].hooks[0].timeout, 660);
  for (const groups of Object.values(hook)) for (const g of groups) for (const h of g.hooks ?? [g]) {
    assert.ok(!h.command.includes('~'), h.command);
    const script = /^node "([^"]+)"/.exec(h.command)[1];
    assert.ok(path.isAbsolute(script) && fs.existsSync(script), script);
  }
  fs.mkdirSync(o.agyDir, { recursive: true });
  assert.deepEqual(smokeRunCommand(hook.PreToolUse[0].hooks[0].command, { cwd: o.agyDir, requireDecision: true }), { ok: true });
});

test('a command that fails its smoke run is never installed', t => {
  const o = fixture(t);
  delete o.smoke;
  assert.throws(() => installAgyConfig(o), /smoke run/);
  assert.equal(fs.existsSync(path.join(o.agyDir, 'hooks.json')), false);
});

test('tripwire: tests can never write the live agy home', () => {
  assert.throws(() => installAgyConfig({ agyDir: AGY_DIR, scriptsDir: REAL_SCRIPTS, smoke: ok }), /live ~\/\.gemini\/config/);
  assert.throws(() => installAgyStatusLine({ settingsFile: AGY_SETTINGS, scriptsDir: REAL_SCRIPTS, smoke: ok }), /live agy settings/);
});

test('receipts certify only their own event', t => {
  const o = fixture(t);
  installAgyConfig(o);
  const dir = path.join(o.agyDir, 'harness-hooks');
  fs.mkdirSync(dir);
  for (const e of ['SessionStart', 'PreToolUse', 'Stop'])
    fs.writeFileSync(path.join(dir, `${e}.json`), JSON.stringify({ definition: hookDefinitionId(o, e) }));
  assert.equal(inspectAgyConfig(o).executed, true);
  fs.writeFileSync(path.join(dir, 'Stop.json'), JSON.stringify({ definition: hookDefinitionId(o, 'SessionStart') }));
  assert.equal(inspectAgyConfig(o).executed, false);
});

test('refuses symlinked or malformed files', t => {
  const o = fixture(t);
  fs.mkdirSync(o.agyDir, { recursive: true });
  fs.writeFileSync(path.join(o.agyDir, 'hooks.json'), '[]');
  assert.throws(() => installAgyConfig(o), /invalid object shape/);
  const real = path.join(o.home, 'real.json');
  fs.writeFileSync(real, '{}');
  fs.rmSync(path.join(o.agyDir, 'hooks.json'));
  try { fs.symlinkSync(real, path.join(o.agyDir, 'hooks.json'), 'file'); } catch { return t.skip('no symlink rights'); }
  assert.throws(() => installAgyConfig(o), /user-linked/);
});

test('drift is detected', t => {
  const o = fixture(t);
  installAgyConfig(o);
  const file = path.join(o.agyDir, 'hooks.json');
  const hooks = JSON.parse(fs.readFileSync(file, 'utf8'));
  hooks[HOOK_NAME].Stop[0].timeout = 99;
  fs.writeFileSync(file, JSON.stringify(hooks));
  assert.equal(inspectAgyConfig(o).installed, false);
});

test('script path is quoted with forward slashes', () => {
  assert.equal(hookScriptRef(path.join(path.sep, 'opt', 'x y', 'scripts')).replace(/^"[A-Za-z]:/, '"'), '"/opt/x y/scripts/hooks/agy-hook.mjs"');
});

test('statusLine: sets telemetry: true, preserves user keys, and smoke-checks when present', t => {
  const o = fixture(t);
  const settingsFile = path.join(o.home, '.gemini', 'antigravity-cli', 'settings.json');
  assert.equal(installAgyStatusLine({ settingsFile, scriptsDir: o.scriptsDir }).status, 'written');
  fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark', statusLine: { command: 'mine.sh' } }));
  assert.equal(installAgyStatusLine({ settingsFile, scriptsDir: o.scriptsDir, smoke: ok }).status, 'skipped');
  fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark', statusLine: { command: '' } }));
  fs.mkdirSync(path.join(o.scriptsDir, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(o.scriptsDir, 'hooks', 'agy-statusline.mjs'), '');
  assert.equal(installAgyStatusLine({ settingsFile, scriptsDir: o.scriptsDir, smoke: () => ({ ok: false, why: 'x' }) }).status, 'skipped');
  assert.equal(installAgyStatusLine({ settingsFile, scriptsDir: o.scriptsDir, smoke: ok }).status, 'written');
  const s = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  assert.equal(s.theme, 'dark');
  assert.equal(s.statusLine.type, 'command');
  assert.equal(s.statusLine.enabled, true);
  assert.equal(s.statusLine.telemetry, true);
  assert.equal(s.statusLine.command.includes('"'), false);
  assert.match(s.statusLine.command, /^node (\S+\/hooks\/agy-statusline\.mjs|-e eval\(Buffer\.from\('[A-Za-z0-9+/=]+','base64'\)\.toString\(\)\))$/);
  assert.equal(installAgyStatusLine({ settingsFile, scriptsDir: o.scriptsDir, smoke: ok }).status, 'unchanged');
  fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'node "/old/hooks/agy-statusline.mjs"', enabled: false } }));
  assert.equal(installAgyStatusLine({ settingsFile, scriptsDir: o.scriptsDir, smoke: ok }).status, 'written');
  fs.writeFileSync(settingsFile, JSON.stringify({ theme: 'dark', statusLine: { command: '' } }));
  assert.equal(installAgyStatusLine({ settingsFile, scriptsDir: REAL_SCRIPTS }).status, 'written');
});
