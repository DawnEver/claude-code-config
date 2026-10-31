// scripts/dashboard/public/app.js — the Mini App's DOM side. Authenticates every request
// with the raw Telegram initData (the gateway verifies it); never reads initDataUnsafe for
// anything but display (the user's language). All data is rendered with textContent, never as HTML.
// Every word shown comes from shared/i18n.mjs.

import { GROUPS, accountSessions, codeView, ago, applyFilters, countdown, displayStatus, filterOptions, unreadEvents, tabs, accountName, verdictText, accountIndex, accountTag, hostsView, timeTicks, configView, configLabel, CONFIG_GROUPS, groupSessions, resetText, windowLabel, emailName, bestAccounts, amount, formatTime, sessionLabel, chatTime, unreadBadge, unreadHere, topicTarget, replyTime, sessionsOf, resourceView, providerName, agentName, eventText, usageView, tokenText, hoursText, statusLabel } from './view.mjs';
import { t, defaultLang, LANGS } from './shared/i18n.mjs';
import { USAGE_FILTER_MAX } from './shared/vocab.mjs';
import { demoMasker } from './demo.mjs';
import { mockDashboard } from './mock.mjs';
import { LOGOS } from './logos.mjs';

const POLL_MS = 8000;
const REPO = 'https://github.com/DawnEver/claude-code-config';
const tg = window.Telegram?.WebApp;
const params = new URLSearchParams(location.search);
const mock = params.has('mock');
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const filters = { group: 'all', host: '', agent: '', project: '' };
let snapshot = null;
let lastOk = null;
let loading = false;
let selectsKey = null;
// Settings of this device: localStorage, never sent anywhere (private mode: none kept).
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
// The UI language: chosen on this device, else what the Telegram user's language asks for.
const autoLang = defaultLang(tg?.initDataUnsafe?.user?.language_code ?? navigator.language);
let langChoice = LANGS.includes(store.get('dashboard.lang')) ? store.get('dashboard.lang') : 'auto';
let lang = langChoice === 'auto' ? autoLang : langChoice;
const tr = (key, vars) => t(key, lang, vars);
const agoText = (ms) => ago(new Date(ms).toISOString(), Date.now(), lang);
// The open tab survives a reopen: a #quota / #events link opens that tab; otherwise the last
// one used; sessions the first time.
const TABS = ['sessions', 'quota', 'usage', 'code', 'events', 'config'];
const hashTab = location.hash.slice(1);
let tab = [hashTab, store.get('dashboard.tab')].find((x) => TABS.includes(x)) ?? 'sessions';
// Events newer than this were not seen yet: kept on this device, moved on by opening the tab.
let seenAt = store.get('dashboard.eventsSeenAt');
// The Events tab lists what was unread when it was opened: read events are cleared on the next visit.
let shownFrom = seenAt;
// Demo mode (Config › Developer, or `?demo`): the live data with every identity masked in this
// browser, for showing the dashboard to others. A setting of this device only: nothing reaches the gateway.
if (params.has('demo')) store.set('dashboard.demo', '1');
let demoOn = store.get('dashboard.demo') === '1';
let masker = null;   // one per page: names stay put when demo is toggled off and on
let raw = null;      // the last snapshot as fetched; `snapshot` is what is shown
const shown = () => (raw && demoOn ? (masker ??= demoMasker())(raw) : raw);
// Quota rows opened to their detail (host|account), kept across polls.
const openRows = new Set();
// Quota hosts opened from their header: every account row open, plus the host's facts.
const openHosts = new Set();
let accounts = new Map();
let hostList = [];   // hostsView(snapshot): the one host model the Sessions and Quota tabs render
// The display settings of this device, each one choice of a few values; the first is the default.
const PREFS = {
  clock: ['24', '12'], date: ['day', 'iso', 'off'], replyStyle: ['ago', 'clock'], unit: ['used', 'left'],
  groupBy: ['project', 'host'], groupOrder: ['host', 'urgency'], openAt: ['latest', 'first'], pinTabs: ['on', 'off'],
  load: ['detailed', 'compact', 'off'], codeAttention: ['off', 'on'],
};
const pref = Object.fromEntries(Object.entries(PREFS).map(([k, vals]) => [k, vals.includes(store.get(`dashboard.${k}`)) ? store.get(`dashboard.${k}`) : vals[0]]));
const timeFormat = () => ({ clock: pref.clock, date: pref.date, lang });
let deployed = null;   // the live version from /api/health: {commit, id, at}
// Per session, its `posted` count when this device last opened its Topic: what came before is read here.
const topicSeen = (() => { try { return JSON.parse(store.get('dashboard.topicSeen')) ?? {}; } catch { return {}; } })();
// Usage (the store's report, docs/usage.md): fetched when its tab opens and every few minutes while open.
const USAGE_RANGES = [1, 7, 30, 90, 365];   // 1: the last 24 h, by hour
const USAGE_EVERY_MS = 5 * 60000;
// The Code tab's activity range, kept on this device: 30 days the first time.
const CODE_RANGES = [1, 7, 30, 365];
let codeDays = CODE_RANGES.includes(Number(store.get('dashboard.codeDays'))) ? Number(store.get('dashboard.codeDays')) : 30;
// The repos this device shows (Config › Code), or null: each repo's default (bridge.forges `show`).
let codeRepos = (() => { try { const v = JSON.parse(store.get('dashboard.codeRepos')); return Array.isArray(v) ? v.map(String) : null; } catch { return null; } })();
const saveCodeRepos = (v) => { codeRepos = v; store.set('dashboard.codeRepos', v ? JSON.stringify(v) : ''); };
let usageDays = USAGE_RANGES.includes(Number(store.get('dashboard.usageDays'))) ? Number(store.get('dashboard.usageDays')) : 30;
let usage = null;        // {key, report, at} | {key, error, at}
// The Usage filter: selected values per dimension ('' = no project); kept per device.
const USAGE_DIMS = { project: 'projects', model: 'models', machine: 'machines' };
let usageFilter = (() => { try { const f = JSON.parse(store.get('dashboard.usageFilter') ?? '{}'); return Object.fromEntries(Object.keys(USAGE_DIMS).map((d) => [d, Array.isArray(f[d]) ? f[d].map(String).slice(0, USAGE_FILTER_MAX) : []])); } catch { return { project: [], model: [], machine: [] }; } })();
const usageKey = () => JSON.stringify([usageDays, usageFilter]);
let usageLoading = false;
let configShown = null;   // the config view last rendered (JSON)
let configDirty = false;  // a shared edit typed but not saved
let devOpen = false;      // the Developer section of Config, opened on this page

tg?.ready();
tg?.expand();

/** The page chrome in the current language: what index.html holds before any data. */
function applyLang() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  document.title = tr('app.title');
  $('title').textContent = tr('app.title');
  $('force-update').title = tr('app.forceUpdate');
  $('force-update').setAttribute('aria-label', tr('app.forceUpdate'));
  for (const b of document.querySelectorAll('#tabs [data-tab]')) b.querySelector('.label').textContent = tr(`tab.${b.dataset.tab}`);
  document.body.classList.toggle('pin-tabs', pref.pinTabs === 'on');
}

function openTopic(s) {
  const url = topicTarget(s, topicSeen[s.id], pref.openAt);
  tg?.HapticFeedback?.impactOccurred?.('light');
  // What the Topic holds now is read on this device; only sessions still listed are kept.
  const live = new Set(sessionsOf(snapshot).map((x) => x.id));
  for (const id of Object.keys(topicSeen)) if (!live.has(id)) delete topicSeen[id];
  topicSeen[s.id] = s.posted ?? 0;
  store.set('dashboard.topicSeen', JSON.stringify(topicSeen));
  if (tg?.openTelegramLink) tg.openTelegramLink(url); else window.open(url, '_blank', 'noopener');
  render();
}

