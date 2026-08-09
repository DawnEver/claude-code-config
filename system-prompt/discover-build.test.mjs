// Tests for discover-styles.mjs + build.mjs (system-prompt platform tooling).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFrontmatter, discoverStyles } from './discover-styles.mjs';
import { validateStatic, buildStyle } from './build.mjs';

test('parseFrontmatter: name/description/keep-coding-instructions + body', () => {
  const { body, meta } = parseFrontmatter('---\nname: "Academic"\ndescription: "Scholarly"\nkeep-coding-instructions: false\n---\nBODY TEXT\n');
  assert.equal(meta.name, 'Academic');
  assert.equal(meta.description, 'Scholarly');
  assert.equal(meta['keep-coding-instructions'], false);
  assert.equal(body.trim(), 'BODY TEXT');
  // no frontmatter → whole text is body
  const plain = parseFrontmatter('just text');
  assert.equal(plain.body, 'just text');
  assert.deepEqual(plain.meta, {});
});

test('discoverStyles: user dir + project dir, nearest wins on conflict', () => {
  const root = mkdtempSync(join(tmpdir(), 'disc-'));
  const user = join(root, 'user', '.claude', 'output-styles');
  const proj = join(root, 'proj', '.claude', 'output-styles');
  mkdirSync(user, { recursive: true });
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(user, 'coding.md'), '---\nname: Coding\n---\nuser coding\n');
  writeFileSync(join(proj, 'coding.md'), '---\nname: Coding\n---\nproject coding (wins)\n');
  writeFileSync(join(proj, 'post.md'), '---\nname: post\n---\npost body\n');
  const styles = discoverStyles([proj, user]); // proj is "nearest"
  const byName = Object.fromEntries(styles.map((s) => [s.name, s]));
  assert.equal(byName.Coding.description, '');
  assert.ok(byName.Coding.file.startsWith(proj), 'nearest dir must win');
  assert.equal(byName.post.name, 'post');
});

test('validateStatic flags dynamic content (cwd/env/gitStatus/time)', () => {
  assert.deepEqual(validateStatic('clean static text', 'x'), []);
  const hits = validateStatic('Primary working directory: C:/x\nprocess.env.HOME\n2026-08-09T12:00', 'x');
  assert.ok(hits.length >= 2, 'dynamic patterns must be flagged');
});

test('buildStyle = base + style body (frontmatter stripped)', () => {
  const { text } = buildStyle({ name: 'post', file: null, body: 'STYLE BODY' }, 'BASE\n');
  assert.ok(text.startsWith('BASE'));
  assert.ok(text.includes('STYLE BODY'));
});
