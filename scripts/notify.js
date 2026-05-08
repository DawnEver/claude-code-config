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
let event = null;
let gotoTarget = null;
let logPath = path.join(os.homedir(), '.claude', 'logs', 'notifications.jsonl');
const rest = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--event') { event = args[++i]; continue; }
  if (args[i] === '--goto') { gotoTarget = args[++i]; continue; }
  if (args[i] === '--no-log') { logPath = null; continue; }
  rest.push(args[i]);
}

const title = rest[0] || 'Claude Code';
const message = rest.length > 2 ? rest.slice(1).join(' ') : (rest[1] || '');
const severity = event === 'PostToolUseFailure' ? 'error' : (event === 'Notification' ? 'warn' : 'info');
const cwd = findGitRoot(process.cwd());
const folder = path.basename(cwd);

const entry = {
  ts: new Date().toISOString(),
  event,
  severity,
  title: `${title} [${folder}]`,
  message,
  cwd,
  folder,
  workspace: process.env.CLAUDE_WORKSPACE || null,
  goto: gotoTarget || null,
  ppid: process.ppid,
};

if (logPath) {
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, 'utf-8');
  } catch {}
}