/** The @ and unread-count badges of a session, as Telegram draws them on a chat. */
function badges(s) {
  const out = [];
  if (s.mention) { const at = el('span', 'badge at', '@'); at.title = tr('session.mention'); out.push(at); }
  const n = unreadBadge(unreadHere(s, topicSeen[s.id]));
  if (n) { const b = el('span', 'badge', n); b.title = tr('session.unread'); out.push(b); }
  return out;
}

/**
 * One session as Telegram lists a chat: the agent as avatar (its status as the dot on it), the
 * name and the time of the last activity, then its state and where it runs (`withHost`, or in a
 * project group `inProject`: the machine); on the right the messages the Topic got since you
 * last spoke there, and @ while a mention waits for you. Counts only: no message text reaches the dashboard.
 */
function sessionRow(s, { withHost = false, inProject = false } = {}) {
  const status = displayStatus(s);
  const row = el(s.topic ? 'button' : 'div', `chat s-${status}${s.topic ? ' link' : ''}`);
  // The platform the session spends: a provider's own mark (ccds, cods), else the agent's maker.
  const brand = LOGOS[s.provider] ? s.provider : s.agent === 'claude' ? 'claude' : 'openai';
  const avatar = el('span', `avatar ${s.agent} b-${brand}`);
  avatar.append(logo(brand));
  avatar.append(el('span', 'dot'));
  const body = el('div', 'main');
  const top = el('div', 'chat-top');
  const time = el('span', `chat-time${unreadHere(s, topicSeen[s.id]) ? ' fresh' : ''}`, chatTime(s.lastActivityAt, Date.now(), timeFormat()));
  top.append(el('span', 'title', sessionLabel(s, lang)), time);
  const bottom = el('div', 'chat-bottom');
  const where = [s.name && !inProject && s.project, (inProject || withHost) && s.hostId, s.branch].filter(Boolean);
  const sub = el('span', 'sub', [statusLabel(status, lang), status === 'idle' && s.background && tr('session.background', { n: s.background }), replyTime(s, Date.now(), pref.replyStyle, lang), ...where,
    s.topic?.closed && tr('session.topicClosed')].filter(Boolean).join(' · '));
  // The account the session spends, as on the Quota tab (observation-only sessions have none).
  const q = s.account && accounts.get(s.account);
  if (q) sub.append(document.createTextNode(' · '), acctTag(q));
  // No reading of it anywhere: name what it spends — the platform for an API-key session, else the seat.
  else if (s.provider || s.seat) sub.append(document.createTextNode(` · ${s.provider ? providerName(s.provider) : s.seat}`));
  bottom.append(sub, ...badges(s));
  body.append(top, bottom);
  row.append(avatar, body);
  if (s.topic) { row.title = tr('session.openTopic'); row.addEventListener('click', () => openTopic(s)); }
  return row;
}

/** Position bar in the reader's unit: fill = what is used (or left), the line = where an even spend would be by now. */
function bar(w, stale) {
  const track = el('div', `bar${w.renewed ? ' unknown' : w.forecast?.short || w.used >= 100 ? ' hot' : ''}`);
  const fill = el('div', 'fill');
  fill.style.width = `${amount(w.used, pref.unit)}%`;
  const pace = el('div', 'pace');
  pace.style.left = `${amount(w.pace, pref.unit)}%`;
  track.append(fill, pace);
  track.title = `${windowLabel(w, stale, pref.unit, lang).title} · ${tr('quota.evenPace', { n: amount(w.pace, pref.unit), unit: tr(`quota.${pref.unit}`) })}`;
  return track;
}

/** A window's % left or used, dimmed with a clock when the reading is stale. */
function leftCell(w, stale, cls = 'used') {
  const l = windowLabel(w, stale, pref.unit, lang);
  const span = el('span', `${cls}${l.stale ? ' stale-v' : ''}`, l.text);
  span.title = l.title;
  return span;
}

/**
 * Trend on the window's time axis, opening to reset: spend per slice against an even spend
 * (half height; hatched = never observed), the present as a line, and local-time ticks under it.
 */
function trend(w) {
  const wrap = el('div', 'trend-wrap');
  const box = el('div', 'trend');
  for (const c of w.cells) {
    const cell = el('span', c === null ? 'ahead' : c < 0 ? 'unseen' : 'seen');
    if (c !== null && c >= 0) cell.style.height = `${Math.max(4, Math.min(100, c * 50))}%`;
    box.append(cell);
  }
  const ticks = timeTicks(w, Date.now(), lang);
  if (ticks.now !== null) { const now = el('i', 'now'); now.style.left = `${ticks.now * 100}%`; box.append(now); }
  const axis = el('div', 'axis');
  for (const tick of ticks.ticks) {
    const mark = el('span', null, tick.label);
    mark.style.left = `${tick.pos * 100}%`;
    axis.append(mark);
  }
  wrap.append(box, axis);
  return wrap;
}

/** A window's reset, as weighty as its use: the one place the countdown is shown on a quota row. */
const resetCell = (w) => { const s = el('span', 'reset', resetText(w)); if (s.textContent) s.title = tr('quota.resetsIn'); return s; };

/** A window's name; the binding one (what the account's % left is read from) is marked. */
const kCell = (w, q) => { const k = el('span', `k${q.bind?.k === w.k ? ' bind' : ''}`, w.k); if (q.bind?.k === w.k) k.title = tr('quota.binding', { unit: tr(`quota.${pref.unit}`) }); return k; };

/**
 * The expanded part of an account row: for a subscription each window with its trend on a time
 * axis and the resets to act on; then, for any account, this host's sessions spending it.
 */
function accountDetail(q, hostId) {
  const box = el('div', 'qdetail');
  if (q.detail) box.append(el('div', 'sub', q.detail));
  for (const w of q.windows) {
    const row = el('div', 'win');
    row.append(kCell(w, q), bar(w, q.stale), leftCell(w, q.stale), resetCell(w));
    const sub = el('div', 'win-sub');
    const forecast = w.forecast && (w.forecast.short ? tr('quota.runsOutIn', { eta: countdown(w.forecast.eta) })
      : tr('quota.atReset', { n: amount(w.forecast.atReset, pref.unit), unit: tr(`quota.${pref.unit}`) }));
    // The forecast is read alongside the window's use and reset: the same weight, coloured when it runs out.
    sub.append(trend(w), el('span', `forecast${w.forecast?.short ? ' hot' : ''}`, w.renewed ? tr('quota.resetUnknown') : forecast || ''));
    box.append(row, sub);
  }
  if (q.resetCredits) {
    const first = q.resetCredits.expiries.filter(Boolean).sort((x, y) => x - y)[0];
    box.append(el('div', 'note', tr('quota.credits', { n: q.resetCredits.count, first: first && countdown(first) })));
  }
  if (q.extraReset) {
    const note = el(q.extraReset.url ? 'button' : 'div', 'note link', tr('quota.extraReset', { in: q.extraReset.at && countdown(q.extraReset.at) }));
    if (q.extraReset.url) note.addEventListener('click', (e) => { e.stopPropagation(); tg?.openLink ? tg.openLink(q.extraReset.url) : window.open(q.extraReset.url, '_blank', 'noopener'); });
    box.append(note);
  }
  box.append(sessionsPart(hostSessions(q.key, hostId)));
  return box;
}

/**
 * A host's sessions on an account: a shared account is one budget, but each session sits under
 * the machine it runs on (the other host lists its own under its reference row).
 */
const hostSessions = (key, hostId) => accountSessions(snapshot, key).filter((u) => u.hostId === hostId);

