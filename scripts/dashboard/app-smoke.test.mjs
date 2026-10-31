// scripts/dashboard/app-smoke.test.mjs — the page itself, run against the example data in a
// minimal DOM: every tab renders, and no view throws. A fault that only shows in a browser (a
// ReferenceError in one tab blanked another, 2026-10-30) fails here before it is deployed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

/** Just enough of an element for app.js: tree, text, classes, attributes, events, simple selectors. */
class Node {
  constructor(tag) {
    Object.assign(this, { tag, children: [], attrs: {}, className: '', hidden: false, dataset: {}, style: {}, listeners: {}, value: '', ownText: '' });
    this.classList = {
      add: (...c) => { this.className = [...new Set([...this.#classes(), ...c])].join(' '); },
      remove: (...c) => { this.className = this.#classes().filter((x) => !c.includes(x)).join(' '); },
      toggle: (c, on = !this.#classes().includes(c)) => { on ? this.classList.add(c) : this.classList.remove(c); return on; },
      contains: (c) => this.#classes().includes(c),
    };
  }
  #classes() { return this.className.split(/\s+/).filter(Boolean); }
  get textContent() { return this.ownText + this.children.map((c) => c.textContent).join(''); }
  get childNodes() { return this.children; }
  set textContent(v) { this.children = []; this.ownText = String(v); }
  append(...n) { for (const c of n) { const x = typeof c === 'string' ? text(c) : c; x.parent = this; this.children.push(x); } }
  prepend(...n) { this.children.unshift(...n.map((c) => { const x = typeof c === 'string' ? text(c) : c; x.parent = this; return x; })); }
  replaceWith(n) { const i = this.parent.children.indexOf(this); this.parent.children[i] = n; n.parent = this.parent; }
  replaceChildren(...n) { this.children = []; this.ownText = ''; this.append(...n); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  dispatch(type) { for (const fn of this.listeners[type] ?? []) fn({ type, target: this, preventDefault() {}, stopPropagation() {}, key: '' }); }
  matches(sel) {
    if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
    if (sel.startsWith('#')) return this.id === sel.slice(1);
    const data = /^\[data-([a-z-]+)(?:="([^"]*)")?\]$/.exec(sel);
    if (data) return data[2] === undefined ? data[1] in this.dataset : this.dataset[data[1]] === data[2];
    return this.tag === sel;
  }
  *all() { for (const c of this.children) { yield c; yield* c.all(); } }
  querySelectorAll(sel) {
    const [first, ...rest] = sel.split(' ');
    const found = [...this.all()].filter((n) => n.matches(first));
    return rest.length ? found.flatMap((n) => n.querySelectorAll(rest.join(' '))) : found;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  closest() { return null; }
  click() { this.dispatch('click'); }
  focus() {}
}
const text = (s) => Object.assign(new Node('#text'), { ownText: String(s) });

/** index.html's elements that carry an id or a data-tab/data-view, as a flat tree under body. */
function documentFrom(html) {
  const body = new Node('body');
  const byId = new Map();
  for (const [, tag, attrs] of html.matchAll(/<([a-z]+)\s([^>]*?(?:id|data-tab|data-view)="[^"]*"[^>]*)>/g)) {
    const n = new Node(tag);
    for (const [, k, v] of attrs.matchAll(/([a-z-]+)="([^"]*)"/g)) {
      if (k === 'class') n.className = v; else if (k.startsWith('data-')) n.dataset[k.slice(5)] = v; else n.setAttribute(k, v);
    }
    if (n.dataset.tab) { const label = new Node('span'); label.className = 'label'; n.append(label); }
    (n.dataset.tab ? byId.get('tabs') : body).append(n);
    if (n.id) byId.set(n.id, n);
  }
  return {
    body, documentElement: Object.assign(new Node('html'), { scrollHeight: 0 }), activeElement: null, hidden: false, title: '', listeners: {},
    getElementById: (id) => byId.get(id) ?? null,
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    querySelector: (sel) => body.querySelector(sel),
    createElement: (tag) => new Node(tag),
    createElementNS: (_, tag) => new Node(tag),
    createTextNode: text,
    addEventListener() {},
  };
}

test('the page renders every tab from the example data, and no view throws', async () => {
  const errors = [];
  const doc = documentFrom(fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8'));
  const memory = new Map();
  Object.assign(globalThis, {
    document: doc,
    window: { addEventListener() {}, scrollTo() {}, scrollY: 0, innerHeight: 800, open() {} },
    location: { search: '?mock', hash: '', pathname: '/', reload() {} },
    localStorage: { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)) },
  });
  const consoleError = console.error;
  console.error = (e) => errors.push(e);
  try {
    await import('./public/app.js');
    const tabs = doc.querySelectorAll('#tabs [data-tab]');
    assert.deepEqual(tabs.map((b) => b.dataset.tab), ['sessions', 'quota', 'usage', 'code', 'events', 'config']);
    for (const b of tabs) {
      b.dispatch('click');
      // Open every foldable row of the tab once, so detail views render too: a row whose tap goes
      // elsewhere (a repo, to its sessions) opens from its chevron button.
      for (const row of doc.querySelectorAll('.qrow')) {
        const chev = row.querySelectorAll('button').find((x) => x.classList.contains('chev'));
        (chev ?? row).dispatch('click');
      }
    }
    tabs.find((b) => b.dataset.tab === 'code').dispatch('click');
    assert.deepEqual(errors, [], 'a view threw while rendering');
    assert.ok(doc.getElementById('code-view').querySelectorAll('.qrow').length > 0, 'the Code tab lists repositories');
    assert.ok(doc.getElementById('code-view').querySelectorAll('.code-item').length > 0, 'an open repo lists its PRs and branches');
    tabs[0].dispatch('click');
    assert.deepEqual(errors, [], 'a view threw while rendering');
    assert.ok(doc.getElementById('hosts').querySelectorAll('.chat').length > 0, 'the Sessions tab lists sessions');
    // A repo's own tap goes to the Sessions tab, narrowed to its project.
    tabs.find((b) => b.dataset.tab === 'code').dispatch('click');
    const repo = doc.getElementById('code-view').querySelectorAll('.qrow').find((r) => r.textContent.includes('example/backend-api'));
    repo.dispatch('click');
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true', 'the repo went to Sessions');
    const shown = doc.getElementById('hosts').querySelectorAll('.chat');
    const text = doc.getElementById('hosts').textContent;
    assert.ok(shown.length > 0 && text.includes('OAuth token refresh') && !text.includes('Landing page redesign'), 'only that project\'s sessions');
    tabs[0].dispatch('click');
    assert.ok(doc.getElementById('quota-view').querySelectorAll('.qrow').length > 0, 'the Quota tab lists accounts');
    // Opening a row redraws that row alone: every other row of the view is the same node as before.
    tabs.find((b) => b.dataset.tab === 'quota').dispatch('click');
    const before = doc.getElementById('quota-view').querySelectorAll('.qrow');
    before[0].dispatch('click');
    const after = doc.getElementById('quota-view').querySelectorAll('.qrow');
    assert.notEqual(after[0], before[0], 'the tapped row was redrawn');
    assert.ok(after.slice(1).every((x, i) => x === before[i + 1]), 'no other row was rebuilt');
    // An API balance is an account like any other: a row in the card of the host that reads it.
    const balance = doc.getElementById('quota-view').querySelectorAll('.deepseek');
    assert.equal(balance.length, 1);
    assert.equal(balance[0].textContent, 'DeepSeek');
  } finally {
    console.error = consoleError;
  }
});
