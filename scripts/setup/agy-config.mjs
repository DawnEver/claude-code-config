// Antigravity CLI (agy) global config: ~/.gemini/config/{hooks,mcp_config,plugins}.json.
// agy and the user write these files too, so they are MERGED in place, never linked:
// setup owns exactly one named hook (`cc-config`), one MCP server (`session-bridge`) and
// one plugins.json entry (the cc-market checkout); every other key is preserved verbatim.
// A file that is itself a symlink is refused: writing through it would edit someone else's file.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileAtomic } from './codex-config-file.mjs';

export const AGY_DIR = path.join(os.homedir(), '.gemini', 'config');
export const HOOK_NAME = 'cc-config';
export const MCP_NAME = 'session-bridge';
/** Events the managed hook serves. Tool events are grouped (matcher), the rest flat. */
export const AGY_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreInvocation', 'Stop'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
// PreToolUse waits up to 600 s for a Telegram answer, but only in Telegram-started turns.
const timeoutFor = event => event === 'PreToolUse' ? 660 : event === 'SessionStart' ? 30 : event === 'Stop' ? 15 : 10;
/** cc-market plugins agy loads, and the dormant ones loaded only once their manifest ships disabled. */
export const AGY_PLUGINS = { enabled: ['rem', 'sharp-review', 'evolve', 'fabric'], dormant: ['watch', 'cc-latex', 'cc-academia'] };

const slash = p => p.replace(/\\/g, '/');
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** agy is installed when its home (~/.gemini) exists; setup never creates another host's home. */
export const agyInstalled = (agyDir = AGY_DIR) => fs.existsSync(path.dirname(agyDir));

/** The absolute, quoted, forward-slash script path. Never `~`: agy expands it only at the very
 * start of a command, and `node ~/...` then resolved under ~/.gemini/config and failed every tool call. */
export function hookScriptRef(scriptsDir) {
  return `"${slash(path.resolve(scriptsDir, 'hooks', 'agy-hook.mjs'))}"`;
}

const commandFor = (scriptsDir, event, definition) =>
  `node ${hookScriptRef(scriptsDir)} --event ${event} --definition ${definition}`;

/** The id a receipt must carry: binds every handler field except the id itself. */
export function hookDefinitionId({ scriptsDir }, event) {
  return fingerprint({ type: 'command', command: commandFor(scriptsDir, event, '<definition>'), timeout: timeoutFor(event) });
}

export function managedAgyHook({ scriptsDir }) {
  const hook = {};
  for (const event of AGY_EVENTS) {
    const handler = { type: 'command', command: commandFor(scriptsDir, event, hookDefinitionId({ scriptsDir }, event)), timeout: timeoutFor(event) };
    hook[event] = TOOL_EVENTS.has(event) ? [{ matcher: '*', hooks: [handler] }] : [handler];
  }
  return hook;
}

/**
 * Run one managed command exactly as agy would (`cmd /c` / `sh -c`, cwd = the config dir, `{}` on
 * stdin). A hook that fails blocks every tool call in every agy session, so setup installs nothing
 * that does not answer with JSON and exit 0 here.
 */
export function smokeRunCommand(command, { cwd, json = true, run = spawnSync } = {}) {
  const [shell, args, extra] = process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/c', command], { windowsVerbatimArguments: true }] : ['sh', ['-c', command], {}];
  const r = run(shell, args, { cwd, input: '{}', encoding: 'utf8', timeout: 20000, windowsHide: true,
    env: { ...process.env, CC_CONFIG_AGY_SMOKE: '1' }, ...extra });
  if (r.error || r.status !== 0) return { ok: false, why: r.error?.message || String(r.stderr || '').trim().split('\n').pop() || `exit ${r.status}` };
  if (!json) return { ok: true };
  try { JSON.parse(r.stdout || ''); return { ok: true }; } catch { return { ok: false, why: `non-JSON output: ${String(r.stdout).slice(0, 80)}` }; }
}

