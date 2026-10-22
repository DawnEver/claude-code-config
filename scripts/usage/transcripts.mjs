// scripts/usage/transcripts.mjs — a host transcript -> its turns as metadata (docs/usage.md).
// Pure: text in, rows out. The transcripts are the only source of usage there is: every model
// call carries its model and token usage, every prompt its time, cwd and branch. Nothing of the
// conversation's text leaves this module: a row holds ids, times, counts and tool names.
//
// Tokens are normalised to one meaning on both hosts: `input` uncached, `cache_read`,
// `cache_write`, `output` (reasoning included) and `reasoning` (of output). Codex's input
// counts its cached part; Claude's does not.

const ms = (t) => { const v = Date.parse(t); return Number.isFinite(v) ? v : null; };
const n = (v) => (Number.isFinite(v) && v > 0 ? v : 0);

function lines(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* a line still being written, or damaged */ }
  }
  return out;
}

/** A turn's rows, one per model, from its calls: [{model, usage, at}] + tools. */
function rowsOf(t) {
  const byModel = new Map();
  for (const c of t.calls) {
    const r = byModel.get(c.model) ?? { model: c.model, calls: 0, input: 0, cache_read: 0, cache_write: 0, output: 0, reasoning: 0 };
    r.calls++;
    for (const k of ['input', 'cache_read', 'cache_write', 'output', 'reasoning']) r[k] += c.usage[k];
    byModel.set(c.model, r);
  }
  const tools = Object.keys(t.tools).length ? JSON.stringify(t.tools) : null;
  // The turn's tools go on its first model's row: a tool is the turn's, not a model's.
  return [...byModel.values()].map((r, i) => ({ turn: t.id, started_at: t.start, ended_at: Math.max(t.start, t.end), origin: t.origin,
    client: t.client, branch: t.branch, cwd: t.cwd, ...r, tools: i === 0 ? tools : null }));
}

const CLAUDE_ORIGINS = { human: 'human', sdk: 'sdk', peer: 'peer', task_notification: 'task' };

/** Whether a Claude user entry is a prompt (not a tool result, not injected context). */
function isPrompt(e) {
  if (e.type !== 'user' || e.isMeta || e.toolUseResult !== undefined) return false;
  const c = e.message?.content;
  return typeof c === 'string' || (Array.isArray(c) && !c.some((b) => b?.type === 'tool_result'));
}

/**
 * A Claude Code transcript (`<config dir>/projects/<project>/<session>.jsonl`, or a subagent's
 * `<session>/subagents/agent-<id>.jsonl` with `subagent` true) -> {session, turns, costs}.
 * Streamed calls repeat one message id per content block: a call counts once, at its last usage.
 */
export function claudeTranscript(text, { subagent = false } = {}) {
  let session = null;
  const turns = [];
  const seen = new Map();   // message id -> its call
  let cur = null;
  let costs = [];
  const open = (e, origin) => {
    cur = { id: subagent ? `${e.agentId ?? 'agent'}:${e.uuid}` : e.uuid, start: ms(e.timestamp), end: ms(e.timestamp),
      origin, client: e.entrypoint ?? null, branch: e.gitBranch ?? null, cwd: e.cwd ?? null, calls: [], tools: {} };
    turns.push(cur);
  };
  for (const e of lines(text)) {
    session ??= e.sessionId ?? null;
    if (e.type === 'cost-state') {
      costs = Object.entries(e.modelUsage ?? {}).filter(([, u]) => u?.costUSD > 0).map(([model, u]) => ({ model, cost_usd: u.costUSD }));
      continue;
    }
    const at = ms(e.timestamp);
    if (at === null) continue;
    if (isPrompt(e) && !(subagent && cur)) {
      open(e, subagent ? 'subagent' : CLAUDE_ORIGINS[e.turnOrigin] ?? (e.promptSource === 'system' ? 'system' : 'human'));
      continue;
    }
    if (e.type === 'assistant') {
      const m = e.message;
      if (!m?.usage || !m.model || m.model === '<synthetic>') continue;
      if (!cur) open(e, subagent ? 'subagent' : 'system');   // calls before any prompt (a resumed or compacted start)
      const u = m.usage;
      const usage = { input: n(u.input_tokens), cache_read: n(u.cache_read_input_tokens), cache_write: n(u.cache_creation_input_tokens),
        output: n(u.output_tokens), reasoning: n(u.output_tokens_details?.thinking_tokens) };
      const call = seen.get(m.id);
      if (call && call.turn === cur) call.usage = usage;
      else if (!call) { const c = { model: m.model, usage, turn: cur }; seen.set(m.id ?? `${e.uuid}`, c); cur.calls.push(c); }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type === 'tool_use' && typeof b.name === 'string' && !cur.toolIds?.has(b.id)) {
          (cur.toolIds ??= new Set()).add(b.id);
          cur.tools[b.name] = (cur.tools[b.name] ?? 0) + 1;
        }
      }
      cur.end = Math.max(cur.end, at);
    } else if (cur && e.type === 'user' && e.toolUseResult !== undefined) cur.end = Math.max(cur.end, at);   // a tool result
  }
  return { session, turns: turns.filter((t) => t.calls.length && t.start !== null).flatMap(rowsOf), costs };
}

