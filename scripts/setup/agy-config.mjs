// Antigravity CLI (agy) global config: ~/.gemini/config/{hooks,plugins}.json (+ mcp_config.json cleanup).
// agy and the user write these files too, so they are MERGED in place, never linked:
// setup owns one named hook (`cc-config`) and one plugins.json entry (the cc-market checkout);
// every other key is preserved verbatim. Like Codex, agy has no channel protocol so setup
// registers no `session-bridge` MCP server (and removes any stale managed one); attachments go
// through `scripts/bridge/send-attachment.mjs`. A file that is itself a symlink is refused.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writeFileAtomic } from './codex-config-file.mjs';
import { readMarketDir } from '../shared/market-dir.mjs';

export const AGY_DIR = path.join(os.homedir(), '.gemini', 'config');
export const HOOK_NAME = 'cc-config';
const LEGACY_MCP_NAME = 'session-bridge';
/** Events the managed hook serves. Tool events are grouped (matcher), the rest flat. */
export const AGY_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PreInvocation', 'Stop'];
const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse']);
// PreToolUse waits up to 600 s for a Telegram answer, but only in Telegram-started turns.
const timeoutFor = event => event === 'PreToolUse' ? 660 : event === 'SessionStart' ? 30 : event === 'Stop' ? 15 : 10;
/** cc-market plugins agy loads, and the dormant ones loaded only once their manifest ships disabled. */
export const AGY_PLUGINS = { enabled: [], dormant: ['cc-academia'] };

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
export function smokeRunCommand(command, { cwd, json = true, requireDecision = false, verbatim = true, run = spawnSync } = {}) {
  const [shell, args, extra] = process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/c', command], verbatim ? { windowsVerbatimArguments: true } : {}] : ['sh', ['-c', command], {}];
  const r = run(shell, args, { cwd, input: '{}', encoding: 'utf8', timeout: 20000, windowsHide: true,
    env: { ...process.env, CC_CONFIG_AGY_SMOKE: '1' }, ...extra });
  if (r.error || r.status !== 0) return { ok: false, why: r.error?.message || String(r.stderr || '').trim().split('\n').pop() || `exit ${r.status}` };
  if (!json) return { ok: true };
  let parsed;
  try { parsed = JSON.parse(r.stdout || ''); } catch { return { ok: false, why: `non-JSON output: ${String(r.stdout).slice(0, 80)}` }; }
  if (requireDecision && (!parsed || typeof parsed.decision !== 'string' || !parsed.decision))
    return { ok: false, why: 'PreToolUse hook returned empty decision (agy treats {} as deny)' };
  return { ok: true };
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

const isLegacyBridgeMcp = (entry) =>
  typeof entry?.args?.[0] === 'string' && /claude_plugins\/session-bridge\/server\.mjs$/i.test(slash(entry.args[0]));

function stripLegacyBridgeMcp(agyDir) {
  const file = path.join(agyDir, 'mcp_config.json');
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) return { file, changed: false };
  const { before, value } = readObject(file);
  if (!isLegacyBridgeMcp(value.mcpServers?.[LEGACY_MCP_NAME])) return { file, changed: false };
  const { [LEGACY_MCP_NAME]: _removed, ...rest } = value.mcpServers;
  const nextObj = Object.keys(rest).length ? { ...value, mcpServers: rest } : (() => {
    const { mcpServers: _empty, ...top } = value;
    return Object.keys(top).length ? top : { mcpServers: {} };
  })();
  const next = JSON.stringify(nextObj, null, 2) + '\n';
  if (next === before) return { file, changed: false };
  writeFileAtomic(file, next);
  return { file, changed: true };
}

/**
 * Merge the managed hook and plugin entry, and clean up any stale managed session-bridge MCP entry.
 * `marketDir` defaults to the machine's declared cc-market checkout (shared/market-dir.mjs); undeclared ->
 * no plugin entry (a stale one is removed). A cc-market folder beside this repo is never guessed.
 */
export function installAgyConfig({ agyDir = AGY_DIR, scriptsDir, marketDir = readMarketDir().dir, smoke } = {}) {
  if (process.env.NODE_TEST_CONTEXT && path.resolve(agyDir) === path.resolve(AGY_DIR))
    throw new Error('refusing to write the live ~/.gemini/config from a test: give the test a temp HOME / agyDir');
  const hook = managedAgyHook({ scriptsDir });
  if (JSON.stringify(readObject(path.join(agyDir, 'hooks.json')).value[HOOK_NAME]) !== JSON.stringify(hook)) {
    fs.mkdirSync(agyDir, { recursive: true });
    const probe = (smoke ?? smokeRunCommand)(hook.PreToolUse[0].hooks[0].command, { cwd: agyDir, requireDecision: true });
    if (!probe.ok) throw new Error(`agy hook command failed its smoke run (${probe.why}); hooks.json left unchanged`);
  }
  const results = {};
  results.hooks = writeMerged(agyDir, 'hooks.json', config => ({ ...config, [HOOK_NAME]: managedAgyHook({ scriptsDir }) }));
  results.mcp = stripLegacyBridgeMcp(agyDir);
  results.plugins = writeMerged(agyDir, 'plugins.json', config => {
    if (config.entries !== undefined && !Array.isArray(config.entries)) throw new Error('plugins.json entries must be an array');
    const others = (config.entries ?? []).filter(e => !(typeof e?.path === 'string' && /(^|\/)cc-market\/?$/.test(slash(e.path))));
    const usable = marketDir && fs.existsSync(marketDir);
    return { ...config, entries: usable ? [...others, managedPluginEntry({ marketDir })] : others };
  });
  return { changed: Object.values(results).some(r => r.changed), results };
}

