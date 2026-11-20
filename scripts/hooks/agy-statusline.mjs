#!/usr/bin/env node
// scripts/hooks/agy-statusline.mjs — Antigravity's statusLine command (settings.json
// `statusLine: {type: "command", command: "node <~/.claude/scripts>/hooks/agy-statusline.mjs"}`).
// agy writes its status JSON to stdin on every update; this tees its `quota` into the dashboard's
// series (quota.mjs teeAgyUsage, only on a host with a configured dashboard, as hud-hook.js for
// Claude) and prints one line: model, context use, each pool's most-used window. Never fails the line.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isMain } from '../shared/is-main.mjs';

/** The status line for a payload: `Claude Opus 5.5 (Low) · ctx 31% · gemini 5h 2% · claude 7d 40%`. */
export function statusText(p, pools = {}) {
  const parts = [];
  const model = p?.model?.display_name ?? p?.model?.id ?? (typeof p?.model === 'string' ? p.model : null);
  if (model) parts.push(model);
  const ctx = p?.context_window?.used_percentage;
  if (Number.isFinite(ctx)) parts.push(`ctx ${Math.round(ctx)}%`);
  for (const [pool, windows] of Object.entries(pools)) {
    const top = Object.entries(windows).sort(([, a], [, b]) => b.used - a.used)[0];
    if (top) parts.push(`${pool} ${top[0]} ${Math.round(top[1].used)}%`);
  }
  return parts.join(' · ') || 'agy';
}

async function main() {
  let raw = '';
  if (!process.stdin.isTTY) for await (const c of process.stdin) raw += c;
  let p = null;
  try { p = JSON.parse(raw); } catch { /* not JSON */ }
  if (p && typeof p === 'object' && Object.keys(p).length > 0 && !process.env.NODE_TEST_CONTEXT && process.env.CC_CONFIG_AGY_SMOKE !== '1') {
    try {
      const dir = path.join(os.homedir(), '.claude', 'bridge');
      fs.mkdirSync(dir, { recursive: true });
      const dst = path.join(dir, 'agy-statusline-last.json');
      const tmp = `${dst}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(p));
      fs.renameSync(tmp, dst);
    } catch { /* diagnostic snapshot only */ }
  }
  let pools = {};
  try {
    const { recordsQuota, teeAgyUsage, agyPools } = await import('../bridge/quota.mjs');
    pools = recordsQuota() ? teeAgyUsage(p) : agyPools(p);
  } catch { /* quota is optional */ }
  process.stdout.write(statusText(p, pools) + '\n');
}

if (isMain(import.meta.url)) main().catch(() => process.stdout.write('agy\n')).finally(() => process.exit(0));
