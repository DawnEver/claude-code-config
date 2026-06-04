#!/usr/bin/env node
// sync-tasks.js — bridge sharp-review findings into structured task list
// Scans .claude/sharp-review/ + .claude/memory/ → rebuilds .claude/memory/tasks/tasks.md

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';

// ── Paths (relative to project root) ──

const ROOT = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const SHARP_REVIEW_DIR = join(ROOT, '.claude', 'sharp-review');
const MEMORY_DIR = join(ROOT, '.claude', 'memory');
const TASKS_DIR = join(MEMORY_DIR, 'tasks');
const ARCHIVE_DIR = join(TASKS_DIR, 'archive');
const TASKS_FILE = join(TASKS_DIR, 'tasks.md');
const MEMORY_INDEX = join(ROOT, '.claude', 'rules', 'MEMORY.md');

const STALE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

// ── Module mapping ──

const MODULE_MAP = [
  { pattern: /cc-market[/\\]takeover/, name: 'takeover plugin' },
  { pattern: /scripts[/\\]hooks[/\\]notify/, name: 'notify hook' },
  { pattern: /scripts[/\\]runtime[/\\]notify/, name: 'notify hook' },
  { pattern: /scripts[/\\]hooks[/\\]sharp-review/, name: 'sharp review hook' },
  { pattern: /skills[/\\]sharp-review/, name: 'sharp review skill' },
  { pattern: /scripts[/\\]runtime[/\\]api-proxy/, name: 'api-proxy' },
  { pattern: /scripts[/\\]runtime[/\\]cc\./, name: 'cc runtime' },
  { pattern: /scripts[/\\]hooks[/\\]hud/, name: 'hud hook' },
  { pattern: /scripts[/\\]setup/, name: 'setup scripts' },
  { pattern: /cc-market[/\\]rem/, name: 'rem plugin' },
  { pattern: /\.claude[/\\]rules/, name: 'claude rules' },
  { pattern: /\.claude[/\\]memory/, name: 'claude memory' },
  { pattern: /claude_settings/, name: 'claude settings' },
  { pattern: /GLOBAL-AGENTS/, name: 'global config' },
  { pattern: /AGENTS\.md/, name: 'project config' },
  { pattern: /README\.md/, name: 'documentation' },
];

function inferModule(filePath) {
  if (!filePath) return 'unknown';
  const normalized = filePath.replace(/\\/g, '/');
  for (const { pattern, name } of MODULE_MAP) {
    if (pattern.test(normalized)) return name;
  }
  const parts = normalized.split('/');
  const lastFile = parts[parts.length - 1] || '';
  const lastDir = parts.length > 1 ? parts[parts.length - 2] : '';
  return lastDir || lastFile.replace(/\.[^.]+$/, '') || 'unknown';
}

function inferCategory(summary, explicit) {
  if (explicit) {
    const cat = explicit.toLowerCase();
    if (cat === 'bug' || cat === 'perf' || cat === 'performance' || cat === 'feature') {
      return cat === 'perf' ? 'Performance' : cat[0].toUpperCase() + cat.slice(1);
    }
  }
  if (!summary) return 'Bug';
  const s = summary.toLowerCase();
  if (/performance|slow|optimize|latency|memory leak|memory usage/i.test(s)) return 'Performance';
  if (/feature|support|add |implement|new capability/i.test(s)) return 'Feature';
  return 'Bug';
}

// ── Parsing ──

