// scripts/dashboard/notify.mjs — the gateway's one way to tell the human something: a message from
// the dashboard bot in each allowed user's private chat (docs/dashboard.md "Alerts"). The registry
// judges what is worth telling, as data ({kind, ...}); this words it and sends it. Plain text, no
// parse mode: nothing a host reports can turn into markup or a link it did not write.

import { t } from './public/shared/i18n.mjs';
import { agentName } from './public/shared/vocab.mjs';
import { countdown } from './public/view.mjs';

const TELEGRAM_MAX = 4096;

/** Who an alert is about, as one prefix: the account, else the host and session. */
function who(a) {
  if (a.account) return `${agentName(a.account.agent)}${a.account.label ? ` · ${a.account.label}` : ''}${a.account.email ? ` (${a.account.email})` : ''}: `;
  return '';
}

/** An alert (registry.mjs) in words, on `now`'s clock: a countdown is to now, not to when it was judged. */
export function alertText(a, now = Date.now(), lang = 'en') {
  const until = (at) => (at > now ? countdown(at, now) : null);
  switch (a.kind) {
    case 'exhausted': return `${who(a)}${t('quota.exhausted', lang, { k: a.window, reset: until(a.resetsAt) ? t('quota.resetSuffix', lang, { in: until(a.resetsAt) }) : '' })}`;
    case 'seat-problem': return `${who(a)}${a.problem}`;
    case 'extra-reset': return t('alert.extraReset', lang, { who: who(a), in: until(a.at), url: a.url });
    case 'config-refused': return t('alert.configRefused', lang, { key: a.key, value: JSON.stringify(a.value), host: a.host, error: a.error });
    case 'host-offline': return t('alert.hostOffline', lang, { host: a.host, for: a.lastSeen ? countdown(now, Date.parse(a.lastSeen)) : null });
    case 'turn-failed': return t('alert.turnFailed', lang, { host: a.host, agent: agentName(a.agent), session: a.session, project: a.project, error: a.error, url: a.url });
    default: return a.kind;
  }
}

/**
 * `notify(alert)` sending each alert to every chat in `chatIds` (a user id is that user's private
 * chat with the bot). Never throws: a failure is logged without the token, and the next alert is tried.
 */
export function telegramNotifier({ token, chatIds, lang = 'en', fetch = globalThis.fetch, log = () => {}, now = Date.now }) {
  return async (alert) => {
    const text = alertText(alert, now(), lang).slice(0, TELEGRAM_MAX);
    for (const chatId of chatIds) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }) });
        const out = await res.json().catch(() => ({}));
        if (!out.ok) log(`alert ${alert.kind} to ${chatId} not sent: ${out.description ?? `HTTP ${res.status}`}`);
      } catch (e) { log(`alert ${alert.kind} to ${chatId} not sent: ${e.message}`); }
    }
  };
}
