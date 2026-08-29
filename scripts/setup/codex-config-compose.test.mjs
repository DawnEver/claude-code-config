import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  splitCodexConfig,
  composeCodexConfig,
  sharedHeadOf,
  LOCAL_SECTION_PREFIXES,
  CODEX_TOML_START_MARKER,
  CODEX_TOML_END_MARKER,
} from './codex-config-compose.mjs';

const SAMPLE = `sandbox_mode = "danger-full-access"
model = "gpt-5.6-sol"

[tui]
theme = "github"

[plugins."rem@cc-market"]
enabled = true

${CODEX_TOML_START_MARKER}
[model_providers.deepseek]
name = "deepseek"
${CODEX_TOML_END_MARKER}

[projects.'c:\\users\\linxu\\somewhere']
trust_level = "trusted"

[projects."/Users/linxu/elsewhere"]
trust_level = "trusted"

[hooks.state]
seen = true

[hooks.state."rem@cc-market:hooks/hooks.json:stop:0:0"]
enabled = true

[notice]
hide_rate_limit_model_nudge = true
`;

test('splitCodexConfig: separates preamble, shared sections, generated block and local sections', () => {
  const parts = splitCodexConfig(SAMPLE);

  assert.match(parts.preamble, /sandbox_mode = "danger-full-access"/);
  assert.match(parts.preamble, /model = "gpt-5\.6-sol"/);
  // The preamble stops at the first table header.
  assert.doesNotMatch(parts.preamble, /\[tui\]/);

  const sharedHeaders = parts.shared.map(s => s.header);
  assert.deepEqual(sharedHeaders, ['tui', 'plugins."rem@cc-market"']);

  assert.match(parts.generated, /\[model_providers\.deepseek\]/);
  // The markers themselves are not part of the captured body.
  assert.doesNotMatch(parts.generated, /setup-managed/);

  const localHeaders = parts.local.map(s => s.header);
  assert.deepEqual(localHeaders, [
    "projects.'c:\\users\\linxu\\somewhere'",
    'projects."/Users/linxu/elsewhere"',
    'hooks.state',
    'hooks.state."rem@cc-market:hooks/hooks.json:stop:0:0"',
    'notice',
  ]);
});

test('LOCAL_SECTION_PREFIXES covers every machine-written section Codex appends', () => {
  // Guard against silently sharing a new state section: these are the ones observed
  // in a live config (30 projects, 8 hooks.state, 1 notice).
  assert.deepEqual([...LOCAL_SECTION_PREFIXES].sort(), ['hooks', 'notice', 'projects']);
});

test('sharedHeadOf: strips local sections and the generated block, keeps hand-edited content', () => {
  const head = sharedHeadOf(SAMPLE);

  assert.match(head, /sandbox_mode/);
  assert.match(head, /\[tui\]/);
  assert.match(head, /\[plugins\."rem@cc-market"\]/);

  // Everything machine-written is gone — this is what gets written to the cloud payload.
  assert.doesNotMatch(head, /\[projects\./);
  assert.doesNotMatch(head, /\[hooks\./);
  assert.doesNotMatch(head, /\[notice\]/);
  assert.doesNotMatch(head, /model_providers/);
  assert.doesNotMatch(head, /setup-managed/);
});

test('sharedHeadOf: is idempotent', () => {
  const once = sharedHeadOf(SAMPLE);
  assert.equal(sharedHeadOf(once), once);
});

test('composeCodexConfig: head + generated block + local sections, in that order', () => {
  const out = composeCodexConfig({
    head: 'model = "x"\n\n[tui]\ntheme = "github"\n',
    providersBlock: '[model_providers.deepseek]\nname = "deepseek"\n',
    localSections: "[projects.'/tmp/a']\ntrust_level = \"trusted\"\n",
  });

  const iHead = out.indexOf('[tui]');
  const iGen = out.indexOf('[model_providers.deepseek]');
  const iLocal = out.indexOf("[projects.'/tmp/a']");
  assert.ok(iHead >= 0 && iGen > iHead && iLocal > iGen, `bad order: ${out}`);

  assert.ok(out.includes(CODEX_TOML_START_MARKER));
  assert.ok(out.includes(CODEX_TOML_END_MARKER));
});

test('composeCodexConfig: round-trips through split without drifting', () => {
  const out = composeCodexConfig({
    head: sharedHeadOf(SAMPLE),
    providersBlock: '[model_providers.deepseek]\nname = "deepseek"\n',
    localSections: splitCodexConfig(SAMPLE).local.map(s => s.text).join('\n'),
  });

  // Composing the split of a composed file must be a fixed point.
  const again = composeCodexConfig({
    head: sharedHeadOf(out),
    providersBlock: '[model_providers.deepseek]\nname = "deepseek"\n',
    localSections: splitCodexConfig(out).local.map(s => s.text).join('\n'),
  });
  assert.equal(again, out);
});

test('composeCodexConfig: omits the marker block entirely when there are no providers', () => {
  const out = composeCodexConfig({ head: 'model = "x"\n', providersBlock: '', localSections: '' });
  assert.doesNotMatch(out, /setup-managed/);
  assert.equal(out.trim(), 'model = "x"');
});

test('composeCodexConfig: a host with no local sections yields no trailing noise', () => {
  const out = composeCodexConfig({
    head: 'model = "x"\n',
    providersBlock: '[model_providers.a]\n',
    localSections: '',
  });
  assert.ok(out.endsWith('\n'));
  assert.doesNotMatch(out, /\n\n\n/);
});

test('splitCodexConfig: tolerates a file with no generated block', () => {
  const parts = splitCodexConfig('model = "x"\n\n[tui]\ntheme = "a"\n');
  assert.equal(parts.generated, '');
  assert.deepEqual(parts.local, []);
  assert.deepEqual(parts.shared.map(s => s.header), ['tui']);
});

test('splitCodexConfig: an unterminated generated block does not swallow the rest of the file', () => {
  const broken = `model = "x"\n${CODEX_TOML_START_MARKER}\n[model_providers.a]\n\n[projects.'/tmp/a']\ntrust_level = "trusted"\n`;
  const parts = splitCodexConfig(broken);
  // Local sections must still be recoverable even if the end marker was lost, otherwise
  // a truncated file would silently drop this host's project trust list.
  assert.deepEqual(parts.local.map(s => s.header), ["projects.'/tmp/a'"]);
});
