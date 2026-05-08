import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';

/**
 * Represents a notification event from Claude Code
 */
type ClaudeEvent = {
  ts?: string;
  event?: string;
  severity?: string;
  title?: string;
  message?: string;
  cwd?: string;
  folder?: string;
  workspace?: string;
  goto?: string | null;
  showNative?: boolean | null;
};

function resolveHome(p: string): string {
  return p.replace('${userHome}', os.homedir());
}

function dedupKey(e: ClaudeEvent): string {
  return `${e.event ?? ''}|${e.folder ?? e.title ?? ''}|${e.message ?? ''}`;
}

function formatLine(e: ClaudeEvent): string {
  const ts = e.ts ? new Date(e.ts).toLocaleTimeString() : new Date().toLocaleTimeString();
  const sev = e.severity ? ` ${e.severity.toUpperCase()}` : '';
  const msg = e.message ?? '';
  const cwd = e.cwd ?? e.workspace ?? '';
  return `[${ts}] [${e.event ?? 'Event'}${sev}] ${msg}${cwd ? ` (${cwd})` : ''}`;
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

async function jumpTo(e: ClaudeEvent): Promise<void> {
  const target = e.cwd || e.workspace;
  if (!target) {
    vscode.window.showWarningMessage('No workspace/file info found on this event.');
    return;
  }
  try {
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceReuseWindow: true });
  } catch {
    vscode.window.showErrorMessage(`Failed to open: ${target}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Claude Notifications');
  context.subscriptions.push(output);

  let events: ClaudeEvent[] = [];
  let fileOffset = 0;
  let catchingUp = true;
  let watcher: fs.FSWatcher | null = null;
  let config = getConfig();
  let lastNotif: { key: string; ts: number } | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;

  function getConfig() {
    const c = vscode.workspace.getConfiguration('claudeNotifications');
    return {
      logPath: resolveHome(c.get<string>('logPath', `${os.homedir()}/.claude/logs/notifications.jsonl`)),
      maxEvents: c.get<number>('maxEvents', 500),
    };
  }

  function pushEvent(e: ClaudeEvent): void {
    const max = Math.max(10, Math.min(config.maxEvents, 5000));
    events.push(e);
    if (events.length > max) events = events.slice(-max);
    output.appendLine(formatLine(e));
    if (catchingUp) return;

    const timeStr = e.ts
      ? new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const displayTitle = e.folder || e.title || 'Claude Code';
    const text = e.message ? `[${timeStr}] ${displayTitle}: ${e.message}` : `[${timeStr}] ${displayTitle}`;
    const hasTarget = !!(e.goto || e.cwd || e.workspace);
    const label = hasTarget ? 'Go to Claude Code' : undefined;

    const now = Date.now();
    const key = dedupKey(e);
    if (lastNotif && lastNotif.key === key && now - lastNotif.ts < 2000) return;
    lastNotif = { key, ts: now };

    const showFn =
      e.severity === 'error'
        ? vscode.window.showErrorMessage
        : e.severity === 'warn'
          ? vscode.window.showWarningMessage
          : vscode.window.showInformationMessage;

    if (label) {
      showFn(text, label).then((sel) => {
        if (sel === label) jumpTo(e);
      });
    } else {
      showFn(text);
    }

    if (e.showNative) {
      sendNativeNotification(displayTitle, e.message ? `[${timeStr}] ${e.message}` : `[${timeStr}]`);
    }
  }

  function readNewLines(): void {
    try {
      const stat = fs.statSync(config.logPath);
      if (stat.size < fileOffset) fileOffset = 0;
      const toRead = stat.size - fileOffset;
      if (toRead <= 0) return;

      const buf = Buffer.alloc(toRead);
      const fd = fs.openSync(config.logPath, 'r');
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
      watcher = fs.watch(config.logPath, { persistent: true }, debouncedRead);
    } catch {
      const dir = path.dirname(config.logPath);
      fs.mkdirSync(dir, { recursive: true });
      watcher = fs.watch(dir, { persistent: true }, (_evt, filename) => {
        if (filename && path.join(dir, filename.toString()) === config.logPath) debouncedRead();
      });
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeNotifications.showOutput', () => output.show(true)),
    vscode.commands.registerCommand('claudeNotifications.clearHistory', () => {
      events = [];
      try {
        fileOffset = fs.existsSync(config.logPath) ? fs.statSync(config.logPath).size : 0;
      } catch {
        fileOffset = 0;
      }
      output.clear();
      output.appendLine('[info] cleared (ignoring previous log entries)');
    }),
    vscode.commands.registerCommand('claudeNotifications.jumpToRecent', async () => {
      if (events.length === 0) {
        vscode.window.showInformationMessage('No Claude events yet.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        [...events].reverse().map((e) => ({
          label: formatLine(e),
          description: e.goto ?? e.workspace ?? e.cwd ?? '',
          e,
        })),
        { placeHolder: 'Select an event to jump to', matchOnDescription: true },
      );
      if (picked) await jumpTo(picked.e);
    }),
    vscode.workspace.onDidChangeConfiguration((ev) => {
      if (ev.affectsConfiguration('claudeNotifications')) {
        config = getConfig();
        startWatching();
      }
    }),
  );

  startWatching();
  output.appendLine('[info] Claude Notifications extension active');
}

export function deactivate(): void {
  // context.subscriptions handles disposal
}
