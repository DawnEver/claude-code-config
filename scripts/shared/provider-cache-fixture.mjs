// Test support: a temp ai-lab install (venv dist-info + providers.toml inputs) and a current
// provider cache built from the real `ai_lab.providers --json` output in
// provider-catalogue.fixture.json (trimmed to three rows; `session` key usernames added
// because lab_commons API_KEY_TASKS does not declare that task yet).

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sourceSha256 } from './provider-cache.mjs';

const FIXTURE = new URL('./provider-catalogue.fixture.json', import.meta.url);

export function catalogueDoc() {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'));
}

/** A temp dir holding a fake venv with ai-lab installed and the two catalogue inputs. */
export function fakeAiLab({ version = catalogueDoc().ai_lab_version, userToml = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-lab-'));
  const python = join(dir, 'venv', 'Scripts', 'python.exe');
  const dist = join(dir, 'venv', 'Lib', 'site-packages', `ai_lab-${version}.dist-info`);
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'METADATA'), `Metadata-Version: 2.4\nName: ai-lab\nVersion: ${version}\n`);
  const packaged = join(dir, 'providers.toml');
  writeFileSync(packaged, '[deepseek]\nurl = "https://api.deepseek.com"\n');
  const user = join(dir, 'user-providers.toml');
  if (userToml !== null) writeFileSync(user, userToml);
  return { dir, python, packaged, user };
}

/** The document `ai_lab.providers --json` would print for `lab`, generated at `at`. */
export function documentFor(lab, at = new Date()) {
  const doc = catalogueDoc();
  doc.generated_at = at.toISOString();
  doc.python = lab.python;
  doc.inputs = [{ path: lab.packaged }, { path: lab.user }];
  doc.source_sha256 = sourceSha256(doc.inputs);
  return doc;
}

/** Write a current cache for `lab` and return its path. */
export function writeCache(lab, doc = documentFor(lab)) {
  const path = join(lab.dir, 'provider-cache.json');
  writeFileSync(path, JSON.stringify(doc));
  return path;
}
