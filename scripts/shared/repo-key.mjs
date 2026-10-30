// scripts/shared/repo-key.mjs — one repository's identity across forges, hosts and sessions:
// `<forge host>/<owner>/<name>`, lower-cased. A forge reader keys what it reads with it and a
// session keys its working tree's origin with it, so the two meet by equality, not by a guess.

/** `https://h/o/n.git`, `git@h:o/n.git`, `ssh://git@h:22/o/n` -> `h/o/n`; null when not a forge URL. */
export function repoKey(url) {
  const s = String(url ?? '').trim();
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(s);
  return m ? `${m[1]}/${m[2]}/${m[3]}`.toLowerCase() : null;
}
