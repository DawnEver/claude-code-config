import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  looksLikeBrokenGuard, findAbsolutePaths, compareKeySets, parseHookCommands,
  checkPayloadPaths, checkPayloadShape, checkHooks, checkHygiene, runChecks,
} from './doctor.js';

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
  const hits = findAbsolutePaths('"project": "C:/Users/linxu/Documents/PEMC/x",\n"other": "D:\\\\Work\\\\y",');
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
  assert.deepEqual(findAbsolutePaths('// realpath was C:/Users/linxu/foo\n# /Users/x/bar'), []);
});

// ── key sets ──

test('compareKeySets reports drift in both directions', () => {
  const { onlyInActual, onlyInTemplate } = compareKeySets({ a: 1, b: 2 }, { b: 2, c: 3 });
  assert.deepEqual(onlyInActual, ['a']);
  assert.deepEqual(onlyInTemplate, ['c']);
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

// The invariant is "no value that would be WRONG on another host", not "no absolute path
// ever". A path under byHost.<hostname> is read only by the host it names, so it cannot be
// wrong elsewhere — failing on it would enforce a rule stricter than the design.
test('a path under a byHost override is reported, but is not a failure', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify({
    serve: { byHost: { ws1: { projects: { p: 'D:/work/thing' } } } },
  }));
  const out = checkPayloadPaths(dir, ['x.json']);
  assert.equal(out.length, 1);
  assert.equal(out[0].level, 'WARN');
  assert.equal(out[0].id, 'payload-host-keyed-path');
});

test('a path outside byHost in the same file is still a failure', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'x.json'), JSON.stringify({
    shared: { p: 'C:/Users/someone/thing' },
    serve: { byHost: { ws1: { projects: { p: 'D:/work/thing' } } } },
  }));
  const out = checkPayloadPaths(dir, ['x.json']);
  const levels = out.map((f) => f.level).sort();
  assert.deepEqual(levels, ['FAIL', 'WARN']);
});

// Values are inspected through the parsed tree, so a compact file cannot hide a violation
// behind a formatting accident — nor can a byHost exemption leak onto a value that merely
// shares the line.
test('the check is independent of JSON formatting', () => {
  const pretty = tmp(); const compact = tmp();
  const data = { shared: { p: 'C:/Users/someone/thing' }, serve: { byHost: { a: { p: 'D:/ok' } } } };
  fs.writeFileSync(path.join(pretty, 'x.json'), JSON.stringify(data, null, 2));
  fs.writeFileSync(path.join(compact, 'x.json'), JSON.stringify(data));
  const a = checkPayloadPaths(pretty, ['x.json']).map((f) => f.level).sort();
  const b = checkPayloadPaths(compact, ['x.json']).map((f) => f.level).sort();
  assert.deepEqual(a, b);
  assert.deepEqual(a, ['FAIL', 'WARN']);
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
