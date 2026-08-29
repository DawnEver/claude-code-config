# Claude Code & Codex provider aliases — dot-sourced by PowerShell profile
# Managed by scripts/setup/setup.js — edit claude_env_settings.json (the
# `providers.<name>` block) to change providers. One source of truth feeds both
# hosts: `cc.js` reads it for the `claude` binary, `codex.js` for the `codex`
# binary.

$claudeRuntime = Join-Path $HOME ".claude/scripts/runtime"

function ccc   { node (Join-Path $claudeRuntime "cc.js") claude @args }
function ccds  { node (Join-Path $claudeRuntime "cc.js") deepseek @args }
function cckm  { node (Join-Path $claudeRuntime "cc.js") kimi @args }
function ccgmi { node (Join-Path $claudeRuntime "cc.js") gmi @args }
function cods  { node (Join-Path $claudeRuntime "codex.js") deepseek @args }
function todo  { node (Join-Path $claudeRuntime "todo-launcher.mjs") @args }
