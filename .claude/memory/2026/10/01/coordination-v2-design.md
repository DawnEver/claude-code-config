---
name: coordination-v2-design
---

# v2 coordination view + issue conventions — approved design (2026-10-01)

User approved the design and all four default decisions ("同意默认决策，按顺序去做").
Principles: first principles, no baggage, Occam, single source of truth. Fits the family
protocol (lab-commons `the-three-participants.md`): readiness = ref movement on origin;
chat/notification is a hint, never a trigger.

## Part A — lab-commons (family process)
- **A1 verdict → commit status** (completes forge.md "Layer C" steps 3–4, unbuilt as of
  2026-10-01; the status check was disabled 2026-08-27 because nothing published it).
  Contexts `lab/gate` (lane gate, dev agent posts) and `lab/heavy` (integrator; gates `main`).
  PASS→success, FAIL→failure, INCONCLUSIVE→**no status**. Description = the verdict line.
  `verify`/gate runner posts automatically via new forge verbs `status post|list`; missing
  credentials skip, a post failure never changes the verdict. Then enable `main` protection
  requiring `lab/heavy` — **ask the user first** (forge setting).
- **A2 issues = intent only; state is derived, never hand-kept, NO status labels**:
  open & unreferenced = todo; a branch commit `Refs #N` = in progress; that tip has
  `lab/gate` success = ready; `Closes #N` landing on main = done (forge auto-closes).
  `feat/<slug>` covers many issues via commits; `fix/<N>-<slug>` for one.
  Claim = forge comment `claim <branch>` with provenance line (single account → assignee is
  useless); conflicting claims are resolved by the human. Agent→agent = `@<machine>` in an
  issue comment — hint only. forge verbs `issue claim`, `issue status <N>` (derives the
  table). Rule rows ISSUE-IS-INTENT, VERDICT-AS-STATUS. commit-msg warns on malformed refs
  but never requires one. Docs: `docs-src/dev/issues.md` + forge.md publish steps.

## Part B — cc-config bridge observer (observe only, never triggers)
- Sources: origin tips (`git ls-remote`/`fetch` in the project's own repo — remote refs only),
  commit statuses and issue comments via that repo's `python -m lab_commons.dev.forge ... --json`
  (family repos only; others skip; cc-config never imports lab-commons).
- No duplicate posts across 6 bots: each machine reports only pushes whose committer carries
  its own machine name (provenance `Name (<machine-b>/codex)`); unprovenanced (human) pushes are
  reported by `bridge.coordinator` (<machine-a>) only.
- Session Topic: `pushed abc123 → feat/x (+3)`, `lab/gate PASS abc123`. Project group gets a
  `lanes` Topic (created by the coordinator machine): new issues, lane state changes, `@machine`
  hints for machines with no live session. Docs `docs/coordination.md`.

## Order
1. wait for the running bridge unified-lifecycle refactor (cc-config) and the <group> closing pass
   (lab-commons/<project-c>/<project-b>) to avoid conflicts; 2. Part A; 3. Part B with live checks;
4. Layer C protection — after a real `lab/heavy` status exists, with user confirmation.
