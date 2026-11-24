// The cc-market plugins retired by the user ruling of 2026-11-24 (cc-market keeps only cc-academia).
// No template here enables one (retired-plugins.test.mjs); a machine removes an installed one with
// `claude plugin uninstall <name>@cc-market` (rem: dev-lab's `python -m dev_lab.dev.remretired uninstall --apply`).
export const RETIRED_PLUGINS = Object.freeze(['rem', 'sharp-review', 'evolve', 'watch', 'cc-latex', 'traceme', 'fabric']);
