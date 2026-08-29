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
//   local      [projects.*] / [hooks.*] / [notice], MACHINE-ONLY -> never leaves the host
//
// `~/.codex/config.toml` is consequently a real file composed per host, not a symlink into
// the payload. See docs/sync-architecture.md § 3.

// Re-exported so the marker protocol has exactly one definition; inject-codex-providers.mjs
// owns the strings.
export {
  CODEX_TOML_START_MARKER,
  CODEX_TOML_END_MARKER,
} from './inject-codex-providers.mjs';

import {
  CODEX_TOML_START_MARKER as START,
  CODEX_TOML_END_MARKER as END,
} from './inject-codex-providers.mjs';

/**
 * Top-level table names Codex writes by itself. Anything under these prefixes is machine
 * state and must never reach the sync payload.
 *
 * If Codex grows a new state table, add it here — the failure mode of missing one is that
 * host-specific junk starts syncing, which setup reports as a drifting shared head.
 */
export const LOCAL_SECTION_PREFIXES = new Set(['projects', 'hooks', 'notice']);

function topLevelName(header) {
  // `plugins."rem@cc-market"` -> `plugins`; `projects.'c:\x'` -> `projects`
  const m = /^[A-Za-z0-9_-]+/.exec(header);
  return m ? m[0] : header;
}

/**
 * Split a codex config into its three parts.
 *
 * @returns {{
 *   preamble: string,                              // scalars before the first table
 *   shared:   Array<{header: string, text: string}>,
 *   generated: string,                             // body between the markers, exclusive
 *   local:    Array<{header: string, text: string}>,
 * }}
 */
export function splitCodexConfig(text = '') {
  const lines = String(text).split('\n');

  const preamble = [];
  const shared = [];
  const local = [];
  const generated = [];

  let current = null;      // {header, lines, isLocal}
  let inGenerated = false;

  const flush = () => {
    if (!current) return;
    const entry = { header: current.header, text: current.lines.join('\n').replace(/\s+$/, '') + '\n' };
    (current.isLocal ? local : shared).push(entry);
    current = null;
  };

  for (const line of lines) {
    if (line.trim() === START) {
      flush();
      inGenerated = true;
      continue;
    }
    if (line.trim() === END) {
      inGenerated = false;
      continue;
    }

    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line)?.[1];

    // A table header while inside the generated block ends it when the table is not a
    // model_providers one: an unterminated block (truncated file, lost end marker) must
    // not swallow this host's [projects.*] list.
    if (inGenerated && header && topLevelName(header) !== 'model_providers') {
      inGenerated = false;
    }

    if (inGenerated) {
      generated.push(line);
      continue;
    }

    if (header) {
      flush();
      current = { header, lines: [line], isLocal: LOCAL_SECTION_PREFIXES.has(topLevelName(header)) };
      continue;
    }

    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  flush();

  return {
    preamble: preamble.join('\n').replace(/\s+$/, '') + '\n',
    shared,
    generated: generated.join('\n').trim() ? generated.join('\n').replace(/^\s*\n/, '').replace(/\s+$/, '') + '\n' : '',
    local,
  };
}

/**
 * The shareable head: preamble + hand-edited tables, with all machine state and the
 * generated block removed. This is what gets written to the sync payload.
 */
export function sharedHeadOf(text = '') {
  const { preamble, shared } = splitCodexConfig(text);
  const parts = [preamble.trim(), ...shared.map(s => s.text.trim())].filter(Boolean);
  return parts.join('\n\n') + '\n';
}

/** The machine-only tables, as text. */
export function localSectionsOf(text = '') {
  return splitCodexConfig(text).local.map(s => s.text.trim()).filter(Boolean).join('\n\n');
}

/**
 * Build the per-host `~/.codex/config.toml`.
 *
 * @param {{head: string, providersBlock: string, localSections: string}} parts
 */
export function composeCodexConfig({ head = '', providersBlock = '', localSections = '' } = {}) {
  const chunks = [head.trim()];

  const body = providersBlock.trim();
  if (body) chunks.push([START, body, END].join('\n'));

  const tail = localSections.trim();
  if (tail) chunks.push(tail);

  return chunks.filter(Boolean).join('\n\n') + '\n';
}
