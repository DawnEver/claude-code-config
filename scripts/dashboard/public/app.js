// scripts/dashboard/public/app.js — the Mini App's DOM side. Authenticates every request
// with the raw Telegram initData (the gateway verifies it); never reads initDataUnsafe for
// anything but display. All data is rendered with textContent, never as HTML.

import { GROUPS, STATUS_LABELS, ago, applyFilters, attention, countdown, displayStatus, filterOptions, quotaAlerts, alertKey, unreadEvents, quotaView, stats, tabs, accountName, verdictText, accountIndex, accountTag, hostsView, timeTicks, configView, stateAge, groupSessions, resetText, windowLabel, emailName, bestAccounts, amount, formatTime, sessionLabel, chatTime, unreadBadge, resourceView, agentName, eventText, usageView, tokenText, hoursText } from './view.mjs';
import { demoMasker } from './demo.mjs';
import { mockDashboard } from './mock.mjs';

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
// The open tab survives a reopen: a #quota / #events link opens that tab; otherwise the last
// one used; sessions the first time.
const TABS = ['sessions', 'quota', 'usage', 'events', 'config'];
const hashTab = location.hash.slice(1);
let tab = [hashTab, store.get('dashboard.tab')].find((x) => TABS.includes(x)) ?? 'sessions';
// Events newer than this were not seen yet: kept on this device, moved on by opening the tab.
let seenAt = store.get('dashboard.eventsSeenAt');
// The Events tab lists what was unread when it was opened: read events are cleared on the next visit.
let shownFrom = seenAt;
// Demo mode (Config tab, or `?demo`): the live data with every identity masked in this browser,
// for showing the dashboard to others. A setting of this device only: nothing reaches the gateway.
if (params.has('demo')) store.set('dashboard.demo', '1');
let demoOn = store.get('dashboard.demo') === '1';
let masker = null;   // one per page: names stay put when demo is toggled off and on
let raw = null;      // the last snapshot as fetched; `snapshot` is what is shown
const shown = () => (raw && demoOn ? (masker ??= demoMasker())(raw) : raw);
// Quota alerts read on this device (tapped in the needs-you card); only keys still standing are kept.
// Demo keys are masked, so they are kept apart from the real ones.
const readKey = () => (demoOn ? 'dashboard.readAlerts.demo' : 'dashboard.readAlerts');
const loadRead = () => { try { const v = JSON.parse(store.get(readKey())); return Array.isArray(v) ? v : []; } catch { return []; } };
let readAlerts = loadRead();
// Sessions grouped by project (default) or by host: a setting of this device.
let groupBy = store.get('dashboard.groupBy') === 'host' ? 'host' : 'project';
// Inside a project group: by workstation (default) or by urgency alone.
let groupOrder = store.get('dashboard.groupOrder') === 'urgency' ? 'urgency' : 'host';
// Quota rows opened to their detail (host|account), kept across polls.
const openRows = new Set();
let accounts = new Map();
let hostList = [];   // hostsView(snapshot): the one host model the Sessions and Quota tabs render
let unit = store.get('dashboard.unit') === 'left' ? 'left' : 'used';   // bars and numbers read as % left or % used
// How absolute times read on this device: 24h (default) or 12h clock; date 'day', 'iso' or 'off'.
const timeFormat = { clock: store.get('dashboard.clock') === '12' ? '12' : '24', date: ['iso', 'off'].includes(store.get('dashboard.date')) ? store.get('dashboard.date') : 'day' };
let deployed = null;   // the live version from /api/health: {commit, id, at}
let packed = store.get('dashboard.packed') !== '0';   // hosts in packed columns, not aligned rows
document.body.classList.toggle('packed', packed);
// Sessions drawn as a Telegram chat list (avatar, name, time, unread and @ badges) instead of status rows.
let chatList = store.get('dashboard.chatList') === '1';
// The needs-you card above the tabs (#summary): off unless turned on here; the Events tab is the
// notification. Not the #banner strip, which reports sign-in and gateway problems.
let needsYouCard = store.get('dashboard.needsYouCard') === '1';
// Each host header's load: 'detailed' (meters and the hardware line, default), 'compact' (meters) or 'off'.
const LOAD_MODES = [['detailed', 'Detailed'], ['compact', 'Compact'], ['off', 'Off']];
let loadMode = LOAD_MODES.some(([m]) => m === store.get('dashboard.load')) ? store.get('dashboard.load') : 'detailed';
// Usage (the store's report, docs/usage.md): fetched when its tab opens and every few minutes while open.
const USAGE_RANGES = [7, 30, 90, 365];
const USAGE_EVERY_MS = 5 * 60000;
let usageDays = USAGE_RANGES.includes(Number(store.get('dashboard.usageDays'))) ? Number(store.get('dashboard.usageDays')) : 30;
let usage = null;        // {days, report, at} | {days, error, at}
let usageLoading = false;
let configShown = null;   // the config view last rendered (JSON)
let configDirty = false;  // an edit typed but not saved

