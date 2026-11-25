// scripts/shared/principles.mjs -- the family principles block of GLOBAL-AGENTS.md (~/.claude/CLAUDE.md on every
// host). dev_lab.dev.principles is the one source; the block is its bullets verbatim, read under this checkout's own
// interpreter (own-python.mjs) and rendered here, never hand-edited. Re-render: node scripts/shared/principles.mjs --write

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { isMain } from './is-main.mjs';
import { OWN_ROOT, ownPython } from './own-python.mjs';

export const GLOBAL_REL = 'GLOBAL-AGENTS.md';
export const RENDER_DOOR = 'node scripts/shared/principles.mjs --write';
export const BEGIN = '<!-- principles:begin -- family policy, rendered from dev_lab.dev.principles by '
  + 'scripts/shared/principles.mjs; edit there -->';
export const END = '<!-- principles:end -->';
const BLOCK = /<!-- principles:begin[^>]*-->\n[\s\S]*?<!-- principles:end -->/;
const ENV_DOOR = "build this checkout's environment with `uv sync --all-groups` (or `npm run setup`)";

/** The family's principle bullets (`python -m dev_lab.dev.principles`), LF, ending in one newline. Throws naming the door. */
export function familyBullets({ python = ownPython(), run = spawnSync } = {}) {
  const r = run(python, ['-m', 'dev_lab.dev.principles'], { encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error(`no interpreter at ${python} (${r.error.code || r.error.message}): ${ENV_DOOR}`);
  if (r.status !== 0) {
    const why = (r.stderr || '').trim().split('\n').slice(-1)[0] || 'no stderr';
    throw new Error(`${python} -m dev_lab.dev.principles exited ${r.status} (${why}): ${ENV_DOOR}`);
  }
  return `${r.stdout.replace(/\r\n/g, '\n').replace(/\n+$/, '')}\n`;
}

/** *text* (LF) with its principles block, marker included, replaced by *bullets*. Throws when it holds no block. */
export function spliceBlock(text, bullets) {
  if (!BLOCK.test(text)) throw new Error(`${GLOBAL_REL} holds no principles:begin/end block`);
  return text.replace(BLOCK, () => `${BEGIN}\n${bullets}${END}`);
}

/** Rewrite `<root>/GLOBAL-AGENTS.md`'s block from *bullets* (default: the family source), LF. */
export function renderGlobal({ root = OWN_ROOT, bullets = familyBullets() } = {}) {
  const file = path.join(root, GLOBAL_REL);
  fs.writeFileSync(file, spliceBlock(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), bullets));
}

if (isMain(import.meta.url)) {
  if (process.argv[2] !== '--write') {
    console.error(`usage: ${RENDER_DOOR}  (re-renders ${GLOBAL_REL}'s principles block from dev_lab.dev.principles)`);
    process.exit(2);
  }
  renderGlobal();
}
