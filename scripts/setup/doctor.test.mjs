import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  looksLikeBrokenGuard, findAbsolutePaths, compareKeySets, comparePermissionRules, parseHookCommands,
  checkPayloadPaths, checkPayloadShape, checkHooks, checkHygiene, runChecks, linkedTo,
  checkCodexPluginCache,
  checkPlugins, checkBridgeRevision, checkProtectedCodexCaches,
  checkMachineName,
  checkCodexShellEnv,
  checkRetiredCodexRootKey,
  scanPublicHygiene, parseMarkers, checkPublicHygiene, checkLinks, checkBridgeHost, checkDashboardHost, checkChannelServer,
} from './doctor.js';

test('doctor reports a retired root Codex flag read-only and ignores nested user keys', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-retired-codex-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.toml');
  assert.deepEqual(checkRetiredCodexRootKey({ configPath }), []);
  const nested = '[notice]\nwindows_wsl_setup_acknowledged = false\n';
  fs.writeFileSync(configPath, nested);
  assert.deepEqual(checkRetiredCodexRootKey({ configPath }), []);
  const stale = 'windows_wsl_setup_acknowledged = true\n' + nested;
  fs.writeFileSync(configPath, stale);
  const [issue] = checkRetiredCodexRootKey({ configPath });
  assert.equal(issue.level, 'FAIL');
  assert.match(issue.detail, /setup\.js/);
  assert.equal(fs.readFileSync(configPath, 'utf8'), stale);
});

test('doctor warns about unidentified or dead cache lock owners without changing the lock', async t => {
  const { checkPluginCacheLock } = await import('./doctor.js');
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-cache-lock-'));
  t.after(() => fs.rmSync(codexHome, { recursive: true, force: true }));
  const lock = path.join(codexHome, '.tmp', 'cc-config-plugin-update.lock');
  assert.deepEqual(checkPluginCacheLock({ codexHome }), []);
  fs.mkdirSync(path.dirname(lock));
  fs.writeFileSync(lock, '');
  assert.equal(checkPluginCacheLock({ codexHome })[0].level, 'WARN');
  assert.equal(fs.readFileSync(lock, 'utf8'), '');
  const owner = JSON.stringify({ pid: 12345, token: '11111111-2222-4333-8444-555555555555', startedAt: '2026-10-23T10:00:00.000Z' });
  fs.writeFileSync(lock, owner);
  assert.deepEqual(checkPluginCacheLock({ codexHome, isAlive: () => true }), []);
  const [issue] = checkPluginCacheLock({ codexHome, isAlive: () => false });
  assert.equal(issue.level, 'WARN');
  assert.match(issue.detail, /OS handles/);
  assert.equal(fs.readFileSync(lock, 'utf8'), owner);
});

test('doctor detects native updates that leave a cache root but delete its protected contents', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-protected-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.deepEqual(checkProtectedCodexCaches({ codexHome: home }), []);
  const backup = path.join(home, '.tmp', 'cc-config-plugin-backup-fixture');
  const old = path.join(backup, 'rem', '1.0.0');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'hook.js'), 'original');
  fs.writeFileSync(path.join(backup, 'snapshot.json'), JSON.stringify([{ name: 'rem', versions: ['1.0.0'] }]));
  fs.writeFileSync(path.join(home, '.tmp', 'cc-config-plugin-backup-pointer'), backup);
  const target = path.join(home, 'plugins', 'cache', 'cc-market', 'rem', '1.0.0');
  fs.mkdirSync(target, { recursive: true });
  assert.equal(checkProtectedCodexCaches({ codexHome: home })[0].level, 'FAIL');
  fs.writeFileSync(path.join(target, 'hook.js'), 'different surviving bytes');
  assert.equal(checkProtectedCodexCaches({ codexHome: home })[0].level, 'WARN');
  fs.writeFileSync(path.join(target, 'hook.js'), 'original');
  assert.deepEqual(checkProtectedCodexCaches({ codexHome: home }), []);
  fs.writeFileSync(path.join(home, '.tmp', 'cc-config-plugin-backup-pointer'), path.dirname(home));
  assert.equal(checkProtectedCodexCaches({ codexHome: home })[0].level, 'WARN');
});
import { CLAUDE_LINKS } from './setup.js';

