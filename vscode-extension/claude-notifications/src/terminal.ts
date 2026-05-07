import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { ClaudeEvent } from './types';

const execAsync = promisify(exec);

/**
 * Get the parent PID of the given process.
 * Returns null if the PID is invalid or the process doesn't exist.
 */
async function getParentPid(pid: number): Promise<number | null> {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    if (os.platform() === 'win32') {
      const { stdout } = await execAsync(
        `powershell -NoProfile -Command "try { (Get-CimInstance Win32_Process -Filter \\"ProcessId = ${pid}\\" -ErrorAction Stop).ParentProcessId } catch { }"`,
        { timeout: 2000 },
      );
      const val = parseInt(stdout.trim(), 10);
      return isNaN(val) ? null : val;
    } else {
      const { stdout } = await execAsync(`ps -o ppid= -p ${pid} 2>/dev/null | tr -d ' '`, { timeout: 2000 });
      const val = parseInt(stdout.trim(), 10);
      return isNaN(val) ? null : val;
    }
  } catch {
    return null;
  }
}

/**
 * Walk up the process tree from `descendantPid` and check if `ancestorPid`
 * appears anywhere in the ancestry chain.
 */
async function isAncestorProcess(ancestorPid: number, descendantPid: number): Promise<boolean> {
  if (!Number.isInteger(ancestorPid) || !Number.isInteger(descendantPid) || ancestorPid < 1 || descendantPid < 1) {
    return false;
  }
  let currentPid = descendantPid;
  for (let i = 0; i < 20; i++) {
    if (currentPid === ancestorPid) return true;
    const parent = await getParentPid(currentPid);
    if (parent === null || parent === currentPid || parent < 1) return false;
    currentPid = parent;
  }
  return false;
}

async function findTerminalByPpid(ppid: number): Promise<vscode.Terminal | undefined> {
  for (const t of vscode.window.terminals) {
    const shellPid = await t.processId;
    if (!shellPid) continue;
    // Only match when the event process is a direct descendant of the
    // terminal shell / conpty PID. Walking up from the terminal PID
    // converges at Code.exe (common to all terminals in the window) and
    // produces false positives.
    if (await isAncestorProcess(shellPid, ppid)) return t;
  }
  return undefined;
}

/**
 * Focus the Claude Code terminal that sent this event, or open a file if
 * the event includes a `goto` target.
 */
export async function jumpTo(e: ClaudeEvent): Promise<void> {
  // Priority 1: `goto` target (file:line:col or file:line) — open the document
  if (e.goto) {
    let filePath: string = e.goto;
    let line = 0;
    let col = 0;
    // Parse trailing :line:col or :line from the end, being careful not to
    // confuse with Windows drive letters (C:\...).
    const tailMatch = e.goto.match(/:(\d+)$/);
    if (tailMatch) {
      const rest = e.goto.substring(0, tailMatch.index);
      line = Math.max(0, parseInt(tailMatch[1], 10) - 1);
      const colMatch = rest.match(/:(\d+)$/);
      if (colMatch) {
        col = Math.max(0, parseInt(colMatch[1], 10) - 1);
        filePath = e.goto.substring(0, colMatch.index);
      } else {
        filePath = rest;
      }
    }
    // Resolve relative paths against the event's working directory
    if (!path.isAbsolute(filePath) && (e.cwd || e.workspace)) {
      filePath = path.resolve(e.cwd || e.workspace!, filePath);
    }
    try {
      const doc = await vscode.workspace.openTextDocument(filePath);
      const editor = await vscode.window.showTextDocument(doc);
      if (line > 0 || col > 0) {
        const targetLine = Math.min(line, doc.lineCount - 1);
        const range = doc.lineAt(targetLine).range;
        editor.selection = new vscode.Selection(targetLine, col, targetLine, col);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      }
      return;
    } catch {
      /* fall through to terminal focus */
    }
  }

  // Priority 2: match by ppid (most precise for multiple instances)
  if (e.ppid) {
    const terminal = await findTerminalByPpid(e.ppid);
    if (terminal) {
      terminal.show();
      return;
    }
  }

  // Strategy 2: show available terminals to pick from
  const cwd = e.cwd || e.workspace;
  const allTerms = vscode.window.terminals;

  if (allTerms.length === 1) {
    allTerms[0].show();
    return;
  }

  if (allTerms.length > 1) {
    const picked = await vscode.window.showQuickPick(
      allTerms.map((t) => ({ label: t.name, terminal: t })),
      { placeHolder: 'Select the Claude Code terminal to focus' },
    );
    if (picked) {
      picked.terminal.show();
      return;
    }
    return;
  }

  // No terminals at all — create one
  if (cwd) {
    const term = vscode.window.createTerminal({ cwd });
    term.show();
  } else {
    vscode.window.showWarningMessage('No workspace/file info found on this event.');
  }
}