/** "In use by N" and the session rows as on the Sessions tab (status, branch; a tap opens the Topic). */
function sessionsPart(sessions) {
  const box = el('div');
  box.append(el('div', 'note', sessions.length ? tr('quota.inUse', { n: sessions.length }) : tr('quota.notInUse')));
  if (!sessions.length) return box;
  const list = el('div', 'waiting');
  for (const u of sessions) list.append(sessionRow(u));
  list.addEventListener('click', (e) => e.stopPropagation());
  box.append(list);
  return box;
}

const SVG = 'http://www.w3.org/2000/svg';
function logo(brand) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-label', brand);
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', LOGOS[brand]);
  svg.append(path);
  return svg;
}

/** An account as a compact tag: who and how much is left, coloured by its verdict. */
function acctTag(q, withAgent = false) {
  const left = q.left === null ? '' : ` ${windowLabel(q.bind, q.stale, pref.unit, lang).text}`;
  const tag = el('span', `acct v-${q.verdict}`, `${withAgent && q.agent ? `${agentName(q.agent)} ` : ''}${accountTag(q)}${left}`);
  tag.title = `${accountName(q)}${q.email ? ` · ${q.email}` : ''}${q.amounts ? ` · ${q.amounts}` : ''}${q.left === null ? '' : ` · ${q.left}% ${tr('quota.left')}`}`;
  return tag;
}

/** An account's headline: a subscription's binding window, a balance's amounts (or its error). */
function headline(q) {
  if (q.kind === 'balance') return el('span', q.error ? 'left muted' : 'left', q.error ?? q.amounts);
  if (!q.bind) return noReading(q);
  const left = leftCell(q.bind, q.stale, 'left');
  left.textContent += ` ${tr(`quota.${pref.unit}`)}`;
  return left;
}

/**
 * One account on one host, whatever its kind: at a glance who and what is left (a subscription's
 * windows against even pace, a balance's amounts); tapped, it opens in place to its detail and
 * this host's sessions on it. A shared account is one budget: its full row sits on one host, and
 * elsewhere a reference row (`refTo`) that opens to that host's own sessions the same way.
 */
function accountRow(q, hostId) {
  const ref = Boolean(q.refTo);
  const using = hostSessions(q.key, hostId);
  const meta = [];
  if (q.email && !ref) { const e = el('span', null, emailName(q.email)); e.title = q.email; meta.push(e); }
  if (using.length) meta.push({ folded: tr('quota.inUse', { n: using.length }) });
  if (q.sharedWith.length && !ref) meta.push(tr('quota.sharedAlso', { hosts: q.sharedWith.join(', ') }));
  if (q.kind === 'balance' && q.at && !ref) meta.push(agoText(q.at));
  const row = foldRow(`${hostId}|${q.key}`, {
    cls: `${ref ? 'qref ' : ''}v-${q.verdict}${q.stale ? ' stale' : ''}`,
    name: el('span', `agent ${q.agent ?? q.provider}`, accountName(q)), headline: headline(q),
    right: ref ? el('span', 'see', tr('quota.see', { host: q.refTo })) : null,
    title: ref ? tr('quota.oneBudget', { host: q.refTo }) : null,
    folded: () => (!ref && q.windows.length ? [quotaMini(q)] : []),
    open: () => [ref ? sessionsPart(using) : accountDetail(q, hostId)],
    meta, warns: ref ? [] : [...(q.verdict === 'short' || q.verdict === 'exhausted' ? [verdictText(q, { withReset: false, lang })] : []), ...q.problems],
  });
  if (q.stale && q.at) { const c = el('span', 'clock', ' ◷'); c.title = tr('quota.reading', { ago: agoText(q.at) }); row.querySelector('.sub')?.append(c); }
  return row;
}

function quotaMini(q) {
  const mini = el('div', 'qmini');
  for (const w of q.windows) {
    const cell = el('div');
    cell.append(kCell(w, q), bar(w, q.stale), leftCell(w, q.stale), resetCell(w));
    mini.append(cell);
  }
  return mini;
}

/**
 * The one foldable row every card list uses (accounts, repositories): a name, a headline and a
 * chevron (or `right`) on top; folded, a glance (`folded`); tapped, its detail (`open`) in place;
 * then a meta line (a part `{folded}` shows only while folded) and warnings. Its open state is
 * kept by `id` across polls, and a host header can open every row of the host at once.
 */
function foldRow(id, opts) {
  const { cls = '', name, headline: head, right = null, title = null, folded = () => [], open: detail = () => [], meta = [], warns = [], go = null } = opts;
  const open = openRows.has(id);
  const row = el('div', `qrow ${cls}${open ? ' open' : ''}`);
  row.setAttribute('role', go ? 'link' : 'button');
  if (!go) row.setAttribute('aria-expanded', String(open));
  row.tabIndex = 0;
  if (title) row.title = title;
  const top = el('div', 'qrow-top');
  // `go`: the row's own tap goes there (e.g. a repo to its sessions); its detail opens from the chevron alone.
  const chev = right ?? el(go ? 'button' : 'span', 'chev', open ? '⌄' : '›');
  top.append(name, head, chev);
  row.append(top, ...(open ? detail() : folded()));
  // A part is a node or text; a falsy one (a `cond && text` that did not hold) is left out.
  const parts = meta.map((m) => (m?.folded !== undefined ? (open ? null : m.folded) : m)).filter(Boolean);
  if (parts.length) {
    const line = el('div', 'sub');
    parts.forEach((p, i) => line.append(...(i ? [' · '] : []), p));
    row.append(line);
  }
  for (const w of warns) row.append(el('div', 'warn', w));
  // Opening or folding redraws this row alone, in place: the rest of the page and its scroll stay put.
  const toggle = () => {
    open ? openRows.delete(id) : openRows.add(id);
    tg?.HapticFeedback?.selectionChanged?.();
    const next = foldRow(id, opts);
    row.replaceWith(next);
    next.focus({ preventScroll: true });
  };
  const tap = go ?? toggle;
  if (go) {
    chev.setAttribute('aria-label', tr(open ? 'row.fold' : 'row.open'));
    chev.setAttribute('aria-expanded', String(open));
    chev.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  }
  row.addEventListener('click', tap);
  row.addEventListener('keydown', (e) => { if (e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); tap(); } });
  return row;
}

/** Show the Sessions tab narrowed to one project (a repo's sessions), every other filter cleared. */
function showProject(project) {
  Object.assign(filters, { group: 'all', host: '', agent: '', project });
  selectsKey = null;
  showTab('sessions');
}

/** What a host reports about itself and nobody may change here: bridge, who may control it, approvals, sources. */
function hostFacts(h) {
  const facts = h.config?.facts;
  if (!facts) return [];
  const dl = el('dl', 'facts');
  const on = (b) => tr(b ? 'fact.on' : 'fact.off');
  for (const [k, val] of [['fact.bridge', on(facts.bridge)], ['fact.allowedUsers', String(facts.allowedUsers)],
    ['fact.approvals', on(facts.approvalsFromTelegram)],
    ['fact.codexSources', facts.codexSources.join(', ') || '—'], facts.dashboardError && ['fact.dashboard', facts.dashboardError]].filter(Boolean)) {
    dl.append(el('dt', null, tr(k)), el('dd', null, val));
  }
  return [dl];
}

/**
 * Quota by host: what each machine has left on each account. A shared account is one budget.
 * Tapping a host's header opens all its accounts and its facts; tapping again folds them.
 */
