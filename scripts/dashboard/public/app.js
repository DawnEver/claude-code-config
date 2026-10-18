// scripts/dashboard/public/app.js — the Mini App's DOM side. Authenticates every request
// with the raw Telegram initData (the gateway verifies it); never reads initDataUnsafe for
// anything but display. All data is rendered with textContent, never as HTML.

import { GROUPS, STATUS_LABELS, ago, applyFilters, attention, countdown, displayStatus, filterOptions, mockDashboard, quotaAlerts, quotaView, stats, tabs, accountName, verdictText } from './view.mjs';

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
let tab = (() => { try { return localStorage.getItem('dashboard.tab') === 'quota' ? 'quota' : 'sessions'; } catch { return 'sessions'; } })();

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
  const rest = [withHost && s.hostId, s.branch, s.seat, ago(s.lastActivityAt), s.topic?.closed && 'Topic closed'].filter(Boolean);
  sub.append(document.createTextNode(` · ${rest.join(' · ')}`));
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
  const quota = quotaAlerts(snapshot);
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

/** Trend: spend per slice of the window against an even spend (half height); hatched = never observed. */
function trend(cells) {
  const box = el('div', 'trend');
  for (const c of cells) {
    const cell = el('span', c === null ? 'ahead' : c < 0 ? 'unseen' : 'seen');
    if (c !== null && c >= 0) cell.style.height = `${Math.max(4, Math.min(100, c * 50))}%`;
    box.append(cell);
  }
  return box;
}

function quotaCard(q) {
  const card = el('section', `quota-card v-${q.verdict}${q.stale ? ' stale' : ''}`);
  const head = el('div', 'quota-head');
  head.append(el('span', `agent ${q.agent}`, accountName(q)),
    el('span', 'left', q.left === null ? 'no data' : `${q.stale && q.bind.used < 100 ? '≤' : ''}${q.left}% left`));
  card.append(head, el('div', 'sub', [q.email ?? 'not logged in', q.detail].filter(Boolean).join(' · ')));
  if (q.verdict === 'short' || q.verdict === 'exhausted') card.append(el('div', 'warn', verdictText(q)));
  for (const p of q.problems) card.append(el('div', 'warn', p));
  for (const w of q.windows) {
    const row = el('div', 'win');
    const used = w.renewed ? 'new' : `${q.stale && w.used < 100 ? '≥' : ''}${Math.round(w.used)}%`;
    row.append(el('span', 'k', w.k), bar(w, q.stale), el('span', 'used', used));
    const sub = el('div', 'win-sub');
    const forecast = w.forecast && (w.forecast.short ? `runs out in ${countdown(w.forecast.eta)}` : `→ ${Math.round(w.forecast.atReset)}% at reset`);
    sub.append(trend(w.cells), el('span', null, w.renewed ? 'new window, not started' : [`resets in ${countdown(w.resetsAt)}`, forecast].filter(Boolean).join(' · ')));
    card.append(row, sub);
  }
  if (q.resetCredits) {
    const first = q.resetCredits.expiries.filter(Boolean).sort((x, y) => x - y)[0];
    card.append(el('div', 'note', `${q.resetCredits.count} reset credit${q.resetCredits.count === 1 ? '' : 's'}${first ? ` · first expires in ${countdown(first)}` : ''}`));
  }
  if (q.extraReset) {
    const note = el(q.extraReset.url ? 'button' : 'div', 'note link', `extra reset announced${q.extraReset.at ? ` · in ${countdown(q.extraReset.at)}` : ''}`);
    if (q.extraReset.url) note.addEventListener('click', () => (tg?.openLink ? tg.openLink(q.extraReset.url) : window.open(q.extraReset.url, '_blank', 'noopener')));
    card.append(note);
  }
  card.append(el('div', 'muted foot', `${(q.hosts ?? []).join(', ')}${q.at ? ` · reading ${ago(new Date(q.at).toISOString())}` : ''}`));
  return card;
}

function renderQuota() {
  const box = $('quota');
  box.replaceChildren();
  const accounts = (snapshot.accounts ?? []).map((a) => quotaView(a));
  if (!accounts.length) return;
  const grid = el('div', 'quota-grid');
  for (const q of accounts) grid.append(quotaCard(q));
  box.append(grid);
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
    head.append(el('span', `dot ${h.online ? 'on-dot' : 'off-dot'}`), el('span', 'name', h.id),
      el('span', 'muted meta', h.online ? `${h.sessions.length} session${h.sessions.length === 1 ? '' : 's'}` : `offline · seen ${ago(h.lastSeen)}`));
    const list = el('div', 'list');
    if (!h.sessions.length) list.append(el('div', 'empty', h.online ? 'No sessions' : 'No data'));
    for (const s of h.sessions) list.append(sessionRow(s));
    section.append(head, list);
    main.append(section);
  }
}

function renderTabs() {
  const t = tabs(snapshot);
  $('tabs').hidden = !t.show;
  if (!t.show) tab = 'sessions';
  $('n-sessions').textContent = String(t.sessions);
  $('n-quota').textContent = String(t.quota);
  $('quota-dot').hidden = !t.alert;
  for (const b of document.querySelectorAll('#tabs [data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const v of document.querySelectorAll('.view')) v.hidden = v.dataset.view !== tab;
}

for (const b of document.querySelectorAll('#tabs [data-tab]')) {
  b.addEventListener('click', () => {
    tab = b.dataset.tab;
    try { localStorage.setItem('dashboard.tab', tab); } catch { /* private mode */ }
    tg?.HapticFeedback?.selectionChanged?.();
    render();
  });
}

function render() {
  if (!snapshot) return;
  $('updated').textContent = snapshot.mock ? 'example data' : lastOk ? `updated ${ago(new Date(lastOk).toISOString())}` : '';
  renderSummary();
  renderTabs();
  renderQuota();
  renderChips();
  renderSelects();
  renderHosts();
}

function stop(message) {
  $('summary').replaceChildren(el('div', 'summary-head', message));
  $('hosts').replaceChildren();
  $('chips').replaceChildren();
  $('quota').replaceChildren();
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
