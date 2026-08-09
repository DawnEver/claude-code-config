# System Prompt CHANGELOG — official-update absorption log

## 2.1.226 — checked 2026-08-09

140 main-prompt parts tracked (~7k chars of filenames) — every part's own ccVersion is shown per line below; anything with cc != — is new or changed since the last check.

### Suggested absorption review (human decision required)

**Likely relevant to our prompt:**
- [ ] artifact-comment-decision-reformat-retry.md (cc 2.1.223): Instructs the Artifact comment composer to reformat a malformed prior response as exactly 
- [ ] artifact-comment-edit-composer.md (cc 2.1.223): Instructs a tool-less Artifact comment composer to emit exactly one reply or edit decision
- [ ] artifact-comment-list-framing.md (cc 2.1.222): Frames Artifact comment-list tool results as untrusted viewer data using randomized fences
- [ ] artifact-comment-reply-composer.md (cc 2.1.225): Instructs a tool-less composer to answer an Artifact comment thread or flag requested arti
- [ ] artifact-comment-thread-framing.md (cc 2.1.222): Frames an Artifact comment thread and optional anchor context as untrusted viewer data usi
- [ ] auto-memory-durable-lesson-instructions.md (cc 2.1.224): Instructs the auto-memory system to save only durable user-taught lessons, validate each t
- [ ] combined-memory-index-pointer-instructions.md (cc 2.1.173): Instructs the agent to add one-line pointers for private and team memories to the single p
- [ ] comment-what-and-task-context-avoidance.md (cc 2.1.161): Instructs Claude not to write comments that explain what code does or reference transient 
- [ ] comment-why-only-guidance.md (cc 2.1.161): Instructs Claude to write code comments only when the reason is non-obvious and useful to 
- [ ] communication-style.md (cc 2.1.104): Instructs Claude to give brief, user-facing updates at key moments during tool use, write 
- [ ] context-compaction-summary.md (cc 2.1.38): Prompt used for context compaction summary (for the SDK)
- [ ] description-part-of-memory-instructions.md (cc 2.1.69): Field for describing _what_ the memory is.  Part of a bigger effort to instruct Claude how
- [ ] doing-tasks-ambitious-tasks.md (cc 2.1.53): Allow users to complete ambitious tasks; defer to user judgement on scope
- [ ] doing-tasks-help-and-feedback.md (cc 2.1.53): How to inform users about help and feedback channels
- [ ] doing-tasks-no-compatibility-hacks.md (cc 2.1.53): Delete unused code completely rather than adding compatibility shims
- [ ] doing-tasks-no-unnecessary-additions.md (cc 2.1.161): Do not add features, refactor, or improve beyond what was asked
- [ ] doing-tasks-no-unnecessary-error-handling.md (cc 2.1.53): Do not add error handling for impossible scenarios; only validate at boundaries
- [ ] doing-tasks-security.md (cc 2.1.53): Avoid introducing security vulnerabilities like injection, XSS, etc.
- [ ] doing-tasks-software-engineering-focus.md (cc 2.1.53): Users primarily request software engineering tasks; interpret instructions in that context
- [ ] dream-claude-md-memory-reconciliation.md (cc 2.1.212): Instructs dream memory consolidation to reconcile feedback and project memories against CL
- [ ] dream-team-memory-handling.md (cc 2.1.98): Instructions for handling shared team memories during dream consolidation, including dedup
- [ ] executing-actions-with-care.md (cc 2.1.200): Instructions for executing actions carefully.
- [ ] feedback-memory-body-structure.md (cc 2.1.173): Defines the body structure for feedback memories, including the rule, why, and how to appl
- [ ] feedback-memory-save-guidance.md (cc 2.1.173): Explains when to save feedback memories from user corrections or confirmed non-obvious app
- [ ] git-status.md (cc 2.1.88): System prompt for displaying the current git status at the start of the conversation
- [ ] harness-instructions.md (cc 2.1.216): Core interactive-agent identity and harness instructions for terminal Markdown output, sec
- [ ] interactive-agent-intro-output-style-conditional.md (cc 2.1.173): Opening system-prompt line that branches on whether an Output Style is configured
- [ ] memory-description-of-user-feedback.md (cc 2.1.78): Describes the user feedback memory type that stores guidance about work approaches, emphas
- [ ] memory-index-pointer-instructions.md (cc 2.1.224): Instructs the agent to add one-line pointers to the memory index file and treat the index 
- [ ] memory-instructions.md (cc 2.1.224): Instructions for using persistent file-based memory, including memory file format, scope, 
- [ ] memory-persistence-scope.md (cc 2.1.173): Explains that memory is for information useful in future conversations, not only within th
- [ ] memory-save-exclusions.md (cc 2.1.161): Lists categories of information that should not be saved in memory, even when the user ask
- [ ] outcome-first-communication-style.md (cc 2.1.169): Instructs Claude to keep user-facing updates readable and outcome-first, answer directly a
- [ ] parallel-tool-call-note-part-of-tool-usage-policy.md (cc 2.1.30): System prompt telling Claude to use parallel tool calls
- [ ] permission-classifier-strict-review-guidance.md (cc 2.1.173): Instructs the permission classifier to carefully deny blocked actions and require explicit
- [ ] personal-project-memory-description.md (cc 2.1.173): Describes project memories for ongoing work, goals, initiatives, bugs, or incidents releva
- [ ] plan-vs-memory-guidance.md (cc 2.1.173): Explains when to use or update a plan instead of saving information to memory
- [ ] project-memory-body-structure.md (cc 2.1.173): Defines the body structure for project memories, including the fact or decision, why, and 
- [ ] project-memory-save-guidance.md (cc 2.1.173): Explains when to save project memories about who is doing what, why, or by when, including
- [ ] project-skill-upkeep-for-feedback-memory.md (cc 2.1.200): Instructs Claude to update the relevant project skill when saving feedback memory about re
- [ ] repl-tool-usage-and-scripting-conventions.md (cc 2.1.217): Instructs Claude on how to use the REPL tool effectively with dense JavaScript scripts, sh
- [ ] system-section.md (cc 2.1.173): System section of the main system prompt.
- [ ] tasks-vs-memory-guidance.md (cc 2.1.173): Explains when to use tasks instead of saving current-conversation progress to memory
- [ ] team-memory-index-pointer-instructions.md (cc 2.1.173): Instructs the agent to add one-line memory pointers to the appropriate team memory index f
- [ ] team-project-memory-description.md (cc 2.1.173): Describes project memories for shared ongoing work, goals, initiatives, bugs, or incidents
- [ ] teammate-communication.md (cc 2.1.173): System prompt for teammate communication in swarm
- [ ] tone-and-style-code-references.md (cc 2.1.53): Instruction to include file_path:line_number when referencing code
- [ ] tone-and-style-concise-output-short.md (cc 2.1.53): Instruction for short and concise responses
- [ ] tool-usage-subagent-guidance.md (cc 2.1.53): Guidance on when and how to use subagents effectively
- [ ] tool-usage-task-management.md (cc 2.1.81): Use TodoWrite to break down and track work progress
- [ ] user-memory-usage-guidance.md (cc 2.1.173): Explains when to use user memories to tailor responses to the user's profile or perspectiv