function renderQuota() {
  const box = $('quota-view');
  box.replaceChildren();
  const grid = el('div', 'quota-hosts columns');
  for (const h of hostList) {
    const expanded = openHosts.has(h.id);
    const facts = expanded ? hostFacts(h) : [];
    let section;
    if (!h.accounts.length) section = hostSection(h, [el('div', 'qrows empty', tr('quota.noAccounts')), ...facts]);
    else {
      const best = bestAccounts(h.accounts);
      const bestLine = el('div', 'qbest', best.length ? tr('quota.bestNow') : tr('quota.bestNone'));
      best.forEach(({ q }, i) => bestLine.append(i ? ' · ' : '', acctTag(q, true)));
      const rows = el('div', 'qrows');
      for (const q of h.accounts) rows.append(accountRow(q, h.id));
      section = hostSection(h, [bestLine, rows, ...facts]);
    }
    const head = section.querySelector('.host-head');
    head.classList.add('toggle');
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', String(expanded));
    head.tabIndex = 0;
    const toggle = () => {
      const ids = h.accounts.map((q) => `${h.id}|${q.key}`);
      if (expanded) { openHosts.delete(h.id); ids.forEach((id) => openRows.delete(id)); }
      else { openHosts.add(h.id); ids.forEach((id) => openRows.add(id)); }
      tg?.HapticFeedback?.selectionChanged?.();
      render();
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    grid.append(section);
  }
  box.append(el('div', 'section-h', tr('quota.heading', { unit: pref.unit })), grid);
}

/** A host's load: one meter per CPU, memory and GPU (coloured past 80%), then what the hardware is. */
function resourcesBox(r, online) {
  const { meters, about } = resourceView(r);
  const box = el('div', `res${online ? '' : ' stale-v'}`);
  if (!meters.length) { box.append(el('span', 'muted', tr('host.noLoad'))); return box; }
  for (const m of meters) {
    const cell = el('div', 'res-m');
    const track = el('div', `bar${m.pct >= 80 ? ' hot' : ''}`);
    const fill = el('div', 'fill');
    fill.style.width = `${Math.min(100, Math.max(0, m.pct))}%`;
    track.append(fill);
    cell.append(el('span', 'k', m.label), track, el('span', 'res-t', m.text));
    box.append(cell);
  }
  if (about && pref.load === 'detailed') box.append(el('div', 'res-about muted', about));
  return box;
}

/** The headline when no window has a current reading: reset since the last one, or never read. */
function noReading(q) {
  const reset = q.windows.length > 0;
  const span = el('span', 'left', tr(reset ? 'quota.notReadSinceReset' : 'quota.noReading'));
  span.title = tr(reset ? 'quota.notReadSinceResetTitle' : 'quota.noReadingTitle');
  return span;
}

function renderChips() {
  const { counts } = filterOptions(snapshot);
  const nav = $('chips');
  nav.replaceChildren();
  for (const key of Object.keys(GROUPS)) {
    if (key !== 'all' && key !== filters.group && !counts[key]) continue;   // an empty chip is noise
    const chip = el('button', `chip${filters.group === key ? ' on' : ''}`, tr(`group.${key}`));
    chip.append(el('b', null, String(counts[key])));
    chip.addEventListener('click', () => { filters.group = key; tg?.HapticFeedback?.selectionChanged?.(); render(); });
    nav.append(chip);
  }
}

/** Host / agent / project selects, each only when it has a choice to make. */
function renderSelects() {
  const opts = filterOptions(snapshot);
  const key = JSON.stringify([opts.host, opts.agent, opts.project, filters, lang]);
  if (key === selectsKey) return;   // rebuilding a select closes its open native picker
  selectsKey = key;
  const box = $('selects');
  box.replaceChildren();
  for (const name of ['host', 'agent', 'project']) {
    if (opts[name].length < 2 && !filters[name]) continue;
    const select = el('select');
    select.setAttribute('aria-label', name);
    select.append(Object.assign(el('option', null, tr(`filter.${name}`)), { value: '' }));
    // A project chosen from elsewhere (a repo on the Code tab) stays chosen even with no session: an empty list says so.
    const values = name === 'project' && filters.project && !opts.project.includes(filters.project) ? [...opts.project, filters.project] : opts[name];
    for (const v of values) select.append(Object.assign(el('option', null, name === 'agent' ? agentName(v) : v), { value: v }));
    select.value = values.includes(filters[name]) ? filters[name] : '';
    filters[name] = select.value;
    select.addEventListener('change', () => { filters[name] = select.value; render(); });
    box.append(select);
  }
}

function renderHosts() {
  const main = $('hosts');
  main.replaceChildren();
  const hosts = applyFilters(hostList, filters);
  if (!hosts.length) {
    main.append(el('div', 'empty', tr(snapshot.hosts.length ? 'sessions.noMatch' : 'sessions.noHosts')));
    return;
  }
  if (pref.groupBy === 'project') {
    for (const g of groupSessions(hosts, 'project', pref.groupOrder)) {
      const section = el('section', `host${g.online ? '' : ' off'}`);
      const head = el('div', 'host-head');
      head.append(el('span', `dot ${g.online ? 'on-dot' : 'off-dot'}`), el('span', 'name', g.id),
        el('span', 'muted meta', tr('sessions.count', { n: g.sessions.length })));
      const list = el('div', 'list');
      for (const s of g.sessions) list.append(sessionRow(s, { inProject: true }));
      section.append(head, list);
      main.append(section);
    }
    return;
  }
  for (const h of hosts) {
    const tags = el('div', 'qbest');
    h.accounts.forEach((q, i) => tags.append(i ? ' ' : '', acctTag(q, true)));
    const list = el('div', 'list');
    if (!h.sessions.length) list.append(el('div', 'empty', tr(h.online ? 'sessions.none' : 'sessions.noData')));
    for (const s of h.sessions) list.append(sessionRow(s));
    main.append(hostSection(h, [...(h.accounts.length ? [tags] : []), list]));
  }
}

/**
 * One host as every tab shows it: online dot, name, how many sessions (or when it was last
 * seen), and its load when shown; then the tab's own content. The one host header there is.
 */
function hostSection(h, body) {
  const section = el('section', `host${h.online ? '' : ' off'}`);
  const head = el('div', 'host-head');
  head.append(el('span', `dot ${h.online ? 'on-dot' : 'off-dot'}`), el('span', 'name', h.id),
    el('span', 'muted meta', h.online ? tr('sessions.count', { n: h.sessions.length }) : tr('host.offlineSeen', { ago: ago(h.lastSeen, Date.now(), lang) })));
  section.append(head, ...(pref.load !== 'off' ? [resourcesBox(h.resources, h.online)] : []), ...body);
  return section;
}

function renderEvents() {
  const box = $('events-view');
  box.replaceChildren();
  const events = unreadEvents(snapshot.events, shownFrom);
  if (!events.length) { box.append(el('div', 'empty', tr('events.none'))); return; }
  const list = el('div', 'event-list');
  for (const e of events) {
    const row = el('div', 'event new');
    row.append(el('div', 'text', eventText(e, Date.now(), lang)), el('div', 'muted', agoText(e.at)));
    list.append(row);
  }
  box.append(list);
}

// ── Config: Display (this device), Shared settings (all hosts), Developer ──

/** A choice of a few short values as one segmented control; picking applies at once. */
function segmented(values, current, label, pick) {
  const seg = el('div', 'seg');
  seg.setAttribute('role', 'radiogroup');
  for (const [value, text] of values) {
    const b = el('button', null, text);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(value === current));
    b.addEventListener('click', () => { if (value !== current) { tg?.HapticFeedback?.selectionChanged?.(); pick(value); } });
    seg.append(b);
  }
  seg.setAttribute('aria-label', label);
  return seg;
}

/** One display setting: its name (the long explanation behind `?`) and its segmented choice. */
function displayRow(labelKey, hintKey, control) {
  const row = el('div', 'cfg-row cfg-top');
  const name = el('span', 'cfg-name', tr(labelKey));
  if (hintKey) { const hint = el('span', 'hint', '?'); hint.title = tr(hintKey); name.append(' ', hint); }
  row.append(name, control);
  return row;
}

