import * as vscode from 'vscode';
import * as fs from 'fs';
import { getSignalPath } from './lib/state-paths';
import { markResolved } from './lib/stage-dedup';

const POLL_MS = 400;
const SWEEP_FIRED_MS = 8000;
const STALE_THRESHOLD_MS = 30000;

interface Signal {
  version: number;
  event: 'waiting' | 'completed';
  hookEventName: string;
  sessionId: string;
  project: string;
  pids: number[];
  state: 'pending' | 'fired';
  timestamp: number;
}

function parseSignal(content: string): Signal | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  try {
    const data = JSON.parse(trimmed);
    if (data.version === 2) {
      if (data.timestamp && Date.now() - data.timestamp > STALE_THRESHOLD_MS) {
        return null;
      }
      return {
        version: 2,
        event: data.event === 'completed' ? 'completed' : 'waiting',
        hookEventName: typeof data.hookEventName === 'string' ? data.hookEventName : '',
        sessionId: typeof data.sessionId === 'string' ? data.sessionId : '',
        project: data.project || 'Unknown',
        pids: Array.isArray(data.pids) ? data.pids : [],
        state: data.state === 'fired' ? 'fired' : 'pending',
        timestamp: data.timestamp || Date.now(),
      };
    }
  } catch {
    /* corrupt JSON */
  }
  return null;
}

async function describeTerminal(terminal: vscode.Terminal, index: number): Promise<string> {
  let pid = '?';
  try {
    const resolved = await terminal.processId;
    if (resolved) pid = String(resolved);
  } catch {
    /* disposed */
  }
  return `[${index}]"${terminal.name}"(pid=${pid})`;
}

async function focusMatchingTerminal(pids: number[], log: vscode.OutputChannel): Promise<void> {
  const terminals = vscode.window.terminals;
  const descriptions = await Promise.all(terminals.map((t, i) => describeTerminal(t, i)));
  log.appendLine(`Open terminals (${terminals.length}): ${descriptions.join(', ')}`);

  // Level 1: PID exact match
  for (let i = 0; i < terminals.length; i++) {
    const terminal = terminals[i];
    try {
      const termPid = await terminal.processId;
      if (termPid && pids.includes(termPid)) {
        log.appendLine(`PID match: ${await describeTerminal(terminal, i)}`);
        terminal.show();
        return;
      }
    } catch {
      /* disposed */
    }
  }

  // Level 2: name match
  for (let i = 0; i < terminals.length; i++) {
    const terminal = terminals[i];
    const name = terminal.name.toLowerCase();
    if (name.includes('claude') || name.includes('node')) {
      log.appendLine(`Name match: ${await describeTerminal(terminal, i)}`);
      terminal.show();
      return;
    }
  }

  // Level 3: last terminal fallback
  if (terminals.length > 0) {
    const last = terminals[terminals.length - 1];
    log.appendLine(`Fallback: last terminal ${await describeTerminal(last, terminals.length - 1)}`);
    last.show();
  } else {
    log.appendLine('No terminals found to focus');
  }
}

async function handleSignal(signal: Signal, workspaceRoot: string, log: vscode.OutputChannel): Promise<void> {
  const sessionTag = signal.sessionId ? signal.sessionId.slice(0, 8) : '?';
  log.appendLine(
    `Signal: event=${signal.event}(${signal.hookEventName}), session=${sessionTag}, project=${signal.project}, pids=[${signal.pids.join(',')}]`,
  );

  // Already-on-correct-terminal check
  const activeTerminal = vscode.window.activeTerminal;
  if (activeTerminal) {
    try {
      const activePid = await activeTerminal.processId;
      if (activePid && signal.pids.includes(activePid)) {
        log.appendLine('Already on correct terminal — skipping toast');
        markResolved(workspaceRoot, signal.sessionId);
        return;
      }
    } catch {
      /* disposed */
    }
  }

  const message =
    signal.event === 'completed'
      ? `Task completed in: ${signal.project}`
      : `Waiting for your response in: ${signal.project}`;

  const action = await vscode.window.showInformationMessage(message, 'Focus Terminal');

  if (action === 'Focus Terminal') {
    log.appendLine('User clicked Focus Terminal');
    await focusMatchingTerminal(signal.pids, log);
    markResolved(workspaceRoot, signal.sessionId);
  }
}

function sweepFiredSignal(signalPath: string): void {
  try {
    if (!fs.existsSync(signalPath)) return;
    const stat = fs.statSync(signalPath);
    if (Date.now() - stat.mtimeMs < SWEEP_FIRED_MS) return;
    const content = fs.readFileSync(signalPath, 'utf8');
    const signal = parseSignal(content);
    if (!signal || signal.state === 'fired') {
      fs.unlinkSync(signalPath);
    }
  } catch {
    /* race */
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Claude Notifications');
  log.appendLine(`Claude Notifications v${context.extension.packageJSON.version} activated`);

  // 400ms polling loop
  const timer = setInterval(() => {
    if (!vscode.workspace.workspaceFolders) return;

    for (const folder of vscode.workspace.workspaceFolders) {
      const workspaceRoot = folder.uri.fsPath;
      const signalPath = getSignalPath(workspaceRoot);

      sweepFiredSignal(signalPath);

      if (!fs.existsSync(signalPath)) continue;

      let content: string;
      try {
        content = fs.readFileSync(signalPath, 'utf8').trim();
      } catch {
        continue;
      }

      const signal = parseSignal(content);
      if (!signal) {
        try {
          fs.unlinkSync(signalPath);
        } catch {
          /* ignore */
        }
        continue;
      }

      if (signal.state === 'fired') continue;

      try {
        fs.unlinkSync(signalPath);
      } catch {
        /* ignore */
      }

      handleSignal(signal, workspaceRoot, log);
      return;
    }
  }, POLL_MS);

  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // Window focus handler
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        if (!vscode.workspace.workspaceFolders) return;
        for (const folder of vscode.workspace.workspaceFolders) {
          const signalPath = getSignalPath(folder.uri.fsPath);
          if (!fs.existsSync(signalPath)) continue;
          let content: string;
          try {
            content = fs.readFileSync(signalPath, 'utf8').trim();
          } catch {
            continue;
          }
          const signal = parseSignal(content);
          if (!signal || signal.state === 'fired') continue;
          try {
            fs.unlinkSync(signalPath);
          } catch {
            /* ignore */
          }
          handleSignal(signal, folder.uri.fsPath, log);
          return;
        }
      }
    }),
  );

  log.appendLine(`Polling every ${POLL_MS}ms for signals`);
  log.appendLine('Ready');
}

export function deactivate(): void {
  // context.subscriptions handles disposal
}