tg?.ready();
tg?.expand();

function openTopic(url) {
  tg?.HapticFeedback?.impactOccurred?.('light');
  if (tg?.openTelegramLink) tg.openTelegramLink(url); else window.open(url, '_blank', 'noopener');
}

/**
 * One session: status dot, a title, the context line, a status pill, `›` when it opens a Topic.
 * The title is what its group does not already say: in a project group the machine and branch,
 * elsewhere the project.
 */
function sessionRow(s, opts = {}) {
  if (chatList) return chatRow(s, opts);
  const { withHost = false, inProject = false } = opts;
  const status = displayStatus(s);
  const row = el(s.topic ? 'button' : 'div', `row s-${status}${s.topic ? ' link' : ''}`);
  const main = el('div', 'main');
  const where = inProject ? [s.hostId, s.branch].filter(Boolean).join(' · ') : s.project ?? 'unknown project';
  main.append(el('div', 'title', s.name ?? where));
  const sub = el('div', 'sub');
  sub.append(el('span', `agent ${s.agent}`, agentName(s.agent)));
  const rest = [s.name && where, !inProject && withHost && s.hostId, !inProject && s.branch, stateAge(s), s.topic?.closed && 'Topic closed'].filter(Boolean);
  sub.append(document.createTextNode(` · ${rest.join(' · ')}`));
  const q = s.account && accounts.get(s.account);
  if (q) sub.append(document.createTextNode(' · '), acctTag(q));
  else if (s.seat) sub.append(document.createTextNode(` · ${s.seat}`));
  main.append(sub);
  row.append(el('span', 'dot'), main, el('span', 'pill', STATUS_LABELS[status] ?? status));
  if (s.topic) {
    row.append(el('span', 'chev', '›'));
    row.title = 'Open Topic';
    row.addEventListener('click', () => openTopic(s.topic.url));
  }
  return row;
}

/**
 * One session as Telegram lists a chat: the agent as avatar (its status as the dot on it), the
 * name and the time of the last activity, then where it runs and its state; on the right the
 * messages the Topic got since you last spoke there, and @ while a mention waits for you.
 * Counts only: no message text reaches the dashboard.
 */
function chatRow(s, { withHost = false, inProject = false } = {}) {
  const status = displayStatus(s);
  const row = el(s.topic ? 'button' : 'div', `chat s-${status}${s.topic ? ' link' : ''}`);
  const avatar = el('span', `avatar ${s.agent}`, s.agent === 'claude' ? 'C' : 'X');
  avatar.append(el('span', 'dot'));
  const body = el('div', 'main');
  const top = el('div', 'chat-top');
  top.append(el('span', 'title', sessionLabel(s)), el('span', `chat-time${s.unread ? ' fresh' : ''}`, chatTime(s.lastActivityAt, Date.now(), timeFormat)));
  const bottom = el('div', 'chat-bottom');
  const where = [s.name && !inProject && s.project, (inProject || withHost) && s.hostId, s.branch].filter(Boolean);
  bottom.append(el('span', 'sub', [STATUS_LABELS[status] ?? status, ...where, s.topic?.closed && 'Topic closed'].filter(Boolean).join(' · ')));
  if (s.mention) { const at = el('span', 'badge at', '@'); at.title = 'a mention waits for you'; bottom.append(at); }
  const n = unreadBadge(s.unread);
  if (n) { const b = el('span', 'badge', n); b.title = 'messages since you last wrote in this Topic'; bottom.append(b); }
  body.append(top, bottom);
  row.append(avatar, body);
  if (s.topic) { row.title = 'Open Topic'; row.addEventListener('click', () => openTopic(s.topic.url)); }
  return row;
}

function renderSummary() {
  const box = $('summary');
  const st = stats(snapshot);
  const waiting = attention(snapshot);
  if (snapshot.accounts) {
    const standing = quotaAlerts(snapshot, Date.now(), [], accounts).map(alertKey);
    readAlerts = readAlerts.filter((k) => standing.includes(k));
    store.set(readKey(), JSON.stringify(readAlerts));
  }
  // Off (the default): Events is the only notification; the "Needs you" chip still lists the sessions.
  box.hidden = !needsYouCard;
  if (!needsYouCard) return;
  const quota = quotaAlerts(snapshot, Date.now(), readAlerts, accounts);
  const n = waiting.length + quota.length;
  box.className = `summary${n ? ' alert' : ''}`;
  box.replaceChildren();
  box.append(el('div', 'summary-head', n ? `${n} need${n === 1 ? 's' : ''} you` : 'All clear'), el('div', 'summary-sub',
    `${st.working} working · ${st.hostsOnline}/${st.hosts} host${st.hosts === 1 ? '' : 's'} online`));
  if (!n) return;
  const list = el('div', 'waiting');
  for (const s of waiting) list.append(sessionRow(s, { withHost: true }));
  for (const q of quota) list.append(quotaAlertRow(q));
  box.append(list);
}