/** A device preference as a row: `key` of PREFS, its values named by i18n `labels`. Applies instantly. */
function prefRow(key, labelKey, hintKey, labels) {
  return displayRow(labelKey, hintKey, segmented(PREFS[key].map((v, i) => [v, labels[i]]), pref[key], tr(labelKey), (v) => {
    pref[key] = v;
    store.set(`dashboard.${key}`, v);
    applyLang();
    renderVersion();
    redrawConfig();
  }));
}

/** A group of settings: its heading and a card of rows. */
function cfgGroup(titleKey, rows) {
  const card = el('div', 'cfg');
  card.append(...rows);
  return [el('div', 'cfg-h', tr(titleKey)), card];
}

function displaySection() {
  const sample = Date.parse('2026-10-21T12:00:00');
  const languages = displayRow('cfg.language', 'cfg.lang.autoHint', segmented([['auto', tr('cfg.lang.auto')], ['en', 'English'], ['zh', '中文']], langChoice, tr('cfg.language'), (v) => {
    langChoice = v;
    store.set('dashboard.lang', v);
    lang = v === 'auto' ? autoLang : v;
    selectsKey = null;
    applyLang();
    renderVersion();
    redrawConfig();
  }));
  return [
    el('div', 'section-h', tr('cfg.display')),
    cfgGroup('cfg.language', [languages])[1],   // its row names it: no heading
    ...cfgGroup('cfg.time', [
      prefRow('clock', 'cfg.clock', null, [tr('cfg.clock.24'), tr('cfg.clock.12')]),
      prefRow('date', 'cfg.date', 'cfg.date.hint', [formatTime(sample, { date: 'day', lang }).split(' ').slice(0, -1).join(' '), '2026-10-21', tr('cfg.date.off')]),
      prefRow('replyStyle', 'cfg.reply', 'cfg.reply.hint', [tr('cfg.reply.ago'), tr('cfg.reply.clock')])]),
    ...cfgGroup('cfg.accounts', [prefRow('unit', 'cfg.unit', 'cfg.unit.hint', [tr('cfg.unit.used'), tr('cfg.unit.left')])]),
    ...cfgGroup('cfg.sessions', [
      prefRow('groupBy', 'cfg.groupBy', null, [tr('cfg.groupBy.project'), tr('cfg.groupBy.host')]),
      prefRow('groupOrder', 'cfg.order', 'cfg.order.hint', [tr('cfg.order.host'), tr('cfg.order.urgency')]),
      prefRow('openAt', 'cfg.openAt', 'cfg.openAt.hint', [tr('cfg.openAt.latest'), tr('cfg.openAt.first')])]),
    ...codeReposGroup(),
    ...cfgGroup('cfg.layout', [
      prefRow('pinTabs', 'cfg.pinTabs', 'cfg.pinTabs.hint', [tr('cfg.pinTabs.on'), tr('cfg.pinTabs.off')]),
      prefRow('load', 'cfg.load', 'cfg.load.hint', [tr('cfg.load.detailed'), tr('cfg.load.compact'), tr('cfg.load.off')])]),
  ];
}

/**
 * Config › Code: which repositories this device shows, one switch each; until one is changed
 * the defaults stand (each forge source's `show`), and Default goes back to them.
 */
function codeReposGroup() {
  const all = snapshot?.repos ?? [];
  if (!all.length) return [];
  const attention = prefRow('codeAttention', 'cfg.codeAttention', 'cfg.codeAttention.hint', [tr('cfg.code.off'), tr('cfg.code.on')]);
  const shown = new Set(codeRepos ?? all.filter((r) => r.pinned !== false).map((r) => r.key));
  const rows = all.map((r) => {
    const row = el('div', 'cfg-row cfg-top');
    row.append(el('span', 'cfg-name', r.name), segmented([['on', tr('cfg.code.on')], ['off', tr('cfg.code.off')]], shown.has(r.key) ? 'on' : 'off', r.name, (v) => {
      const next = new Set(shown);
      v === 'on' ? next.add(r.key) : next.delete(r.key);
      saveCodeRepos([...next]);
      redrawConfig();
    }));
    return row;
  });
  if (codeRepos) {
    const reset = el('button', 'chip', tr('cfg.code.default'));
    reset.addEventListener('click', () => { saveCodeRepos(null); redrawConfig(); });
    rows.push(reset);
  }
  return cfgGroup('cfg.code', [attention, ...rows]);
}

// Edits are a request to the gateway, applied by a host: the row shows it queued, handed over, then the outcome.
async function saveConfig(key, value, button) {
  button.disabled = true;
  configDirty = false;
  configShown = null;
  try {
    const res = await fetch('api/config', { method: 'POST', headers: { authorization: `tma ${tg.initData}`, 'content-type': 'application/json' },
      body: JSON.stringify({ key, value }) });
    if (!res.ok) throw new Error(res.status === 400 ? tr('cfg.badValue') : `HTTP ${res.status}`);
    tg?.HapticFeedback?.notificationOccurred?.('success');
    await load();
  } catch (e) {
    button.disabled = false;
    const text = tr('cfg.notSaved', { error: e.message });
    tg?.showAlert ? tg.showAlert(text) : alert(text);
  }
}

/** Where a change to this key stands: queued, handed to a host, or the last outcome a host reported. */
function changeState(r) {
  const value = (v) => JSON.stringify(v);
  if (r.pending) return r.pending.host ? ['pending', tr('cfg.handed', { value: value(r.pending.value), host: r.pending.host })]
    : ['pending', tr('cfg.queued', { value: value(r.pending.value) })];
  if (!r.last) return null;
  return r.last.outcome === 'applied' ? ['ok', tr('cfg.applied', { value: value(r.last.value), host: r.last.host, ago: agoText(r.last.at) })]
    : ['bad', tr('cfg.refused', { value: value(r.last.value), host: r.last.host, error: r.last.error, ago: agoText(r.last.at) })];
}

function configRow(r) {
  const row = el('div', 'cfg-row');
  const top = el('div', 'cfg-top');
  const name = el('label', 'cfg-name', configLabel(r.key, r.meta.key, lang));
  // A mark when not every host reads the shared value: still syncing, or overridden locally.
  if (r.differs.length) { const m = el('span', 'mark', tr('cfg.mark.differs')); m.title = r.differs.map((d) => tr('cfg.differs', { host: d.host, value: JSON.stringify(d.value) })).join('\n'); name.append(' ', m); }
  if (r.overrides.length) { const m = el('span', 'mark', tr('cfg.mark.overrides')); m.title = tr('cfg.overrides', { hosts: r.overrides.join(', '), n: r.overrides.length }); name.append(' ', m); }
  top.append(name);
  const edit = el('div', 'cfg-edit');
  let input;
  if (r.meta.options) {
    input = el('select');
    for (const o of r.meta.options) input.append(Object.assign(el('option', null, tr(`config.option.${o}`)), { value: o }));
  } else {
    input = Object.assign(el('input'), { type: 'number', min: r.meta.min, max: r.meta.max, step: 1 });
    input.title = tr('cfg.range', { min: r.meta.min, max: r.meta.max });
  }
  input.value = String(r.pending?.value ?? r.value);
  const save = el('button', null, tr('cfg.save'));
  save.disabled = true;
  const parse = () => (r.meta.options ? input.value : Number(input.value));
  input.addEventListener('input', () => {
    configDirty = true; save.disabled = parse() === r.value || (!r.meta.options && !(Number.isInteger(parse()) && parse() >= r.meta.min && parse() <= r.meta.max)); });
  save.addEventListener('click', () => saveConfig(r.key, parse(), save));
  if (mock || demoOn || !tg?.initData) input.disabled = true;
  edit.append(input, save);
  top.append(edit);
  row.append(top);
  const state = changeState(r);
  if (state) row.append(el('div', `sub change ${state[0]}`, state[1]));
  return row;
}

