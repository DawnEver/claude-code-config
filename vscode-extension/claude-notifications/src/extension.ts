import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
};

/**
 * Resolve ${userHome} placeholder in paths
 */
function resolveHome(p: string): string {
  return p.includes('${userHome}') ? p.replace('${userHome}', os.homedir()) : p;
}

/**
 * Send native OS notification using platform-specific methods
 * - macOS: Use osascript with the correct VS Code sender (detected at runtime)
 * - Windows: PowerShell Toast Notification
 * - Linux: notify-send
 */
function sendNativeNotification(title: string, message: string, event?: ClaudeEvent) {
  const platform = os.platform();

  if (platform === 'darwin') {
    // macOS: Use simple AppleScript notification - no activation on click
    const messageEscaped = message.replace(/["\\]/g, '\\$&');
    const titleEscaped = title.replace(/["\\]/g, '\\$&');

    // Use a neutral notification that won't activate any app when clicked
    const script = `display notification "${messageEscaped}" with title "${titleEscaped}"`;
    execFile('osascript', ['-e', script]);
  } else if (platform === 'win32') {
    // Windows: Use PowerShell with WinRT Toast Notifications
    // Base64 encoding safely handles special characters
    const b64Title = Buffer.from(title).toString('base64');
    const b64Message = Buffer.from(message).toString('base64');
    const psScript = [
      '$ErrorActionPreference = "SilentlyContinue"',
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
      '$t = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(\'' + b64Title + '\'))',
      '$m = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String(\'' + b64Message + '\'))',
      '$APP_ID = \'{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe\'',
      '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
      '$xml.LoadXml(\'<toast><visual><binding template="ToastText02"><text id="1"></text><text id="2"></text></binding></visual></toast>\')',
      '$xml.GetElementsByTagName("text").Item(0).AppendChild($xml.CreateTextNode($t)) | Out-Null',
      '$xml.GetElementsByTagName("text").Item(1).AppendChild($xml.CreateTextNode($m)) | Out-Null',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($APP_ID).Show([Windows.UI.Notifications.ToastNotification]::new($xml))',
    ].join('; ');
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript]);
  } else {
    // Linux: Use notify-send (libnotify)
    execFile('notify-send', [title, message]);
  }
}

/**
 * Activate the Claude Notifications extension
 */
export function activate(context: vscode.ExtensionContext) {
  // Create output channel for logging
  const output = vscode.window.createOutputChannel('Claude Notifications');

  // State management
  let events: ClaudeEvent[] = [];
  let fileOffset = 0;
  let catchingUp = true;
  let watcher: fs.FSWatcher | null = null;
  // Track last displayed notification to suppress duplicate bursts
  const DEDUP_WINDOW_MS = 2_000;
  let lastNotif: { key: string; ts: number } | null = null;

  /**
   * Get extension configuration
   */
  function cfg() {
    const c = vscode.workspace.getConfiguration('claudeNotifications');
    return {
      logPath: resolveHome(c.get<string>('logPath', path.join(os.homedir(), '.claude', 'logs', 'notifications.jsonl'))),
      maxEvents: c.get<number>('maxEvents', 500),
    };
  }

  /**
   * Format an event for display in the output channel
   */
  function formatLine(e: ClaudeEvent): string {
    const ts = e.ts ? new Date(e.ts).toLocaleTimeString() : new Date().toLocaleTimeString();
    const ev = e.event ?? 'Event';
    const sev = e.severity ? ` ${e.severity.toUpperCase()}` : '';
    const msg = e.message ?? '';
    const cwd = e.cwd ?? e.workspace ?? '';
    const tail = cwd ? ` (${cwd})` : '';
    return `[${ts}] [${ev}${sev}] ${msg}${tail}`;
  }

  /**
   * Jump to a specific location or workspace from an event
   * - If goto contains file:line:col, open that file at position
   * - Otherwise, open the workspace folder
   */
  async function jumpTo(e: ClaudeEvent) {
    const target = e.goto || e.cwd || e.workspace;
    if (!target) {
      vscode.window.showWarningMessage('No workspace/file info found on this event.');
      return;
    }

    // Try to parse as file:line:col format first
    const m = target.match(/^(.*?):(\d+):(\d+)$/);
    if (m) {
      const uri = vscode.Uri.file(m[1]);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: false });
      const pos = new vscode.Position(Math.max(0, Number(m[2]) - 1), Math.max(0, Number(m[3]) - 1));
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      return;
    }

    // Fallback to opening workspace folder
    try {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target), { forceReuseWindow: true });
    } catch {
      vscode.window.showErrorMessage(`Failed to open: ${target}`);
    }
  }

  /**
   * Process a new event: add to history, show notifications
   */
  function pushEvent(e: ClaudeEvent) {
    // Keep event history within configured limits
    const max = Math.max(10, Math.min(cfg().maxEvents, 5000));
    events.push(e);
    if (events.length > max) events = events.slice(events.length - max);

    // Log to output channel
    output.appendLine(formatLine(e));

    // Don't show popups during initial catchup
    if (catchingUp) return;

    // Prepare notification content: title shows folder name when available
    const timeStr = e.ts ? new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const displayTitle = e.folder || e.title || 'Claude Code';
    const text = e.message ? `[${timeStr}] ${displayTitle}: ${e.message}` : `[${timeStr}] ${displayTitle}`;
    const hasTarget = !!(e.goto || e.cwd || e.workspace);
    const label = hasTarget ? 'Go to Claude Code' : undefined;

    // Dedup: skip if identical Notification event bursts within 10s.
    // Use stable key (folder + message) — NOT the display text which includes
    // a time string that changes across minute boundaries.
    const now = Date.now();
    const stableKey = `${e.event ?? ''}|${e.folder ?? e.title ?? ''}|${e.message ?? ''}`;
    const isDuplicate = lastNotif !== null && lastNotif.key === stableKey && (now - lastNotif.ts) < DEDUP_WINDOW_MS;

    if (!isDuplicate) {
      lastNotif = { key: stableKey, ts: now };
      const showFn = e.severity === 'error' ? vscode.window.showErrorMessage :
                     e.severity === 'warn' ? vscode.window.showWarningMessage :
                     vscode.window.showInformationMessage;

      if (label) {
        showFn(text, label).then(sel => { if (sel === label) jumpTo(e); });
      } else {
        showFn(text);
      }

      sendNativeNotification(displayTitle, e.message ? `[${timeStr}] ${e.message}` : `[${timeStr}]`, e);
    }
  }

  /**
   * Read and process new lines from the log file
   */
  function readNewLines(logPath: string) {
    try {
      const stat = fs.statSync(logPath);

      // Reset offset if file was truncated
      if (stat.size < fileOffset) fileOffset = 0;

      const toRead = stat.size - fileOffset;
      if (toRead <= 0) return;

      // Read new content since last read
      const buf = Buffer.allocUnsafe(toRead);
      const fd = fs.openSync(logPath, 'r');
      fs.readSync(fd, buf, 0, toRead, fileOffset);
      fs.closeSync(fd);

      fileOffset = stat.size;

      // Parse JSONL lines and push events
      buf.toString('utf8').split(/\r?\n/).filter(Boolean).forEach(line => {
        try { pushEvent(JSON.parse(line) as ClaudeEvent); }
        catch { output.appendLine(`[warn] Failed to parse JSONL line: ${line}`); }
      });
    } catch {}
  }

  /**
   * Start watching the log file for changes
   */
  function startWatching() {
    const { logPath } = cfg();

    // Clean up existing watcher
    if (watcher) { watcher.close(); watcher = null; }

    // Read existing content first (without showing popups)
    catchingUp = true;
    readNewLines(logPath);
    catchingUp = false;

    // Watch the log file for changes
    try {
      watcher = fs.watch(logPath, { persistent: true }, () => readNewLines(logPath));
    } catch {
      // If file doesn't exist, watch its directory instead
      const dir = path.dirname(logPath);
      fs.mkdirSync(dir, { recursive: true });
      watcher = fs.watch(dir, { persistent: true }, (_evt, filename) => {
        if (filename && path.join(dir, filename.toString()) === logPath) readNewLines(logPath);
      });
    }
  }

  // Register extension commands
  context.subscriptions.push(
    // Show output channel
    vscode.commands.registerCommand('claudeNotifications.showOutput', () => output.show(true)),

    // Clear history and ignore previous log entries
    vscode.commands.registerCommand('claudeNotifications.clearHistory', () => {
      events = [];
      try {
        const { logPath } = cfg();
        fileOffset = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
      } catch { fileOffset = 0; }
      output.clear();
      output.appendLine('[info] cleared (ignoring previous log entries)');
    }),

    // Show quick pick of recent events to jump to
    vscode.commands.registerCommand('claudeNotifications.jumpToRecent', async () => {
      if (events.length === 0) {
        vscode.window.showInformationMessage('No Claude events yet.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        events.slice().reverse().map(e => ({ label: formatLine(e), description: e.goto ?? e.workspace ?? e.cwd ?? '', e })),
        { placeHolder: 'Select an event to jump to', matchOnDescription: true }
      );
      if (picked) await jumpTo(picked.e);
    })
  );

  // Start watching the log file
  startWatching();

  // Reload watcher when configuration changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(ev => {
      if (ev.affectsConfiguration('claudeNotifications')) startWatching();
    })
  );

  output.appendLine('[info] Claude Notifications extension active');
}

/**
 * Cleanup when extension is deactivated
 */
export function deactivate() {}
