#!/usr/bin/env node
// scripts/fleet-gateway/server.mjs — the fleet gateway (docs/fleet-gateway.md): receives each
// host's pushed snapshot, serves the Telegram Mini App and its read-only API. V0.1 has no
// write path to any session. Plain HTTP on loopback by default: TLS is the job of the
// reverse proxy or tunnel in front of it (a Mini App must be served over https).
//
//   node scripts/fleet-gateway/server.mjs [--config <file>]  serve (default ~/.claude/fleet-gateway.json)
//   node scripts/fleet-gateway/server.mjs host-token <id>  mint a host token: prints the token
//                                                           (for that host) and its hash (for here)
//   node scripts/fleet-gateway/server.mjs set-menu         point this machine's bridge bot menu button at publicUrl

import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { isMain } from '../shared/is-main.mjs';
import { SCHEMA_VERSION, isHostId, parseHostPush } from '../shared/fleet-schema.mjs';
import { Registry } from './registry.mjs';
import { newHostToken, verifyHostToken, verifyInitData } from './auth.mjs';
import { readBridgeConfig } from '../bridge/context.mjs';

export const CONFIG_PATH = path.join(os.homedir(), '.claude', 'fleet-gateway.json');
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/view.mjs': ['view.mjs', 'text/javascript; charset=utf-8'] };
const MAX_BODY = 256 * 1024;
const CSP = [
  "default-src 'self'", "script-src 'self' https://telegram.org", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:", "connect-src 'self'", 'frame-ancestors https://web.telegram.org https://*.telegram.org',
].join('; ');

/**
 * Normalised gateway config. The gateway runs on a bridge workstation and reuses that
 * machine's bridge bot and allowlist (readBridgeConfig): the Mini App opens from that bot, so
 * its initData is signed with that token. This file holds only what is the gateway's own:
 * the host token hashes and the listener.
 */
export function readGatewayConfig(file = CONFIG_PATH, bridge = readBridgeConfig()) {
  const c = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!bridge.botToken) throw new Error('no bridge.botToken on this machine: run the gateway on a bridge workstation (docs/bridge.md)');
  const hosts = c.hosts ?? {};
  for (const [id, h] of Object.entries(hosts)) {
    if (!isHostId(id) || !/^[a-f0-9]{64}$/.test(h)) throw new Error(`${file}: hosts["${id}"] must map a machine name to the sha256 printed by host-token`);
  }
  return {
    botToken: bridge.botToken,
    allowedUserIds: bridge.allowedUserIds,
    hosts,
    listen: { host: c.listen?.host ?? '127.0.0.1', port: Number.isInteger(c.listen?.port) ? c.listen.port : 8787 },
    publicUrl: typeof c.publicUrl === 'string' ? c.publicUrl : null,
    ttlSeconds: c.ttlSeconds > 0 ? c.ttlSeconds : 60,
    initDataMaxAgeSeconds: c.initDataMaxAgeSeconds > 0 ? c.initDataMaxAgeSeconds : 3600,
    trustProxy: c.trustProxy === true,
    ratePerMinute: c.ratePerMinute > 0 ? c.ratePerMinute : 120,
  };
}

