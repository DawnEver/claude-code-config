// scripts/shared/agy-payload.mjs — single source of truth for Antigravity CLI (agy)
// hook payload normalization, prompt envelope stripping, and tool mappings.

export const AGY_COSMETIC_ARGS = new Set(['toolSummary', 'toolAction', 'WaitMsBeforeAsync']);

export const AGY_POLLING_TOOLS = [
  'manage_task',
  'manage_subagents',
  'schedule',
  'send_message',
  'ask_question',
];

const SHELL_TOOL = () => (process.platform === 'win32' ? 'PowerShell' : 'Bash');

export const AGY_TO_CLAUDE_TOOL = {
  run_command: SHELL_TOOL,
  write_file: () => 'Write',
  write_to_file: () => 'Write',
  edit_file: () => 'Edit',
  replace_file_content: () => 'Edit',
  multi_replace_file_content: () => 'MultiEdit',
  read_file: () => 'Read',
  view_file: () => 'Read',
  grep_search: () => 'Grep',
  find_by_name: () => 'Glob',
};

/** Strip Antigravity's `<USER_REQUEST>...</USER_REQUEST>` prompt wrapper. */
export function stripAgyPromptEnvelope(raw) {
  const t = String(raw ?? '');
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(t);
  return (m ? m[1] : t).trim();
}

/** Drop cosmetic-only presentation fields from an agy `toolCall.args` object for repeat detection. */
export function normalizeAgyGuardPayload(payload) {
  if (!payload?.toolCall) return payload;
  const args = Object.fromEntries(
    Object.entries(payload.toolCall.args ?? {}).filter(([k]) => !AGY_COSMETIC_ARGS.has(k)),
  );
  return { ...payload, tool_name: payload.toolCall.name, tool_input: args, session_id: payload.conversationId };
}

/** Convert an Antigravity camelCase hook input into the canonical Claude snake_case hook payload. */
export function agyToCanonicalPayload(claudeEvent, input = {}, { repoRoot, isSubagent = false } = {}) {
  const cwd = input.cwd || input.workspacePaths?.[0] || repoRoot || process.cwd();
  const out = {
    session_id: String(input.conversationId ?? ''),
    transcript_path: String(input.transcriptPath ?? ''),
    cwd,
    hook_event_name: claudeEvent,
  };
  if (isSubagent && out.session_id) out.agent_id = out.session_id;
  if (input.continuationActive) out.stop_hook_active = true;
  if (typeof input.lastUserInput === 'string') out.prompt = stripAgyPromptEnvelope(input.lastUserInput);
  const tc = input.toolCall;
  if (tc && typeof tc === 'object') {
    const mapFn = AGY_TO_CLAUDE_TOOL[tc.name];
    out.tool_name = mapFn ? mapFn() : String(tc.name ?? '');
    const a = tc.args && typeof tc.args === 'object' ? tc.args : {};
    const filePath = a.Path ?? a.TargetFile ?? a.AbsolutePath;
    out.tool_input = {
      ...a,
      ...(a.CommandLine !== undefined ? { command: String(a.CommandLine) } : {}),
      ...(filePath !== undefined ? { file_path: String(filePath) } : {}),
      ...(a.Content !== undefined || a.CodeContent !== undefined ? { content: String(a.Content ?? a.CodeContent) } : {}),
      ...(a.Target !== undefined || a.TargetContent !== undefined ? { old_string: String(a.Target ?? a.TargetContent) } : {}),
      ...(a.Replacement !== undefined || a.ReplacementContent !== undefined ? { new_string: String(a.Replacement ?? a.ReplacementContent) } : {}),
    };
  }
  return out;
}