test('checkBridgeRevision is read-only and distinguishes inactive, unknown, current and stale code', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-revision-'));
  const runtimeFile = path.join(dir, 'runtime.json');
  const options = { runtimeFile, isAlive: () => true, revision: () => 'current' };
  try {
    assert.deepEqual(checkBridgeRevision(options), []);
    fs.writeFileSync(runtimeFile, JSON.stringify({ pid: 123 }));
    assert.match(checkBridgeRevision(options)[0].title, /unknown/);
    assert.deepEqual(checkBridgeRevision({ ...options, isAlive: () => false }), []);
    fs.writeFileSync(runtimeFile, JSON.stringify({ pid: 123, sourceRevision: 'current' }));
    assert.deepEqual(checkBridgeRevision(options), []);
    fs.writeFileSync(runtimeFile, JSON.stringify({ pid: 123, sourceRevision: 'old' }));
    const before = fs.readFileSync(runtimeFile, 'utf8');
    const [stale] = checkBridgeRevision(options);
    assert.equal(stale.level, 'WARN');
    assert.match(stale.title, /differs/);
    assert.equal(fs.readFileSync(runtimeFile, 'utf8'), before);
    assert.match(checkBridgeRevision({ ...options, revision: () => { throw new Error('unreadable'); } })[0].title, /cannot compare/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── machine name (provenance, harness-architecture §8b) ──

test('checkMachineName: WARN when missing or invalid, silent when valid', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-machine-'));
  const file = path.join(dir, 'machine.json');
  const [missing] = checkMachineName(file);
  assert.equal(missing.level, 'WARN');
  assert.equal(missing.id, 'machine-name');
  assert.match(missing.detail, /--machine <NAME>/);
  fs.writeFileSync(file, '{"name":"a b"}');
  assert.equal(checkMachineName(file).length, 1);
  fs.writeFileSync(file, '{"name":"host-a"}');
  assert.deepEqual(checkMachineName(file), []);
});

test('checkCodexShellEnv: FAIL when a named host composed config lacks the policy', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-codex-env-'));
  const cfg = path.join(dir, 'config.toml');
  assert.deepEqual(checkCodexShellEnv({ machine: null, configPath: cfg }), []);
  fs.writeFileSync(cfg, 'model = "x"\n');
  const [f] = checkCodexShellEnv({ machine: 'WS9', configPath: cfg });
  assert.equal(f.level, 'FAIL');
  assert.equal(f.id, 'codex-provenance');
  fs.writeFileSync(cfg, '[shell_environment_policy.set]\nHARNESS_MACHINE = "WS9"\n');
  assert.deepEqual(checkCodexShellEnv({ machine: 'WS9', configPath: cfg }), []);
  assert.deepEqual(checkCodexShellEnv({ machine: 'WS9', configPath: path.join(dir, 'none') }), []);
});

// ── the guard detector ──
// This check exists because the idiom below silently disabled loop-guard-hook.js for
// two days. It must catch every spelling of it and nothing else.

test('detects every spelling of the broken guard', () => {
  const broken = [
    'if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {',
    'if (process.argv[1] === fileURLToPath(import.meta.url)) {',
    'if (import.meta.url === pathToFileURL(process.argv[1]).href) {',
    "if (path.resolve(process.argv[1] || '') === path.resolve(__dirname, 'setup.js')) {",
  ];
  for (const line of broken) assert.equal(looksLikeBrokenGuard(line), true, line);
});

test('the correct forms are not flagged', () => {
  const fine = [
    'if (isMain(import.meta.url)) {',
    'return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(moduleUrl));',
    'const x = process.argv[1];',
    'if (a === b) {',
  ];
  for (const line of fine) assert.equal(looksLikeBrokenGuard(line), false, line);
});

// A comment that DESCRIBES the idiom is documentation, not a defect — otherwise
// is-main.mjs, whose job is to explain it, reports itself.
test('prose about the idiom is not an instance of it', () => {
  assert.equal(looksLikeBrokenGuard('//   `path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)`'), false);
  assert.equal(looksLikeBrokenGuard('  # process.argv[1] === fileURLToPath(import.meta.url)'), false);
  assert.equal(looksLikeBrokenGuard(' * import.meta.url === pathToFileURL(process.argv[1]).href'), false);
});

// ── the path detector ──
// A drive-letter pattern loose enough to be useful is also loose enough to match
// `env:/` and `https://`, which is most of what a naive version reports.

test('catches real machine paths in values', () => {
  const hits = findAbsolutePaths('"project": "C:/Users/user/Documents/proj/x",\n"other": "D:\\\\Work\\\\y",');
  assert.equal(hits.length, 2);
  assert.match(hits[0].what, /drive-letter/);
});

test('does not mistake colons inside words or URLs for drive letters', () => {
  const noise = [
    "k.replace(/^env:/, '')",
    'source: https://github.com/DawnEver/claude-config.git',
    'see docs/sync-architecture.md',
  ].join('\n');
  assert.deepEqual(findAbsolutePaths(noise), []);
});

test('a commented-out path is not a value', () => {
  assert.deepEqual(findAbsolutePaths('// realpath was C:/Users/user/foo\n# /Users/x/bar'), []);
});

// ── key sets ──

test('compareKeySets reports drift in both directions', () => {
  const { onlyInActual, onlyInTemplate } = compareKeySets({ a: 1, b: 2 }, { b: 2, c: 3 });
  assert.deepEqual(onlyInActual, ['a']);
  assert.deepEqual(onlyInTemplate, ['c']);
});

test('comparePermissionRules reports allow/deny drift in both directions', () => {
  const live = { permissions: { allow: ['Bash', 'Glob'], deny: ['Bash(sudo *)'] } };
  const template = { permissions: { allow: ['Bash', 'Read'], deny: ['Bash(sudo *)', 'Bash(rm -rf *)'] } };
  assert.deepEqual(comparePermissionRules(live, template), {
    onlyInActual: ['allow:Glob'],
    onlyInTemplate: ['allow:Read', 'deny:Bash(rm -rf *)'],
  });
  assert.deepEqual(comparePermissionRules({}, {}), { onlyInActual: [], onlyInTemplate: [] });
});

test('checkPayloadShape flags permission rules that drifted from the template', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-perm-'));
  fs.writeFileSync(path.join(dir, 'claude_settings.template.json'),
    JSON.stringify({ permissions: { allow: ['Bash'], deny: [] } }));
  fs.writeFileSync(path.join(dir, 'claude_settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash', 'Glob'], deny: [] } }));
  const ids = checkPayloadShape(dir, dir, ['claude_settings.json']).map((f) => f.id);
  assert.deepEqual(ids, ['payload-permission-drift']);
});

