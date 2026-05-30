#!/usr/bin/env node
import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envSettingsPath = path.join(__dirname, '..', '..', 'claude_env_settings.json');
const REQUEST_TIMEOUT_MS = 120_000;

function loadConfig() {
  return JSON.parse(fs.readFileSync(envSettingsPath, 'utf8')).proxy || {};
}

// --- Helpers ---

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Whitelist — never forward Claude Code's internal headers to upstream.
// https://api-docs.deepseek.com/guides/anthropic_api
// DeepSeek uses x-api-key for auth (authorization is ignored).
// anthropic-beta is forwarded so prompt-caching-2024-07-31 reaches DeepSeek.
const SAFE_REQ_HEADERS = new Set([
  'content-type', 'accept', 'x-api-key', 'anthropic-beta',
]);

function safeForwardHeaders(reqHeaders, overrides = {}) {
  const out = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (v != null && SAFE_REQ_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return { ...out, ...overrides };
}

// Safe upstream response headers to forward to Claude Code
const SAFE_RES_HEADERS = new Set([
  'content-type', 'cache-control', 'x-request-id',
  'anthropic-ratelimit-requests-limit', 'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-tokens-limit', 'anthropic-ratelimit-tokens-remaining',
  'retry-after',
]);

function safeResponseHeaders(upHeaders) {
  const out = {};
  for (const [k, v] of Object.entries(upHeaders)) {
    if (SAFE_RES_HEADERS.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

function contentToString(content, ctx) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const dropped = content.filter(b => b.type !== 'text');
    if (dropped.length) console.warn(`[proxy] ${ctx}: dropping ${dropped.length} non-text block(s): ${dropped.map(b => b.type).join(', ')}`);
    return content.filter(b => b.type === 'text').map(b => b.text).join('');
  }
  return '';
}

// (cache_control is kept — DeepSeek's Anthropic-compat API supports prompt caching via cache_control)

// --- DeepSeek route: normalize request to avoid cache misses ---

function normalizeRequest(buf) {
  let data = JSON.parse(buf.toString());

  // 1. Consolidate system-role messages into top-level system field
  //    (Claude Code 2.1.154+ produces messages with role: 'system')
  const sysMessages = (data.messages || []).filter(m => m.role === 'system');
  if (sysMessages.length) {
    const extra = sysMessages.map(m => contentToString(m.content, 'deepseek/system')).join('\n\n');
    if (typeof data.system === 'string') data.system = extra + '\n\n' + data.system;
    else if (Array.isArray(data.system)) data.system = [{ type: 'text', text: extra }, ...data.system];
    else data.system = extra;
    data.messages = data.messages.filter(m => m.role !== 'system');
  }

  return Buffer.from(JSON.stringify(data));
}

async function handleDeepSeek(req, res, body, config) {
  const target = new URL(config.deepseek?.target || 'https://api.deepseek.com/anthropic');
  const upstreamPath = target.pathname.replace(/\/$/, '') + req.url.replace(/^\/deepseek/, '');

  const normalized = normalizeRequest(body);

  // Forward auth headers that DeepSeek actually uses (x-api-key, not authorization)
  const headers = safeForwardHeaders(req.headers, {
    'content-length': String(normalized.byteLength),
  });

  // Convert Authorization: Bearer <key> → x-api-key (ANTHROPIC_AUTH_TOKEN compat)
  if (!headers['x-api-key'] && req.headers['authorization']) {
    const m = req.headers['authorization'].match(/^Bearer\s+(.+)$/i);
    if (m) headers['x-api-key'] = m[1];
  }

  console.log(`[deepseek] ${req.method} ${upstreamPath}`);
  proxyPassthrough(target.hostname, target.port || 443, upstreamPath, req.method, headers, normalized, res, 'deepseek');
}

function proxyPassthrough(hostname, port, urlPath, method, headers, body, res, tag) {
  const up = https.request({
    hostname, port: parseInt(port) || 443, path: urlPath, method, headers,
    timeout: REQUEST_TIMEOUT_MS,
  }, upRes => {
    console.log(`[${tag}] upstream ${upRes.statusCode}`);
    res.writeHead(upRes.statusCode, safeResponseHeaders(upRes.headers));
    upRes.pipe(res);
  });
  up.on('timeout', () => {
    up.destroy();
    if (!res.headersSent) { res.writeHead(504); res.end(JSON.stringify({ error: { message: 'Upstream timeout' } })); }
  });
  up.on('error', err => {
    console.error(`[${tag}] error: ${err.message}`);
    if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: { message: err.message } })); }
  });
  up.write(body);
  up.end();
}

// --- Server ---

const config = loadConfig();
const port = config.port || 3082;
const IDLE_TIMEOUT_MS = (config.idle_timeout_min ?? 10) * 60 * 1000;

let lastActivity = Date.now();
let activeRequests = 0;

function touchActivity() { lastActivity = Date.now(); }

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  touchActivity();
  activeRequests++;
  res.on('finish', () => { activeRequests--; touchActivity(); });
  try {
    const body = await collectBody(req);
    if (req.url.startsWith('/deepseek')) await handleDeepSeek(req, res, body, config);
    else { res.writeHead(404); res.end('Not found'); }
  } catch (err) {
    console.error(`[proxy] ${err.message}`);
    if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: { message: err.message } })); }
  }
});

server.listen(port, () => {
  console.log(`[proxy] Listening on http://localhost:${port} (idle timeout: ${IDLE_TIMEOUT_MS / 60000}min)`);
  console.log(`[proxy]   /deepseek/* → ${config.deepseek?.target || 'https://api.deepseek.com/anthropic'}`);
});

// Idle shutdown: exit when no active requests and no activity for IDLE_TIMEOUT_MS
setInterval(() => {
  if (activeRequests > 0) return;
  if (Date.now() - lastActivity >= IDLE_TIMEOUT_MS) {
    console.log(`[proxy] Idle for ${IDLE_TIMEOUT_MS / 60000}min — shutting down`);
    server.close(() => process.exit(0));
  }
}, 60_000);
