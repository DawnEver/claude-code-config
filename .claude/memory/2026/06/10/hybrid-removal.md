---
name: hybrid-removal
description: cc v2.1.170 — Claude models under hybrid mode cannot use auto mode; removed the hybrid provider and the cchb alias
metadata:
  type: project
---

In cc v2.1.170, Claude models under the hybrid provider (mixing DeepSeek Fable/Haiku + Anthropic Opus/Sonnet) cannot use auto mode. Removed the hybrid provider and the `cchb` alias, keeping only the two providers `cc` (claude) and `ccds` (deepseek).

**Why:** Claude models do not support auto mode in hybrid mode, which limits practical use.
**How to apply:** Do not add a hybrid provider again. To mix models from different providers, use the takeover feature to switch within a conversation.