/** A quota alert in the needs-you card: the account and why. */
function quotaAlertRow(q) {
  const row = el('div', `row s-${q.verdict === 'exhausted' ? 'exhausted' : 'needs_input'}`);
  const main = el('div', 'main');
  main.append(el('div', 'title', accountName(q)), el('div', 'sub', [q.email, q.hosts?.length && `on ${q.hosts.join(', ')}`].filter(Boolean).join(' · ')),
    el('div', 'sub', verdictText(q)));
  // Dismiss marks it read: it leaves the card until the verdict or the window period changes.
  const dismiss = el('button', 'dismiss', 'Dismiss');
  dismiss.title = 'Mark read';
  dismiss.addEventListener('click', () => { readAlerts.push(alertKey(q)); store.set(readKey(), JSON.stringify(readAlerts)); render(); });
  row.append(el('span', 'dot'), main, el('span', 'pill', q.verdict === 'exhausted' ? 'Exhausted' : 'Runs out'), dismiss);
  return row;
}

/** Position bar in the reader's unit: fill = what is used (or left), the line = where an even spend would be by now. */
function bar(w, stale) {
  const track = el('div', `bar${w.renewed ? ' unknown' : w.forecast?.short || w.used >= 100 ? ' hot' : ''}`);
  const fill = el('div', 'fill');
  fill.style.width = `${amount(w.used, unit)}%`;
  const pace = el('div', 'pace');
  pace.style.left = `${amount(w.pace, unit)}%`;
  track.append(fill, pace);
  track.title = `${windowLabel(w, stale, unit).title} · even pace: ${amount(w.pace, unit)}% ${unit} by now`;
  return track;
}

/** A window's % left or used, dimmed with a clock when the reading is stale. */
function leftCell(w, stale, cls = 'used') {
  const l = windowLabel(w, stale, unit);
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
  const t = timeTicks(w);
  if (t.now !== null) { const now = el('i', 'now'); now.style.left = `${t.now * 100}%`; box.append(now); }
  const axis = el('div', 'axis');
  for (const tick of t.ticks) {
    const mark = el('span', null, tick.label);
    mark.style.left = `${tick.pos * 100}%`;
    axis.append(mark);
  }
  wrap.append(box, axis);
  return wrap;
}

/** A window's reset, as weighty as its use: the one place the countdown is shown on a quota row. */
const resetCell = (w) => { const s = el('span', 'reset', resetText(w)); if (s.textContent) s.title = 'resets in'; return s; };

/** A window's name; the binding one (what the account's % left is read from) is marked. */
const kCell = (w, q) => { const k = el('span', `k${q.bind?.k === w.k ? ' bind' : ''}`, w.k); if (q.bind?.k === w.k) k.title = `binding window: the account's % ${unit}`; return k; };

/** The expanded part of a quota row: each window with its trend on a time axis, then resets to act on. */
function quotaDetail(q) {
  const box = el('div', 'qdetail');
  if (q.detail) box.append(el('div', 'sub', q.detail));
  for (const w of q.windows) {
    const row = el('div', 'win');
    row.append(kCell(w, q), bar(w, q.stale), leftCell(w, q.stale), resetCell(w));
    const sub = el('div', 'win-sub');
    const forecast = w.forecast && (w.forecast.short ? `runs out in ${countdown(w.forecast.eta)}` : `→ ${amount(w.forecast.atReset, unit)}% ${unit} at reset`);
    sub.append(trend(w), el('span', null, w.renewed ? 'reset since the last reading: use unknown' : forecast || ''));
    box.append(row, sub);
  }
  if (q.resetCredits) {
    const first = q.resetCredits.expiries.filter(Boolean).sort((x, y) => x - y)[0];
    box.append(el('div', 'note', `${q.resetCredits.count} reset credit${q.resetCredits.count === 1 ? '' : 's'}${first ? ` · first expires in ${countdown(first)}` : ''}`));
  }
  if (q.extraReset) {
    const note = el(q.extraReset.url ? 'button' : 'div', 'note link', `extra reset announced${q.extraReset.at ? ` · in ${countdown(q.extraReset.at)}` : ''}`);
    if (q.extraReset.url) note.addEventListener('click', (e) => { e.stopPropagation(); tg?.openLink ? tg.openLink(q.extraReset.url) : window.open(q.extraReset.url, '_blank', 'noopener'); });
    box.append(note);
  }
  return box;
}

/** An account as a compact tag: who and how much is left, coloured by its verdict. */
function acctTag(q, withAgent = false) {
  const left = q.left === null ? '' : ` ${windowLabel(q.bind, q.stale, unit).text}`;
  const tag = el('span', `acct v-${q.verdict}`, `${withAgent ? `${agentName(q.agent)} ` : ''}${accountTag(q)}${left}`);
  tag.title = `${accountName(q)}${q.email ? ` · ${q.email}` : ''}${q.left === null ? '' : ` · ${q.left}% left`}`;
  return tag;
}

