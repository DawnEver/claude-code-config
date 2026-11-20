# cc-market has one checkout, declared by the machine file

Supersedes `2026/06/07/cc-market-separate-repo.md` (which described a clone setup made inside this repo).

User, 2026-11-19: two cc-market clones (one nested here, one with the family repos) -- keep one. The family
checkout stays. cc-config now reads its location from the machine file `[repos] cc-market` through
`scripts/shared/market-dir.mjs` (lab_commons' reader), used by setup, doctor, agy-config, the plugin launcher
and migrate. Setup no longer clones cc-market here; an undeclared location refuses by name with the door
`python -m dev_lab.dev.devhost local set repos.cc-market <path>`. No fallback to `<repo>/cc-market`.

Before the nested folder is deleted, the machine file must point at the family checkout (it still named the
nested path on 11-19). The `cc-market/` ignore line stays until the folder is gone (it is rendered from
`scripts/_famconfig.py`).
