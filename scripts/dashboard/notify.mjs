// scripts/dashboard/notify.mjs — the one way the dashboard bot speaks: every message it sends is an
// alert (data, {kind, ...}) worded here and sent by `telegramNotifier` (docs/dashboard.md "Alerts").
// The Worker sends what the registry judges worth telling; `deploy.mjs test-alert` sends a `test`
// alert through the same code. One shape for all of them:
//
//   <what happened>: <who or what>
//   <detail>
//   <link>
//
// ALERTS is the single table of kinds: each names its subject, detail and link; the words are
// i18n keys (`alert.<kind>` the heading, `alert.detail.*` the details). Plain text, no parse
// mode: nothing a host reports can turn into markup or a link it did not write.

import { t } from './public/shared/i18n.mjs';
import { agentName } from './public/shared/vocab.mjs';
import { countdown } from './public/view.mjs';

const TELEGRAM_MAX = 4096;

/** An account as the alerts name it: agent, seat, email. */
const accountOf = (a) => [agentName(a.account?.agent), a.account?.label, a.account?.email].filter(Boolean).join(' · ');

/** Every kind the bot sends: subject, detail and link of an alert, worded on `now` in `lang`. */
const ALERTS = {
  exhausted: {
    subject: (a) => accountOf(a),
    detail: (a, now, lang) => t('alert.detail.window', lang, { k: a.window, in: a.resetsAt > now ? countdown(a.resetsAt, now) : null }),
  },
  'seat-problem': { subject: (a) => accountOf(a), detail: (a) => a.problem },
  'extra-reset': {
    subject: (a) => accountOf(a),
    detail: (a, now, lang) => (a.at > now ? t('alert.detail.in', lang, { in: countdown(a.at, now) }) : null),
    url: (a) => a.url,
  },
  'host-offline': {
    subject: (a) => a.host,
    detail: (a, now, lang) => (a.lastSeen ? t('alert.detail.silent', lang, { for: countdown(now, Date.parse(a.lastSeen)) }) : t('alert.detail.neverSeen', lang)),
  },
  'turn-failed': {
    subject: (a) => [agentName(a.agent), a.host, a.project, a.session].filter(Boolean).join(' · '),
    detail: (a) => a.error,
    url: (a) => a.url,
  },
  'config-refused': {
    subject: (a) => `${a.key} = ${JSON.stringify(a.value)}`,
    detail: (a, now, lang) => t('alert.detail.refusedBy', lang, { host: a.host, error: a.error }),
  },
  test: { subject: (a) => a.from ?? null, detail: (a, now, lang) => t('alert.detail.test', lang) },
};

export const ALERT_KINDS = Object.keys(ALERTS);

/** An alert (registry.mjs, or a test) as the message the bot sends, on `now`'s clock: a countdown is to now. */
export function alertText(a, now = Date.now(), lang = 'en') {
  const k = ALERTS[a.kind];
  if (!k) return a.kind;
  const subject = k.subject(a);
  return [`${t(`alert.${a.kind}`, lang)}${subject ? `${t('alert.sep', lang)}${subject}` : ''}`, k.detail?.(a, now, lang), k.url?.(a)].filter(Boolean).join('\n');
}

/**
 * `notify(alert)` sending each alert to every chat in `chatIds` (a user id is that user's private
 * chat with the bot). Never throws: a failure is logged without the token, and the next chat is
 * tried. Resolves the chats it reached.
 */
export function telegramNotifier({ token, chatIds, lang = 'en', fetch = globalThis.fetch, log = () => {}, now = Date.now }) {
  return async (alert) => {
    const text = alertText(alert, now(), lang).slice(0, TELEGRAM_MAX);
    const reached = [];
    for (const chatId of chatIds) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }) });
        const out = await res.json().catch(() => ({}));
        if (out.ok) reached.push(chatId);
        else log(`alert ${alert.kind} to ${chatId} not sent: ${out.description ?? `HTTP ${res.status}`}`);
      } catch (e) { log(`alert ${alert.kind} to ${chatId} not sent: ${e.message}`); }
    }
    return reached;
  };
}