function sharedSection() {
  const v = configView(snapshot);
  const out = [el('div', 'section-h', tr('cfg.shared'))];
  if (!v.hosts.length) return [...out, el('div', 'empty', tr('cfg.noHosts'))];
  for (const g of CONFIG_GROUPS) {
    const rows = v.rows.filter((r) => r.group === g);
    if (rows.length) out.push(...cfgGroup(`cfg.group.${g}`, rows.map(configRow)));
  }
  return [...out, el('div', 'muted', tr('cfg.onlyThese'))];
}

/** Settings for whoever works on the dashboard itself, collapsed by default. */
function developerSection() {
  if (mock) return [];
  const box = el('details', 'dev');
  box.open = devOpen;
  box.addEventListener('toggle', () => { devOpen = box.open; });
  box.append(el('summary', 'section-h', tr('cfg.developer')));
  const demo = displayRow('cfg.demo', 'cfg.demo.hint', segmented([['off', tr('fact.off')], ['on', tr('fact.on')]], demoOn ? 'on' : 'off', tr('cfg.demo'), (v) => {
    demoOn = v === 'on';
    store.set('dashboard.demo', demoOn ? '1' : '0');
    filters.host = filters.project = '';   // the chosen names belong to the other view
    selectsKey = null;
    snapshot = shown();
    redrawConfig();
  }));
  const card = el('div', 'cfg');
  card.append(demo);
  box.append(card);
  return [box];
}

function renderConfig() {
  const box = $('config-view');
  box.replaceChildren(...displaySection(), ...(snapshot ? sharedSection() : []), ...developerSection());
}

/** A display setting changed: everything redraws at once, the config form included. */
function redrawConfig() {
  configShown = null;
  configDirty = false;
  if (snapshot) render(); else renderConfig();
}

const tzOffsetMin = () => -new Date().getTimezoneOffset();

async function fetchUsage(force = false) {
  if (mock || usageLoading || !tg?.initData) return;
  const key = usageKey();
  if (!force && usage?.key === key && Date.now() - usage.at < USAGE_EVERY_MS) return;
  usageLoading = true;
  const q = new URLSearchParams({ days: String(usageDays), tz: String(tzOffsetMin()) });
  for (const [d, vs] of Object.entries(usageFilter)) for (const v of vs) q.append(d, v);
  try {
    const res = await fetch(`api/usage?${q}`, { headers: { authorization: `tma ${tg.initData}` }, cache: 'no-store' });
    usage = res.ok ? { key, report: await res.json(), at: Date.now() }
      : { key, error: res.status === 503 ? ['usage.notSetUp'] : ['usage.unavailable', { status: res.status }], at: Date.now() };
  } catch { usage = { key, error: ['usage.unreachable'], at: Date.now() }; } finally { usageLoading = false; }
  // A selection made while this request was in flight asks again.
  if (usageKey() !== key) return fetchUsage(true);
  renderUsage();
}

/** Select or unselect one value of a dimension, then refetch. */
function toggleUsage(dim, value) {
  const vs = usageFilter[dim];
  // The API refuses more than USAGE_FILTER_MAX values in a dimension: a further pick is not taken.
  if (!vs.includes(value) && vs.length >= USAGE_FILTER_MAX) { tg?.HapticFeedback?.notificationOccurred?.('error'); return; }
  usageFilter = { ...usageFilter, [dim]: vs.includes(value) ? vs.filter((v) => v !== value) : [...vs, value] };
  store.set('dashboard.usageFilter', JSON.stringify(usageFilter));
  tg?.HapticFeedback?.selectionChanged?.();
  renderUsage();
  fetchUsage(true);
}

/** One ranked list: name, agent time and turns, tokens, and a hairline for its share. */
function usageList(titleKey, rows, dim) {
  const box = el('div', 'usage-list');
  for (const r of rows) {
    // Demo mode shows masked names: a row there names no real value to filter by.
    const row = el(demoOn ? 'div' : 'button', `u${r.selected ? ' on' : ''}`);
    if (!demoOn) { row.setAttribute('aria-pressed', String(r.selected)); row.addEventListener('click', () => toggleUsage(dim, r.value)); }
    const share = el('i', 'share');
    share.style.width = `${Math.round(r.share * 100)}%`;
    row.append(el('span', 'n', r.name), el('span', 'm', `${hoursText(r.active)} · ${tr('usage.turns', { n: r.turns })}`), el('b', null, tokenText(r.tokens)), share);
    row.title = tr('usage.share', { n: r.turns, pct: Math.round(r.share * 100) });
    box.append(row);
  }
  return [el('div', 'section-h', tr(titleKey)), rows.length ? box : el('div', 'qrows empty', tr('usage.none'))];
}

function renderUsage() {
  const box = $('usage-view');
  box.replaceChildren();
  box.append(rangePicker(USAGE_RANGES, usageDays, (d) => { usageDays = d; store.set('dashboard.usageDays', String(d)); renderUsage(); fetchUsage(true); }));
  if (mock) return box.append(el('div', 'qrows empty', tr('usage.mock')));
  const picked = Object.entries(usageFilter).flatMap(([d, vs]) => vs.map((v) => [d, v]));
  if (picked.length) {
    const bar = el('div', 'usage-filter');
    for (const [d, v] of picked) {
      const chip = el('button', 'chip on', `${demoOn ? '•••' : v || tr('session.unknownProject')} ×`);
      chip.addEventListener('click', () => toggleUsage(d, v));
      bar.append(chip);
    }
    const clear = el('button', 'chip', tr('usage.clearFilter'));
    clear.addEventListener('click', () => { usageFilter = { project: [], model: [], machine: [] }; store.set('dashboard.usageFilter', JSON.stringify(usageFilter)); renderUsage(); fetchUsage(true); });
    bar.append(clear);
    box.append(bar);
  }
  if (!usage || usage.key !== usageKey()) return box.append(el('div', 'qrows empty', tr('app.loading')));
  if (usage.error) return box.append(el('div', 'qrows empty', tr(...usage.error)));
  const v = usageView(demoOn ? (masker ??= demoMasker()).usage(usage.report) : usage.report, Date.now(), tzOffsetMin());
  const totals = el('div', 'usage-totals');
  const total = (value, labelKey, titleKey) => { const c = el('div'); c.append(el('b', null, value), el('span', null, tr(labelKey))); if (titleKey) c.title = tr(titleKey); totals.append(c); };
  total(tokenText(v.totals.tokens), 'usage.tokens', 'usage.tokensTitle');
  total(hoursText(v.totals.active), 'usage.agentTime', 'usage.agentTimeTitle');
  total(String(v.totals.turns), 'usage.turnsLabel');
  if (v.totals.cacheHit != null) total(`${Math.round(v.totals.cacheHit * 100)}%`, 'usage.cacheHit', 'usage.cacheHitTitle');
  if (v.totals.costUsd != null) total(`$${Math.round(v.totals.costUsd)}`, 'usage.apiValue', 'usage.apiValueTitle');
  const chart = el('div', 'usage-days');
  for (const d of v.days) {
    const col = el('div', 'd');
    col.title = tr('usage.day', { day: d.day, claude: tokenText(d.claude), codex: tokenText(d.codex), active: hoursText(d.active) });
    for (const a of ['claude', 'codex']) { const seg = el('div', a); seg.style.height = `${d[`${a}Pct`]}%`; col.append(seg); }
    chart.append(col);
  }
  const axis = el('div', 'usage-axis');
  const tick = (d) => (!d ? '' : v.unit === 'hour' ? `${d.day.slice(11)}:00` : d.day);
  axis.append(el('span', null, tick(v.days[0])), el('span', null, tr('usage.axis', { unit: v.unit })), el('span', null, tick(v.days.at(-1))));
  box.append(totals, chart, axis, ...usageList('usage.projects', v.projects, 'project'), ...usageList('usage.models', v.models, 'model'), ...usageList('usage.machines', v.machines, 'machine'));
  restoreScroll();
}

