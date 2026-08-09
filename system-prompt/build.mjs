// build.mjs — build per-style system prompts for the claude platform.
//
//   node system-prompt/build.mjs [style...]   (default: all discovered styles)
//
// Output: dist/<style>.claude.md = claude-base.md (platform layer) + style body.
// Also writes dist/styles.json (the registry) and validates static-ness
// (no cwd/env/git-status/time leaks — those break cross-process prompt cache).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { discoverStyles, parseFrontmatter } from "./discover-styles.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = join(HERE, "claude-base.md");

const DYNAMIC_PATTERNS = [
  /cwd/i, /working directory/i, /git status/i, /gitStatus/i,
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/, /timestamp/i, /process\.env/i, /__dirname/i,
];

export function validateStatic(text, name) {
  const hits = [];
  for (const pat of DYNAMIC_PATTERNS) {
    const m = text.match(pat);
    if (m) hits.push(`${pat}:${m[0]}`);
  }
  return hits;
}

export function buildStyle(style, baseText) {
  const body = style.body ?? (style.file ? parseFrontmatter(readFileSync(style.file, "utf8")).body : "");
  const text = `${baseText.trimEnd()}\n\n${body.trim()}\n`;
  return { text, style };
}

export function buildAll(styleNames = []) {
  const styles = discoverStyles();
  const baseText = readFileSync(BASE, "utf8");
  const dist = join(HERE, "dist");
  mkdirSync(dist, { recursive: true });

  const registry = [];
  for (const style of styles) {
    if (styleNames.length && !styleNames.includes(style.name)) continue;
    const { text } = buildStyle(style, baseText);
    const hits = validateStatic(text, style.name);
    if (hits.length) {
      console.error(`✗ ${style.name}: dynamic content would break cache: ${hits.join(", ")}`);
      process.exitCode = 1;
      continue;
    }
    const out = join(dist, `${style.name}.claude.md`);
    writeFileSync(out, text);
    registry.push({ ...style, dist: out, chars: text.length });
    console.log(`✓ ${style.name.padEnd(14)} ${text.length} chars → ${out}`);
  }
  writeFileSync(join(dist, "styles.json"), JSON.stringify(registry, null, 2));
  console.log(`\n${registry.length} styles built → ${dist}/`);
  return registry;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildAll(process.argv.slice(2));
}