const FINDING_HEADER_RE = /^###\s+\[(SR-\d{8}-\d{3})\]\s+\[(\w+)\]\s+(.+?)\s+—\s+(.+)/;
const LEGACY_FINDING_RE = /^\[(\w+)\]\s+(.+?)\s+—\s+(.+?)(?:\s+→\s+(.+))?$/;
const KV_RE = /^-\s+\*\*(.+?):\*\*\s+(.+)/;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function parseFindings(content, fileDate) {
  const findings = [];
  const lines = content.split('\n');
  let i = 0;
  let legacySeq = 0;

  while (i < lines.length) {
    // New format: ### [SR-YYYYMMDD-NNN] [SEVERITY] file — summary
    const hdr = lines[i].match(FINDING_HEADER_RE);
    if (hdr) {
      const finding = {
        id: hdr[1],
        severity: hdr[2],
        file: hdr[3].trim(),
        summary: hdr[4].trim(),
        category: null,
        module: null,
        status: 'open',
        discovered: hdr[1].slice(3, 11), // extract date from ID
        suggestion: '',
        detail: '',
      };
      i++;
      while (i < lines.length && lines[i].trim() !== '---' && !lines[i].startsWith('### [')) {
        const kv = lines[i].match(KV_RE);
        if (kv) {
          const key = kv[1].toLowerCase();
          const val = kv[2].trim();
          if (key === 'category') finding.category = val;
          else if (key === 'module') finding.module = val;
          else if (key === 'status') finding.status = val.toLowerCase();
          else if (key === 'discovered') finding.discovered = val;
          else if (key === 'suggestion') finding.suggestion = val;
          else if (key === 'description') finding.detail = val;
        }
        i++;
      }
      if (!finding.module) finding.module = inferModule(finding.file);
      if (!finding.category) finding.category = inferCategory(finding.summary, finding.category);
      findings.push(finding);
      if (i < lines.length && lines[i].trim() === '---') i++;
      continue;
    }

    // Legacy format: [SEVERITY] file — issue → suggestion  OR  [SEVERITY] freeform summary
    const leg = lines[i].match(LEGACY_FINDING_RE);
    if (leg) {
      legacySeq++;
      const id = `SR-${fileDate}-L${String(legacySeq).padStart(2, '0')}`;
      const status = leg[4] && /FIXED|fixed|已修复/i.test(leg[4]) ? 'fixed' : 'open';
      const maybeFile = leg[2].trim();
      // Heuristic: if it looks like a file path (has .ext or /), treat as file; else it's part of summary
      const looksLikeFile = /[.\\/]/.test(maybeFile) && maybeFile.length < 80;
      const file = looksLikeFile ? maybeFile : '';
      const summary = looksLikeFile ? leg[3].trim() : `${maybeFile} — ${leg[3].trim()}`;
      // Collect detail lines until --- or next finding
      const detailLines = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '---' && !lines[j].startsWith('### [') && !lines[j].match(/^\[(\w+)\]\s+/)) {
        if (lines[j].trim()) detailLines.push(lines[j].trim());
        j++;
      }
      findings.push({
        id,
        severity: leg[1],
        file,
        summary,
        category: inferCategory(summary, null),
        module: inferModule(file),
        status,
        discovered: fileDate,
        suggestion: leg[4] ? leg[4].trim() : '',
        detail: detailLines.join('\n'),
      });
      i = j;
      continue;
    }
    i++;
  }

  return findings;
}

function collectSharpReviewFiles() {
  if (!existsSync(SHARP_REVIEW_DIR)) return [];
  const results = [];
  for (const entry of readdirSync(SHARP_REVIEW_DIR)) {
    if (entry.endsWith('.md')) {
      const match = entry.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (match) {
        results.push({ path: join(SHARP_REVIEW_DIR, entry), date: match[1] });
      }
    }
  }
  results.sort((a, b) => b.date.localeCompare(a.date)); // newest first
  return results;
}

// ── Memory cross-reference ──

function collectMemoryRefs() {
  const refs = new Map(); // slug → { name, description, path }
  if (!existsSync(MEMORY_DIR)) return refs;

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'tasks') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.md')) {
        try {
          const content = readFileSync(full, 'utf8');
          const nameMatch = content.match(/^name:\s*(.+)$/m);
          const descMatch = content.match(/^description:\s*(.+)$/m);
          if (nameMatch) {
            const relPath = relative(MEMORY_DIR, full).replace(/\\/g, '/');
            refs.set(nameMatch[1].trim(), {
              name: nameMatch[1].trim(),
              description: descMatch ? descMatch[1].trim() : '',
              path: relPath,
              fullPath: full,
            });
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }
  walk(MEMORY_DIR);
  return refs;
}