// ── hook parsing ──

test('parseHookCommands finds the script in each wired command', () => {
  const settings = {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'node ~/.claude/scripts/hooks/a.js --pull', timeout: 5 }] }],
      SessionEnd: [{ hooks: [{ type: 'command', command: 'node ~/.claude/scripts/hooks/b.js' }] }],
    },
  };
  const cmds = parseHookCommands(settings, '/home/u');
  assert.equal(cmds.length, 2);
  assert.equal(cmds[0].event, 'SessionStart');
  assert.equal(cmds[0].script, path.join('/home/u', '.claude/scripts/hooks/a.js'));
  assert.equal(cmds[1].event, 'SessionEnd');
});

// ── checks, against temp fixtures ──

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-')); }

test('a payload carrying a machine path is a FAIL', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'x.json'), '{ "p": "C:/Users/someone/proj" }');
  const out = checkPayloadPaths(dir, ['x.json']);
  assert.equal(out.length, 1);
  assert.equal(out[0].level, 'FAIL');
  assert.equal(out[0].id, 'payload-abs-path');
});

test('a clean payload passes', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'x.json'), '{ "p": "~/proj" }');
  assert.deepEqual(checkPayloadPaths(dir, ['x.json']), []);
});

// Values are inspected through the parsed tree, so a compact file cannot hide a violation
// behind a formatting accident.
test('the check is independent of JSON formatting', () => {
  const pretty = tmp(); const compact = tmp();
  const data = { shared: { p: 'C:/Users/someone/thing' }, other: { q: '~/fine' } };
  fs.writeFileSync(path.join(pretty, 'x.json'), JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(compact, 'x.json'), JSON.stringify(data));
  const a = checkPayloadPaths(pretty, ['x.json']).map((f) => f.level).sort();
  const b = checkPayloadPaths(compact, ['x.json']).map((f) => f.level).sort();
  assert.deepEqual(a, b);
  assert.deepEqual(a, ['FAIL']);
});

