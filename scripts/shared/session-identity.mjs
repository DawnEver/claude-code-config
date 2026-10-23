// Native runtime identity is authoritative; launcher IDs are only a lineage fallback.
import { codexRolloutId } from './vendor-session.mjs';
const id = value => typeof value === 'string' && value.trim() ? value.trim() : null;

/** Root conversation lineage and actual execution thread are intentionally distinct.
 * Codex subagent hook session_id may name the parent, so never use it as a thread key. */
export function sessionIdentity(env = process.env, payload = {}, { host } = {}) {
  host ??= env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || env.HARNESS_AGENT === 'codex' ? 'codex' : 'claude';
  if (host === 'codex') {
    const threadId = id(payload.thread_id) || id(payload.agent_id) || codexRolloutId(payload.transcript_path) || id(env.CODEX_THREAD_ID);
    return { host, sessionId: id(payload.session_id) || id(env.CODEX_SESSION_ID) || threadId || id(env.LAB_SESSION), threadId };
  }
  const sessionId = id(payload.session_id) || id(env.CLAUDE_CODE_SESSION_ID) || id(env.LAB_SESSION);
  return { host, sessionId, threadId: id(payload.agent_id) || sessionId };
}
