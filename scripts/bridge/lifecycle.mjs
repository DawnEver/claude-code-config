// scripts/bridge/lifecycle.mjs — the one session lifecycle, for every host (docs/bridge.md
// "Session lifecycle"). Pure: each transition mutates the session record and returns the
// Telegram actions the daemon must run, in order, on that session's write queue.
//
//   none   registered, no Topic (a leftover that was loaded before the bridge started)
//   open   Topic open
//   closed Topic closed (idle), session still registered; closedAt recorded
//   ended  session gone; its Topic is closed and ages towards deletion
//
// Actions: 'create' (new Topic + `session up`), 'reopen', 'close', 'notice-ended'.

/** @param {{key: string, cached: {topicId, closedAt?}|null, now: number}} */
export function newSession({ key, cached, now }) {
  return {
    key,
    topicId: cached?.topicId ?? null,
    statusMessageId: Number.isSafeInteger(cached?.statusMessageId) ? cached.statusMessageId : null,
    state: cached ? (cached.closedAt != null ? 'closed' : 'open') : 'none',
    closedAt: cached?.closedAt ?? null,
    lastActivity: now,
  };
}

/** A session appeared. A leftover stays as it is until it shows activity. */
export function onUp(s, { preexisting, now }) {
  return preexisting ? [] : onActivity(s, now);
}

/** Any prompt, progress, final, approval or Telegram inject. */
export function onActivity(s, now) {
  if (s.state === 'ended') return [];
  s.lastActivity = now;
  const was = s.state;
  s.state = 'open';
  s.closedAt = null;
  if (was === 'none') return ['create'];
  if (was === 'closed') return ['reopen'];
  return [];
}

/** Close an open Topic after `minutes` without activity (0 = never). */
export function onIdleTick(s, now, minutes) {
  if (!(minutes > 0) || s.state !== 'open' || !s.topicId || now - s.lastActivity < minutes * 60000) return [];
  s.state = 'closed';
  s.closedAt = now;
  return ['close'];
}

/** The session ended. Only an open Topic gets a notice; a closed one keeps its closedAt. */
export function onDown(s, now) {
  const was = s.state;
  s.state = 'ended';
  if (was !== 'open') return [];
  if (!s.topicId) return ['notice-ended'];
  s.closedAt = now;
  return ['notice-ended', 'close'];
}

/** The session turned out not to be a main session: close its Topic, no notice. */
export function onDismiss(s, now) {
  const was = s.state;
  s.state = 'ended';
  if (was !== 'open' || !s.topicId) return [];
  s.closedAt = now;
  return ['close'];
}

/** Telegram says the Topic no longer exists. */
export function onTopicGone(s) {
  s.topicId = null;
  s.state = 'open';
  s.closedAt = null;
  return ['create'];
}

/** Telegram refused a post because the Topic is closed (e.g. closed by hand). */
export function onTopicFoundClosed(s) {
  s.state = 'open';
  s.closedAt = null;
  return ['reopen'];
}

/** The topics.json entry for a session, or null when it holds no Topic. */
export function cacheEntry(s, title) {
  if (!s.topicId) return null;
  return { topicId: s.topicId, title, ...(s.closedAt != null ? { closedAt: s.closedAt } : {}),
    ...(s.statusMessageId ? { statusMessageId: s.statusMessageId } : {}) };
}