// The 2026-08-29 incident in miniature: the payload kept an old shape, nothing
// compared it to the template, and the generator emitted an empty catalogue.
test('a payload missing a key its template declares is a FAIL', () => {
  const live = tmp(); const repo = tmp();
  fs.writeFileSync(path.join(live, 'x.json'), '{"providers":{}}');
  fs.writeFileSync(path.join(repo, 'x.template.json'), '{"providers":{},"fabric":{}}');
  const out = checkPayloadShape(live, repo, ['x.json']);
  assert.equal(out.length, 1);
  assert.equal(out[0].level, 'FAIL');
  assert.equal(out[0].id, 'payload-missing-key');
});

test('a live-only key is a WARN, not a failure — that is host tuning', () => {
  const live = tmp(); const repo = tmp();
  fs.writeFileSync(path.join(live, 'x.json'), '{"providers":{},"model":"opus"}');
  fs.writeFileSync(path.join(repo, 'x.template.json'), '{"providers":{}}');
  const out = checkPayloadShape(live, repo, ['x.json']);
  assert.equal(out.length, 1);
  assert.equal(out[0].level, 'WARN');
});

test('Claude CLI model preference is optional and does not mask real payload drift', () => {
  const live = tmp(); const repo = tmp();
  fs.writeFileSync(path.join(repo, 'claude_settings.template.json'), '{"env":{}}');
  const file = path.join(live, 'claude_settings.json');
  fs.writeFileSync(file, '{"env":{},"model":"haiku"}');
  assert.deepEqual(checkPayloadShape(live, repo, ['claude_settings.json']), []);
  fs.writeFileSync(file, '{"env":{}}');
  assert.deepEqual(checkPayloadShape(live, repo, ['claude_settings.json']), []);
  fs.writeFileSync(file, '{"env":{},"model":"haiku","unexpected":true}');
  assert.equal(checkPayloadShape(live, repo, ['claude_settings.json'])[0].id, 'payload-extra-key');
  fs.writeFileSync(file, '{"model":"haiku"}');
  assert.equal(checkPayloadShape(live, repo, ['claude_settings.json'])[0].id, 'payload-missing-key');
  fs.writeFileSync(file, '{"env":{},"model":42}');
  assert.equal(checkPayloadShape(live, repo, ['claude_settings.json'])[0].id, 'payload-invalid-model');
});

test('a hook script behind a broken guard is a FAIL', () => {
  const home = tmp();
  const hookDir = path.join(home, '.claude', 'scripts', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, 'dead.js'),
    'if (process.argv[1] === fileURLToPath(import.meta.url)) { main(); }\n');
  const settings = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node ~/.claude/scripts/hooks/dead.js' }] }] } };
  const out = checkHooks(settings, home);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'hook-dead-guard');
});

test('a hook whose script is absent is a FAIL', () => {
  const home = tmp();
  const settings = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node ~/.claude/scripts/hooks/ghost.js' }] }] } };
  const out = checkHooks(settings, home);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'hook-missing');
});

test('a retired Codex plugin cache is reported without flagging current plugins', () => {
  const root = tmp(); const home = tmp();
  const marketDir = path.join(root, 'cc-market', '.agents', 'plugins');
  const cacheDir = path.join(home, '.codex', 'plugins', 'cache', 'cc-market');
  fs.mkdirSync(marketDir, { recursive: true });
  fs.mkdirSync(path.join(cacheDir, 'fabric'), { recursive: true });
  fs.mkdirSync(path.join(cacheDir, 'takeover'), { recursive: true });
  fs.writeFileSync(path.join(marketDir, 'marketplace.json'), JSON.stringify({
    plugins: [{ name: 'fabric' }],
  }));
  const out = checkCodexPluginCache(root, home);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'codex-plugin-orphan-cache');
  assert.match(out[0].title, /takeover/);
});

test('project-scoped plugin installs are not reported as globally dormant', () => {
  const home = tmp();
  const dir = path.join(home, '.claude', 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'installed_plugins.json'), JSON.stringify({
    plugins: {
      'watch@cc-market': [{ scope: 'project', projectPath: '/work/a' }],
      'rem@cc-market': [{ scope: 'user' }],
    },
  }));
  const out = checkPlugins({ enabledPlugins: {} }, home);
  assert.equal(out.length, 1);
  assert.match(out[0].title, /rem@cc-market/);
});

