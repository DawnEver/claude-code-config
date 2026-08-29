# Claude Code & Codex provider aliases — sourced by ~/.bashrc / ~/.zshrc
# Managed by scripts/setup/setup.js — edit claude_env_settings.json (the
# `providers.<name>` block) to change providers. One source of truth feeds both
# hosts: `cc.js` reads it for the `claude` binary, `codex.js` for the `codex`
# binary.

alias ccc='node ~/.claude/scripts/runtime/cc.js claude'
alias ccds='node ~/.claude/scripts/runtime/cc.js deepseek'
alias cckm='node ~/.claude/scripts/runtime/cc.js kimi'
alias ccgmi='node ~/.claude/scripts/runtime/cc.js gmi'
alias cods='node ~/.claude/scripts/runtime/codex.js deepseek'
alias todo='node ~/.claude/scripts/runtime/todo-launcher.mjs'