/** The one range picker (Usage, Code): 24h, 7d, …, 1y; `pick(days)` on a tap. */
function rangePicker(ranges, current, pick) {
  const range = el('div', 'range');
  for (const d of ranges) {
    const b = el('button', null, d === 1 ? '24h' : d === 365 ? '1y' : `${d}d`);
    b.setAttribute('aria-pressed', String(d === current));
    b.addEventListener('click', () => pick(d));
    range.append(b);
  }
  return range;
}

// ── Code: what each forge's repositories are doing, as the hosts that reach them read it ──

const CI_GLYPH = { success: '✓', failure: '✗', pending: '●' };
function ciBadge(ci) {
  const b = el('span', `ci ci-${ci ?? 'none'}`, CI_GLYPH[ci] ?? '–');
  b.title = tr(`code.ci.${ci ?? 'none'}`);
  return b;
}
const openUrl = (url) => (tg?.openLink ? tg.openLink(url) : window.open(url, '_blank', 'noopener'));
const timeAgo = (t) => (t ? agoText(Date.parse(t)) : null);

/** One PR or branch inside a repo card: its CI glyph, its title, a meta line; a tap opens it on the forge. */
function codeItem(ci, title, meta, url, sessions = []) {
  // A div, not a button: a session row (itself a button) may sit inside it.
  const item = el('div', `code-item${url ? ' link' : ''}`);
  if (url) { item.setAttribute('role', 'link'); item.tabIndex = 0; }
  item.append(ciBadge(ci), el('span', 'title', title), el('span', 'sub', meta.filter(Boolean).join(' · ')));
  if (sessions.length) {
    // A session opens its own Topic: the tap stops there, never also opening the item's forge page.
    const list = el('div', 'waiting');
    for (const s of sessions) list.append(sessionRow(s, { withHost: true }));
    list.addEventListener('click', (e) => e.stopPropagation());
    item.append(list);
  }
  if (url) item.addEventListener('click', (e) => { e.stopPropagation(); openUrl(url); });
  return item;
}

function repoDetail(r) {
  const box = el('div', 'qdetail');
  box.addEventListener('click', (e) => e.stopPropagation());
  if (r.pulls.length) {
    box.append(el('div', 'code-h', tr('code.openPulls')));
    for (const p of r.pulls) box.append(codeItem(p.ci, `#${p.number} ${p.title ?? ''}`, [`${p.head} → ${p.base}`, p.author, p.draft && tr('code.draft'),
      p.review && tr(`code.review.${p.review}`), p.conflict && tr('code.conflict'), timeAgo(p.updatedAt)], p.url));
  }
  box.append(el('div', 'code-h', tr('code.activeBranches')));
  for (const b of r.branches) {
    box.append(codeItem(b.ci, b.name, [b.name === r.defaultBranch && '★', b.author, timeAgo(b.at), b.pull && `#${b.pull.number}`],
      r.url && `${r.url}/${r.forge === 'github' ? 'tree' : 'src/branch'}/${encodeURIComponent(b.name)}`, b.sessions));
  }
  return box;
}

/** A repository as a card row, folded like an account: its default branch's CI, then PRs and branches. */
function repoRow(r) {
  const working = r.branches.reduce((n, b) => n + b.sessions.length, 0);
  const head = el('span', 'left');
  if (!r.error) head.append(ciBadge(r.mainCi), ` ${r.defaultBranch ?? ''}`);
  // The repo's project as its sessions name it (their origin's repo name), else the repo's own name.
  const project = sessionsOf(snapshot).find((s) => s.repo === r.key)?.project ?? r.name.split('/').pop();
  return foldRow(`code|${r.key}`, {
    name: el('span', 'agent', r.name), headline: head, go: () => showProject(project),
    title: tr('code.toSessions', { project }),
    open: () => [repoDetail(r)],
    // A repo not read has no counts to give: its forge and the error say all there is.
    meta: [r.forge === 'github' ? 'GitHub' : 'Gitea', ...(r.error ? [] : [tr('code.pulls', { n: r.pulls.length }), tr('code.branches', { n: r.branches.length }),
      working && tr('code.working', { n: working }), timeAgo(r.pushedAt) && tr('code.pushed', { ago: timeAgo(r.pushedAt) })])],
    warns: r.error ? [r.error] : [],
  });
}

function renderCode() {
  const box = $('code-view');
  box.replaceChildren();
  box.append(rangePicker(CODE_RANGES, codeDays, (d) => { codeDays = d; store.set('dashboard.codeDays', String(d)); render(); }));
  if (!(snapshot.repos ?? []).length) { box.append(el('div', 'qrows empty', tr('code.none'))); return; }
  const v = codeView(snapshot, codeDays, Date.now(), codeRepos);
  // Needs attention is shown only on a device that asked for it (Config › Code).
  if (pref.codeAttention === 'on' && v.attention.length) {
    const list = el('div', 'cards columns');
    for (const a of v.attention) {
      const url = a.pull?.url ?? (a.repo.url && a.branch ? `${a.repo.url}/${a.repo.forge === 'github' ? 'tree' : 'src/branch'}/${encodeURIComponent(a.branch)}` : a.repo.url);
      list.append(codeItem('failure', tr(`code.att.${a.kind}`, { repo: a.repo.name, branch: a.branch, n: a.pull?.number, error: a.repo.error }), [], url, a.sessions ?? []));
    }
    box.append(el('div', 'section-h', tr('code.attention')), list);
  }
  const rows = el('div', 'cards columns');
  for (const r of v.repos) rows.append(repoRow(r));
  box.append(el('div', 'section-h', tr('code.repos', { n: v.repos.length })), rows);
  if (v.inactive) box.append(el('div', 'note', tr('code.inactive', { n: v.inactive })));
  if (v.hidden) {
    const note = el('button', 'note link', tr('code.hidden', { n: v.hidden }));
    note.addEventListener('click', () => showTab('config'));
    box.append(note);
  }
}

