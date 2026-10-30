// scripts/dashboard/api.mjs — the gateway's HTTP API on Web-standard Request/Response, so the
// same code runs in the Worker's Durable Object and in Node tests.

import { SCHEMA_VERSION, isHostId, parseConfigChange, parseHostPush } from '../shared/dashboard-schema.mjs';
import { Registry } from './registry.mjs';
import { TELEGRAM_PUBLIC_KEY, verifyHostToken, verifyInitData } from './auth.mjs';
import { parseUsageBatch } from '../shared/usage-schema.mjs';
import { FILTER_DIMS, ingest, query, report } from './usage-store.mjs';

const MAX_BODY = 256 * 1024;
const MAX_CONFIG_BODY = 4096;   // one {key, value}
export const REPORT_TTL_MS = 5 * 60000;

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
    initDataMaxAgeSeconds: c.initDataMaxAgeSeconds > 0 ? c.initDataMaxAgeSeconds : 86400,
    ratePerMinute: c.ratePerMinute > 0 ? c.ratePerMinute : 120,
  };
}

const json = (status, body) => new Response(JSON.stringify(body), { status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const error = (status, code) => json(status, { error: { code } });

/** A request body as text, or null when over `max` bytes. */
async function body(request, max) {
  if (Number(request.headers.get('content-length')) > max) return null;
  const text = await request.text();
  return text.length > max ? null : text;
}

/**
 * `store`: the Durable Object's key-value storage (events, alert state). `db`: the usage store
 * (D1, scripts/dashboard/usage-store.mjs); without it the usage routes answer 503.
 */
export function createApi(config, { now = Date.now, log = () => {}, store = null, db = null } = {}) {
  const registry = new Registry({ hosts: Object.keys(config.hosts), ttlMs: config.ttlSeconds * 1000, now, store });
  const hits = new Map();   // client -> requests in the current minute
  // The Usage tab's report per (days, tz), kept REPORT_TTL_MS: polls of an open tab cost no reads.
  const reports = new Map();
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
    // A host's own routes: its snapshot, its usage, and read-only SQL over the usage store.
    const hostRoute = /^\/api\/hosts\/([^/]+)\/(snapshot|usage|query)$/.exec(url.pathname);
    if (hostRoute && request.method === 'POST') {
      const [, hostId, what] = hostRoute;   // a machine name needs no percent-decoding
      if (!isHostId(hostId) || !(await verifyHostToken(hostId, request.headers.get('authorization'), config.hosts))) {
        log(`host ${what} refused: ${isHostId(hostId) ? hostId : 'invalid host id'}`);
        return error(401, 'unauthorized');
      }
      const text = await body(request, MAX_BODY);
      if (text === null) return error(413, 'too_large');
      let raw;
      try { raw = JSON.parse(text); } catch { return error(400, 'invalid_body'); }
      if (what === 'snapshot') {
        const parsed = parseHostPush(raw);
        if (!parsed) return error(400, 'invalid_snapshot');
        const { accepted, configChanges = [] } = registry.accept(hostId, parsed);
        return json(200, { accepted, configChanges });
      }
      if (!db) return error(503, 'no_usage_store');
      if (what === 'usage') {
        const batch = parseUsageBatch(raw);
        if (!batch) return error(400, 'invalid_usage');
        return json(200, { stored: await ingest(db, hostId, batch, now()) });
      }
      const result = await query(db, raw?.sql);
      if (result.error) log(`query by ${hostId} refused: ${result.error}`);
      return json(result.error ? 400 : 200, result);
    }
    if (request.method !== 'GET' && !(request.method === 'POST' && url.pathname === '/api/config')) return error(404, 'not_found');
    const who = await verifyInitData(/^tma (.+)$/.exec(request.headers.get('authorization') ?? '')?.[1],
      { botId: config.botId, allowedUserIds: config.allowedUserIds, maxAgeSeconds: config.initDataMaxAgeSeconds, now: now(), publicKey: config.publicKey });
    if (!who.ok) {
      log(`viewer refused: ${who.status === 403 ? 'user not allowlisted' : 'initData missing, invalid or expired'}`);
      return error(who.status, who.status === 403 ? 'forbidden' : 'unauthorized');
    }
    if (url.pathname === '/api/config') {
      // The one write: a change to a CONFIG_KEYS key, queued for a host to apply.
      const text = await body(request, MAX_CONFIG_BODY);
      if (text === null) return error(413, 'too_large');
      let change;
      try { change = parseConfigChange(JSON.parse(text)); } catch { change = null; }
      if (!change) return error(400, 'not_editable');
      log(`config change requested by ${who.userId}: ${change.key}`);
      return json(202, { id: registry.requestChange(change, who.userId) });
    }
    if (url.pathname === '/api/dashboard') return json(200, registry.snapshot());
    if (url.pathname === '/api/usage') {
      if (!db) return error(503, 'no_usage_store');
      const days = Math.min(366, Math.max(1, Number(url.searchParams.get('days')) || 30));
      const tz = Math.min(840, Math.max(-720, Number(url.searchParams.get('tz')) || 0));
      // ?project=a&project=b&model=…: up to 20 values per dimension; '' is the no-project bucket.
      const filter = Object.fromEntries(FILTER_DIMS.map((d) => [d, [...new Set(url.searchParams.getAll(d).map((v) => v.slice(0, 200)))].slice(0, 20).sort()]));
      const key = JSON.stringify([days, tz, filter]);
      const held = reports.get(key);
      if (held && now() - held.at < REPORT_TTL_MS) return json(200, held.value);
      const value = await report(db, { days, tzOffsetMin: tz, now: now(), filter });
      // One entry per range and filter: expired ones go, so the cache stays bounded.
      for (const [k, r] of reports) if (now() - r.at >= REPORT_TTL_MS) reports.delete(k);
      reports.set(key, { at: now(), value });
      return json(200, value);
    }
    return error(404, 'not_found');
  }

  return (request) => route(request).catch((e) => {
    log(`request failed: ${e.message}`);   // never echoed to the client
    return error(500, 'internal');
  });
}
