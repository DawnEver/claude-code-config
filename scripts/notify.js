#!/usr/bin/env node
// notify.js — Claude Code hook script
// Called by Claude Code on Stop, Notification, and PermissionRequest.
// Writes signal file for the VS Code extension, plus native OS notification fallback.

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { execSync, execFileSync, execFile, spawn } from 'child_process';

// ── State path derivation ──

const STATE_ROOT = path.join(os.homedir(), '.claude', 'focus-state');

function normalizeWorkspaceRoot(workspaceRoot) {
  let s = String(workspaceRoot).replace(/\\/g, '/');
  if (process.platform === 'win32') {
    s = s.replace(/^([a-zA-Z]):/, (_m, d) => d.toLowerCase() + ':');
  }
  if (s.length > 1 && s.endsWith('/') && !s.endsWith(':/')) {
    s = s.slice(0, -1);
  }
  return s;
}

function hashWorkspace(workspaceRoot) {
  return crypto.createHash('sha1').update(normalizeWorkspaceRoot(workspaceRoot)).digest('hex').slice(0, 12);
}

function getStateDir(workspaceRoot) {
  return path.join(STATE_ROOT, hashWorkspace(workspaceRoot));
}

function getSignalPath(workspaceRoot) {
  return path.join(getStateDir(workspaceRoot), 'signal');
}

function getSessionsPath(workspaceRoot) {
  return path.join(getStateDir(workspaceRoot), 'sessions');
}

// ── Stage-ID dedup ──

const SESSIONS_PRUNE_MS = 60 * 60 * 1000;