function renderTabs() {
  // Looking at the events marks them seen (after this render still shows which were new).
  const n = tabs(snapshot, Date.now(), seenAt, [], shownFrom, accounts);
  $('tabs').hidden = false;   // always: Config holds this device's settings, whatever data there is
  $('n-sessions').textContent = String(n.sessions);
  $('n-quota').textContent = String(n.quota);
  $('quota-dot').hidden = !n.alert;
  const code = codeView(snapshot, codeDays, Date.now(), codeRepos);
  $('n-code').textContent = (snapshot.repos ?? []).length ? String(code.repos.length) : '';
  $('code-dot').hidden = pref.codeAttention !== 'on' || !code.attention.length;
  $('n-events').textContent = String(n.events);
  $('events-badge').hidden = !n.unseen || tab === 'events';
  $('events-badge').textContent = String(n.unseen);
  for (const b of document.querySelectorAll('#tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== tab;
}

// Each tab's scroll position, kept across tab switches and reopening the app. Content arrives
// after load (the snapshot, the usage report), so a restore is retried on each render until it
// lands or the reader scrolls by hand.
const scrollAt = (() => { try { return JSON.parse(store.get('dashboard.scroll')) ?? {}; } catch { return {}; } })();
let restoring = tab;
let restoreTries = 0;
/**
 * Back to the tab's saved position once the page is tall enough to hold it, then never again
 * (a redraw keeps the reader's own position). Content that never grows that tall stops the
 * attempt after a few redraws, at the nearest position: no later redraw pulls the page back.
 */
function restoreScroll() {
  if (restoring !== tab) return;
  const y = scrollAt[tab] ?? 0;
  const max = document.documentElement.scrollHeight - window.innerHeight;
  if (max < y && ++restoreTries < 20) return;
  window.scrollTo(0, Math.min(y, Math.max(0, max)));
  restoring = null;
  restoreTries = 0;
}
let scrollSave = null;
window.addEventListener('scroll', () => {
  if (restoring) return;
  clearTimeout(scrollSave);
  scrollSave = setTimeout(() => { scrollAt[tab] = Math.round(window.scrollY); store.set('dashboard.scroll', JSON.stringify(scrollAt)); }, 200);
}, { passive: true });
for (const ev of ['wheel', 'touchstart', 'keydown']) window.addEventListener(ev, () => { restoring = null; }, { passive: true });

/** Switch to a tab as its button does (a link inside a view, e.g. Code › Config). */
const showTab = (name) => document.querySelector(`#tabs [data-tab="${name}"]`)?.click();

for (const b of document.querySelectorAll('#tabs [data-tab]')) {
  b.addEventListener('click', () => {
    clearTimeout(scrollSave);
    scrollAt[tab] = Math.round(window.scrollY);
    store.set('dashboard.scroll', JSON.stringify(scrollAt));
    tab = b.dataset.tab;
    restoring = tab;
    restoreTries = 0;
    if (tab === 'events') shownFrom = seenAt;
    if (tab === 'usage') { renderUsage(); fetchUsage(); }
    configShown = null;
    configDirty = false;
    store.set('dashboard.tab', tab);
    tg?.HapticFeedback?.selectionChanged?.();
    render();
  });
}

function render() {
  if (!snapshot) return;
  accounts = accountIndex(snapshot);
  hostList = hostsView(snapshot, Date.now(), accounts);   // one account index per render, shared by every view
  $('summary').hidden = true;   // only a sign-in or access problem stands there
  $('updated').textContent = snapshot.mock ? tr('app.exampleData') : lastOk && snapshot.demo ? tr('app.demoData', { ago: agoText(lastOk) })
    : lastOk ? tr('app.data', { ago: agoText(lastOk) }) : '';
  renderTabs();
  // Only the tab in view is drawn (another is drawn when shown), each on its own: a fault in one
  // must not blank another. A redraw keeps the reader where they were on the page.
  const y = window.scrollY;
  if (tab === 'quota') isolated(renderQuota);
  if (tab === 'events') isolated(renderEvents);
  if (tab === 'code') isolated(renderCode);
  if (tab === 'usage') isolated(renderUsage);
  // The config form is rebuilt only when its data changed and nobody is editing a shared value:
  // a poll must not wipe a value being typed.
  if (tab === 'config') {
    const key = JSON.stringify(configView(snapshot));
    const editing = configDirty || document.activeElement?.matches?.('#config-view input, #config-view select');
    if (key !== configShown && !editing) { configShown = key; renderConfig(); }
  }
  if (tab === 'events' && snapshot.events?.length) { seenAt = snapshot.events[0].at; store.set('dashboard.eventsSeenAt', seenAt); }
  if (tab === 'sessions') isolated(() => { renderChips(); renderSelects(); renderHosts(); });
  if (!restoring && Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y);
  restoreScroll();
}

function isolated(fn) {
  try { fn(); } catch (e) { console.error(e); }
}

function stop(messageKey) {
  $('summary').hidden = false;
  $('summary').replaceChildren(el('div', 'summary-head', tr(messageKey)));
  $('hosts').replaceChildren();
  $('chips').replaceChildren();
  $('quota-view').replaceChildren();
  $('events-view').replaceChildren();
  $('usage-view').replaceChildren();
  $('config-view').replaceChildren();
  $('tabs').hidden = true;
}

async function fetchSnapshot() {
  if (mock) { snapshot = mockDashboard(); render(); return; }
  if (!tg?.initData) return stop('app.openFromBot');
  try {
    const res = await fetch('api/dashboard', { headers: { authorization: `tma ${tg.initData}` }, cache: 'no-store' });
    // Expired sign-in (Telegram only signs initData at open): keep the last data, ask for a reopen.
    if (res.status === 401 && snapshot) { $('banner').textContent = tr('app.signInExpiredKeep', { ago: agoText(lastOk) }); return render(); }
    if (res.status === 401) return stop('app.signInExpired');
    if (res.status === 403) return stop('app.notAllowed');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = await res.json();
    if (!Array.isArray(next?.hosts)) throw new Error('unexpected response');
    raw = next;
    snapshot = shown();
    lastOk = Date.now();
    $('banner').textContent = '';
  } catch {
    // Keep the last data, clearly marked as old.
    $('banner').textContent = lastOk ? tr('app.unreachableKeep', { ago: agoText(lastOk) }) : tr('app.unreachable');
  }
  render();
}

async function load() {
  if (loading) return;
  loading = true;
  try { await fetchSnapshot(); } finally { loading = false; }
  if (tab === 'usage') fetchUsage();   // at most every USAGE_EVERY_MS
}

/** The deployed version beside the title, for a human to check what is live: commit and upload time. */
async function showVersion() {
  try {
    const { version: v } = await (await fetch('api/health', { cache: 'no-store' })).json();
    if (v) { deployed = v; renderVersion(); }
  } catch { /* no version shown */ }
}

/**
 * The live build: when it was deployed (what a human compares) and its commit, which opens on
 * GitHub. Kept apart from the data's own "updated" time.
 */
function renderVersion() {
  const box = $('version');
  box.replaceChildren();
  if (deployed) {
    const build = el('span', null, tr('app.build', { at: deployed.at ? formatTime(Date.parse(deployed.at), timeFormat()) : deployed.id.slice(0, 8) }));
    if (deployed.commit) {
      const sha = deployed.commit.replace(/\+$/, '');
      const link = el('button', 'commit', deployed.commit);
      link.title = tr(deployed.commit.endsWith('+') ? 'app.commitDirty' : 'app.commitOpen');
      link.addEventListener('click', () => { const url = `${REPO}/commit/${sha}`; tg?.openLink ? tg.openLink(url) : window.open(url, '_blank', 'noopener'); });
      build.append(' · ', link);
    }
    box.append(build);
  }
}

// Telegram keeps a closed Mini App alive and its webview may serve cached files despite
// no-cache: the page compares what it runs (the cached app.js) with the server's, and on a
// difference refetches every file it loaded, then reloads. The footer button does the same.
const OWN_FILES = () => [location.pathname, ...performance.getEntriesByType('resource').map((e) => new URL(e.name))
  .filter((u) => u.origin === location.origin && !u.pathname.includes('/api/')).map((u) => u.pathname)];
async function hardReload() {
  await Promise.allSettled([...new Set(OWN_FILES())].map((u) => fetch(u, { cache: 'reload' })));
  location.reload();
}
async function stale() {
  try {
    const tag = async (cache) => (await fetch('app.js', { method: 'HEAD', cache })).headers.get('etag');
    const [mine, live] = await Promise.all([tag('force-cache'), tag('no-store')]);
    return Boolean(mine && live && mine !== live);
  } catch { return false; }
}
async function updateIfStale() {
  // At most once a minute: a webview that will not refresh its cache must not reload forever.
  const last = Number(store.get('dashboard.autoReloadAt')) || 0;
  if (Date.now() - last < 60000 || !(await stale())) return;
  store.set('dashboard.autoReloadAt', String(Date.now()));
  await hardReload();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) updateIfStale(); });

applyLang();
$('summary').replaceChildren(el('div', 'summary-head', tr('app.loading')));
load();
$('force-update').addEventListener('click', () => hardReload());
if (!mock) { setInterval(load, POLL_MS); showVersion(); updateIfStale(); }