test('a @builtin plugin ships with the CLI: enabled without an install record is fine', () => {
  const home = tmp();
  const dir = path.join(home, '.claude', 'plugins');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'installed_plugins.json'), JSON.stringify({ plugins: {} }));
  const out = checkPlugins({ enabledPlugins: { 'x@builtin': true, 'y@market': true } }, home);
  assert.deepEqual(out.map((f) => f.title), ['y@market is enabled but not installed']);
});

// A NUL byte makes git call the file binary: its diffs become unreviewable and
// ripgrep skips it. That is why loop-guard-hook.js was invisible to search.
test('a NUL byte in a script is a FAIL', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'x.js'), Buffer.from('const a = "\u0000";'));
  const out = checkHygiene(root);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'hygiene-nul');
});

// wrangler writes per-deploy bundles with absolute paths into .wrangler/: generated, not source.
test('generated trees (.wrangler) are not scanned', () => {
  const root = tmp();
  const bundle = path.join(root, 'scripts', 'dashboard', '.wrangler', 'tmp');
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(bundle, 'facade.js'), Buffer.from('import x from "C:\\\\a\\\\b.mjs";\u0000'));
  assert.deepEqual(checkHygiene(root), []);
});

// 2026-10-18: OneDrive replaced the synced file, breaking this host's hard link; the host kept
// reading a private copy for 11 days and doctor said nothing.
test('linkedTo: a hard link or symlink is linked; a detached copy is not', () => {
  const root = tmp();
  const src = path.join(root, 'sync.json'), dest = path.join(root, 'claude.json');
  fs.writeFileSync(src, '{"a":1}');
  fs.linkSync(src, dest);
  assert.equal(linkedTo(src, dest), true, 'hard link');
  // What a cloud client does on download: write a new file and rename it over the old one.
  fs.writeFileSync(src + '.tmp', '{"a":2}');
  fs.renameSync(src + '.tmp', src);
  assert.equal(linkedTo(src, dest), false, 'the replace broke the link: dest is a private copy now');
  fs.writeFileSync(dest, '{"a":2}');
  assert.equal(linkedTo(src, dest), false, 'same content on the same volume is still detached');
  assert.equal(linkedTo(src, path.join(root, 'missing.json')), false);
});

// ── the real repo ──

test('runChecks returns a well-formed finding list for this checkout', () => {
  const findings = runChecks();
  assert.ok(Array.isArray(findings));
  for (const f of findings) {
    assert.ok(['FAIL', 'WARN'].includes(f.level), `bad level: ${f.level}`);
    assert.ok(f.id && f.title, 'every finding needs an id and a title');
  }
});

// The point of the whole file: it must be possible for this to fail. A checker that
// cannot fail is not a check.
test('the payload check can actually fail on the real sync dir', () => {
  const syncDir = tmp();
  fs.writeFileSync(path.join(syncDir, 'claude_env_settings.json'),
    JSON.stringify({ fabric: { projects: { x: 'C:/Users/someone/x' } } }));
  const out = checkPayloadPaths(syncDir, ['claude_env_settings.json']);
  assert.ok(out.some((f) => f.level === 'FAIL'), 'a real violation must produce a FAIL');
});


// ── public hygiene (tracked files must carry no personal/local information) ──
// Planted positives are assembled at runtime so this source file itself stays clean.

const J = (...p) => p.join('');

test('scanPublicHygiene: generic patterns hit real-looking personal data', () => {
  const text = [
    J('p = "C:', '\\Users\\alice\\proj"'),
    J('p = "/Users/', 'alice/proj"'),
    J('p = "/home/', 'alice/proj"'),
    J('mail alice', '@uni.ac.uk'),
    J('chat -100', '9876543210'),
    J('dir OneDrive', ' - Acme University/x'),
  ].join('\n');
  const hits = scanPublicHygiene(text);
  assert.deepEqual(hits.map((h) => h.line), [1, 2, 3, 4, 5, 6]);
});