/**
 * One account on one host: at a glance who, each window's use against even pace and what is
 * left; tapped, it opens in place to the detail (trend with time ticks, reset, forecast).
 */
function quotaRow(q, hostId) {
  const id = `${hostId}|${q.key}`;
  const open = openRows.has(id);
  const row = el('div', `qrow v-${q.verdict}${q.stale ? ' stale' : ''}${open ? ' open' : ''}`);
  row.setAttribute('role', 'button');
  row.setAttribute('aria-expanded', String(open));
  row.tabIndex = 0;
  const top = el('div', 'qrow-top');
  let left;
  if (q.bind) { left = leftCell(q.bind, q.stale, 'left'); left.textContent += ` ${unit}`; }
  else left = noReading(q);
  top.append(el('span', `agent ${q.agent}`, accountName(q)), left, el('span', 'chev', open ? '⌄' : '›'));
  row.append(top);
  if (open) row.append(quotaDetail(q));
  else {
    const mini = el('div', 'qmini');
    for (const w of q.windows) {
      const cell = el('div');
      cell.append(kCell(w, q), bar(w, q.stale), leftCell(w, q.stale), resetCell(w));
      mini.append(cell);
    }
    row.append(mini);
  }
  const meta = el('div', 'sub');
  if (q.email) { const e = el('span', null, emailName(q.email)); e.title = q.email; meta.append(e); }
  if (q.sharedWith.length) meta.append(`${meta.childNodes.length ? ' · ' : ''}one budget, also on ${q.sharedWith.join(', ')}`);
  if (q.stale && q.at) { const c = el('span', 'clock', ' ◷'); c.title = `reading ${ago(new Date(q.at).toISOString())}`; meta.append(c); }
  if (meta.childNodes.length) row.append(meta);
  if (q.verdict === 'short' || q.verdict === 'exhausted') row.append(el('div', 'warn', verdictText(q, { withReset: false })));
  for (const p of q.problems) row.append(el('div', 'warn', p));
  const toggle = () => { open ? openRows.delete(id) : openRows.add(id); tg?.HapticFeedback?.selectionChanged?.(); render(); };
  row.addEventListener('click', toggle);
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  return row;
}

/** Quota by host: what each machine has left on each account. A shared account is one budget. */
function renderQuota() {
  const box = $('quota-view');
  box.replaceChildren();
  const grid = el('div', 'quota-hosts');
  for (const h of hostList) {
    if (!h.accounts.length) { grid.append(hostSection(h, [el('div', 'qrows empty', 'No accounts')])); continue; }
    const best = bestAccounts(h.accounts);
    const bestLine = el('div', 'qbest', best.length ? 'Best now: ' : 'Best now: none with quota left');
    best.forEach(({ q }, i) => bestLine.append(i ? ' · ' : '', acctTag(q, true)));
    const rows = el('div', 'qrows');
    for (const q of h.accounts) rows.append(q.refTo ? quotaRef(q) : quotaRow(q, h.id));
    grid.append(hostSection(h, [bestLine, rows]));
  }
  box.append(el('div', 'section-h', `Quota ${unit}`), grid);
}

/** A host's load: one meter per CPU, memory and GPU (coloured past 80%), then what the hardware is. */
function resourcesBox(r, online) {
  const { meters, about } = resourceView(r);
  const box = el('div', `res${online ? '' : ' stale-v'}`);
  if (!meters.length) { box.append(el('span', 'muted', 'no load reported')); return box; }
  for (const m of meters) {
    const cell = el('div', 'res-m');
    const track = el('div', `bar${m.pct >= 80 ? ' hot' : ''}`);
    const fill = el('div', 'fill');
    fill.style.width = `${Math.min(100, Math.max(0, m.pct))}%`;
    track.append(fill);
    cell.append(el('span', 'k', m.label), track, el('span', 'res-t', m.text));
    box.append(cell);
  }
  if (about && loadMode === 'detailed') box.append(el('div', 'res-about muted', about));
  return box;
}

/** The headline when no window has a current reading: reset since the last one, or never read. */
function noReading(q) {
  const reset = q.windows.length > 0;
  const span = el('span', 'left', reset ? 'not read since reset' : 'no reading');
  span.title = reset ? 'every window has reset since the last reading: use unknown until the account is used on this host' : 'no window reported for this account yet';
  return span;
}

function quotaRef(q) {
  const row = el('div', `qrow qref v-${q.verdict}${q.stale ? ' stale' : ''}`);
  const left = q.bind ? leftCell(q.bind, q.stale, 'left') : noReading(q);
  if (q.bind) left.textContent += ` ${unit}`;
  row.append(el('span', `agent ${q.agent}`, accountName(q)), left, el('span', 'see', `→ see ${q.refTo}`));
  row.title = `one budget: its full card is on ${q.refTo}`;
  return row;
}