const readJson = file => { try { const t = fs.readFileSync(file, 'utf8'); return t.trim() ? JSON.parse(t) : {}; } catch { return null; } };

/** What doctor reports: managed parts present and current, no stale session-bridge MCP, and hook receipts. */
export function inspectAgyConfig({ agyDir = AGY_DIR, scriptsDir, marketDir = readMarketDir().dir } = {}) {
  const hooks = readJson(path.join(agyDir, 'hooks.json'));
  const installed = !!hooks && JSON.stringify(hooks[HOOK_NAME]) === JSON.stringify(managedAgyHook({ scriptsDir }));
  const mcp = readJson(path.join(agyDir, 'mcp_config.json'));
  const mcpClean = !isLegacyBridgeMcp(mcp?.mcpServers?.[LEGACY_MCP_NAME]);
  const plugins = readJson(path.join(agyDir, 'plugins.json'));
  const pluginsOk = !marketDir || !fs.existsSync(marketDir) ||
    (plugins?.entries ?? []).some(e => JSON.stringify(e) === JSON.stringify(managedPluginEntry({ marketDir })));
  const events = {};
  for (const event of AGY_EVENTS) {
    const receipt = readJson(path.join(agyDir, 'harness-hooks', `${event}.json`));
    events[event] = { executed: installed && receipt?.definition === hookDefinitionId({ scriptsDir }, event), at: receipt?.at ?? null };
  }
  return { installed, mcpClean, plugins: pluginsOk, events,
    executed: installed && ['SessionStart', 'PreToolUse', 'Stop'].every(e => events[e].executed) };
}

/** agy's own settings (statusLine lives there, not under ~/.gemini/config). */
export const AGY_SETTINGS = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
const STATUSLINE_SCRIPT = 'agy-statusline.mjs';

export function managedStatusLine({ scriptsDir }) {
  const file = slash(path.resolve(scriptsDir, 'hooks', STATUSLINE_SCRIPT));
  // agy's statusline_runner passes `command` without shell quote-stripping / via EscapeArg on
  // Windows (`"` becomes a literal `"` in node's argv[1], causing MODULE_NOT_FOUND). Emit zero
  // double-quotes: bare forward-slash path when safe, else a quote-free, space-free base64 loader.
  const command = !/[\s"&|<>^()%!']/u.test(file)
    ? `node ${file}`
    : `node -e eval(Buffer.from('${Buffer.from(`process.argv[1]=${JSON.stringify(file)};import(${JSON.stringify(pathToFileURL(file).href)})`).toString('base64')}','base64').toString())`;
  // `telemetry: true` makes agy include `quota` (`map[string]StatusLineQuotaBucket`) on stdin JSON.
  return { type: 'command', command, enabled: true, telemetry: true };
}

/**
 * Merge our statusLine into agy's settings.json, only when it is unset or already ours.
 * Re-enables `enabled: true` if an earlier broken command caused agy to auto-disable after 30 failures.
 * Returns { status: 'written'|'unchanged'|'skipped', why? }.
 */
export function installAgyStatusLine({ settingsFile = AGY_SETTINGS, scriptsDir, smoke } = {}) {
  if (process.env.NODE_TEST_CONTEXT && path.resolve(settingsFile) === path.resolve(AGY_SETTINGS))
    throw new Error('refusing to write the live agy settings.json from a test: give the test a temp HOME');
  const { before, value } = readObject(settingsFile);
  const current = value.statusLine?.command;
  const isOurs = (cmd) => {
    if (!cmd) return true;
    const s = String(cmd);
    if (s.includes(STATUSLINE_SCRIPT)) return true;
    const m = /Buffer\.from\('([A-Za-z0-9+/=]+)','base64'\)/.exec(s);
    if (!m) return false;
    try { return Buffer.from(m[1], 'base64').toString('utf8').includes(STATUSLINE_SCRIPT); } catch { return false; }
  };
  if (!isOurs(current)) return { status: 'skipped', why: 'statusLine is the user\'s own' };
  const line = managedStatusLine({ scriptsDir });
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  if (smoke || fs.existsSync(path.join(scriptsDir, 'hooks', STATUSLINE_SCRIPT))) {
    const probe = (smoke ?? ((cmd, opts) => {
      const tokens = cmd.trim().split(/\s+/);
      const direct = spawnSync(tokens[0], tokens.slice(1), { cwd: opts.cwd, input: '{}', encoding: 'utf8', timeout: 20000, windowsHide: true });
      if (direct.error || direct.status !== 0)
        return { ok: false, why: direct.error?.message || String(direct.stderr || '').trim().split('\n').pop() || `exit ${direct.status}` };
      return smokeRunCommand(cmd, { ...opts, json: false, verbatim: false });
    }))(line.command, { cwd: path.dirname(settingsFile), json: false, verbatim: false });
    if (!probe.ok) return { status: 'skipped', why: `smoke run failed: ${probe.why}` };
  }
  const next = JSON.stringify({ ...value, statusLine: line }, null, 2) + '\n';
  if (next === before) return { status: 'unchanged' };
  writeFileAtomic(settingsFile, next);
  return { status: 'written' };
}