test('scanPublicHygiene: placeholders and neutral fixtures are clean', () => {
  const text = [
    String.raw`C:\Users\<user>\x`,'C:/Users/u/.claude', '/Users/x/bar', '/home/u/.claude',
    'user@example.com', 'a@example.org', '1+me@users.noreply.github.com', 'git@github.com:o/r.git',
    'chatId: -1001234567890', 'chat -1001111111111', 'OneDrive - <Org>', 'npm i -g @openai/codex',
    'pkg@1.2.3', 't@t',
  ].join('\n');
  assert.deepEqual(scanPublicHygiene(text), []);
});

test('scanPublicHygiene: private markers (literal and /regex/), inline allow marker', () => {
  const markers = parseMarkers(['# comment', '', 'SecretLab', String.raw`/\bhost-z\d\b/`, '/bad[/'].join('\n'));
  assert.equal(markers.length, 2, 'invalid regex is dropped, comments/blank skipped');
  const text = ['we use secretlab here', 'on host-z9 today', 'host-zz is fine',
    J('secretlab ', 'public-hygiene: allow (fixture)')].join('\n');
  assert.deepEqual(scanPublicHygiene(text, markers).map((h) => h.line), [1, 2]);
});

test('checkPublicHygiene: FAILs every tracked hit (memory included), skips binary', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-pub-'));
  const files = {
    'a.md': J('reach me at bob', '@corp.io'),
    'b.md': 'clean',
    '.claude/memory/2026/x.md': 'secretlab and secretlab\nsecretlab',
    'bin.dat': Buffer.from([0, 1, J('bob', '@corp.io').charCodeAt(0)]),
  };
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const markersFile = path.join(dir, 'markers');
  fs.writeFileSync(markersFile, 'secretlab\n');
  const out = checkPublicHygiene({ root: dir, files: Object.keys(files), markersFile });
  assert.deepEqual(out.map((f) => [f.level, f.title.split(' ')[0]]),
    [['FAIL', 'a.md:1'], ['FAIL', '.claude/memory/2026/x.md:1'], ['FAIL', '.claude/memory/2026/x.md:2']]);
  assert.equal(checkPublicHygiene({ root: dir, files: ['b.md'], markersFile: path.join(dir, 'none') }).length, 0);
});

test('checkPublicHygiene: WARN when a fleet host (sync dir) lacks the private markers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-pub-markers-'));
  const markersFile = path.join(dir, 'none');
  const [w] = checkPublicHygiene({ root: dir, files: [], markersFile, requireMarkers: true });
  assert.equal(w.level, 'WARN');
  assert.equal(w.id, 'private-markers-missing');
  assert.deepEqual(checkPublicHygiene({ root: dir, files: [], markersFile }), []);
  fs.writeFileSync(markersFile, 'x\n');
  assert.deepEqual(checkPublicHygiene({ root: dir, files: [], markersFile, requireMarkers: true }), []);
});

