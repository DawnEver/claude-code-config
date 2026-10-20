// scripts/shared/provider-cache.mjs — the setup-time copy of ai-lab's provider catalogue.
//
// ai-lab owns the catalogue (urls, per-protocol paths, Claude-role model maps, key usernames).
// cc-config keeps no copy of it: setup runs `<python> -m ai_lab.providers --json` ONCE and
// writes the document to ~/.claude/provider-cache.json; every launch reads only that file, in
// Node, with no Python call. The cache holds no secret (key USERNAMES only).
//
// A launch refuses a cache that is absent or stale, naming the remedy. Stale means any of:
//   (a) source_sha256 differs from a fresh sha256 over the recorded input files (packaged
//       providers.toml bytes, then the user providers.toml bytes, an absent file adding none —
//       the rule ai_lab.providers documents);
//   (b) the ai-lab version installed beside the recorded interpreter differs from the recorded one;
//   (c) the document is older than MAX_AGE_MS.
// There is no silent regeneration and no fallback to a catalogue in claude_env_settings.json.

import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import os from 'os';

export const PROVIDER_CACHE_PATH = join(os.homedir(), '.claude', 'provider-cache.json');
export const PROVIDER_CACHE_SCHEMA = 1;
export const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
export const SETUP_REMEDY = 'node scripts/setup/setup.js';

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** sha256 over the input files in order, an absent file contributing no bytes. */
export function sourceSha256(inputs) {
  const h = createHash('sha256');
  for (const { path } of inputs) if (path && existsSync(path)) h.update(readFileSync(path));
  return h.digest('hex');
}

/**
 * The ai-lab version installed for `python`, read from its `ai_lab-<v>.dist-info` directory
 * (venv layout: Scripts/python.exe -> Lib/site-packages, bin/python -> lib/python3.X/site-packages).
 * Null when none is found.
 */
export function aiLabVersionOnDisk(python) {
  const root = dirname(dirname(python));
  const sites = [join(root, 'Lib', 'site-packages')];
  const lib = join(root, 'lib');
  if (existsSync(lib)) for (const d of readdirSync(lib)) if (d.startsWith('python')) sites.push(join(lib, d, 'site-packages'));
  for (const site of sites) {
    if (!existsSync(site)) continue;
    const dist = readdirSync(site).find((d) => /^ai_lab-.+\.dist-info$/.test(d));
    if (!dist) continue;
    const meta = join(site, dist, 'METADATA');
    const m = existsSync(meta) && /^Version:\s*(\S+)/m.exec(readFileSync(meta, 'utf8'));
    return m ? m[1] : dist.slice('ai_lab-'.length, -'.dist-info'.length);
  }
  return null;
}

/** Shape check of an `ai_lab.providers --json` document; returns an error string or null. */
export function validateCatalogue(doc) {
  if (!doc || typeof doc !== 'object') return 'not a JSON object';
  if (doc.schema_version !== PROVIDER_CACHE_SCHEMA) return `schema_version ${doc.schema_version} is not ${PROVIDER_CACHE_SCHEMA}`;
  for (const k of ['generated_at', 'ai_lab_version', 'python', 'source_sha256']) {
    if (typeof doc[k] !== 'string' || !doc[k]) return `missing ${k}`;
  }
  if (!Array.isArray(doc.inputs)) return 'missing inputs';
  if (!doc.providers || typeof doc.providers !== 'object') return 'missing providers';
  return null;
}

/**
 * Setup: run `<python> -m ai_lab.providers --json` and write the cache.
 * Returns {ok:true, providers:n} or {error}. A missing interpreter or ai-lab refuses by name.
 */
export function writeProviderCache({ python, path = PROVIDER_CACHE_PATH, run = spawnSync } = {}) {
  if (!python) {
    return { error: `no Python for ai-lab: pass --ai-lab-python <path to the ai-lab venv interpreter> to ${SETUP_REMEDY}` };
  }
  const res = run(python, ['-m', 'ai_lab.providers', '--json'], { encoding: 'utf8' });
  if (res.error?.code === 'ENOENT') return { error: `no Python: ${python} not found (the provider cache needs Python + ai-lab)` };
  if (res.error) return { error: `ai_lab.providers failed: ${res.error.message}` };
  if (res.status !== 0) {
    const why = String(res.stderr || '').trim().split('\n').pop() || `exit ${res.status}`;
    return { error: `no ai-lab: ${python} -m ai_lab.providers --json failed (${why})` };
  }
  let doc;
  try { doc = JSON.parse(res.stdout); } catch (e) { return { error: `ai_lab.providers printed no JSON: ${e.message}` }; }
  const bad = validateCatalogue(doc);
  if (bad) return { error: `ai_lab.providers document refused: ${bad}` };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  return { ok: true, providers: Object.keys(doc.providers).length, python: doc.python };
}

/** The interpreter a previous setup recorded, or null. */
export function recordedPython(path = PROVIDER_CACHE_PATH) {
  try { return JSON.parse(readFileSync(path, 'utf8')).python || null; } catch { return null; }
}

/**
 * Launch: the cache if it is current, else {error} naming why and the remedy.
 * @returns {{cache: object} | {error: string}}
 */
export function readProviderCache({
  path = PROVIDER_CACHE_PATH, now = Date.now(), maxAgeMs = MAX_AGE_MS, versionOnDisk = aiLabVersionOnDisk,
} = {}) {
  const refuse = (why) => ({ error: `provider cache ${path} ${why}; rerun \`${SETUP_REMEDY}\`` });
  if (!existsSync(path)) return refuse('is absent');
  let doc;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { return refuse(`is unreadable (${e.message})`); }
  const bad = validateCatalogue(doc);
  if (bad) return refuse(`is refused: ${bad}`);
  const age = now - Date.parse(doc.generated_at);
  if (!(age <= maxAgeMs)) return refuse(`is stale: generated ${doc.generated_at}, older than ${Math.round(maxAgeMs / 86400000)} d`);
  if (sourceSha256(doc.inputs) !== doc.source_sha256) return refuse('is stale: the ai-lab providers.toml inputs changed since setup');
  const installed = versionOnDisk(doc.python);
  if (installed !== doc.ai_lab_version) {
    return refuse(`is stale: ai-lab ${installed ?? '(not installed)'} beside ${doc.python} is not the recorded ${doc.ai_lab_version}`);
  }
  return { cache: doc };
}

export { sha256 };