export function managedMcpServer({ repoRoot }) {
  return { command: 'node', args: [slash(path.join(repoRoot, 'claude_plugins', 'session-bridge', 'server.mjs'))], env: {} };
}

const manifestDisabled = dir => {
  for (const rel of ['.antigravity-plugin/plugin.json', 'plugin.json']) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')).disabled === true; } catch { /* next */ }
  }
  return false;
};

/** The cc-market entry: dormant plugins are listed only when their manifest ships `disabled: true`. */
export function managedPluginEntry({ marketDir }) {
  const present = name => fs.existsSync(path.join(marketDir, name));
  const include = [...AGY_PLUGINS.enabled.filter(present),
    ...AGY_PLUGINS.dormant.filter(n => present(n) && manifestDisabled(path.join(marketDir, n)))];
  return { path: slash(marketDir), include_only: include };
}

function readObject(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new Error(`${path.basename(file)} is user-linked; refusing to write through it`);
  const before = stat ? fs.readFileSync(file, 'utf8') : null;
  const value = before?.trim() ? JSON.parse(before) : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path.basename(file)} has an invalid object shape`);
  return { before, value };
}

function writeMerged(dir, name, merge) {
  const file = path.join(dir, name);
  const { before, value } = readObject(file);
  const next = JSON.stringify(merge(value), null, 2) + '\n';
  const changed = next !== before;
  if (changed) { fs.mkdirSync(dir, { recursive: true }); writeFileAtomic(file, next); }
  return { file, changed };
}

const samePath = (a, b) => typeof a === 'string' &&
  (process.platform === 'win32' ? slash(a).toLowerCase() === slash(b).toLowerCase() : slash(a) === slash(b));

/**
 * Merge the managed hook, MCP server and plugin entry. `marketDir` absent -> no plugin entry
 * (a stale one is removed); `bridge: false` -> the MCP server is left alone.
 */
export function installAgyConfig({ agyDir = AGY_DIR, scriptsDir, repoRoot, marketDir = repoRoot && path.join(repoRoot, 'cc-market'), bridge = true, smoke } = {}) {
  // Tripwire: under `node --test` (inherited by spawned children) the live agy home is off limits.
  // A test that reached it once installed a broken hook that blocked every tool call in every session.
  if (process.env.NODE_TEST_CONTEXT && path.resolve(agyDir) === path.resolve(AGY_DIR))
    throw new Error('refusing to write the live ~/.gemini/config from a test: give the test a temp HOME / agyDir');
  // Nothing is written unless the hook command really runs: a failing hook blocks every tool call.
  // Probed only when the managed hook would change, so the per-session re-merge spawns nothing.
  const hook = managedAgyHook({ scriptsDir });
  if (JSON.stringify(readObject(path.join(agyDir, 'hooks.json')).value[HOOK_NAME]) !== JSON.stringify(hook)) {
    fs.mkdirSync(agyDir, { recursive: true });
    const probe = (smoke ?? smokeRunCommand)(hook.PreToolUse[0].hooks[0].command, { cwd: agyDir });
    if (!probe.ok) throw new Error(`agy hook command failed its smoke run (${probe.why}); hooks.json left unchanged`);
  }
  const results = {};
  results.hooks = writeMerged(agyDir, 'hooks.json', config => ({ ...config, [HOOK_NAME]: managedAgyHook({ scriptsDir }) }));
  if (bridge && repoRoot) {
    results.mcp = writeMerged(agyDir, 'mcp_config.json', config => {
      if (config.mcpServers !== undefined && (typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)))
        throw new Error('mcp_config.json mcpServers must be an object');
      return { ...config, mcpServers: { ...config.mcpServers, [MCP_NAME]: managedMcpServer({ repoRoot }) } };
    });
  }
  results.plugins = writeMerged(agyDir, 'plugins.json', config => {
    if (config.entries !== undefined && !Array.isArray(config.entries)) throw new Error('plugins.json entries must be an array');
    // Ours is the entry naming a cc-market checkout; a moved checkout replaces it, never duplicates it.
    const others = (config.entries ?? []).filter(e => !(typeof e?.path === 'string' && /(^|\/)cc-market\/?$/.test(slash(e.path))));
    const usable = marketDir && fs.existsSync(marketDir);
    return { ...config, entries: usable ? [...others, managedPluginEntry({ marketDir })] : others };
  });
  return { changed: Object.values(results).some(r => r.changed), results };
}

const readJson = file => { try { const t = fs.readFileSync(file, 'utf8'); return t.trim() ? JSON.parse(t) : {}; } catch { return null; } };

/** What doctor reports: managed parts present and current, and which hook events have run this definition. */
export function inspectAgyConfig({ agyDir = AGY_DIR, scriptsDir, repoRoot, marketDir = repoRoot && path.join(repoRoot, 'cc-market'), bridge = true } = {}) {
  const hooks = readJson(path.join(agyDir, 'hooks.json'));
  const installed = !!hooks && JSON.stringify(hooks[HOOK_NAME]) === JSON.stringify(managedAgyHook({ scriptsDir }));
  const mcp = readJson(path.join(agyDir, 'mcp_config.json'));
  const mcpOk = !bridge || !repoRoot || samePath(mcp?.mcpServers?.[MCP_NAME]?.args?.[0], managedMcpServer({ repoRoot }).args[0]);
  const plugins = readJson(path.join(agyDir, 'plugins.json'));
  const pluginsOk = !marketDir || !fs.existsSync(marketDir) ||
    (plugins?.entries ?? []).some(e => JSON.stringify(e) === JSON.stringify(managedPluginEntry({ marketDir })));
  const events = {};
  for (const event of AGY_EVENTS) {
    const receipt = readJson(path.join(agyDir, 'harness-hooks', `${event}.json`));
    events[event] = { executed: installed && receipt?.definition === hookDefinitionId({ scriptsDir }, event), at: receipt?.at ?? null };
  }
  return { installed, mcp: mcpOk, plugins: pluginsOk, events,
    executed: installed && ['SessionStart', 'PreToolUse', 'Stop'].every(e => events[e].executed) };
}

/** agy's own settings (statusLine lives there, not under ~/.gemini/config). */
export const AGY_SETTINGS = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
const STATUSLINE_SCRIPT = 'agy-statusline.mjs';

export function managedStatusLine({ scriptsDir }) {
  return { type: 'command', command: `node "${slash(path.resolve(scriptsDir, 'hooks', STATUSLINE_SCRIPT))}"`, enabled: true };
}

/**
 * Merge our statusLine into agy's settings.json, only when it is unset or already ours.
 * When the script exists on disk, smoke-run it first; when absent (`pr/agy-bridge` adds it),
 * merge the command directly (agy ignores a missing statusLine gracefully until it lands).
 * Returns { status: 'written'|'unchanged'|'skipped', why? }.
 */
export function installAgyStatusLine({ settingsFile = AGY_SETTINGS, scriptsDir, smoke } = {}) {
  if (process.env.NODE_TEST_CONTEXT && path.resolve(settingsFile) === path.resolve(AGY_SETTINGS))
    throw new Error('refusing to write the live agy settings.json from a test: give the test a temp HOME');
  const { before, value } = readObject(settingsFile);
  const current = value.statusLine?.command;
  if (current && !String(current).includes(STATUSLINE_SCRIPT)) return { status: 'skipped', why: 'statusLine is the user\'s own' };
  const line = managedStatusLine({ scriptsDir });
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  if (smoke || fs.existsSync(path.join(scriptsDir, 'hooks', STATUSLINE_SCRIPT))) {
    const probe = (smoke ?? smokeRunCommand)(line.command, { cwd: path.dirname(settingsFile), json: false });
    if (!probe.ok) return { status: 'skipped', why: `smoke run failed: ${probe.why}` };
  }
  const next = JSON.stringify({ ...value, statusLine: line }, null, 2) + '\n';
  if (next === before) return { status: 'unchanged' };
  writeFileAtomic(settingsFile, next);
  return { status: 'written' };
}
