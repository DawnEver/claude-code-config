#!/usr/bin/env node
// notify.js — Claude Code hook script
// Sends native OS notifications for Claude Code events.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync, spawn } from 'child_process';

// ── Native OS notification ──
// All platforms support clicking the notification to open VS Code at the
// workspace root. The PowerShell/dbus tunnel runs detached so it survives
// Claude Code tearing down the hook process tree.

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getVscodeUri(workspaceRoot) {
  if (!workspaceRoot) return '';
  let p = String(workspaceRoot).replace(/\\/g, '/');
  // Convert MSYS2 paths (/c/Users/...) to Windows paths (C:/Users/...)
  if (process.platform === 'win32') {
    p = p.replace(/^\/([a-zA-Z])\//, (_, d) => `${d.toUpperCase()}:/`);
  }
  return encodeURI(`vscode://file/${p}`);
}

function sendNativeNotification(title, message, workspaceRoot) {
  const platform = os.platform();
  if (platform === 'darwin') {
    const vscodeUri = getVscodeUri(workspaceRoot);
    const tnArgs = ['-title', title, '-message', message];
    if (vscodeUri) tnArgs.push('-open', vscodeUri);
    try {
      execFileSync('terminal-notifier', tnArgs, { timeout: 5000, stdio: 'ignore' });
    } catch {
      // terminal-notifier unavailable/failed — fall back to osascript as last resort
      try {
        const esc = (s) => s.replace(/["\\]/g, '\\$&');
        execFileSync('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`], { timeout: 3000, stdio: 'ignore' });
      } catch {}
    }
  } else if (platform === 'win32') {
    const vscodeUri = getVscodeUri(workspaceRoot);
    const tmpScript = path.join(os.tmpdir(), `claude-notif-${Date.now()}-${process.pid}.ps1`);
    const toastLaunch = vscodeUri
      ? `activationType="protocol" launch="${xmlEscape(vscodeUri)}"`
      : 'activationType="background"';
    const psScript = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$template = @"
<toast ${toastLaunch} duration="long">
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
  Start-Sleep -Milliseconds 2000
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
    const vscodeUri = getVscodeUri(workspaceRoot);
    if (vscodeUri) {
      try {
        const actionId = `claude-${Date.now()}`;
        const result = execFileSync('notify-send', [
          title, message,
          '--action', `${actionId}=Open in VS Code`,
          '--app-name', 'Claude Code',
          '--expire-time', '10000',
          '--print-id',
        ], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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
      } catch {
        execFileSync('notify-send', [title, message]);
      }
    } else {
      execFileSync('notify-send', [title, message]);
    }
  }
}

// ── Main ──

// Parse CLI args
const args = process.argv.slice(2);
let isUserPrompt = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--event' && args[++i] === 'user-prompt') { isUserPrompt = true; }
}

// Don't notify on user prompt events
if (isUserPrompt) process.exit(0);

// Read stdin JSON from Claude Code hook
let hookEvent = 'waiting';
let hookCwd = '';
if (!process.stdin.isTTY) {
  try {
    const stdinData = fs.readFileSync(0, 'utf8');
    const input = JSON.parse(stdinData);
    const hookEventName = (input.hook_event_name || '').toLowerCase();
    // Refer to https://code.claude.com/docs/en/hooks
    if (hookEventName === 'stop' || hookEventName === 'taskcompleted' || hookEventName === 'task_completed') {
      hookEvent = 'completed';
    } else if (hookEventName === 'posttoolusefailure' || hookEventName === 'post_tool_use_failure') {
      hookEvent = 'error';
    }
    hookCwd = input.cwd || '';
    if (hookCwd) hookCwd = hookCwd.replace(/\//g, path.sep);
  } catch {}
}

const projectDir = hookCwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const projectName = path.basename(projectDir);

// Find workspace root (for click-to-open VS Code)
// 1. If in a git repo, git root is always the best workspace root
// 2. Otherwise walk up for .vscode
// 3. Never use homeDir as workspace root
const homeDir = process.platform === 'win32'
  ? (process.env.USERPROFILE || process.env.HOME || '').replace(/^\/([a-zA-Z])\//, (_, d) => `${d.toUpperCase()}:\\`)
  : (process.env.HOME || '');
let workspaceRoot = '';

// First, try git root (works from any subdirectory in a repo)
try {
  const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    cwd: projectDir
  }).trim();
  if (gitRoot) workspaceRoot = gitRoot;
} catch {
  // Not in a git repo — walk up for .vscode
  let searchDir = projectDir;
  while (searchDir !== path.dirname(searchDir)) {
    if (searchDir === homeDir) break;
    if (fs.existsSync(path.join(searchDir, '.vscode'))) {
      workspaceRoot = searchDir;
      break;
    }
    searchDir = path.dirname(searchDir);
  }
}

// If nothing worked, use projectDir directly but NEVER homeDir
if (!workspaceRoot || workspaceRoot === homeDir) {
  workspaceRoot = projectDir === homeDir ? '' : projectDir;
}

// Send native notification
let title, message;
if (hookEvent === 'completed') {
  title = 'Claude Code — Done';
  message = `Task completed in: ${projectName}`;
} else if (hookEvent === 'error') {
  title = 'Claude Code — Error';
  message = `Tool failed in: ${projectName}`;
} else {
  title = 'Claude Code';
  message = `Waiting for your response in: ${projectName}`;
}
sendNativeNotification(title, message, workspaceRoot);
