import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** One active home per process. Never discover account directories by guessing names. */
export function resolveCodexHome({ env = process.env, home = os.homedir(), cwd = process.cwd() } = {}) {
  let value = typeof env.CODEX_HOME === 'string' ? env.CODEX_HOME.trim() : '';
  if (!value) return path.join(home, '.codex');
  if (value === '~') value = home;
  else if (/^~[\\/]/.test(value)) value = path.join(home, value.slice(2));
  return path.resolve(cwd, value);
}

/** Opaque home scope for local derived cursors/series; never transmit a private path. */
export function codexHomeKey(home = resolveCodexHome()) {
  return createHash('sha256').update(process.platform === 'win32' ? path.resolve(home).toLowerCase() : path.resolve(home)).digest('hex').slice(0, 16);
}

// Which homes exist is what launches say, never a guess at directory names: each `codc`/`cods`
// launch (codex.js -> bridge ensure) records its CODEX_HOME here, and the bridge daemon follows
// the base home plus every recorded home still on disk — one adapter, one account each.
const sameHome = (a, b) => codexHomeKey(a) === codexHomeKey(b);
export const codexHomesFile = (home = os.homedir()) => path.join(home, '.claude', 'bridge', 'codex-homes.json');

function readRecorded(file) {
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(v) ? v.filter((h) => typeof h === 'string' && path.isAbsolute(h)) : []; } catch { return []; }
}

/** Record a home a launch runs in; the base home needs no record. Best effort. */
export function recordCodexHome(codexHome, { file = codexHomesFile(), home = os.homedir() } = {}) {
  const base = resolveCodexHome({ env: {}, home });
  const recorded = readRecorded(file);
  if (sameHome(codexHome, base) || recorded.some((h) => sameHome(h, codexHome))) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([...recorded, path.resolve(codexHome)], null, 2) + '\n');
  } catch { /* best effort */ }
}

/** The homes this machine's Codex runs in: the base home first, then each recorded one still present. */
export function codexHomes({ file = codexHomesFile(), home = os.homedir() } = {}) {
  const base = resolveCodexHome({ env: {}, home });
  const out = [base];
  for (const h of readRecorded(file)) if (fs.existsSync(h) && !out.some((o) => sameHome(o, h))) out.push(h);
  return out;
}

/** A home's label (Topic title `codex:<label>`, the dashboard's account alias): null for the base home, else its dir name. */
export function codexHomeLabel(codexHome, home = os.homedir()) {
  if (sameHome(codexHome, resolveCodexHome({ env: {}, home }))) return null;
  const name = path.basename(path.resolve(codexHome)).replace(/^\.?codex-/i, '').replace(/^\./, '');
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || codexHomeKey(codexHome);
}
