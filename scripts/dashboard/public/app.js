// scripts/dashboard/public/app.js — the Mini App's DOM side. Authenticates every request
// with the raw Telegram initData (the gateway verifies it); never reads initDataUnsafe for
// anything but display. All data is rendered with textContent, never as HTML.

import { GROUPS, STATUS_LABELS, ago, applyFilters, attention, countdown, displayStatus, filterOptions, mockDashboard, quotaAlerts, alertKey, quotaView, stats, tabs, accountName, verdictText, accountIndex, accountTag, quotaByHost, timeTicks, configView } from './view.mjs';

const POLL_MS = 8000;
const tg = window.Telegram?.WebApp;
const mock = new URLSearchParams(location.search).has('mock');
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const filters = { group: 'all', host: '', agent: '', project: '' };
let snapshot = null;
let lastOk = null;
let loading = false;
let selectsKey = null;
// The open tab survives a reopen; sessions is the default view.
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };
// A #quota / #events link opens that tab; otherwise the last one used. 
const TABS = ['sessions', 'quota', 'events', 'config'];
const hashTab = location.hash.slice(1);
let tab = [hashTab, store.get('dashboard.tab')].find((x) => TABS.includes(x)) ?? 'sessions';
// Events newer than this were not seen yet: kept on this device, moved on by opening the tab.
let seenAt = store.get('dashboard.eventsSeenAt');
// Quota alerts read on this device (tapped in the needs-you card); only keys still standing are kept.
let readAlerts = (() => { try { const v = JSON.parse(store.get('dashboard.readAlerts')); return Array.isArray(v) ? v : []; } catch { return []; } })();
// Quota rows opened to their detail (host|account), kept across polls.
const openRows = new Set();
let accounts = new Map();
let configShown = null;   // the config view last rendered (JSON)
let configDirty = false;  // an edit typed but not saved

tg?.ready();
tg?.expand();

function openTopic(url) {
  tg?.HapticFeedback?.impactOccurred?.('light');
  if (tg?.openTelegramLink) tg.openTelegramLink(url); else window.open(url, '_blank', 'noopener');
}

