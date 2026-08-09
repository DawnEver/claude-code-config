// validate-cache.mjs — verify cross-process prompt-cache health of a built
// system prompt. Runs the same one-shot `claude -p` twice and compares usage:
// the second run must be almost all cache_read (create ≈ 0) for the static
// head to pay off. Usage:
//   node system-prompt/validate-cache.mjs <prompt-file> [--tools Bash,Read]
// Exit 0 = healthy; 1 = cache broken (second run re-created the prefix).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const [,, promptFile, ...rest] = process.argv;
const toolsArg = rest.find((a, i) => a === "--tools" && rest[i + 1]);
if (!promptFile || !existsSync(promptFile)) {
  console.error(`usage: node validate-cache.mjs <prompt-file> [--tools <list>]`);
  process.exit(2);
}

const PROMPT = "Reply with exactly: cache-probe";
// NOTE: claude.exe mis-parses `--tools <value>` (separate arg) when a prompt
// follows on argv — use the `--tools=<list>` form (fabric's spawns are immune:
// they feed the prompt via stdin, which also satisfies --print).
const baseArgs = ["-p", "--model", "claude-haiku-4-5-20251001", "--system-prompt-file", promptFile, "--output-format", "json"];
if (toolsArg) baseArgs.push(`--tools=${rest[rest.indexOf("--tools") + 1]}`);
baseArgs.push(PROMPT);

function claudeBin() {
  // Prefer the native claude.exe (no shell needed; .cmd shims are EINVAL for
  // Node ≥20.12 without shell:true). Resolve from PATH like claude.cmd does.
  if (process.env.CLAUDE_EXE) return process.env.CLAUDE_EXE;
  const candidates = [
    process.platform === "win32"
      ? "C:/Users/linxu/nodejs/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
      : "claude",
  ];
  return candidates.find((c) => existsSync(c)) ?? "claude";
}

function runUsage() {
  // Strip provider-routing env so the child goes vanilla (OAuth) to
  // api.anthropic.com — otherwise the parent's gateway vars hijack routing.
  const env = { ...process.env };
  for (const k of ["ANTHROPIC_BASE_URL", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "ANTHROPIC_FOUNDRY_BASE_URL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL"]) delete env[k];
  const res = spawnSync(claudeBin(), baseArgs, { encoding: "utf8", timeout: 120000, env });
  if (res.status !== 0) throw new Error(`claude exited ${res.status}: ${(res.stderr || "").slice(0, 300)}`);
  // --output-format json emits a single JSON ARRAY of stream events; the
  // terminal `result` entry carries the real usage.
  const events = JSON.parse(res.stdout);
  const result = events.find((e) => e?.type === "result");
  return result?.usage;
}

function summarize(u) {
  return {
    read: u.cache_read_input_tokens ?? 0,
    create: u.cache_creation_input_tokens ?? 0,
    fresh: u.input_tokens ?? 0,
  };
}

console.log(`prompt: ${promptFile}${toolsArg ? ` (--tools ${rest[rest.indexOf("--tools") + 1]})` : ""}`);
const r1 = summarize(runUsage());
const r2 = summarize(runUsage());
console.log(`run 1: read ${r1.read.toLocaleString()} / create ${r1.create.toLocaleString()} / fresh ${r1.fresh}`);
console.log(`run 2: read ${r2.read.toLocaleString()} / create ${r2.create.toLocaleString()} / fresh ${r2.fresh}`);
const recreated = r2.create > Math.max(500, r1.create * 0.2);
console.log(recreated
  ? `✗ CACHE BROKEN — run 2 re-created ${r2.create.toLocaleString()} tokens; the static head is not byte-stable (check dynamic content in the prompt).`
  : `✓ cache healthy — run 2 ${r2.read.toLocaleString()} read / ${r2.create.toLocaleString()} create (cross-process hit)`);
process.exit(recreated ? 1 : 0);
