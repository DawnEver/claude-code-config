---
name: multi-device-fabric-direction
---

# Multi-device direction: message-passing teammates, no shared FS

Session decision (2026-07-31): multi-device work distribution for fabric uses a **pure
message-passing teammate model** — a peer machine is like a Claude Code teammate you
converse with, never a filesystem you reach into. The OneDrive-shared-repo model was
explicitly rejected as too complex. Remote sessions run in the peer's own project dir
(referenced by an alias registered on that machine, never by path) with the peer's own
credentials; only text travels. File sync is git's job, negotiated in conversation.

Parent-repo side of the change (commit 60771c0): `claude_env_settings.template.json` gained
a desensitized `fabric` block — `token` (shared secret), `nodes` (peer roster), `serve`
(port + `projects` alias map). Riding the synced env-settings file distributes roster and
token to every machine automatically. Implementation lives in cc-market fabric (commit
523c811; see fabric's memory entry `lan-node-fabric`).

Future: a multi-device multi-agent (codex/claude/API heterogeneous) management platform is
a **separate project**, not part of fabric — control plane vs. fabric's execution plane. It
should be a read-only privileged node on this same node protocol (v1 observe-only), sharing
the discovery/auth/transport layer. Differentiation vs. official Claude Code offerings:
heterogeneous agents + self-hosted LAN.
