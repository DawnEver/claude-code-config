// sync-official.mjs — official Claude Code prompt change radar.
//
// We fully REPLACE the stock system prompt, so official prompt updates never
// change our runtime. But official behavior evolves (new tools, new discipline)
// and we should decide what to absorb. This script diffs the Piebald extraction
// (npm-exact) against the last checked version and writes an absorption list to
// CHANGELOG.md for human review. Nothing is auto-merged.
//
//   node system-prompt/sync-official.mjs [--repo <piebald-clone>]
//
// Requires a local clone of https://github.com/Piebald-AI/claude-code-system-prompts
// (shallow is fine: `git clone --depth 1 ...` then `git fetch --depth 1` on each run,
// or just re-clone). Default repo path: .scratch/piebald under this repo.
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO = join(HERE, "..", ".scratch", "piebald");
const CHANGELOG = join(HERE, "CHANGELOG.md");
const STATE = join(HERE, ".sync-official-state.json");

function repoVersion(repo) {
  // The extraction repo pins versions per-file (ccVersion frontmatter) and keeps
  // a CHANGELOG.md of prompt changes across releases.
  const cl = join(repo, "CHANGELOG.md");
  if (!existsSync(cl)) return "unknown";
  const head = readFileSync(cl, "utf8").split("\n").slice(0, 40).join("\n");
  const m = head.match(/v?(\d+\.\d+\.\d+)/);
  return m ? m[1] : "unknown";
}

function listPrompts(repo, prefix) {
  const dir = join(repo, "system-prompts");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
    .map((f) => {
      const text = readFileSync(join(dir, f), "utf8");
      const ver = text.match(/ccVersion: "([^"]+)"/)?.[1] ?? "?";
      const desc = text.match(/description: "([^"]+)"/)?.[1] ?? "";
      return { file: f, ver, desc };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

function sync(repoPath = DEFAULT_REPO) {
  if (!existsSync(repoPath)) {
    console.error(`Piebald clone not found at ${repoPath}.`);
    console.error(`  git clone --depth 1 https://github.com/Piebald-AI/claude-code-system-prompts.git "${repoPath}"`);
    process.exit(1);
  }
  const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : { version: null };
  const version = repoVersion(repoPath);
  console.log(`Piebald extraction at ccVersion ${version} (last checked: ${state.version ?? "none"})`);

  const main = listPrompts(repoPath, "system-prompt-");
  // First check = full baseline (all parts listed for review). Later checks list
  // only parts whose own ccVersion is newer than the last checked extraction.
  const newer = (a, b) => {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
    return false;
  };
  const newSinceLast = !state.version ? main : main.filter((p) => p.ver !== "?" && newer(p.ver, state.version));
  const totalChars = main.reduce((s, p) => s + p.file.length, 0);

  const entry = [
    `\n## ${version} — checked ${new Date().toISOString().slice(0, 10)}`,
    `\n${main.length} main-prompt parts tracked (~${Math.round(totalChars / 1000)}k chars of filenames) — every part's own ccVersion is shown per line below; anything with cc != ${state.version ?? "—"} is new or changed since the last check.`,
    `\n### Suggested absorption review (human decision required)`,
  ];
  // Group by our audit verdict categories — everything that changed since last check.
  const interesting = newSinceLast.filter((p) => {
    const n = p.file.toLowerCase();
    return /doing-tasks|executing-actions|communication|tone|tool-usage|context|memory|security|permission|comment|git-status|system-section|harness|interactive-agent/.test(n);
  });
  const trivia = newSinceLast.filter((p) => !interesting.includes(p));
  entry.push(`\n**Likely relevant to our prompt:**`);
  for (const p of interesting) entry.push(`- [ ] ${p.file.replace(/^system-prompt-/, "")} (cc ${p.ver}): ${p.desc.slice(0, 90)}`);
  entry.push(`\n**Probably irrelevant (feature/utility prompts):**`);
  for (const p of trivia.slice(0, 20)) entry.push(`- ${p.file.replace(/^system-prompt-/, "")} (cc ${p.ver})`);
  if (trivia.length > 20) entry.push(`- …and ${trivia.length - 20} more`);
  entry.push(`\n**Tool-description changes (schema lives in body.tools — auto, but check new tools):**`);
  const tools = listPrompts(repoPath, "tool-description-");
  for (const p of tools.filter((x) => x.ver === version)) entry.push(`- ${p.file.replace(/^tool-description-/, "")} (cc ${p.ver})`);

  writeFileSync(CHANGELOG, readFileSync(CHANGELOG, "utf8") + entry.join("\n"));
  writeFileSync(STATE, JSON.stringify({ version, checkedAt: new Date().toISOString() }, null, 2));
  console.log(`\nWrote absorption list → ${CHANGELOG} (${interesting.length} relevant, ${trivia.length} trivia)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const idx = process.argv.indexOf("--repo");
  sync(idx > 0 && process.argv[idx + 1] ? process.argv[idx + 1] : DEFAULT_REPO);
}
