"""claude-code-config's delta against each family config base -- data, computed by nothing.

The bases live in ``dev_lab.dev._famconfig_rows``; ``python -m dev_lab.dev.famfiles --deltas
scripts/_famconfig.py`` turns base plus delta into the file.
"""

from __future__ import annotations

from typing import Final

from dev_lab.dev.famconfig import Delta

__all__ = ['DELTAS', 'REPO']

REPO: Final = 'claude-code-config'

_GITIGNORE: Final = (
    # Node and the generated bundles.
    'node_modules/',
    'package-lock.json',
    'dist/',
    'system-prompt/dist/',
    '.codex',
    # The private payload setup links in (claude_settings.template.json etc. are the tracked shapes).
    'claude_env_settings.json',
    'claude_settings.json',
    'codex_config.toml',
    'private-markers',
    'trusted-origins',
    'models.json',
    # setup keeps a replaced private copy beside the name it re-linked
    '/*.setup-bak',
    # The cc-market checkout linked beside the config, never this repo's content.
    'cc-market/',
    '**/.claude/memo/',
    '**/.claude/watch/**',
    '!**/.claude/watch/',
    '!**/.claude/watch/components/',
    '!**/.claude/watch/components/*.py',
    '!**/.claude/watch/config.yaml',
    # Account-synced skills the CLI downloads into ~/.claude/skills/synced, a link into this repo.
    'skills/synced/',
    # claude-hud's machine-tuned config is hard-linked into ~/.claude; the template is tracked.
    'claude_plugins/claude-hud/config.json',
    # wrangler dev secrets and state (scripts/dashboard)
    '.dev.vars',
    '.wrangler/',
)

_GITATTRIBUTES: Final = (
    '.claude/memory/**/*.md text eol=lf',
    '.claude/rules/**/*.md text eol=lf',
)

_RGIGNORE: Final = ('.submodules/', '.git/', '!cc-market/')

DELTAS: Final[dict[str, Delta]] = {
    '.gitignore': Delta(repo=REPO, added=_GITIGNORE, dropped={}, ceiling=len(_GITIGNORE)),
    '.gitattributes': Delta(repo=REPO, added=_GITATTRIBUTES, dropped={}, ceiling=len(_GITATTRIBUTES)),
    '.rgignore': Delta(repo=REPO, added=_RGIGNORE, dropped={}, ceiling=len(_RGIGNORE)),
}