// ── Staleness check ──

function isStale(finding) {
  if (!finding.discovered) return false;
  const discovered = new Date(finding.discovered).getTime();
  return (Date.now() - discovered) > STALE_DAYS * DAY_MS;
}

function checkFileModified(finding) {
  if (!finding.file) return false;
  try {
    const absPath = join(ROOT, finding.file);
    if (!existsSync(absPath)) return true; // deleted = likely resolved
    const mtime = statSync(absPath).mtimeMs;
    const discovered = new Date(finding.discovered).getTime();
    // Don't flag same-day modifications (likely our own sync touching files)
    const todayStart = new Date(todayISO()).getTime();
    if (discovered >= todayStart) return false;
    return mtime > discovered;
  } catch { return false; }
}

// ── Scale detection ──

function detectScale(openCount) {
  if (openCount < 10) return 'small';
  if (openCount < 50) return 'medium';
  return 'large';
}

// ── Task file generation ──

function groupByModule(findings) {
  const groups = new Map();
  for (const f of findings) {
    const mod = f.module || 'unknown';
    if (!groups.has(mod)) groups.set(mod, []);
    groups.get(mod).push(f);
  }
  return groups;
}

function groupByCategory(findings) {
  const groups = { Feature: [], Bug: [], Performance: [] };
  for (const f of findings) {
    const cat = f.category || 'Bug';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(f);
  }
  return groups;
}

function mergePreserved(findings, preserved) {
  // Build map of IDs from sharp-review
  const srIds = new Set(findings.map(f => f.id));
  // Add preserved entries not found in sharp-review
  for (const [id, entry] of preserved) {
    if (!srIds.has(id) && !entry.checked) {
      findings.push({
        id: entry.id,
        severity: entry.severity,
        file: '',
        summary: entry.summary,
        category: inferCategory(entry.summary),
        module: inferModule(''),
        status: 'open',
        discovered: entry.discovered,
        suggestion: '',
        detail: '',
        _preserved: true,
      });
    }
  }
  return findings;
}

function formatFindingLine(f) {
  const stale = isStale(f) ? ' ⚠ stale' : '';
  const likely = !f.status.startsWith('fix') && checkFileModified(f) ? ' ⚠ likely-resolved' : '';
  const ref = f.memoryRef ? `\n      ref: ../${f.memoryRef}` : '';
  return `- [ ] ${f.id} [${f.severity}] ${f.summary} (${f.discovered})${stale}${likely}${ref}`;
}

function taskFrontmatter(openCount) {
  const today = todayISO();
  return [
    '---',
    `name: active-tasks`,
    `description: Active task list — ${openCount} open. Managed by sync-tasks.js. Load on demand via MEMORY.md.`,
    'metadata:',
    '  type: project',
    `created: ${today}`,
    `accessed: ${today}`,
    'tier: short',
    '---',
    '',
  ].join('\n');
}

