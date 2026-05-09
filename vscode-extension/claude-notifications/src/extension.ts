import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';

type ClaudeEvent = {
  ts?: string;
  cwd?: string;
  showNative?: boolean;
};

function resolveHome(p: string): string {
  return p.replace('${userHome}', os.homedir());
}

async function jumpTo(e: ClaudeEvent): Promise<void> {
  if (!e.cwd) return;
  try {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(e.cwd), { forceReuseWindow: true });
  } catch {
    vscode.window.showErrorMessage(`Failed to open: ${e.cwd}`);
  }
}

function smartPath(cwd: string, maxLen: number): string {
  if (cwd.length <= maxLen) return cwd;
  const sep = cwd.includes('\\') ? '\\' : '/';
  const parts = cwd.split(/[/\\]/);
  for (let i = 1; i < parts.length; i++) {
    const tail = '…' + sep + parts.slice(i).join(sep);
    if (tail.length <= maxLen) return tail;
  }
  return 'Workspace: …' + sep + parts[parts.length - 1];
}

function vscodeNotificationText(e: ClaudeEvent): string {
  const cwd = e.cwd ?? '';
  if (!cwd) return 'Claude Code Needs Attention';
  return `Claude Code Needs Attention | ${smartPath(cwd, 40)}`;
}

function sendNativeNotification(title: string, message: string): void {
  const platform = os.platform();
  if (platform === 'darwin') {
    const esc = (s: string) => s.replace(/["\\]/g, '\\$&');
    execFile('osascript', ['-e', `display notification "${esc(message)}" with title "${esc(title)}"`]);
  } else if (platform === 'win32') {
    const b64 = (s: string) => Buffer.from(s).toString('base64');
    const ps = [
      '$ErrorActionPreference="SilentlyContinue"',
      '[Windows.UI.Notifications.ToastNotificationManager,Windows.UI.Notifications,ContentType=WindowsRuntime]|Out-Null',
      '[Windows.Data.Xml.Dom.XmlDocument,Windows.Data.Xml.Dom.XmlDocument,ContentType=WindowsRuntime]|Out-Null',
      "$t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64(title) + "'))",
      "$m=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64(message) + "'))",
      "$id='{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
      '$x=New-Object Windows.Data.Xml.Dom.XmlDocument',
      '$x.LoadXml(\'<toast><visual><binding template="ToastText02"><text id="1"/><text id="2"/></binding></visual></toast>\')',
      '$x.GetElementsByTagName("text").Item(0).AppendChild($x.CreateTextNode($t))|Out-Null',
      '$x.GetElementsByTagName("text").Item(1).AppendChild($x.CreateTextNode($m))|Out-Null',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($x))',
    ].join(';');
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]);
  } else {
    execFile('notify-send', [title, message]);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  let fileOffset = 0;
  let catchingUp = true;
  let watcher: fs.FSWatcher | null = null;
  let lastNotif: { key: string; ts: number } | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  let logPath = computeLogPath();

  function computeLogPath(): string {
    return (
      resolveHome(vscode.workspace.getConfiguration('claudeNotifications').get<string>('logPath', '')) ||
      path.join(os.homedir(), '.claude', 'logs', 'notifications.jsonl')
    );
  }

  function pushEvent(e: ClaudeEvent): void {
    if (catchingUp) return;

    const now = Date.now();
    const key = e.cwd ?? '';
    if (lastNotif && lastNotif.key === key && now - lastNotif.ts < 2000) return;
    lastNotif = { key, ts: now };

    vscode.window.showInformationMessage(vscodeNotificationText(e), 'Go to Context').then((sel) => {
      if (sel) jumpTo(e);
    });

    if (e.showNative) {
      sendNativeNotification('Claude Notification', smartPath(e.cwd ?? '', 40));
    }
  }

  function readNewLines(): void {
    try {
      const stat = fs.statSync(logPath);
      if (stat.size < fileOffset) fileOffset = 0;
      const toRead = stat.size - fileOffset;
      if (toRead <= 0) return;

      const buf = Buffer.alloc(toRead);
      const fd = fs.openSync(logPath, 'r');
      fs.readSync(fd, buf, 0, toRead, fileOffset);
      fs.closeSync(fd);
      fileOffset = stat.size;

      buf
        .toString('utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .forEach((line) => {
          try {
            pushEvent(JSON.parse(line));
          } catch {
            /* ignore */
          }
        });
    } catch {
      /* ignore */
    }
  }

  function debouncedRead(): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(readNewLines, 50);
  }

  function startWatching(): void {
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    catchingUp = true;
    readNewLines();
    catchingUp = false;

    try {
      watcher = fs.watch(logPath, { persistent: true }, debouncedRead);
    } catch {
      const dir = path.dirname(logPath);
      fs.mkdirSync(dir, { recursive: true });
      watcher = fs.watch(dir, { persistent: true }, (_evt, filename) => {
        if (filename && path.join(dir, filename.toString()) === logPath) debouncedRead();
      });
    }
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((ev) => {
      if (ev.affectsConfiguration('claudeNotifications')) {
        logPath = computeLogPath();
        startWatching();
      }
    }),
  );

  startWatching();
}

export function deactivate(): void {
  // context.subscriptions handles disposal
}
