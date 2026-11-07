// scripts/dashboard/e2e.spec.mjs — the page in a real browser (Playwright Chromium): scroll keeping
// across tabs and polls, the unread badge, the read circle, task lists, search, layout and theme.
// `npm run test:e2e` (needs `npx playwright install chromium` once). Not part of `npm test`: it
// needs a browser download and takes seconds. Deterministic: a fixed clock, fixed data served from
// this process, the Telegram script stubbed; no network.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { mockDashboard } from './public/mock.mjs';
import { t } from './public/shared/i18n.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const NOW = Date.parse('2026-11-07T12:00:00Z');
const POLL_MS = 8000;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript' };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1280, height: 800 } };

// The served snapshot: the example data plus `extra` sessions, enough to scroll. A test grows it to
// make a poll's redraw taller (the case that once pulled the page back).
let extra = 40;
function snapshotData() {
  const s = mockDashboard(NOW);
  s.mock = false;
  const host = s.hosts[0];
  const base = host.sessions[0];
  for (let i = 0; i < extra; i++) {
    host.sessions.push({ ...base, id: `extra-${i}`, name: `Session ${i}`, project: `proj-${i % 4}`, posted: 10, tasks: i % 5 ? [] : base.tasks });
  }
  return s;
}

let server, origin, browser;
before(async () => {
  server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/api/dashboard') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(snapshotData())); }
    if (p.startsWith('/api/')) { res.writeHead(404); return res.end(); }
    const f = path.join(ROOT, p === '/' ? 'index.html' : p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

const DARK = { '--tg-theme-bg-color': '#17212b', '--tg-theme-text-color': '#f5f5f5', '--tg-theme-secondary-bg-color': '#232e3c', '--tg-theme-hint-color': '#708499' };

/**
 * A page signed in through a stubbed Telegram, at the fixed clock. `unread`: session ids marked
 * unread on this device; `scroll`: saved positions; `theme`: Telegram theme variables.
 */
async function open(device, { unread = [], scroll = null, theme = null } = {}) {
  extra = 40;
  const ctx = await browser.newContext(device);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('https://telegram.org/**', (r) => r.fulfill({ contentType: 'text/javascript',
    body: `window.Telegram = { WebApp: { initData: 'x', initDataUnsafe: {}, ready() {}, expand() {} } };
      ${theme ? `for (const [k, v] of Object.entries(${JSON.stringify(theme)})) document.documentElement.style.setProperty(k, v);` : ''}` }));
  await page.addInitScript(({ unread, scroll }) => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('dashboard.seen', JSON.stringify(Object.fromEntries(unread.map((id) => [id, { p: 0, w: null, m: true }]))));
    if (scroll) localStorage.setItem('dashboard.scroll', JSON.stringify(scroll));
  }, { unread, scroll });
  await page.clock.install({ time: NOW });
  await page.goto(`${origin}/`);
  await page.waitForSelector('[data-session]');
  const cdp = device.hasTouch ? await ctx.newCDPSession(page) : null;
  const h = {
    page, errors,
    y: () => page.evaluate(() => Math.round(window.scrollY)),
    max: () => page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight),
    /** Let the debounced scroll save run. */
    settle: async () => { await page.waitForTimeout(50); await page.clock.runFor(300); },
    /** One poll: the timer fires, the snapshot arrives, the page redraws. */
    poll: async () => {
      const got = page.waitForResponse('**/api/dashboard');
      await page.clock.runFor(POLL_MS);
      await got;
      await page.waitForTimeout(50);
    },
    wheel: async (dy) => { await page.mouse.move(device.viewport.width / 2, device.viewport.height / 2); await page.mouse.wheel(0, dy); await page.waitForTimeout(300); },
    /** A finger drag (real touch events: touchstart, touchmove..., touchend). */
    swipe: async (dy) => {
      const x = device.viewport.width / 2, y0 = device.viewport.height / 2 + (dy < 0 ? 200 : -200);
      const touch = (type, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
      await touch('touchStart', y0);
      for (let k = 1; k <= 10; k++) await touch('touchMove', y0 + (dy * k) / 10);
      await touch('touchEnd');
      await page.waitForTimeout(300);
    },
    /** A scroll with no wheel, touch or key event, as dragging the scrollbar makes. */
    scrollbar: async (y) => { await page.evaluate((y) => window.scrollTo(0, y), y); await page.waitForTimeout(100); },
    // A click, not a tap: after a synthetic touch drag Chromium drops the next synthetic tap's click.
    tab: (name) => page.click(`#tabs [data-tab="${name}"] .label`),
    /** Wait for a smooth scroll to come to rest. */
    still: async () => {
      let last = -1;
      await page.waitForTimeout(150);
      for (let i = 0; i < 40; i++) { const y = await h.y(); if (y === last) return y; last = y; await page.waitForTimeout(100); }
      return last;
    },
    /** How far a session row's middle is from the viewport's middle. */
    offCentre: (id) => page.evaluate((id) => { const r = document.querySelector(`[data-session="${id}"]`).getBoundingClientRect(); return Math.abs(r.top + r.height / 2 - innerHeight / 2); }, id),
    order: () => page.evaluate(() => [...document.querySelectorAll('#hosts [data-session]')].map((r) => r.dataset.session)),
    close: () => ctx.close(),
  };
  return h;
}

const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= 2, `${msg}: ${a} vs ${b}`);

for (const [name, device] of [['phone', PHONE], ['desktop', DESKTOP]]) {
  test(`${name}: switching tabs and back restores each tab's position`, async () => {
    const h = await open(device);
    assert.ok(await h.max() > 900, 'the page scrolls');
    await h.scrollbar(700); await h.settle();
    await h.tab('quota');
    await h.tab('sessions');
    near(await h.y(), 700, 'back on Sessions');
    await h.tab('code'); await h.tab('sessions');
    near(await h.y(), 700, 'again');
    assert.deepEqual(h.errors, []);
    await h.close();
  });

  test(`${name}: a scroll after a tab click is never pulled back, by a poll or anything else`, async () => {
    const h = await open(device);
    await h.scrollbar(600); await h.settle();
    await h.tab('quota'); await h.tab('sessions');
    const ways = device.hasTouch
      ? [['swipe', () => h.swipe(-300)], ['scrollbar', () => h.scrollbar(200)], ['swipe back', () => h.swipe(250)]]
      : [['wheel', () => h.wheel(400)], ['keyboard', () => h.page.keyboard.press('PageDown')], ['scrollbar', () => h.scrollbar(150)], ['wheel up', () => h.wheel(-100)]];
    for (const [how, go] of ways) {
      const was = await h.y();
      await go();
      const now = await h.still();
      assert.notEqual(now, was, `${how} moved the page`);
      await h.poll();
      near(await h.y(), now, `${how}, after a poll`);
    }
    // And the position the reader chose is the one kept for the next return.
    const kept = await h.y();
    await h.settle(); await h.tab('quota'); await h.tab('sessions');
    near(await h.y(), kept, 'kept for the next return');
    await h.close();
  });
}

test('a saved position the page cannot reach does not keep pulling: a scrollbar scroll then a taller poll stays put', async () => {
  // Saved beyond the page (it was taller: an open task list, more sessions). The restore waits for
  // content; the reader scrolls without wheel/touch/keys (the scrollbar); a poll brings more content.
  const h = await open(DESKTOP, { scroll: { sessions: 2500 } });
  assert.ok(await h.max() < 2500, `page shorter than the saved position (${await h.max()})`);
  await h.scrollbar(300);
  extra = 120;
  await h.poll();
  assert.ok(await h.max() > 2500, 'the poll made the page tall enough');
  near(await h.y(), 300, 'still where the reader scrolled');
  await h.settle();
  await h.tab('quota'); await h.tab('sessions');
  near(await h.y(), 300, 'the reader\'s position was saved, not the stale one');
  await h.close();
});

test('a poll while scrolling keeps the position (phone, touch)', async () => {
  const h = await open(PHONE);
  for (let i = 0; i < 4; i++) {
    await h.swipe(-250);
    const y = await h.still();
    await h.poll();
    near(await h.y(), y, `swipe ${i}`);
  }
  await h.close();
});

const UNREAD = ['extra-3', 'extra-21', 'extra-37'];

test('unread badge from another tab opens Sessions and centres the first unread', async () => {
  const h = await open(PHONE, { unread: UNREAD });
  assert.ok(await h.page.isVisible('#n-unread'));
  await h.tab('quota');
  await h.page.click('#n-unread');
  assert.equal(await h.page.getAttribute('#tabs [data-tab="sessions"]', 'aria-selected'), 'true');
  await h.still();
  const first = (await h.order()).find((id) => UNREAD.includes(id));
  assert.ok(await h.offCentre(first) < 4, 'centred');
  assert.ok(await h.page.$eval(`[data-session="${first}"]`, (r) => r.classList.contains('jumped')));
  // The jump is not undone by a poll nor by the saved position.
  const y = await h.y();
  await h.poll();
  near(await h.y(), y, 'after a poll');
  await h.close();
});

test('unread badge repeated taps cycle through every unread session in page order, then wrap', async () => {
  const h = await open(DESKTOP, { unread: UNREAD });
  const want = (await h.order()).filter((id) => UNREAD.includes(id));
  const got = [];
  for (let i = 0; i < want.length + 1; i++) {
    await h.page.click('#n-unread');
    await h.still();
    got.push(await h.page.evaluate(() => document.querySelector('.jumped')?.dataset.session));
    await h.page.clock.runFor(1600);   // the highlight fades
  }
  assert.deepEqual(got, [...want, want[0]]);
  // A scroll after the jump stays.
  await h.wheel(-300);
  const y = await h.still();
  await h.poll();
  near(await h.y(), y, 'wheel after a jump, then a poll');
  await h.close();
});

test('unread badge with a search active clears it and jumps', async () => {
  const h = await open(PHONE, { unread: UNREAD });
  await h.page.fill('#search', 'Session');
  assert.ok(await h.page.isVisible('#search-view'));
  await h.page.click('#n-unread');
  assert.equal(await h.page.inputValue('#search'), '');
  assert.ok(await h.page.isHidden('#search-view'));
  await h.still();
  assert.ok(await h.offCentre((await h.order()).find((id) => UNREAD.includes(id))) < 4);
  await h.close();
});

test('unread badge with filters hiding every unread session clears the filters', async () => {
  const h = await open(DESKTOP, { unread: ['extra-1'] });   // project proj-1
  await h.page.selectOption('select[aria-label="project"]', 'frontend');
  assert.deepEqual(await h.order(), ['019a7f20-2222']);
  await h.page.click('#n-unread');
  assert.equal(await h.page.inputValue('select[aria-label="project"]'), '');
  await h.still();
  assert.ok(await h.page.$eval('[data-session="extra-1"]', (r) => r.classList.contains('jumped')));
  assert.ok(await h.page.isVisible('[data-session="extra-1"]'));
  await h.close();
});

test('nothing unread: no badge, and nothing moves', async () => {
  const h = await open(PHONE);
  assert.ok(await h.page.isHidden('#n-unread'));
  await h.scrollbar(500);
  await h.page.$eval('#n-unread', (b) => b.click());
  near(await h.y(), 500, 'unmoved');
  await h.close();
});

test('read circle toggles read and unread, with the matching tooltip, and keeps the scroll', async () => {
  const h = await open(DESKTOP, { unread: ['extra-10'] });
  const badge = '[data-session="extra-10"] .badge.read';
  await h.page.$eval(badge, (b) => b.scrollIntoView({ block: 'center' }));
  const y = await h.y();
  assert.equal(await h.page.getAttribute(badge, 'title'), t('session.markRead', 'en'));
  assert.ok(await h.page.$eval(badge, (b) => b.classList.contains('on')));
  await h.page.click(badge);
  assert.equal(await h.page.getAttribute(badge, 'title'), t('session.markUnread', 'en'));
  assert.ok(await h.page.$eval(badge, (b) => b.classList.contains('off')));
  assert.ok(await h.page.isHidden('#n-unread'), 'nothing unread now');
  await h.page.click(badge);
  assert.equal(await h.page.getAttribute(badge, 'title'), t('session.markRead', 'en'));
  assert.ok(await h.page.isVisible('#n-unread'));
  near(await h.y(), y, 'scroll kept');
  assert.deepEqual(h.errors, []);
  await h.close();
});

test('task list opens and folds in place, the scroll kept', async () => {
  const h = await open(PHONE);
  const btn = '[data-session="extra-10"] .tasks-btn';
  await h.page.$eval(btn, (b) => b.scrollIntoView({ block: 'center' }));
  const y = await h.y();
  await h.page.click(btn);
  assert.equal(await h.page.getAttribute(btn, 'aria-expanded'), 'true');
  assert.equal(await h.page.getAttribute(btn, 'title'), t('session.tasksHide', 'en'));
  assert.equal(await h.page.$$eval('[data-session="extra-10"] .tasks.all .task', (x) => x.length), 5);
  near(await h.y(), y, 'opened');
  await h.poll();
  near(await h.y(), y, 'open across a poll');
  assert.equal(await h.page.getAttribute(btn, 'aria-expanded'), 'true');
  await h.page.click(btn);
  assert.equal(await h.page.getAttribute(btn, 'aria-expanded'), 'false');
  near(await h.y(), y, 'folded');
  await h.close();
});

test('search: typing lists results, no match says so, clearing brings the tab back', async () => {
  const h = await open(PHONE);
  await h.page.fill('#search', 'Session 1');
  assert.ok(await h.page.isVisible('#search-view'));
  assert.ok(await h.page.isHidden('#hosts'));
  assert.ok(await h.page.$$eval('#search-view .found', (x) => x.length) > 0);
  await h.page.fill('#search', 'zzz-no-such-thing');
  assert.equal(await h.page.textContent('#search-view .empty'), t('search.none', 'en'));
  await h.page.fill('#search', '');
  assert.ok(await h.page.isVisible('#hosts'));
  assert.deepEqual(h.errors, []);
  await h.close();
});

test('narrow phone: no horizontal overflow on any tab', async () => {
  const h = await open({ ...PHONE, viewport: { width: 320, height: 640 } }, { unread: UNREAD });
  for (const name of ['sessions', 'quota', 'code', 'config', 'sessions']) {
    await h.tab(name);
    const [sw, w] = await h.page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    assert.ok(sw <= w, `${name}: ${sw} > ${w}`);
  }
  assert.deepEqual(h.errors, []);
  await h.close();
});

test('dark theme: the Telegram theme colours apply and every tab renders', async () => {
  const h = await open(PHONE, { theme: DARK });
  const [bg, fg] = await h.page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.body).color]);
  assert.equal(bg, 'rgb(23, 33, 43)');
  assert.equal(fg, 'rgb(245, 245, 245)');
  for (const name of ['quota', 'code', 'config', 'sessions']) await h.tab(name);
  assert.deepEqual(h.errors, []);
  await h.close();
});
