// scripts/dashboard/api.mjs — the gateway's HTTP API on Web-standard Request/Response, so the
// same code runs in the Worker's Durable Object and in Node tests.

import { SCHEMA_VERSION, isHostId, parseHostPush } from '../shared/dashboard-schema.mjs';
import { Registry } from './registry.mjs';
import { TELEGRAM_PUBLIC_KEY, verifyHostToken, verifyInitData } from './auth.mjs';

const MAX_BODY = 256 * 1024;

/**
 * DASHBOARD_CONFIG (JSON): {botId, allowedUserIds, hosts: {machine: sha256}, ttlSeconds?,
 * initDataMaxAgeSeconds?, ratePerMinute?}. Malformed = throws: a gateway that cannot
 * authenticate anyone must fail loudly, not serve 401s.
 */
export function parseDashboardConfig(raw, publicKey = TELEGRAM_PUBLIC_KEY) {
  const c = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Number.isSafeInteger(c?.botId) || c.botId <= 0) throw new Error('DASHBOARD_CONFIG.botId: the dashboard bot id required');
  const hosts = c.hosts ?? {};
  for (const [id, h] of Object.entries(hosts)) {
    if (!isHostId(id) || !/^[a-f0-9]{64}$/.test(h)) throw new Error(`DASHBOARD_CONFIG.hosts["${id}"] must map a machine name to a sha256`);
  }
  return {
    botId: c.botId,
    allowedUserIds: (c.allowedUserIds ?? []).map(Number).filter(Number.isSafeInteger),
    hosts,
    publicKey,
    ttlSeconds: c.ttlSeconds > 0 ? c.ttlSeconds : 60,
    initDataMaxAgeSeconds: c.initDataMaxAgeSeconds > 0 ? c.initDataMaxAgeSeconds : 3600,
    ratePerMinute: c.ratePerMinute > 0 ? c.ratePerMinute : 120,
  };
}

const json = (status, body) => new Response(JSON.stringify(body), { status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const error = (status, code) => json(status, { error: { code } });

export function createApi(config, { now = Date.now, log = () => {} } = {}) {
  const registry = new Registry({ hosts: Object.keys(config.hosts), ttlMs: config.ttlSeconds * 1000, now });
  const hits = new Map();   // client -> requests in the current minute
  let window = null;

  const limited = (request) => {
    // Cloudflare sets CF-Connecting-IP itself; a client cannot forge it.
    const client = request.headers.get('cf-connecting-ip') ?? 'local';
    const minute = Math.floor(now() / 60000);
    if (minute !== window) { window = minute; hits.clear(); }   // fixed window: older counts are moot
    const n = (hits.get(client) ?? 0) + 1;
    hits.set(client, n);
    return n > config.ratePerMinute;
  };

  async function route(request) {
    const url = new URL(request.url);
    if (limited(request)) return error(429, 'rate_limited');
    if (request.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: true, schemaVersion: SCHEMA_VERSION });
    const push = /^\/api\/hosts\/([^/]+)\/snapshot$/.exec(url.pathname);
    if (push && request.method === 'POST') {
      const hostId = push[1];   // a machine name needs no percent-decoding
      if (!isHostId(hostId) || !(await verifyHostToken(hostId, request.headers.get('authorization'), config.hosts))) {
        log(`host push refused: ${isHostId(hostId) ? hostId : 'invalid host id'}`);
        return error(401, 'unauthorized');
      }
      if (Number(request.headers.get('content-length')) > MAX_BODY) return error(413, 'too_large');
      const text = await request.text();
      if (text.length > MAX_BODY) return error(413, 'too_large');
      let parsed;
      try { parsed = parseHostPush(JSON.parse(text)); } catch { return error(400, 'invalid_body'); }
      if (!parsed) return error(400, 'invalid_snapshot');
      return json(200, registry.accept(hostId, parsed));
    }
    if (request.method !== 'GET') return error(404, 'not_found');
    const who = await verifyInitData(/^tma (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1],
      { botId: config.botId, allowedUserIds: config.allowedUserIds, maxAgeSeconds: config.initDataMaxAgeSeconds, now: now(), publicKey: config.publicKey });
    if (!who.ok) {
      log(`viewer refused: ${who.status === 403 ? 'user not allowlisted' : 'initData missing, invalid or expired'}`);
      return error(who.status, who.status === 403 ? 'forbidden' : 'unauthorized');
    }
    if (url.pathname === '/api/dashboard') return json(200, registry.snapshot());
    const sessions = /^\/api\/hosts\/([^/]+)\/sessions$/.exec(url.pathname);
    const host = sessions && isHostId(sessions[1]) && registry.host(sessions[1]);
    if (host) return json(200, { schemaVersion: SCHEMA_VERSION, ...host });
    return error(404, sessions ? 'unknown_host' : 'not_found');
  }

  return (request) => route(request).catch((e) => {
    log(`request failed: ${e.message}`);   // never echoed to the client
    return error(500, 'internal');
  });
}
