// scripts/setup/codex-config-compose.mjs — split and recompose ~/.codex/config.toml.
//
// codex_config.toml is NOT a hand-edited file, despite looking like one. Codex appends a
// `[projects.'<abs path>']` trust block on every new project directory it visits, plus
// `[hooks.state.*]` and `[notice]` runtime state. A live config held 30 project blocks
// spanning two usernames (linxu / ezxmb14) and three drive letters. Cloud-syncing the
// whole file therefore recreates the two-writers problem this repo's sync split exists to
// eliminate, and pollutes every host with the other hosts' dead absolute paths.
//
// So the file is split three ways:
//
//   head       hand-edited, SHARED  -> lives in the sync payload as codex_config.toml
//   generated  derived from claude_env_settings.json providers -> rebuilt every setup run
//   local      [projects.*] / [hooks.state.*] / [notice], MACHINE-ONLY -> never leaves the host
//
// `~/.codex/config.toml` is consequently a real file composed per host, not a symlink into
// the payload. See docs/sync-architecture.md § 3.
//
// SAFETY. The output of this splitter is written back over a CLOUD-SYNCED file, so a
// misparse is not a local annoyance — it is fleet-wide data loss. Two defences:
//   1. The line scanner tracks TOML multi-line strings (""" / '''), so a line that merely
//      LOOKS like a table header inside a string is not treated as one. Without this, a
//      `[projects.x]` line inside a multi-line string split the file mid-string and
//      emitted unterminated TOML.
//   2. `partition()` assigns EVERY input line to exactly one bucket, so reconstruction is
//      lossless by construction, and `assertLossless()` verifies it before any caller
//      overwrites a file.

export {
  CODEX_TOML_START_MARKER,
  CODEX_TOML_END_MARKER,
} from './inject-codex-providers.mjs';

import {
  CODEX_TOML_START_MARKER as START,
  CODEX_TOML_END_MARKER as END,
} from './inject-codex-providers.mjs';

/**
 * Dotted table prefixes Codex writes by itself. Anything under these is machine state and
 * must never reach the sync payload.
 *
 * `hooks.state` — NOT `hooks`. Codex's hook *state* is machine-local, but `[hooks]` and
 * any user-authored `[hooks.<something-else>]` is real configuration that belongs in the
 * shared head; claiming the whole `hooks` namespace silently deleted it.
 */
export const LOCAL_SECTION_PREFIXES = ['projects', 'notice', 'hooks.state'];

/** Tables owned by the generator; never shared, even if found outside the markers. */
const GENERATED_PREFIXES = ['model_providers'];

function matchesPrefix(header, prefixes) {
  return prefixes.some(p => header === p || header.startsWith(p + '.'));
}

/**
 * Parse a table header, tolerating a trailing comment (`[tui]  # theme`) and surrounding
 * whitespace. Returns null for anything else — notably `[[array.of.tables]]`, which is
 * left as ordinary content of the preceding section rather than mis-split.
 */
export function parseHeader(line) {
  const m = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/.exec(line);
  return m ? m[1].trim() : null;
}

/**
 * Assign every line of `text` to exactly one bucket.
 *
 * @returns {{lines: string[], kind: string[]}} kind[i] is one of
 *   'preamble' | 'shared' | 'generated' | 'local' | 'marker'
 */
