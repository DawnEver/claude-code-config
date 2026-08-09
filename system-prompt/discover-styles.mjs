// discover-styles.mjs — output-style discovery mirroring the official mechanism.
//
// Official lookup order (claude code): user ~/.claude/output-styles/ →
// project .claude/output-styles/ (from cwd up to repo root, nearest wins) →
// plugin <plugin>/output-styles/. Styles are markdown files with YAML
// frontmatter `name` / `description` / `keep-coding-instructions`.
//
// We walk the same paths in place — existing config is never moved. Usage:
//   node system-prompt/discover-styles.mjs [--json]
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, parse } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const DEFAULT_SEARCH_DIRS = () => {
  const dirs = [join(homedir(), ".claude", "output-styles")];
  // Project-level: walk from cwd up to the repo root.
  let cwd = process.cwd();
  const root = parse(cwd).root;
  while (true) {
    dirs.push(join(cwd, ".claude", "output-styles"));
    if (cwd === root) break;
    const parent = dirname(cwd);
    if (parent === cwd) break;
    cwd = parent;
  }
  // Extra cross-project dirs via env (semicolon-separated), e.g. other workspaces'
  // style dirs that the platform should also offer.
  if (process.env.STYLE_SEARCH_DIRS) {
    for (const d of process.env.STYLE_SEARCH_DIRS.split(";")) {
      if (d.trim()) dirs.push(d.trim());
    }
  }
  return dirs;
};

export function parseFrontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return { body: text, meta: {} };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (kv) {
      let v = kv[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      else if (v === "true" || v === "false") v = v === "true";
      meta[kv[1]] = v;
    }
  }
  return { body: text.slice(m[0].length), meta };
}

/** Discover styles across all search dirs; nearest dir wins on name conflicts. */
export function discoverStyles(searchDirs = DEFAULT_SEARCH_DIRS()) {
  const found = new Map();
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      const file = join(dir, f);
      const { body, meta } = parseFrontmatter(readFileSync(file, "utf8"));
      const name = meta.name || f.replace(/\.md$/, "");
      // Search dirs are ordered near → far; the FIRST (nearest) entry wins.
      if (found.has(name)) continue;
      found.set(name, {
        name,
        description: meta.description || "",
        keepCodingInstructions: meta["keep-coding-instructions"] === true,
        file,
        chars: body.length + statSync(file).size - statSync(file).size + body.length,
      });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const styles = discoverStyles();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(styles, null, 2));
  } else {
    console.log(`Discovered ${styles.length} styles:`);
    for (const s of styles) console.log(`  ${s.name.padEnd(14)} keep-coding:${s["keepCodingInstructions"] ? "yes" : "no "}  ${s.description.slice(0, 70)}`);
  }
}