test('private-markers rides the sync payload as an optional ~/.claude link', () => {
  const link = CLAUDE_LINKS.find((l) => l.dest === 'private-markers');
  assert.deepEqual(link, { src: 'private-markers', dest: 'private-markers', type: 'file', base: 'sync', optional: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-optional-'));
  const out = checkLinks({ repoRoot: dir, syncDir: dir });
  assert.equal(out.some((f) => f.title.includes('private-markers')), false);
});

test('checkDashboardHost: this host token must match its shared hosts entry; a token with no shared block FAILs', async () => {
  const { createHash } = await import('crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-dash-'));
  const sharedPath = path.join(dir, 'shared.json'), localPath = path.join(dir, 'local.json');
  const write = (shared, local) => { fs.writeFileSync(sharedPath, JSON.stringify(shared)); fs.writeFileSync(localPath, JSON.stringify(local)); };
  const hash = createHash('sha256').update('tok').digest('hex');
  const ids = () => checkDashboardHost({ sharedPath, localPath, machine: 'host-a' }).map((f) => `${f.level} ${f.title}`);
  write({}, {});
  assert.deepEqual(ids(), [], 'no dashboard anywhere');
  write({}, { bridge: { dashboard: { hostToken: 'tok' } } });
  assert.match(ids()[0], /^FAIL .*shared bridge\.dashboard is missing/);
  write({ bridge: { dashboard: { url: 'https://d.example', hosts: { 'host-a': hash } } } }, {});
  assert.match(ids()[0], /^WARN .*no local hostToken/);
  write({ bridge: { dashboard: { url: 'https://d.example', hosts: { 'host-a': 'f'.repeat(64) } } } }, { bridge: { dashboard: { hostToken: 'tok' } } });
  assert.match(ids()[0], /^FAIL .*does not match/);
  write({ bridge: { dashboard: { url: 'https://d.example', hosts: {} } } }, { bridge: { dashboard: { hostToken: 'tok' } } });
  assert.match(ids()[0], /^FAIL .*not in the shared hosts/);
  write({ bridge: { dashboard: { url: 'https://d.example', hosts: { 'host-a': hash } } } }, { bridge: { dashboard: { hostToken: 'tok' } } });
  assert.deepEqual(ids(), []);
});

test('checkBridgeHost: WARN when the fleet runs a bridge and this host has no bot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-bridge-'));
  const sharedPath = path.join(dir, 'shared.json');
  const localPath = path.join(dir, 'local.json');
  assert.deepEqual(checkBridgeHost({ sharedPath, localPath }), []);           // no bridge anywhere
  fs.writeFileSync(sharedPath, JSON.stringify({ bridge: { projects: { p: { chatId: -1001111111111 } } } }));
  const [w] = checkBridgeHost({ sharedPath, localPath });
  assert.equal(w.level, 'WARN');
  assert.equal(w.id, 'bridge-host');
  fs.writeFileSync(localPath, JSON.stringify({ bridge: { botToken: '1:abc' } }));
  assert.deepEqual(checkBridgeHost({ sharedPath, localPath }), []);
  fs.writeFileSync(sharedPath, JSON.stringify({ bridge: { codexSources: ['cli'] } }));
  const [sources] = checkBridgeHost({ sharedPath, localPath });
  assert.equal(sources.id, 'bridge-codex-sources');
  assert.equal(sources.level, 'WARN');
  assert.match(sources.title, /vscode/);
});

test('checkPublicHygiene: the real tracked tree is clean', () => {
  const fails = checkPublicHygiene().filter((f) => f.level === 'FAIL');
  assert.deepEqual(fails.map((f) => f.title), []);
});

test('checkChannelServer: FAIL per bridged config dir that lost the session-bridge registration', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-channel-'));
  const server = path.join(home, 'server.mjs');
  const base = path.join(home, '.claude');
  const seat = path.join(home, '.claude-a');
  fs.mkdirSync(seat);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { 'session-bridge': { args: [server] } } }));
  fs.writeFileSync(path.join(seat, '.claude.json'), JSON.stringify({}));
  const dirs = [{ alias: null, dir: base }, { alias: 'a', dir: seat }, { alias: 'b', dir: path.join(home, '.claude-b') }];
  assert.deepEqual(checkChannelServer({ bridged: false, dirs, server, home }), []);
  const out = checkChannelServer({ bridged: true, dirs, server, home });
  assert.deepEqual(out.map((f) => [f.level, f.id]), [['FAIL', 'channel-server']]);   // base ok, b has no config yet
  assert.match(out[0].title, /^seat a: .*not registered/);
});

test('rules-symbols: a rule naming a function or constant the code no longer has fails', async () => {
  const { checkRuleSymbols } = await import('./doctor.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-rules-'));
  try {
    fs.mkdirSync(path.join(root, '.claude', 'rules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.mjs'), 'export const WRAPPER_NAMES = []; export function migrateOrphanedWrappers() {}');
    fs.writeFileSync(path.join(root, '.claude', 'rules', 'r.md'),
      'Uses `migrateOrphanedWrappers()` and `WRAPPER_NAMES`; renamed from `KNOWN_ALIAS_NAMES`. Plain words: `setup`, `cwd`, `config.json`.');
    const files = ['a.mjs', '.claude/rules/r.md'];
    const out = checkRuleSymbols(root, files);
    assert.deepEqual(out.map((f) => f.level), ['FAIL']);
    assert.match(out[0].title, /KNOWN_ALIAS_NAMES/);
    fs.writeFileSync(path.join(root, '.claude', 'rules', 'r.md'), 'Uses `migrateOrphanedWrappers()` and `WRAPPER_NAMES`.');
    assert.deepEqual(checkRuleSymbols(root, files), [], 'clean: no finding');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
