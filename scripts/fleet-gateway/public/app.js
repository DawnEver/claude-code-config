// scripts/fleet-gateway/public/app.js — the Mini App's DOM side. Authenticates every request
// with the raw Telegram initData (the gateway verifies it); never reads initDataUnsafe for
// anything but display. All data is rendered with textContent, never as HTML.

import { STATUS_LABELS, ago, applyFilters, displayStatus, filterOptions, hostSummary, mockFleet, stats } from './view.mjs';

const POLL_MS = 8000;
const tg = window.Telegram?.WebApp;
const mock = new URLSearchParams(location.search).has('mock');
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const filters = { host: '', agent: '', project: '', status: '' };
let fleet = null;
let lastOk = null;
let loading = false;
let optionsKey = null;

tg?.ready();
tg?.expand();

function openTopic(url) {
  if (tg?.openTelegramLink) tg.openTelegramLink(url); else window.open(url, '_blank', 'noopener');
}

function renderFilters() {
  const opts = filterOptions(fleet);
  // Rebuilding a select closes its open native picker (mobile): only when the options changed.
  const key = JSON.stringify([opts, filters]);
  if (key === optionsKey) return;
  optionsKey = key;
  const all = { host: 'All hosts', agent: 'All agents', project: 'All projects', status: 'All status' };
  for (const key of Object.keys(filters)) {
    const select = $(`f-${key}`);
    select.replaceChildren(el('option', null, all[key]));
    select.firstChild.value = '';
    for (const v of opts[key]) {
      const o = el('option', null, key === 'status' ? STATUS_LABELS[v] ?? v : v);
      o.value = v;
      select.append(o);
    }
    if (filters[key] && !opts[key].includes(filters[key])) filters[key] = '';
    select.value = filters[key];
  }
}

function renderSession(s) {
  const status = displayStatus(s);
  const row = el('div', `session${s.topic ? ' link' : ''}`);
  row.append(el('span', `agent ${s.agent}`, s.agent === 'claude' ? 'Claude' : 'Codex'),
    el('span', null, `${s.project ?? 'unknown'}${s.branch ? ` · ${s.branch}` : ''}`),
    el('span', `status s-${status}`, STATUS_LABELS[status] ?? status));
  const sub = [s.id.slice(0, 8), s.seat && `seat ${s.seat}`, `active ${ago(s.lastActivityAt)}`,
    s.topic ? (s.topic.closed ? 'Topic (closed)' : 'Topic') : 'no Topic'].filter(Boolean).join(' · ');
  row.append(el('span', 'sub', sub));
  if (s.topic) row.addEventListener('click', () => openTopic(s.topic.url));
  return row;
}

function render() {
  if (!fleet) return;
  const st = stats(fleet);
  $('n-hosts').textContent = `${st.hostsOnline}/${st.hosts}`;
  $('n-working').textContent = st.working;
  $('n-attention').textContent = st.attention;
  renderFilters();
  const hosts = applyFilters(fleet, filters);
  const main = $('hosts');
  main.replaceChildren();
  if (!hosts.length) { main.append(el('div', 'empty', fleet.hosts.length ? 'No session matches the filters' : 'No hosts registered')); return; }
  for (const h of hosts) {
    const card = el('section', 'host');
    const head = el('header');
    head.append(el('b', null, h.id), el('span', h.online ? 'online' : 'offline', h.online ? 'Online' : 'Offline'));
    const sum = hostSummary(h);
    card.append(head, el('div', 'meta',
      `Last seen ${ago(h.lastSeen)} · Claude ${sum.claude} · Codex ${sum.codex} · Active ${sum.active} · Attention ${sum.attention}`));
    if (!h.sessions.length) card.append(el('div', 'meta', h.online ? 'No sessions' : 'No data'));
    for (const s of h.sessions) card.append(renderSession(s));
    main.append(card);
  }
}

async function load() {
  if (loading) return;
  loading = true;
  try { await fetchFleet(); } finally { loading = false; }
}

async function fetchFleet() {
  if (mock) { fleet = mockFleet(); $('banner').textContent = 'Mock data: not connected to the gateway'; render(); return; }
  if (!tg?.initData) { $('banner').textContent = 'Open this page from the bridge bot's Fleet button in Telegram'; $('hosts').replaceChildren(); return; }
  try {
    const res = await fetch('api/fleet', { headers: { authorization: `tma ${tg.initData}` }, cache: 'no-store' });
    if (res.status === 401 || res.status === 403) {
      $('banner').textContent = res.status === 403 ? 'This Telegram account is not allowed' : 'Telegram authentication failed or expired: reopen the app';
      fleet = null; $('hosts').replaceChildren(); return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const next = await res.json();
    if (!Array.isArray(next?.hosts)) throw new Error('unexpected response');
    fleet = next;
    lastOk = Date.now();
    $('banner').textContent = '';
  } catch {
    // Keep the last data, clearly marked as old.
    $('banner').textContent = lastOk ? `Gateway unreachable: showing data from ${ago(new Date(lastOk).toISOString())}` : 'Gateway unreachable';
  }
  render();
}

for (const key of Object.keys(filters)) $(`f-${key}`).addEventListener('change', (e) => { filters[key] = e.target.value; render(); });
load();
if (!mock) setInterval(load, POLL_MS);
