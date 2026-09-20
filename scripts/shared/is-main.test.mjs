import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isMain } from './is-main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

// Every hook is wired in claude_settings.json as `node ~/.claude/scripts/...`,
// i.e. through a link. Node realpaths a module but not argv[1], so a naive
// `path.resolve(argv[1]) === fileURLToPath(import.meta.url)` check is false in
// production and silently turns the hook into a no-op. These tests are the
// reason is-main.mjs exists — they must fail if anyone reintroduces it.

/**
 * A `link` path that resolves to a `real` directory. Everything lives under a
 * temp dir: a link points AT the repo, so writing through it would write into
 * the repo.
 */
function withLink(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'is-main-'));
  const real = path.join(tmp, 'real');
  const link = path.join(tmp, 'link');
  fs.mkdirSync(real);
  try {
    fs.symlinkSync(real, link, 'junction'); // 'junction' is ignored on POSIX
    return fn({ real, link });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('isMain is true when the entry path goes through a link', () => {
  withLink(({ real, link }) => {
    const entry = path.join(real, 'probe.mjs');
    // Import the real helper by absolute URL — only the *entry* path is linked.
    fs.writeFileSync(
      entry,
      `import { isMain } from ${JSON.stringify(new URL('./is-main.mjs', import.meta.url).href)};\n` +
        `process.stdout.write(String(isMain(import.meta.url)));\n`,
    );
    const out = execFileSync(process.execPath, [path.join(link, 'probe.mjs')], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.equal(out.trim(), 'true', 'a module invoked via a link must still recognise itself');
  });
});

test('isMain is true for a plain, unlinked entry path', () => {
  withLink(({ real }) => {
    const entry = path.join(real, 'probe.mjs');
    fs.writeFileSync(
      entry,
      `import { isMain } from ${JSON.stringify(new URL('./is-main.mjs', import.meta.url).href)};\n` +
        `process.stdout.write(String(isMain(import.meta.url)));\n`,
    );
    const out = execFileSync(process.execPath, [entry], { encoding: 'utf8', windowsHide: true });
    assert.equal(out.trim(), 'true');
  });
});

test('isMain is false for an imported module', () => {
  // This file imported is-main.mjs at the top; the entry point is the test
  // runner, not that module.
  assert.equal(isMain(new URL('./is-main.mjs', import.meta.url).href), false);
});

// The end-to-end version: a real hook, invoked the way the harness invokes it.
// A silent exit 0 satisfies any assertion that only checks the exit code, so
// this asserts on output.
test('sync-hook still runs when reached through a linked path', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-hook-link-'));
  const link = path.join(tmp, 'scripts');
  try {
    fs.symlinkSync(path.join(REPO, 'scripts'), link, 'junction');
    const raw = execFileSync(process.execPath, [path.join(link, 'hooks', 'sync-hook.js'), '--remind'], {
      cwd: REPO, encoding: 'utf8', input: '{"reason":"other"}',
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8' }).trim();
    if (dirty) assert.match(raw, /\[cc-config\]/, 'hook body must execute via a linked path');
    else assert.equal(raw, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
