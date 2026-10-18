// scripts/dashboard/public/app.js — the Mini App's DOM side. Authenticates every request
// with the raw Telegram initData (the gateway verifies it); never reads initDataUnsafe for
// anything but display. All data is rendered with textContent, never as HTML.

import { GROUPS, STATUS_LABELS, ago, applyFilters, attention, displayStatus, filterOptions, mockDashboard, stats } from './view.mjs';

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
  box.className = `summary${waiting.length ? ' alert' : ''}`;
  box.replaceChildren();
  const head = el('div', 'summary-head', waiting.length ? `${waiting.length} need${waiting.length === 1 ? 's' : ''} you` : 'All clear');
  box.append(head, el('div', 'summary-sub',
    `${st.working} working · ${st.hostsOnline}/${st.hosts} host${st.hosts === 1 ? '' : 's'} online`));
  for (const s of waiting) box.append(sessionRow(s, { withHost: true }));
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

function render() {
  if (!snapshot) return;
  $('updated').textContent = snapshot.mock ? 'example data' : lastOk ? `updated ${ago(new Date(lastOk).toISOString())}` : '';
  renderSummary();
  renderChips();
  renderSelects();
  renderHosts();
}

function stop(message) {
  $('summary').replaceChildren(el('div', 'summary-head', message));
  $('hosts').replaceChildren();
  $('chips').replaceChildren();
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