function renderChips() {
  const { counts } = filterOptions(snapshot);
  const nav = $('chips');
  nav.replaceChildren();
  for (const [key, g] of Object.entries(GROUPS)) {
    if (key !== 'all' && key !== filters.group && !counts[key]) continue;   // an empty chip is noise
    const chip = el('button', `chip${filters.group === key ? ' on' : ''}`, g.label);
    chip.append(el('b', null, String(counts[key])));
    chip.addEventListener('click', () => { filters.group = key; tg?.HapticFeedback?.selectionChanged?.(); render(); });
    nav.append(chip);
  }
}

/** Host / agent / project selects, each only when it has a choice to make. */
function renderSelects() {
  const opts = filterOptions(snapshot);
  const key = JSON.stringify([opts.host, opts.agent, opts.project, filters]);
  if (key === selectsKey) return;   // rebuilding a select closes its open native picker
  selectsKey = key;
  const box = $('selects');
  box.replaceChildren();
  const label = { host: 'All hosts', agent: 'All agents', project: 'All projects' };
  for (const name of ['host', 'agent', 'project']) {
    if (opts[name].length < 2 && !filters[name]) continue;
    const select = el('select');
    select.setAttribute('aria-label', name);
    select.append(Object.assign(el('option', null, label[name]), { value: '' }));
    for (const v of opts[name]) select.append(Object.assign(el('option', null, name === 'agent' ? agentName(v) : v), { value: v }));
    select.value = opts[name].includes(filters[name]) ? filters[name] : '';
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
    main.append(el('div', 'empty', snapshot.hosts.length ? 'Nothing matches' : 'No hosts registered yet'));
    return;
  }
  if (groupBy === 'project') {
    for (const g of groupSessions(hosts, 'project', groupOrder)) {
      const section = el('section', `host${g.online ? '' : ' off'}`);
      const head = el('div', 'host-head');
      head.append(el('span', `dot ${g.online ? 'on-dot' : 'off-dot'}`), el('span', 'name', g.id),
        el('span', 'muted meta', `${g.sessions.length} session${g.sessions.length === 1 ? '' : 's'}`));
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
    if (!h.sessions.length) list.append(el('div', 'empty', h.online ? 'No sessions' : 'No data'));
    for (const s of h.sessions) list.append(sessionRow(s));
    main.append(hostSection(h, [...(h.accounts.length ? [tags] : []), list]));
  }
}

/**
 * One host as every tab shows it: online dot, name, how many sessions (or when it was last
 * seen), and its load when shown; then the tab's own content. The one host header there is.
 */
function hostSection(h, body, { load = loadMode !== 'off' } = {}) {
  const section = el('section', `host${h.online ? '' : ' off'}`);
  const head = el('div', 'host-head');
  head.append(el('span', `dot ${h.online ? 'on-dot' : 'off-dot'}`), el('span', 'name', h.id),
    el('span', 'muted meta', h.online ? `${h.sessions.length} session${h.sessions.length === 1 ? '' : 's'}` : `offline · seen ${ago(h.lastSeen)}`));
  section.append(head, ...(load ? [resourcesBox(h.resources, h.online)] : []), ...body);
  return section;
}

function renderEvents() {
  const box = $('events-view');
  box.replaceChildren();
  const events = unreadEvents(snapshot.events, shownFrom);
  if (!events.length) { box.append(el('div', 'empty', 'No new events')); return; }
  const list = el('div', 'event-list');
  for (const e of events) {
    const row = el('div', 'event new');
    row.append(el('div', 'text', eventText(e)), el('div', 'muted', ago(e.at)));
    list.append(row);
  }
  box.append(list);
}

// Edits are a request to the gateway, applied by a host: the row shows it pending until then.
async function saveConfig(key, value, button) {
  button.disabled = true;
  configDirty = false;
  configShown = null;
  try {
    const res = await fetch('api/config', { method: 'POST', headers: { authorization: `tma ${tg.initData}`, 'content-type': 'application/json' },
      body: JSON.stringify({ key, value }) });
    if (!res.ok) throw new Error(res.status === 400 ? 'not an allowed value' : `HTTP ${res.status}`);
    tg?.HapticFeedback?.notificationOccurred?.('success');
    await load();
  } catch (e) {
    button.disabled = false;
    tg?.showAlert ? tg.showAlert(`Not saved: ${e.message}`) : alert(`Not saved: ${e.message}`);
  }
}

function configRow(r) {
  const row = el('div', 'cfg-row');
  const top = el('div', 'cfg-top');
  const name = r.key.split('.')[2] && r.key.includes('.projects.') ? `${r.meta.label} · ${r.key.split('.')[2]}` : r.meta.label;
  top.append(el('label', null, name));
  const edit = el('div', 'cfg-edit');
  let input;
  if (r.meta.options) {
    input = el('select');
    for (const o of r.meta.options) input.append(Object.assign(el('option', null, o), { value: o }));
  } else {
    input = Object.assign(el('input'), { type: 'number', min: r.meta.min, max: r.meta.max, step: 1 });
  }
  input.value = String(r.pending?.value ?? r.value);
  const save = el('button', null, 'Save');
  save.disabled = true;
  const parse = () => (r.meta.options ? input.value : Number(input.value));
  input.addEventListener('input', () => {
    configDirty = true; save.disabled = parse() === r.value || (!r.meta.options && !(Number.isInteger(parse()) && parse() >= r.meta.min && parse() <= r.meta.max)); });
  save.addEventListener('click', () => saveConfig(r.key, parse(), save));
  if (mock || demoOn || !tg?.initData) input.disabled = true;
  edit.append(input, save);
  top.append(edit);
  row.append(top);
  const notes = [r.pending && `pending: ${JSON.stringify(r.pending.value)}${r.pending.host ? `, handed to ${r.pending.host}` : ', waiting for a host'}`,
    ...r.differs.map((d) => `${d.host} still reads ${JSON.stringify(d.value)} (syncing)`),
    r.overrides.length && `overridden locally on ${r.overrides.join(', ')}: a shared edit does not reach ${r.overrides.length === 1 ? 'it' : 'them'}`,
    !r.meta.options && `${r.meta.min}–${r.meta.max}`].filter(Boolean);
  for (const n of notes) row.append(el('div', 'sub note', n));
  return row;
}

/** How much of each machine's load its host header shows: meters and hardware, meters, or none. */
function loadSetting() {
  const row = el('div', 'cfg demo-toggle');
  const select = el('select');
  select.setAttribute('aria-label', 'machine load');
  for (const [value, text] of LOAD_MODES) select.append(Object.assign(el('option', null, text), { value, selected: loadMode === value }));
  select.addEventListener('change', () => { loadMode = select.value; store.set('dashboard.load', loadMode); render(); });
  row.append(el('span', null, 'Machine load (CPU, memory, GPU) under each host'), select);
  return row;
}

/** Clock and date style for absolute times, this device only. */
function timeSettings() {
  const row = el('div', 'cfg demo-toggle');
  const pick = (name, label, options) => {
    const select = el('select');
    select.setAttribute('aria-label', label);
    for (const [value, text] of options) select.append(Object.assign(el('option', null, text), { value, selected: timeFormat[name] === value }));
    select.addEventListener('change', () => { timeFormat[name] = select.value; store.set(`dashboard.${name}`, select.value); renderVersion(); });
    return select;
  };
  row.append(el('span', null, 'Times'), pick('clock', 'clock', [['24', '24-hour'], ['12', '12-hour']]),
    pick('date', 'date', [['day', '21 Oct'], ['iso', '2026-10-21'], ['off', 'no date']]));
  return row;
}

/** A setting of this device shown as a checkbox: `get` reads it, `set` stores it; the page redraws. */
function deviceToggle(label, get, set) {
  const row = el('label', 'cfg demo-toggle');
  const box = el('input');
  box.type = 'checkbox';
  box.checked = get();
  box.addEventListener('change', () => { set(box.checked); render(); });
  row.append(box, el('span', null, label));
  return row;
}

/** Every checkbox of the "This device" section, in the order shown. */
const deviceToggles = () => [
  deviceToggle('Quota bars show % used (fill = spent) instead of % left (fill = remaining)', () => unit === 'used',
    (v) => { unit = v ? 'used' : 'left'; store.set('dashboard.unit', unit); }),
  deviceToggle('Packed layout (Sessions and Quota): hosts flow down each column and fill the gaps, instead of aligned rows', () => packed,
    (v) => { packed = v; store.set('dashboard.packed', v ? '1' : '0'); document.body.classList.toggle('packed', v); }),
  deviceToggle('Group sessions by project instead of by host', () => groupBy === 'project',
    (v) => { groupBy = v ? 'project' : 'host'; store.set('dashboard.groupBy', groupBy); }),
  deviceToggle('In a project, order sessions by urgency instead of by workstation', () => groupOrder === 'urgency',
    (v) => { groupOrder = v ? 'urgency' : 'host'; store.set('dashboard.groupOrder', groupOrder); }),
  deviceToggle('"Needs you" card at the top (otherwise only the Events tab notifies)', () => needsYouCard,
    (v) => { needsYouCard = v; store.set('dashboard.needsYouCard', v ? '1' : '0'); }),
  deviceToggle('Sessions as a chat list (Telegram style): name, time, unread count and @ mentions', () => chatList,
    (v) => { chatList = v; store.set('dashboard.chatList', v ? '1' : '0'); }),
  ...(mock ? [] : [deviceToggle('Demo mode: mask machines, accounts, projects and ids on this device (config edits off)', () => demoOn, (v) => {
    demoOn = v;
    store.set('dashboard.demo', v ? '1' : '0');
    readAlerts = loadRead();
    filters.host = filters.project = '';   // the chosen names belong to the other view
    selectsKey = null;
    snapshot = shown();
    configShown = null;
  })]),
];

function renderConfig() {
  const box = $('config-view');
  box.replaceChildren();
  box.append(el('div', 'section-h', 'This device'), timeSettings(), loadSetting(), ...deviceToggles());
  const v = configView(snapshot);
  if (!v.hosts.length) { box.append(el('div', 'empty', 'No host has reported its config yet')); return; }
  box.append(el('div', 'section-h', 'Shared settings'));
  const shared = el('div', 'cfg');
  for (const r of v.rows) shared.append(configRow(r));
  box.append(shared, el('div', 'muted', 'Only these can change here. Who may control a host, where sessions are mirrored and every secret stay in the files.'));
  const grid = el('div', 'quota-hosts');
  for (const h of v.hosts) {
    const facts = h.config.facts;
    const dl = el('dl', 'facts cfg');
    const on = (b) => (b ? 'on' : 'off');
    for (const [k, val] of [['Telegram bridge', on(facts.bridge)], ['Allowed users', String(facts.allowedUsers)],
      ['Approvals from Telegram', on(facts.approvalsFromTelegram)],
      ['Codex sources', facts.codexSources.join(', ') || '—'], facts.dashboardError && ['Dashboard', facts.dashboardError]].filter(Boolean)) {
      dl.append(el('dt', null, k), el('dd', null, val));
    }
    grid.append(hostSection(h, [dl], { load: false }));
  }
  box.append(el('div', 'section-h', 'Hosts'), grid);
}

const tzOffsetMin = () => -new Date().getTimezoneOffset();

async function fetchUsage(force = false) {
  if (mock || usageLoading || !tg?.initData) return;
  if (!force && usage?.days === usageDays && Date.now() - usage.at < USAGE_EVERY_MS) return;
  usageLoading = true;
  try {
    const res = await fetch(`api/usage?days=${usageDays}&tz=${tzOffsetMin()}`, { headers: { authorization: `tma ${tg.initData}` }, cache: 'no-store' });
    usage = res.ok ? { days: usageDays, report: await res.json(), at: Date.now() }
      : { days: usageDays, error: res.status === 503 ? 'The usage store is not set up (npm run dashboard -- usage-db)' : `Usage unavailable (HTTP ${res.status})`, at: Date.now() };
  } catch { usage = { days: usageDays, error: 'Usage unreachable', at: Date.now() }; } finally { usageLoading = false; }
  renderUsage();
}

/** One ranked list: name, agent time and turns, tokens, and a hairline for its share. */
function usageList(title, rows) {
  const box = el('div', 'usage-list');
  for (const r of rows) {
    const row = el('div', 'u');
    const share = el('i', 'share');
    share.style.width = `${Math.round(r.share * 100)}%`;
    row.append(el('span', 'n', r.name), el('span', 'm', `${hoursText(r.active)} · ${r.turns} turns`), el('b', null, tokenText(r.tokens)), share);
    row.title = `${r.sessions} sessions · ${Math.round(r.share * 100)}% of the tokens`;
    box.append(row);
  }
  return [el('div', 'section-h', title), rows.length ? box : el('div', 'qrows empty', 'none')];
}

function renderUsage() {
  const box = $('usage-view');
  box.replaceChildren();
  const range = el('div', 'usage-range');
  for (const d of USAGE_RANGES) {
    const b = el('button', null, d === 365 ? '1y' : `${d}d`);
    b.setAttribute('aria-pressed', String(d === usageDays));
    b.addEventListener('click', () => { usageDays = d; store.set('dashboard.usageDays', String(d)); renderUsage(); fetchUsage(true); });
    range.append(b);
  }
  box.append(range);
  if (mock) return box.append(el('div', 'qrows empty', 'No usage in the example data'));
  if (!usage || usage.days !== usageDays) return box.append(el('div', 'qrows empty', 'Loading…'));
  if (usage.error) return box.append(el('div', 'qrows empty', usage.error));
  const v = usageView(demoOn ? (masker ??= demoMasker()).usage(usage.report) : usage.report, Date.now(), tzOffsetMin());
  const totals = el('div', 'usage-totals');
  const total = (value, label, title) => { const c = el('div'); c.append(el('b', null, value), el('span', null, label)); if (title) c.title = title; totals.append(c); };
  total(tokenText(v.totals.tokens), 'tokens', 'input, cache read and write, and output');
  total(hoursText(v.totals.active), 'agent time', 'turn durations summed: parallel sessions add up');
  total(String(v.totals.turns), 'turns');
  if (v.totals.cacheHit != null) total(`${Math.round(v.totals.cacheHit * 100)}%`, 'cache hit', 'input tokens read from the prompt cache');
  if (v.totals.costUsd != null) total(`$${Math.round(v.totals.costUsd)}`, 'API value', 'what Claude Code priced its sessions at: list price, not a subscription bill');
  const chart = el('div', 'usage-days');
  for (const d of v.days) {
    const col = el('div', 'd');
    col.title = `${d.day}: Claude ${tokenText(d.claude)}, Codex ${tokenText(d.codex)}, ${hoursText(d.active)} agent time`;
    for (const a of ['claude', 'codex']) { const seg = el('div', a); seg.style.height = `${d[`${a}Pct`]}%`; col.append(seg); }
    chart.append(col);
  }
  const axis = el('div', 'usage-axis');
  axis.append(el('span', null, v.days[0]?.day ?? ''), el('span', null, 'tokens per day · Claude / Codex'), el('span', null, v.days.at(-1)?.day ?? ''));
  box.append(totals, chart, axis, ...usageList('Projects', v.projects), ...usageList('Models', v.models), ...usageList('Machines', v.machines));
}

function renderTabs() {
  // Looking at the events marks them seen (after this render still shows which were new).
  const t = tabs(snapshot, Date.now(), seenAt, readAlerts, shownFrom, accounts);
  $('tabs').hidden = false;   // always: Config holds this device's settings, whatever data there is
  $('n-sessions').textContent = String(t.sessions);
  $('n-quota').textContent = String(t.quota);
  $('quota-dot').hidden = !t.alert;
  $('n-events').textContent = String(t.events);
  $('events-badge').hidden = !t.unseen || tab === 'events';
  $('events-badge').textContent = String(t.unseen);
  for (const b of document.querySelectorAll('#tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== tab;
}

for (const b of document.querySelectorAll('#tabs [data-tab]')) {
  b.addEventListener('click', () => {
    tab = b.dataset.tab;
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
  $('updated').textContent = snapshot.mock ? 'example data' : lastOk && snapshot.demo ? `demo · data ${ago(new Date(lastOk).toISOString())}` : lastOk ? `data ${ago(new Date(lastOk).toISOString())}` : '';
  renderSummary();
  renderTabs();
  renderQuota();
  renderEvents();
  // The config form is rebuilt only when its data changed and nobody is editing it: a poll must
  // not wipe a value being typed.
  if (tab === 'config') {
    const key = JSON.stringify(configView(snapshot));
    const editing = configDirty || $('config-view').contains(document.activeElement);
    if (key !== configShown && !editing) { configShown = key; renderConfig(); }
  }
  if (tab === 'events' && snapshot.events?.length) { seenAt = snapshot.events[0].at; store.set('dashboard.eventsSeenAt', seenAt); }
  renderChips();
  renderSelects();
  renderHosts();
}

function stop(message) {
  $('summary').hidden = false;   // sign-in and access problems show whatever the needs-you card setting
  $('summary').replaceChildren(el('div', 'summary-head', message));
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
  if (!tg?.initData) return stop('Open this from the Dashboard button of the dashboard bot in Telegram');
  try {
    const res = await fetch('api/dashboard', { headers: { authorization: `tma ${tg.initData}` }, cache: 'no-store' });
    // Expired sign-in (Telegram only signs initData at open): keep the last data, ask for a reopen.
    if (res.status === 401 && snapshot) { $('banner').textContent = `Sign-in expired · close and reopen the app to refresh (data from ${ago(new Date(lastOk).toISOString())})`; return render(); }
    if (res.status === 401) return stop('Sign-in expired: close and reopen the app');
    if (res.status === 403) return stop('This Telegram account is not allowed');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = await res.json();
    if (!Array.isArray(next?.hosts)) throw new Error('unexpected response');
    raw = next;
    snapshot = shown();
    lastOk = Date.now();
    $('banner').textContent = '';
  } catch {
    // Keep the last data, clearly marked as old.
    $('banner').textContent = lastOk ? `Gateway unreachable · showing data from ${ago(new Date(lastOk).toISOString())}` : 'Gateway unreachable';
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
  if (!deployed) return;
  box.append(document.createTextNode(`build ${deployed.at ? formatTime(Date.parse(deployed.at), timeFormat) : deployed.id.slice(0, 8)}`));
  if (deployed.commit) {
    const sha = deployed.commit.replace(/\+$/, '');
    const link = el('button', 'commit', deployed.commit);
    link.title = deployed.commit.endsWith('+') ? 'deployed from this commit plus uncommitted changes' : 'open this commit on GitHub';
    link.addEventListener('click', () => { const url = `${REPO}/commit/${sha}`; tg?.openLink ? tg.openLink(url) : window.open(url, '_blank', 'noopener'); });
    box.append(document.createTextNode(' · '), link);
  }
}

load();
if (!mock) { setInterval(load, POLL_MS); showVersion(); }