export function partition(text = '') {
  const lines = String(text).split('\n');
  const kind = new Array(lines.length).fill('preamble');

  let current = 'preamble';
  let inGenerated = false;
  let openDelim = null; // '"""' or "'''" while inside a multi-line string

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // ── multi-line string tracking ────────────────────────────────────────────
    // Inside a multi-line string nothing is a header. Count delimiters on the line;
    // an odd count toggles the state.
    if (openDelim) {
      kind[i] = current;
      if ((line.split(openDelim).length - 1) % 2 === 1) openDelim = null;
      continue;
    }
    for (const d of ['"""', "'''"]) {
      if ((line.split(d).length - 1) % 2 === 1) { openDelim = d; break; }
    }

    const trimmed = line.trim();
    if (trimmed === START) { kind[i] = 'marker'; inGenerated = true; current = 'generated'; continue; }
    if (trimmed === END) { kind[i] = 'marker'; inGenerated = false; current = 'preamble'; continue; }

    const header = parseHeader(line);

    if (header) {
      if (matchesPrefix(header, GENERATED_PREFIXES)) {
        // A model_providers table anywhere — inside the markers or stranded outside them
        // by a lost end marker — belongs to the generator. Treating a stray one as shared
        // baked it into the payload and then collided with the regenerated block.
        current = 'generated';
      } else if (matchesPrefix(header, LOCAL_SECTION_PREFIXES)) {
        current = 'local';
        inGenerated = false;
      } else {
        current = 'shared';
        inGenerated = false;
      }
    } else if (inGenerated && current !== 'generated') {
      current = 'generated';
    }

    kind[i] = current;
  }

  return { lines, kind };
}

function collect(lines, kind, want) {
  return lines.filter((_, i) => kind[i] === want).join('\n').replace(/\s+$/, '');
}

/**
 * Split a codex config into its parts. `shared` includes the preamble scalars.
 */
export function splitCodexConfig(text = '') {
  const { lines, kind } = partition(text);

  const sectionsOf = (want) => {
    const out = [];
    let cur = null;
    for (let i = 0; i < lines.length; i++) {
      if (kind[i] !== want) { cur = null; continue; }
      const header = parseHeader(lines[i]);
      if (header) { cur = { header, lines: [lines[i]] }; out.push(cur); }
      else if (cur) cur.lines.push(lines[i]);
    }
    return out.map(s => ({ header: s.header, text: s.lines.join('\n').replace(/\s+$/, '') + '\n' }));
  };

  const preamble = collect(lines, kind, 'preamble');
  const generatedBody = lines
    .filter((_, i) => kind[i] === 'generated')
    .join('\n')
    .replace(/^\s*\n/, '')
    .replace(/\s+$/, '');

  return {
    preamble: preamble ? preamble + '\n' : '\n',
    shared: sectionsOf('shared'),
    generated: generatedBody ? generatedBody + '\n' : '',
    local: sectionsOf('local'),
  };
}

/**
 * Every non-local, non-generated line of `text`, in order — the shareable head.
 */
export function sharedHeadOf(text = '') {
  const { lines, kind } = partition(text);
  const keep = lines.filter((_, i) => kind[i] === 'preamble' || kind[i] === 'shared');
  return keep.join('\n').replace(/\s+$/, '') + '\n';
}

/** The machine-only tables, as text. */
export function localSectionsOf(text = '') {
  const { lines, kind } = partition(text);
  return lines.filter((_, i) => kind[i] === 'local').join('\n').replace(/\s+$/, '');
}

/**
 * Throw if splitting `text` would lose content. Callers MUST run this before overwriting
 * a file with a derived head — the payload is cloud-synced, so a silent drop propagates.
 */
export function assertLossless(text = '') {
  const { lines, kind } = partition(text);
  const seen = lines.filter((_, i) => kind[i] !== 'marker').length;
  const expected = lines.length - kind.filter(k => k === 'marker').length;
  if (seen !== expected) throw new Error('codex config partition lost lines');

  const open = /"""|'''/g;
  for (const bucket of ['preamble', 'shared', 'local']) {
    const body = lines.filter((_, i) => kind[i] === bucket).join('\n');
    const count = (body.match(open) || []).length;
    if (count % 2 !== 0) {
      throw new Error(
        `codex config: a multi-line string is split across the ${bucket} boundary; ` +
        'refusing to rewrite (this would emit unterminated TOML)',
      );
    }
  }
  return true;
}

/**
 * Build the per-host `~/.codex/config.toml`.
 */
export function composeCodexConfig({ head = '', providersBlock = '', localSections = '' } = {}) {
  const chunks = [head.trim()];

  const body = providersBlock.trim();
  if (body) chunks.push([START, body, END].join('\n'));

  const tail = localSections.trim();
  if (tail) chunks.push(tail);

  return chunks.filter(Boolean).join('\n\n') + '\n';
}
