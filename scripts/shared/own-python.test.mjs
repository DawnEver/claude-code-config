import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { ownPython, OWN_ROOT } from './own-python.mjs';

test('the interpreter is this checkout\'s own .venv, in the platform\'s layout', () => {
  assert.equal(ownPython({ root: 'C:/w/cc-config', platform: 'win32' }), path.join('C:/w/cc-config', '.venv', 'Scripts', 'python.exe'));
  assert.equal(ownPython({ root: '/w/cc-config', platform: 'linux' }), path.join('/w/cc-config', '.venv', 'bin', 'python'));
});

test('the default root is the checkout these scripts live in, never another repo', () => {
  assert.equal(OWN_ROOT, path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
  assert.ok(ownPython().startsWith(OWN_ROOT));
});
