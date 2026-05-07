import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ClaudeEvent, dedupKey, formatLine, resolveHome } from './types';
import { jumpTo } from './terminal';

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Claude Notifications');
  context.subscriptions.push(output);

  // ---- State ----
  let events: ClaudeEvent[] = [];
  let fileOffset = 0;
  let catchingUp = true;
  let watcher: fs.FSWatcher | null = null;
  const DEDUP_WINDOW_MS = 2_000;
  let lastNotif: { key: string; ts: number } | null = null;

  // ---- Config ----
  function cfg() {
    const c = vscode.workspace.getConfiguration('claudeNotifications');
    return {
      logPath: resolveHome(c.get<string>('logPath', path.join(os.homedir(), '.claude', 'logs', 'notifications.jsonl'))),
      maxEvents: c.get<number>('maxEvents', 500),
    };
  }

  // ---- Process a new event ----
  function pushEvent(e: ClaudeEvent) {
    // Cap history
    const max = Math.max(10, Math.min(cfg().maxEvents, 5000));
    events.push(e);
    if (events.length > max) events = events.slice(events.length - max);

    output.appendLine(formatLine(e));

    // Skip popups during initial catchup
    if (catchingUp) return;

    const timeStr = e.ts
      ? new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const displayTitle = e.folder || e.title || 'Claude Code';
    const text = e.message ? `[${timeStr}] ${displayTitle}: ${e.message}` : `[${timeStr}] ${displayTitle}`;

    // Dedup burst suppression
    const now = Date.now();
    const dKey = dedupKey(e);
    if (lastNotif && lastNotif.key === dKey && now - lastNotif.ts < DEDUP_WINDOW_MS) return;
    lastNotif = { key: dKey, ts: now };

    // Errors → popup. Info/warn → silent (logged to output channel).
    if (e.severity === 'error') {
      const jumpLabel = e.goto || e.cwd || e.workspace ? 'Go to Claude Code' : undefined;
      const buttons = jumpLabel ? ['Dismiss', jumpLabel] : ['Dismiss'];
      vscode.window.showErrorMessage(text, ...buttons).then((sel) => {
        if (sel === jumpLabel) jumpTo(e);
      });
    }
  }

  // ---- File watching ----
  function readNewLines(logPath: string) {
    try {
      const stat = fs.statSync(logPath);
      if (stat.size < fileOffset) fileOffset = 0;
      const toRead = stat.size - fileOffset;
      if (toRead <= 0) return;
      const buf = Buffer.allocUnsafe(toRead);
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
            pushEvent(JSON.parse(line) as ClaudeEvent);
          } catch {
            output.appendLine(`[warn] Failed to parse JSONL line: ${line}`);
          }
        });
    } catch {}
  }

  function startWatching() {
    const { logPath } = cfg();
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    catchingUp = true;
    readNewLines(logPath);
    catchingUp = false;
    // Watch log file for new notifications
    try {
      watcher = fs.watch(logPath, { persistent: true }, () => readNewLines(logPath));
    } catch {
      const dir = path.dirname(logPath);
      fs.mkdirSync(dir, { recursive: true });
      watcher = fs.watch(dir, { persistent: true }, (_evt, filename) => {
        if (filename && path.join(dir, filename.toString()) === logPath) readNewLines(logPath);
      });
    }
  }

  // ---- Commands ----
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeNotifications.showOutput', () => output.show(true)),

    vscode.commands.registerCommand('claudeNotifications.clearHistory', () => {
      events = [];
      try {
        const { logPath } = cfg();
        fileOffset = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
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
        events
          .slice()
          .reverse()
          .map((e) => ({
            label: formatLine(e),
            description: e.goto ?? e.workspace ?? e.cwd ?? '',
            e,
          })),
        { placeHolder: 'Select an event to jump to', matchOnDescription: true },
      );
      if (picked) {
        await jumpTo(picked.e);
      }
    }),
  );

  // ---- Start ----
  startWatching();

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((ev) => {
      if (ev.affectsConfiguration('claudeNotifications')) startWatching();
    }),
  );

  output.appendLine('[info] Claude Notifications extension active');
}

export function deactivate() {}