export function createGateway(config, { now = Date.now, log = () => {} } = {}) {
  const registry = new Registry({ hosts: Object.keys(config.hosts), ttlMs: config.ttlSeconds * 1000, now });
  const hits = new Map();   // client -> requests in the current minute
  let window = null;

  const send = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...headers });
    res.end(Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const error = (res, status, code) => send(res, status, { error: { code } });

  const limited = (req) => {
    // The right-most X-Forwarded-For entry is the one our own proxy appended; the rest is client-supplied.
    const client = (config.trustProxy && req.headers['x-forwarded-for']?.split(',').at(-1).trim()) || req.socket.remoteAddress;
    const minute = Math.floor(now() / 60000);
    if (minute !== window) { window = minute; hits.clear(); }   // fixed window: older counts are moot
    const n = (hits.get(client) ?? 0) + 1;
    hits.set(client, n);
    return n > config.ratePerMinute;
  };

  const viewer = (req) => verifyInitData(/^tma (.+)$/.exec(req.headers.authorization ?? '')?.[1],
    { botToken: config.botToken, allowedUserIds: config.allowedUserIds, maxAgeSeconds: config.initDataMaxAgeSeconds, now: now() });

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    // Past the limit, keep draining without storing so the client still gets its 413.
    req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) chunks.push(c); });
    req.on('end', () => (size > MAX_BODY ? reject(Object.assign(new Error('too large'), { status: 413 }))
      : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://gateway');
    if (limited(req)) return error(res, 429, 'rate_limited');
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, file)), { 'content-type': type, 'content-security-policy': CSP });
    }
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, schemaVersion: SCHEMA_VERSION });
    const push = /^\/api\/hosts\/([^/]+)\/snapshot$/.exec(url.pathname);
    if (push && req.method === 'POST') {
      const hostId = push[1];   // a machine name needs no percent-decoding
      if (!isHostId(hostId) || !verifyHostToken(hostId, req.headers.authorization, config.hosts)) {
        log(`host push refused: ${isHostId(hostId) ? hostId : 'invalid host id'}`);
        return error(res, 401, 'unauthorized');
      }
      let parsed;
      try { parsed = parseHostPush(JSON.parse(await readBody(req))); }
      catch (e) { return error(res, e.status ?? 400, e.status === 413 ? 'too_large' : 'invalid_body'); }
      if (!parsed) return error(res, 400, 'invalid_snapshot');
      return send(res, 200, { accepted: registry.accept(hostId, parsed) });
    }
    if (req.method !== 'GET' || !url.pathname.startsWith('/api/')) return error(res, 404, 'not_found');
    const who = viewer(req);
    if (!who.ok) {
      log(`viewer refused: ${who.status === 403 ? 'user not allowlisted' : 'initData missing, invalid or expired'}`);
      return error(res, who.status, who.status === 403 ? 'forbidden' : 'unauthorized');
    }
    if (url.pathname === '/api/fleet') return send(res, 200, registry.snapshot());
    const sessions = /^\/api\/hosts\/([^/]+)\/sessions$/.exec(url.pathname);
    const host = sessions && isHostId(sessions[1]) && registry.host(sessions[1]);
    if (host) return send(res, 200, { schemaVersion: SCHEMA_VERSION, ...host });
    return error(res, 404, sessions ? 'unknown_host' : 'not_found');
  }

  const server = http.createServer((req, res) => handle(req, res).catch((e) => {
    log(`request failed: ${e.message}`);   // never echoed to the client
    if (!res.headersSent) error(res, 500, 'internal');
  }));
  // A slow client must not hold a connection: whole request within 10 s, headers within 5 s.
  Object.assign(server, { requestTimeout: 10000, headersTimeout: 5000 });
  return { server, registry };
}

async function setMenu(config) {
  if (!config.publicUrl?.startsWith('https://')) throw new Error('publicUrl (https) required in the gateway config');
  const res = await fetch(`https://api.telegram.org/bot${config.botToken}/setChatMenuButton`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ menu_button: { type: 'web_app', text: 'Fleet', web_app: { url: config.publicUrl } } }) });
  const body = await res.json();
  if (!body.ok) throw new Error(`setChatMenuButton: ${body.description}`);
  console.log(`menu button -> ${config.publicUrl}`);
}

export async function main(args = process.argv.slice(2)) {
  const at = args.indexOf('--config');
  const file = at >= 0 ? args[at + 1] : CONFIG_PATH;
  const argv = at >= 0 ? args.filter((_, i) => i !== at && i !== at + 1) : args;
  if (argv[0] === 'host-token') {
    if (!isHostId(argv[1] ?? '')) throw new Error('usage: server.mjs host-token <hostId>  (the machine name, [A-Za-z0-9-]+)');
    const { token, hash } = newHostToken();
    console.log(`On host ${argv[1]}: ~/.claude/claude_env_settings.local.json  bridge.fleetGateway.hostToken =\n  ${token}`);
    console.log(`Here: ${file}  hosts["${argv[1]}"] =\n  ${hash}`);
    return;
  }
  const config = readGatewayConfig(file);
  if (argv[0] === 'set-menu') return setMenu(config);
  const log = (m) => console.error(`[fleet-gateway ${new Date().toISOString()}] ${m}`);
  if (!config.allowedUserIds.length) log('allowedUserIds is empty: every viewer is refused');
  const { server } = createGateway(config, { log });
  server.listen(config.listen.port, config.listen.host, () =>
    log(`listening on ${config.listen.host}:${config.listen.port}; hosts: ${Object.keys(config.hosts).join(', ') || 'none'}`));
}

if (isMain(import.meta.url)) main().catch((e) => { console.error(e.message); process.exit(1); });
