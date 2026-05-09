import fs from 'fs';
import os from 'os';
import path from 'path';

function findGitRoot(dir) {
  let current = path.resolve(dir);
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    current = path.dirname(current);
  }
  return dir;
}

const args = process.argv.slice(2);
let showNative = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--show-native') { showNative = args[++i] === 'true'; continue; }
}

const cwd = findGitRoot(process.cwd());

const entry = {
  ts: new Date().toISOString(),
  cwd,
  showNative,
};

const logPath = path.join(os.homedir(), '.claude', 'logs', 'notifications.jsonl');
try {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf-8');
} catch {}
