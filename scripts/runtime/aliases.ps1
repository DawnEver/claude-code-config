# Claude Code provider aliases — dot-sourced by PowerShell profile
# Managed by scripts/setup/setup.js — edit claude_env_settings.json to change providers

function cc { node ~/.claude/scripts/runtime/cc.js claude @args }
function ccds { node ~/.claude/scripts/runtime/cc.js deepseek @args }
function todo { node ~/.claude/scripts/runtime/todo-launcher.mjs @args }