/** One session: status dot, project, the context line, a status pill, `›` when it opens a Topic. */
function sessionRow(s, { withHost = false } = {}) {
  const status = displayStatus(s);
  const row = el(s.topic ? 'button' : 'div', `row s-${status}${s.topic ? ' link' : ''}`);
  const main = el('div', 'main');
  main.append(el('div', 'title', s.project ?? 'unknown project'));
  const sub = el('div', 'sub');
  sub.append(el('span', `agent ${s.agent}`, s.agent === 'claude' ? 'Claude' : 'Codex'));
  const rest = [withHost && s.hostId, s.branch, ago(s.lastActivityAt), s.topic?.closed && 'Topic closed'].filter(Boolean);
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

function renderSummary() {
  const box = $('summary');
  const st = stats(snapshot);
  const waiting = attention(snapshot);
  if (snapshot.accounts) {
    const standing = quotaAlerts(snapshot).map(alertKey);
    readAlerts = readAlerts.filter((k) => standing.includes(k));
    store.set('dashboard.readAlerts', JSON.stringify(readAlerts));
  }
  const quota = quotaAlerts(snapshot, Date.now(), readAlerts);
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
  main.append(el('div', 'title', accountName(q)), el('div', 'sub', verdictText(q)));
  row.append(el('span', 'dot'), main, el('span', 'pill', q.verdict === 'exhausted' ? 'Exhausted' : 'Runs out'));
  // Tapping marks it read: it leaves the card until the verdict or the window period changes.
  row.title = 'Mark read';
  row.addEventListener('click', () => { readAlerts.push(alertKey(q)); store.set('dashboard.readAlerts', JSON.stringify(readAlerts)); render(); });
  return row;
}

/** Position bar: fill = use, the line = where an even spend would be by now. */
function bar(w, stale) {
  const track = el('div', `bar${w.forecast?.short || w.used >= 100 ? ' hot' : ''}`);
  const fill = el('div', 'fill');
  fill.style.width = `${w.used}%`;
  const pace = el('div', 'pace');
  pace.style.left = `${w.pace}%`;
  track.append(fill, pace);
  track.title = `${stale ? '≥' : ''}${Math.round(w.used)}% used · even pace ${Math.round(w.pace)}%`;
  return track;
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

/** The expanded part of a quota row: each window with its trend on a time axis, then resets to act on. */
function quotaDetail(q) {
  const box = el('div', 'qdetail');
  if (q.detail) box.append(el('div', 'sub', q.detail));
  for (const w of q.windows) {
    const row = el('div', 'win');
    const used = w.renewed ? 'new' : `${q.stale && w.used < 100 ? '≥' : ''}${Math.round(w.used)}%`;
    row.append(el('span', 'k', w.k), bar(w, q.stale), el('span', 'used', used));
    const sub = el('div', 'win-sub');
    const forecast = w.forecast && (w.forecast.short ? `runs out in ${countdown(w.forecast.eta)}` : `→ ${Math.round(w.forecast.atReset)}% at reset`);
    sub.append(trend(w), el('span', null, w.renewed ? 'new window, not started' : [`resets in ${countdown(w.resetsAt)}`, forecast].filter(Boolean).join(' · ')));
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
  const left = q.left === null ? '' : ` ${q.stale && q.bind.used < 100 ? '≤' : ''}${q.left}%`;
  const tag = el('span', `acct v-${q.verdict}`, `${withAgent ? `${q.agent === 'claude' ? 'Claude' : 'Codex'} ` : ''}${accountTag(q)}${left}`);
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
  top.append(el('span', `agent ${q.agent}`, accountName(q)),
    el('span', 'left', q.left === null ? 'no data' : `${q.stale && q.bind.used < 100 ? '≤' : ''}${q.left}% left`), el('span', 'chev', open ? '⌄' : '›'));
  row.append(top);
  if (open) row.append(quotaDetail(q));
  else {
    const mini = el('div', 'qmini');
    for (const w of q.windows) {
      const cell = el('div');
      cell.append(el('span', 'k', w.k), bar(w, q.stale), el('span', 'used', w.renewed ? 'new' : `${q.stale && w.used < 100 ? '≥' : ''}${Math.round(w.used)}%`));
      mini.append(cell);
    }
    row.append(mini);
  }
  row.append(el('div', 'sub', [q.email, q.sharedWith.length && `one budget, also on ${q.sharedWith.join(', ')}`,
    q.at && `reading ${ago(new Date(q.at).toISOString())}`].filter(Boolean).join(' · ')));
  if (q.verdict === 'short' || q.verdict === 'exhausted') row.append(el('div', 'warn', verdictText(q)));
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
  const hosts = el('div', 'quota-hosts');
  for (const h of quotaByHost(snapshot)) {
    const section = el('section', `host${h.online ? '' : ' off'}`);
    const head = el('div', 'host-head');
    head.append(el('span', `dot ${h.online ? 'on-dot' : 'off-dot'}`), el('span', 'name', h.id));
    const rows = el('div', 'qrows');
    for (const q of h.accounts) rows.append(quotaRow(q, h.id));
    section.append(head, rows);
    hosts.append(section);
  }
  box.append(hosts);
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
    for (const v of opts[name]) select.append(Object.assign(el('option', null, name === 'agent' ? (v === 'claude' ? 'Claude' : 'Codex') : v), { value: v }));
    select.value = opts[name].includes(filters[name]) ? filters[name] : '';
    filters[name] = select.value;
    select.addEventListener('change', () => { filters[name] = select.value; render(); });
    box.append(select);
  }
}

function renderHosts() {
  const main = $('hosts');
  main.replaceChildren();
  const hosts = applyFilters(snapshot, filters);
  if (!hosts.length) {
    main.append(el('div', 'empty', snapshot.hosts.length ? 'Nothing matches' : 'No hosts registered yet'));
    return;
  }
  for (const h of hosts) {
    const section = el('section', `host${h.online ? '' : ' off'}`);
    const head = el('div', 'host-head');
    const runs = [...accounts.values()].filter((q) => q.hosts?.includes(h.id));
    const tagsBox = el('span', 'acct-tags');
    for (const q of runs) tagsBox.append(acctTag(q, true));
    head.append(el('span', `dot ${h.online ? 'on-dot' : 'off-dot'}`), el('span', 'name', h.id), tagsBox,
      el('span', 'muted meta', h.online ? `${h.sessions.length} session${h.sessions.length === 1 ? '' : 's'}` : `offline · seen ${ago(h.lastSeen)}`));
    const list = el('div', 'list');
    if (!h.sessions.length) list.append(el('div', 'empty', h.online ? 'No sessions' : 'No data'));
    for (const s of h.sessions) list.append(sessionRow(s));
    section.append(head, list);
    main.append(section);
  }
}

function renderEvents() {
  const box = $('events-view');
  box.replaceChildren();
  const events = snapshot.events ?? [];
  if (!events.length) { box.append(el('div', 'empty', 'No events yet')); return; }
  const list = el('div', 'event-list');
  for (const e of events) {
    const row = el('div', `event${!seenAt || e.at > seenAt ? ' new' : ''}`);
    row.append(el('div', 'text', e.text), el('div', 'muted', ago(e.at)));
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
  if (mock || !tg?.initData) input.disabled = true;
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

function renderConfig() {
  const box = $('config-view');
  box.replaceChildren();
  const v = configView(snapshot);
  if (!v.hosts.length) { box.append(el('div', 'empty', 'No host has reported its config yet')); return; }
  box.append(el('div', 'section-h', 'Shared settings'));
  const shared = el('div', 'cfg');
  for (const r of v.rows) shared.append(configRow(r));
  box.append(shared, el('div', 'muted', 'Only these can change here. Who may control a host, where sessions are mirrored and every secret stay in the files.'));
  const grid = el('div', 'quota-hosts');
  for (const h of v.hosts) {
    const section = el('section', `host${h.online ? '' : ' off'}`);
    const head = el('div', 'host-head');
    head.append(el('span', `dot ${h.online ? 'on-dot' : 'off-dot'}`), el('span', 'name', h.id));
    const dl = el('dl', 'facts cfg');
    const on = (b) => (b ? 'on' : 'off');
    for (const [k, val] of [['Telegram bridge', on(h.facts.bridge)], ['Allowed users', String(h.facts.allowedUsers)],
      ['Approvals from Telegram', on(h.facts.approvalsFromTelegram)], ['Quota alerts', on(h.facts.alerts)],
      ['Codex sources', h.facts.codexSources.join(', ') || '—'], h.facts.dashboardError && ['Dashboard', h.facts.dashboardError]].filter(Boolean)) {
      dl.append(el('dt', null, k), el('dd', null, val));
    }
    section.append(head, dl);
    grid.append(section);
  }
  box.append(el('div', 'section-h', 'Hosts'), grid);
}

function renderTabs() {
  // Looking at the events marks them seen (after this render still shows which were new).
  const t = tabs(snapshot, Date.now(), seenAt, readAlerts);
  $('tabs').hidden = !t.show;
  if (!t.show) tab = 'sessions';
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
  $('updated').textContent = snapshot.mock ? 'example data' : lastOk ? `updated ${ago(new Date(lastOk).toISOString())}` : '';
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
  $('summary').replaceChildren(el('div', 'summary-head', message));
  $('hosts').replaceChildren();
  $('chips').replaceChildren();
  $('quota-view').replaceChildren();
  $('events-view').replaceChildren();
  $('config-view').replaceChildren();
  $('tabs').hidden = true;
}

async function fetchSnapshot() {
  if (mock) { snapshot = mockDashboard(); render(); return; }
  if (!tg?.initData) return stop('Open this from the Dashboard button of the dashboard bot in Telegram');
  try {
    const res = await fetch('api/dashboard', { headers: { authorization: `tma ${tg.initData}` }, cache: 'no-store' });
    if (res.status === 401) return stop('Sign-in expired: close and reopen the app');
    if (res.status === 403) return stop('This Telegram account is not allowed');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = await res.json();
    if (!Array.isArray(next?.hosts)) throw new Error('unexpected response');
    snapshot = next;
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
}

load();
if (!mock) setInterval(load, POLL_MS);
