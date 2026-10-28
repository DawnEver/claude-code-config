// scripts/dashboard/public/shared/config-keys.mjs — the config keys the dashboard may change, defined
// once for the Worker, the host (scripts/bridge/context.mjs) and the page (bounds and options; its example data). Labels are words: i18n.mjs `config.<key>`.
// Pure: no imports.

// The only keys a remote request can touch: behaviour that grants nothing. Permissions
// (allowedUserIds, approvalsFromTelegram), routing (chat ids) and secrets are never here, so a
// compromised dashboard or Telegram account cannot widen who controls a host or where its
// sessions go. Both the Worker and the host validate against this one table.
const int = (lo, hi) => Object.assign((v) => (Number.isInteger(v) && v >= lo && v <= hi ? v : undefined), { min: lo, max: hi });
// No dots in the name: the key is a dotted path, and a dot would address another object.
const PROJECT = /^bridge\.projects\.([A-Za-z0-9_-]{1,100})\.projectInTitle$/;
export const CONFIG_KEYS = {
  'bridge.idleCloseMinutes': { parse: int(0, 1440) },
  'bridge.deleteClosedAfterHours': { parse: int(0, 720) },
  'bridge.dashboard.everySeconds': { parse: int(5, 3600) },
  'bridge.projects.*.projectInTitle': { options: ['always', 'main', 'never'],
    parse: (v) => (['always', 'main', 'never'].includes(v) ? v : undefined) },
};

/** CONFIG_KEYS as plain data (bounds or options), as the snapshot serves it to the page. */
export const configKeysMeta = () => Object.entries(CONFIG_KEYS).map(([key, s]) => ({ key,
  ...(s.options ? { options: s.options } : { min: s.parse.min, max: s.parse.max }) }));

/** The table entry for a concrete key (a project key matches its `*` pattern), or null. */
export function configKey(key) {
  if (typeof key !== 'string') return null;
  if (CONFIG_KEYS[key] && !key.includes('*')) return CONFIG_KEYS[key];
  return PROJECT.test(key) ? CONFIG_KEYS['bridge.projects.*.projectInTitle'] : null;
}

/** A requested change -> {key, value} when the key is editable and the value valid, else null. */
export function parseConfigChange(c) {
  const spec = configKey(c?.key);
  const value = spec?.parse(c.value);
  return value === undefined || !spec ? null : { key: c.key, value };
}
