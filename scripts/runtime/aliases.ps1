# Claude Code provider aliases — dot-sourced by PowerShell profile
# Managed by scripts/setup/setup.js — edit claude_env_settings.json to change providers

$claudeRuntime = Join-Path $HOME ".claude/scripts/runtime"

function ccc { node (Join-Path $claudeRuntime "cc.js") claude @args }
function ccds { node (Join-Path $claudeRuntime "cc.js") deepseek @args }
function todo { node (Join-Path $claudeRuntime "todo-launcher.mjs") @args }
