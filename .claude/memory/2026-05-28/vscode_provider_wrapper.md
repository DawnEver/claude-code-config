---
name: vscode-provider-wrapper
description: VS Code extension uses claudeCode.claudeProcessWrapper to switch providers; use bare command name for cross-platform sync
metadata:
  type: project
---

Set `claudeCode.claudeProcessWrapper = "ccds"` (bare name, not full path) in VS Code user settings to route the VS Code extension through an alternative provider.

**Why:** Full path breaks cross-platform VS Code Settings Sync (Windows path invalid on Mac/Linux). Bare command works because `ccds` is installed alongside `claude` and is always on PATH.

**How to apply:** When documenting or setting up provider switching, always use bare command name. README.md#vscode-extension and setup.js HINT both reflect this.
