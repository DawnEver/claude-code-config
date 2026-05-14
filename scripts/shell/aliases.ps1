# Claude Code provider aliases — dot-sourced by PowerShell profile
# Managed by scripts/setup.js — edit claude_env_settings.json to change providers

function cc { node ~/.claude/scripts/cc.js claude @args }
function ccds { node ~/.claude/scripts/cc.js deepseek @args }