function generateSmall(findings, preserved) {
  const merged = mergePreserved([...findings], preserved);
  const open = merged.filter(f => f.status !== 'fixed');
  const byMod = groupByModule(open);
  const lines = [];
  lines.push(taskFrontmatter(open.length));
  lines.push('# Active Tasks');
  lines.push(`> ${open.length} open · last sync: ${todayISO()}`);
  lines.push('');
  for (const [mod, items] of [...byMod].sort()) {
    if (items.length === 0) continue;
    lines.push(`## ${mod}`);
    for (const f of items) {
      lines.push(formatFindingLine(f));
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

function generateMedium(findings, preserved) {
  const merged = mergePreserved([...findings], preserved);
  const open = merged.filter(f => f.status !== 'fixed');
  const byCat = groupByCategory(open);
  const lines = [];
  lines.push(taskFrontmatter(open.length));
  lines.push('# Active Tasks');
  lines.push(`> ${open.length} open · last sync: ${todayISO()}`);
  lines.push('');

  for (const [cat, items] of Object.entries(byCat)) {
    if (items.length === 0) continue;
    const byMod = groupByModule(items);
    lines.push(`## ${cat} (${items.length})`);
    for (const [mod, modItems] of [...byMod].sort()) {
      lines.push(`### ${mod}`);
      for (const f of modItems) {
        lines.push(formatFindingLine(f));
      }
      lines.push('');
    }
  }
  return lines.join('\n') + '\n';
}

function generateLarge(findings, preserved) {
  // Returns { 'features.md': content, 'bugs.md': content, 'perf.md': content }
  const merged = mergePreserved([...findings], preserved);
  const open = merged.filter(f => f.status !== 'fixed');
  const byCat = groupByCategory(open);
  const files = {};
  const date = todayISO();

  for (const [cat, items] of Object.entries(byCat)) {
    const byMod = groupByModule(items);
    const catSlug = cat.toLowerCase();
    const lines = [];
    lines.push(`# ${cat} Tasks`);
    lines.push(`> ${items.length} open · last sync: ${date}`);
    lines.push('');
    for (const [mod, modItems] of [...byMod].sort()) {
      lines.push(`## ${mod}`);
      for (const f of modItems) {
        lines.push(formatFindingLine(f));
      }
      lines.push('');
    }
    files[`${catSlug}.md`] = lines.join('\n') + '\n';
  }
  return files;
}

// ── Archive ──

function archiveResolved(findings) {
  const resolved = findings.filter(f => f.status === 'fixed' || f.status === 'resolved');
  if (resolved.length === 0) return;

  // Group by month
  const byMonth = new Map();
  for (const f of resolved) {
    const month = (f.resolvedDate || f.discovered || todayISO()).slice(0, 7);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(f);
  }

  if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });

  for (const [month, items] of byMonth) {
    const archiveFile = join(ARCHIVE_DIR, `${month}.md`);
    let existing = '';
    if (existsSync(archiveFile)) {
      existing = readFileSync(archiveFile, 'utf8');
    }

    const newLines = [];
    const today = todayISO();
    for (const f of items) {
      // Check if already archived
      if (existing.includes(f.id)) continue;
      newLines.push(`- [x] ${f.id} [${f.severity}] ${f.summary}`);
      newLines.push(`      → FIXED ${today}: ${f.resolutionNote || 'marked resolved'}`);
      newLines.push('');
    }

    if (newLines.length === 0) continue;

    if (!existing) {
      const header = `# Resolved Tasks — ${month}\n\n`;
      writeFileSync(archiveFile, header + newLines.join('\n') + '\n', 'utf8');
    } else {
      // Insert new items after header line
      const headerEnd = existing.indexOf('\n\n');
      const header = existing.slice(0, headerEnd + 2);
      const body = existing.slice(headerEnd + 2);
      writeFileSync(archiveFile, header + newLines.join('\n') + body, 'utf8');
    }
    const archivedCount = newLines.filter(l => l.startsWith('- [x]')).length;
    console.log(`[sync-tasks] Archived ${archivedCount} items → archive/${month}.md`);
  }
}

// ── MEMORY.md integration ──

const TASK_SECTION_HEADER = '## Tasks (progressive disclosure)';
const TASK_SECTION_DESC = '<!-- Task list managed by sync-tasks.js. Load on demand via the index entries below. Completed tasks are archived to memory/tasks/archive/ and evicted after 90d. -->';

function updateMemoryIndex(scale, openFindings, files) {
  if (!existsSync(MEMORY_INDEX)) return;
  let content = readFileSync(MEMORY_INDEX, 'utf8');
  const today = todayISO();

  // Build task index entries
  const taskEntries = [];
  if (scale === 'large') {
    const catNames = { bugs: 'Bugs', features: 'Features', perf: 'Performance' };
    for (const [catSlug] of Object.entries(files)) {
      const catFindings = openFindings.filter(f => (f.category || 'Bug').toLowerCase() === catSlug);
      taskEntries.push(`- [${today} ${catNames[catSlug] || catSlug}](../memory/tasks/${catSlug}.md) — ${catFindings.length} open`);
    }
  } else {
    taskEntries.push(`- [${today} Active Tasks](../memory/tasks/tasks.md) — ${openFindings.length} open`);
  }

  // Remove old task section if it exists
  const taskSectionStart = content.indexOf(TASK_SECTION_HEADER);
  if (taskSectionStart >= 0) {
    const nextSection = content.indexOf('\n## ', taskSectionStart + TASK_SECTION_HEADER.length);
    if (nextSection >= 0) {
      content = content.slice(0, taskSectionStart - 1) + content.slice(nextSection);
    } else {
      content = content.slice(0, taskSectionStart - 1);
    }
  }

  // Also remove any task entries lingering in Short-term section
  content = content.replace(/^-\s+\[[\d-]+\s+(?:Active Tasks|Bugs|Features|Performance)\]\(\.\.\/memory\/tasks\/.+?\.md\)\s+—.+$/gm, '');
  // Clean up resulting blank lines
  content = content.replace(/\n{3,}/g, '\n\n');

  // Build task section
  const section = [TASK_SECTION_HEADER, '', TASK_SECTION_DESC, '', ...taskEntries, ''].join('\n');

  // Insert before ## Short-term section
  const shortIdx = content.indexOf('\n## Short-term');
  if (shortIdx >= 0) {
    content = content.slice(0, shortIdx) + '\n' + section + content.slice(shortIdx);
  } else {
    content = content.trimEnd() + '\n\n' + section;
  }

  writeFileSync(MEMORY_INDEX, content, 'utf8');
}

// ── Existing task parsing ──

const TASK_LINE_RE = /^-\s+\[([ x])\]\s+(SR-\d{8}-\d{3})\s+\[(\w+)\]\s+(.+?)\s+\((\d{4}-\d{2}-\d{2})\).*$/;

function parseExistingTasks(content) {
  const existing = new Map();
  if (!content) return existing;
  for (const line of content.split('\n')) {
    const m = line.match(TASK_LINE_RE);
    if (m) {
      existing.set(m[2], {
        id: m[2],
        checked: m[1] === 'x',
        severity: m[3],
        summary: m[4].trim(),
        discovered: m[5],
        // Preserve trailing info (ref:, stale marker, likely-resolved)
        trail: line.slice(line.lastIndexOf(`(${m[5]})`) + m[5].length + 1).trim(),
      });
    }
  }
  return existing;
}

// ── Main ──

function main() {
  const args = process.argv.slice(2);
  const checkMode = args.includes('--check');
  const reportMode = args.includes('--report');

  // Collect findings from sharp-review files
  const reviewFiles = collectSharpReviewFiles();
  const allFindings = [];

  for (const { path, date } of reviewFiles) {
    let content;
    try { content = readFileSync(path, 'utf8'); } catch { continue; }
    const findings = parseFindings(content, date);
    for (const f of findings) {
      f.sourceFile = relative(ROOT, path).replace(/\\/g, '/');
    }
    allFindings.push(...findings);
  }

  // Cross-reference with memory entries
  const memoryRefs = collectMemoryRefs();
  // Also scan for findings that have corresponding memory files by slug
  for (const f of allFindings) {
    // Check if any memory entry references this finding by ID
    for (const [slug, ref] of memoryRefs) {
      try {
        const memContent = readFileSync(ref.fullPath, 'utf8');
        if (memContent.includes(f.id)) {
          f.memoryRef = ref.path;
          break;
        }
      } catch {}
    }
    // Fallback: check if memory description matches the finding summary
    if (!f.memoryRef) {
      const summaryLower = f.summary.toLowerCase();
      for (const [slug, ref] of memoryRefs) {
        if (ref.description.toLowerCase().includes(summaryLower.slice(0, 30))) {
          f.memoryRef = ref.path;
          break;
        }
      }
    }
  }

  // Detect scale based on OPEN findings only
  const openFindings = allFindings.filter(f => f.status !== 'fixed');

  if (checkMode) {
    // --check: exit 0 if up to date, exit 1 if needs sync
    if (!existsSync(TASKS_FILE)) {
      console.log('[sync-tasks] No task file found — needs sync');
      process.exit(1);
    }
    const existing = readFileSync(TASKS_FILE, 'utf8');
    if (!existing.includes(`last sync: ${todayISO()}`)) {
      console.log('[sync-tasks] Task file stale — needs sync');
      process.exit(1);
    }
    console.log('[sync-tasks] Task file up to date');
    process.exit(0);
  }

  if (reportMode) {
    console.log(`[sync-tasks] ${reviewFiles.length} review files, ${allFindings.length} findings total`);
    console.log(`[sync-tasks] ${allFindings.filter(f => f.status === 'fixed').length} fixed, ${openFindings.length} open`);
    for (const f of openFindings) {
      const stale = isStale(f) ? ' ⚠ stale' : '';
      const likely = checkFileModified(f) ? ' ⚠ likely-resolved' : '';
      console.log(`  ${f.id} [${f.severity}] ${f.module} — ${f.summary}${stale}${likely}`);
    }
    process.exit(0);
  }

  // Archive resolved findings
  archiveResolved(allFindings);

  // Load existing task file to preserve manual entries
  let preserved = new Map();
  if (existsSync(TASKS_FILE)) {
    const existingContent = readFileSync(TASKS_FILE, 'utf8');
    preserved = parseExistingTasks(existingContent);
  }

  // Generate task file
  const scale = detectScale(openFindings.length);

  if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true });

  if (scale === 'large') {
    const files = generateLarge(openFindings, preserved);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(TASKS_DIR, name), content, 'utf8');
    }
    // Write directory index
    const idxLines = ['# Task Directory', `> Scale: large (${allFindings.length} total, ${openFindings.length} open)`, ''];
    idxLines.push(`→ See sub-files for full lists:`);
    for (const [name] of Object.entries(files)) {
      const catName = name.replace('.md', '');
      const catFindings = openFindings.filter(f => (f.category || 'Bug').toLowerCase() === catName);
      idxLines.push(`- [${catName[0].toUpperCase() + catName.slice(1)}](${name}) (${catFindings.length} items)`);
    }
    writeFileSync(TASKS_FILE, idxLines.join('\n') + '\n', 'utf8');
    updateMemoryIndex(scale, openFindings, files);
    console.log(`[sync-tasks] Large scale — ${Object.keys(files).length} files → memory/tasks/`);
  } else {
    const content = scale === 'small' ? generateSmall(openFindings, preserved) : generateMedium(openFindings, preserved);
    writeFileSync(TASKS_FILE, content, 'utf8');
    updateMemoryIndex(scale, openFindings, {});
    console.log(`[sync-tasks] ${openFindings.length} findings → memory/tasks/tasks.md (${scale} tier)`);
  }

  // Print summary
  const stale = openFindings.filter(isStale).length;
  const likely = openFindings.filter(f => !f.status.startsWith('fix') && checkFileModified(f)).length;
  if (stale > 0) console.log(`[sync-tasks] ⚠ ${stale} stale (>${STALE_DAYS}d)`);
  if (likely > 0) console.log(`[sync-tasks] ⚠ ${likely} likely-resolved (file modified since discovery)`);
}

main();