function readSessions(workspaceRoot) {
  try {
    const data = JSON.parse(fs.readFileSync(getSessionsPath(workspaceRoot), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch { return {}; }
}

function writeSessions(workspaceRoot, map) {
  const dir = getStateDir(workspaceRoot);
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (const key of Object.keys(map)) {
    const u = map[key] && map[key].updatedAt;
    if (typeof u === 'number' && now - u > SESSIONS_PRUNE_MS) delete map[key];
  }
  try { fs.writeFileSync(getSessionsPath(workspaceRoot), JSON.stringify(map)); } catch {}
}

function shouldNotify(workspaceRoot, sessionId, currentEvent) {
  if (!sessionId) return { notify: true, stageId: null };

  const map = readSessions(workspaceRoot);
  const now = Date.now();
  let entry = map[sessionId];

  if (!entry) {
    entry = { stageId: 1, lastEvent: currentEvent, resolved: false, lastNotifiedAt: now, updatedAt: now };
    map[sessionId] = entry;
    writeSessions(workspaceRoot, map);
    return { notify: true, stageId: 1 };
  }

  if (entry.lastEvent === null) {
    entry.lastEvent = currentEvent;
    entry.resolved = false;
    entry.lastNotifiedAt = now;
    entry.updatedAt = now;
    writeSessions(workspaceRoot, map);
    return { notify: true, stageId: entry.stageId };
  }

  if (entry.resolved === true) {
    entry.stageId = (entry.stageId || 0) + 1;
    entry.lastEvent = currentEvent;
    entry.resolved = false;
    entry.lastNotifiedAt = now;
    entry.updatedAt = now;
    writeSessions(workspaceRoot, map);
    return { notify: true, stageId: entry.stageId };
  }

  entry.lastEvent = currentEvent;
  entry.updatedAt = now;
  writeSessions(workspaceRoot, map);
  return { notify: false, stageId: entry.stageId };
}

// ── PID ancestor chain (cross-platform) ──

function getPidChain() {
  const pids = [];
  let currentPid = process.pid;

  if (process.platform === 'win32') {
    while (currentPid && currentPid > 0) {
      pids.push(currentPid);
      try {
        const output = execSync(`wmic process where ProcessId=${currentPid} get ParentProcessId /value`, {
          encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe']
        });
        const match = output.match(/ParentProcessId=(\d+)/);
        if (!match) break;
        const parentPid = parseInt(match[1], 10);
        if (parentPid === currentPid || parentPid === 0) break;
        currentPid = parentPid;
      } catch { break; }
    }
  } else {
    while (currentPid && currentPid > 1) {
      pids.push(currentPid);
      try {
        const output = execSync(`ps -o ppid= -p ${currentPid}`, {
          encoding: 'utf8', timeout: 2000, stdio: ['pipe', 'pipe', 'pipe']
        });
        const parentPid = parseInt(output.trim(), 10);
        if (isNaN(parentPid) || parentPid <= 0 || parentPid === currentPid) break;
        currentPid = parentPid;
      } catch { break; }
    }
  }
  return pids;
}

// ── Native OS notification ──
// All platforms support clicking the notification to open VS Code at the
// workspace root. The PowerShell/dbus tunnel runs detached so it survives
// Claude Code tearing down the hook process tree.

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getVscodeUri(workspaceRoot) {
  let p = String(workspaceRoot).replace(/\\/g, '/');
  // Git Bash paths (/c/Users/...) → Win32 (C:/Users/...)
  if (process.platform === 'win32') {
    p = p.replace(/^\/([a-zA-Z])\//, (_, d) => `${d.toUpperCase()}:/`);
  }
  return encodeURI(`vscode://file/${p}`);
}

function sendNativeNotification(title, message, workspaceRoot) {
  const platform = os.platform();
  if (platform === 'darwin') {
    const vscodeUri = getVscodeUri(workspaceRoot);
    try {
      execSync('which terminal-notifier 2>/dev/null', { stdio: 'pipe', timeout: 2000 });
      execFile('terminal-notifier', [
        '-title', title,
        '-message', message,
        '-open', vscodeUri,
      ]);
      return;
    } catch { /* terminal-notifier not installed */ }
    const esc = (s) => s.replace(/["\\]/g, '\\$&');
    execFile('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`]);
  } else if (platform === 'win32') {
    const vscodeUri = getVscodeUri(workspaceRoot);
    const tmpScript = path.join(os.tmpdir(), `claude-notif-${Date.now()}-${process.pid}.ps1`);
    const psScript = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$template = @"
<toast activationType="protocol" launch="${xmlEscape(vscodeUri)}" duration="long">
  <visual><binding template="ToastGeneric">
    <text>${xmlEscape(title)}</text>
    <text>${xmlEscape(message)}</text>
  </binding></visual>
  <audio src="ms-winsoundevent:Notification.Default" silent="true" />
</toast>
"@
try {
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml($template)
  $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Microsoft.Windows.Shell.RunDialog").Show($toast)
  Start-Sleep -Milliseconds 250
} finally {
  Remove-Item -LiteralPath '${tmpScript.replace(/'/g, "''")}' -Force -ErrorAction SilentlyContinue
}
`;
    try {
      fs.writeFileSync(tmpScript, psScript, 'utf8');
      const child = spawn('cmd.exe', [
        '/c', 'start', '""', '/B',
        'powershell.exe',
        '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
        '-File', tmpScript
      ], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
    } catch {
      try { fs.unlinkSync(tmpScript); } catch {}
    }
  } else {
    // Linux: notify-send (sync, reliable) + dbus-monitor (best-effort click-to-open)
    try {
      execSync('which notify-send 2>/dev/null', { stdio: 'pipe', timeout: 2000 });
      const vscodeUri = getVscodeUri(workspaceRoot);
      const actionId = `claude-${Date.now()}`;

      // Synchronous — throws on failure, notification always reaches the user
      const result = execFileSync('notify-send', [
        title, message,
        '--action', `${actionId}=Open in VS Code`,
        '--app-name', 'Claude Code',
        '--expire-time', '10000',
        '--print-id',
      ], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

      // Best-effort: dbus listener for click handling (detached, survives hook exit)
      const notifyId = result ? result.trim() : '';
      if (notifyId) {
        const dbusScript = `
if command -v dbus-monitor >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then
  timeout 30 dbus-monitor --session \\
    "interface='org.freedesktop.Notifications',member=ActionInvoked" 2>/dev/null | \\
  while IFS= read -r line; do
    if echo "$line" | grep -q "${actionId}"; then
      xdg-open "$VSCODE_URI" 2>/dev/null
      break
    fi
  done
fi`;
        const child = spawn('bash', ['-c', dbusScript], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, VSCODE_URI: vscodeUri }
        });
        child.unref();
      }
      return;
    } catch {
      // Fallback: plain notification, no action button
      execFile('notify-send', [title, message]);
    }
  }
}

// ── Main ──

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const projectName = path.basename(projectDir);

// Parse CLI args
const args = process.argv.slice(2);
let isUserPrompt = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--event' && args[++i] === 'user-prompt') { isUserPrompt = true; }
}

// Read stdin JSON from Claude Code hook (only when piped, not from TTY)
let hookEvent = 'waiting';
let hookEventName = '';
let sessionId = '';
if (!process.stdin.isTTY) {
  try {
    const stdinData = fs.readFileSync(0, 'utf8');
    const input = JSON.parse(stdinData);
    hookEventName = input.hook_event_name || '';
    sessionId = input.session_id || '';
    if (hookEventName.toLowerCase() === 'stop') hookEvent = 'completed';
  } catch {}
}

// Find workspace root
const homeDir = process.env.HOME || process.env.USERPROFILE || '';
let workspaceRoot = projectDir;
let searchDir = projectDir;
while (searchDir !== path.dirname(searchDir)) {
  if (searchDir === homeDir) break;
  if (fs.existsSync(path.join(searchDir, '.vscode'))) {
    workspaceRoot = searchDir;
  }
  searchDir = path.dirname(searchDir);
}

// Ensure state dir exists
const stateDir = getStateDir(workspaceRoot);
fs.mkdirSync(stateDir, { recursive: true });

// UserPromptSubmit: just advance stage, no signal, no notification
if (isUserPrompt) {
  const map = readSessions(workspaceRoot);
  const now = Date.now();
  const entry = map[sessionId] || { stageId: 0, lastEvent: null, resolved: false, lastNotifiedAt: 0, updatedAt: now };
  entry.stageId = (entry.stageId || 0) + 1;
  entry.lastEvent = null;
  entry.resolved = false;
  entry.updatedAt = now;
  map[sessionId] = entry;
  writeSessions(workspaceRoot, map);
  process.exit(0);
}

// Stage-ID dedup
const dedup = shouldNotify(workspaceRoot, sessionId, hookEvent);
if (!dedup.notify) process.exit(0);

// Build PID chain and write signal file
const pids = getPidChain();
const signalPayload = {
  version: 2,
  event: hookEvent,
  hookEventName,
  sessionId,
  project: projectName,
  pids,
  state: 'pending',
  timestamp: Date.now()
};
fs.writeFileSync(getSignalPath(workspaceRoot), JSON.stringify(signalPayload, null, 2));

// Native notification as fallback
const title = hookEvent === 'completed' ? 'Claude Code — Done' : 'Claude Code';
const message = hookEvent === 'completed'
  ? `Task completed in: ${projectName}`
  : `Waiting for your response in: ${projectName}`;
sendNativeNotification(title, message, workspaceRoot);