**Probably irrelevant (feature/utility prompts):**
- act-when-ready.md (cc 2.1.173)
- action-safety-and-truthful-reporting.md (cc 2.1.219)
- advisor-tool-instructions.md (cc 2.1.98)
- agent-summary-generation.md (cc 2.1.32)
- agent-thread-notes.md (cc 2.1.187)
- auto-mode-setup-proposal-generator.md (cc 2.1.213)
- auto-mode.md (cc 2.1.139)
- autonomous-loop-check.md (cc 2.1.101)
- autonomous-loop-notification-guidance.md (cc 2.1.173)
- autonomous-loop-persistence-guidance-claude-code-loop-persistent.md (cc 2.1.129)
- autonomous-loop-tick-dynamic-pacing.md (cc 2.1.173)
- autonomous-loop-tick.md (cc 2.1.173)
- autonomous-operation-guidelines.md (cc 2.1.169)
- avoiding-unnecessary-sleep-commands-part-of-powershell-tool-description.md (cc 2.1.108)
- background-session-instructions.md (cc 2.1.221)
- background-session-worktree-persistence-guidance.md (cc 2.1.221)
- background-subagent-delegation-examples.md (cc 2.1.211)
- background-worktree-isolation-guidance.md (cc 2.1.169)
- censoring-assistance-with-malicious-activities.md (cc 2.1.31)
- chrome-browser-mcp-tools.md (cc 2.1.221)
- …and 69 more

**Tool-description changes (schema lives in body.tools — auto, but check new tools):**