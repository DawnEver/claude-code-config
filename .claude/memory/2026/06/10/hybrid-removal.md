---
name: hybrid-removal
description: cc v2.1.170 — hybrid 模式下的 Claude 模型无法使用 auto mode，已移除 hybrid provider 和 cchb alias
metadata:
  type: project
---

cc v2.1.170 中，hybrid provider（混用 DeepSeek Fable/Haiku + Anthropic Opus/Sonnet）下的 Claude 模型无法使用 auto mode。已移除 hybrid provider 及 `cchb` alias，仅保留 `cc`（claude）和 `ccds`（deepseek）两个 provider。

**Why:** hybrid 模式下 Claude 模型不支持 auto mode，导致实际使用受限。
**How to apply:** 不再添加 hybrid provider。如需混合使用各 provider 的模型，使用 takeover 功能在对话中切换。
