# Sharp Review

`sharp-review-hook.js` (Stop hook) classifies review depth (none/once/triple) and delegates to `/sharp-review` skill.

## Provider config
`classify()` reads the active provider env vars (Foundry/custom/Anthropic) — no hardcoded `api.anthropic.com`. Falls back to `mode: 'once'` if model or key missing.

## Review execution
Skill launches 3 parallel reviewers: Codex adversarial-review + DeepSeek takeover + Claude takeover. Minimum 2 of 3. Cross-check: ≥2 agreement = high-confidence.