/**
 * A Codex rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`) -> {session, project?, turns}.
 * Per call usage is `token_usage_record` (by turn id); an older rollout without it falls back to
 * each `token_count` event's `last_token_usage`, counted when the running total moves.
 */
export function codexTranscript(text) {
  let session = null;
  let meta = {};
  const turns = new Map();
  let cur = null;
  let lastTotal = null;
  const hasRecords = text.includes('"token_usage_record"');
  const turnFor = (id, at) => {
    let t = turns.get(id);
    if (!t) {
      t = { id, start: at, end: at, origin: 'system', client: meta.client ?? null, branch: meta.branch ?? null, cwd: meta.cwd ?? null, model: null, calls: [], tools: {} };
      turns.set(id, t);
    }
    return t;
  };
  for (const e of lines(text)) {
    const at = ms(e.timestamp);
    const p = e.payload ?? {};
    if (e.type === 'session_meta') {
      session ??= p.id ?? p.session_id ?? null;
      meta = { cwd: p.cwd ?? null, client: [p.originator, p.source].filter(Boolean).join('/') || null,
        branch: p.git?.branch ?? null, repositoryUrl: p.git?.repository_url ?? null };
      continue;
    }
    if (at === null) continue;
    const pt = `${e.type}:${p.type ?? ''}`;
    if (pt === 'event_msg:task_started' && p.turn_id) { cur = turnFor(p.turn_id, at); continue; }
    if (e.type === 'turn_context') {
      cur = turnFor(p.turn_id ?? cur?.id ?? `t${turns.size}`, at);
      cur.model = p.model ?? cur.model;
      cur.cwd = p.cwd ?? cur.cwd;
      continue;
    }
    if (!cur) continue;
    cur.end = Math.max(cur.end, at);
    // A prompt: the older event, or (the app-server's rollouts) a user-role message.
    if (pt === 'event_msg:user_message' || (pt === 'response_item:message' && p.role === 'user')) cur.origin = 'human';
    else if (pt === 'event_msg:task_complete') cur = null;
    else if (e.type === 'response_item' && /^(function_call|custom_tool_call|local_shell_call)$/.test(p.type)) {
      const name = p.name ?? (p.type === 'local_shell_call' ? 'shell' : null);
      if (name) cur.tools[name] = (cur.tools[name] ?? 0) + 1;
    } else if (hasRecords ? e.type === 'token_usage_record' : pt === 'event_msg:token_count') {
      const u = hasRecords ? p.usage : p.info?.last_token_usage;
      if (!u) continue;
      if (!hasRecords) {
        const total = p.info?.total_token_usage?.total_tokens;
        if (total === lastTotal) continue;   // a rate-limit update repeats the last usage
        lastTotal = total;
      }
      const t = hasRecords && p.turn_id ? turnFor(p.turn_id, at) : cur;
      t.calls.push({ model: null, usage: { input: Math.max(0, n(u.input_tokens) - n(u.cached_input_tokens)), cache_read: n(u.cached_input_tokens),
        cache_write: n(u.cache_write_input_tokens), output: n(u.output_tokens), reasoning: n(u.reasoning_output_tokens) } });
    }
  }
  const rows = [...turns.values()].filter((t) => t.calls.length).flatMap((t) => {
    for (const c of t.calls) c.model = t.model ?? 'unknown';
    return rowsOf(t);
  });
  return { session, repositoryUrl: meta.repositoryUrl ?? null, turns: rows, costs: [] };
}
