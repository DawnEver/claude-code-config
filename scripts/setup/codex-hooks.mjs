// Machine-local native hook definitions. User hooks survive; trust is exclusively Codex's.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { writeFileAtomic } from './codex-config-file.mjs';

const PREFIX = 'cc-config:';
const own = h => h?.statusMessage?.startsWith(PREFIX) && /codex-hook\.mjs/.test(h.command ?? '');
const events = ['SessionStart', 'PreToolUse', 'PermissionRequest', 'SessionEnd'];
const timeoutFor = event => event === 'SessionEnd' ? 3 : event === 'SessionStart' ? 120 : 5;
const commandFor = argv => {
  const data = Buffer.from(JSON.stringify(argv)).toString('base64');
  return `node -e "/* codex-hook.mjs */const a=JSON.parse(Buffer.from('${data}','base64').toString());const r=require('node:child_process').spawnSync(a[0],a.slice(1),{stdio:'inherit'});process.exit(r.error?1:(r.status??1))"`;
};
export function hookDefinitionId({ scriptsDir, node = process.execPath }, event) {
  // Canonicalize the self-reference; bind every handler field, including bootstrap code.
  const command = commandFor([node, path.join(scriptsDir, 'hooks', 'codex-hook.mjs'), '--event', event, '--definition', '<definition>']);
  return hooksFingerprint({ type: 'command', command, commandWindows: command, statusMessage: `${PREFIX}${event}`, timeout: timeoutFor(event) });
}

export function managedCodexHooks({ scriptsDir, node = process.execPath }) {
  const script = path.join(scriptsDir, 'hooks', 'codex-hook.mjs');
  return Object.fromEntries(events.map(event => {
    // Only fixed code and base64 enter a shell. Local paths are decoded as argv data,
    // never interpreted as shell substitutions on POSIX, cmd or PowerShell.
    const command = commandFor([node, script, '--event', event, '--definition', hookDefinitionId({ scriptsDir, node }, event)]);
    return [event, [{ hooks: [{ type: 'command', command,
      commandWindows: command,
      statusMessage: `${PREFIX}${event}`, timeout: timeoutFor(event) }],
    }]];
  }));
}

export const hooksFingerprint = hooks => createHash('sha256').update(JSON.stringify(hooks)).digest('hex');

export function installCodexHooks({ codexDir = path.join(os.homedir(), '.codex'), scriptsDir, node } = {}) {
  const file = path.join(codexDir, 'hooks.json');
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw new Error('hooks.json is user-linked; refusing to write through it');
  const before = stat ? fs.readFileSync(file, 'utf8') : null;
  const config = before ? JSON.parse(before) : {};
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      (config.hooks !== undefined && (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks))))
    throw new Error('hooks.json has an invalid object shape');
  const hooks = config.hooks ?? {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new Error(`hooks.${event} must be an array`);
    hooks[event] = groups.map(group => {
      if (!Array.isArray(group.hooks)) throw new Error(`hooks.${event} handler group must contain a hooks array`);
      if (!group.hooks.some(own)) return group;
      const remaining = group.hooks.filter(h => !own(h));
      return remaining.length ? { ...group, hooks: remaining } : null;
    }).filter(group => group !== null);
    if (!hooks[event].length) delete hooks[event];
  }
  for (const [event, groups] of Object.entries(managedCodexHooks({ scriptsDir, node })))
    hooks[event] = [...(hooks[event] ?? []), ...groups];
  const next = JSON.stringify({ ...config, hooks }, null, 2) + '\n';
  if (next !== before) { fs.mkdirSync(codexDir, { recursive: true }); writeFileAtomic(file, next); }
  return { changed: next !== before, file, reviewRequired: true };
}

export function inspectCodexHooks({ codexDir = path.join(os.homedir(), '.codex'), scriptsDir, node } = {}) {
  const expected = managedCodexHooks({ scriptsDir, node });
  let config;
  try { config = JSON.parse(fs.readFileSync(path.join(codexDir, 'hooks.json'), 'utf8')); }
  catch { return { installed: false, executed: false }; }
  let installed = false;
  try {
    installed = Object.entries(expected).every(([event, groups]) =>
      JSON.stringify((config.hooks?.[event] ?? []).flatMap(g => g.hooks ?? []).filter(own)) === JSON.stringify(groups[0].hooks));
  } catch { /* malformed user data is reported, never rewritten */ }
  const observed = {};
  for (const event of events) {
    let receipt;
    try { receipt = JSON.parse(fs.readFileSync(path.join(codexDir, 'harness-hooks', `${event}.json`), 'utf8')); } catch { /* not yet executed */ }
    observed[event] = { executed: installed && receipt?.definition === hookDefinitionId({ scriptsDir, node }, event), at: receipt?.at ?? null };
  }
  return { installed, executed: installed && events.every(event => observed[event].executed), events: observed };
}
