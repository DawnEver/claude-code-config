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

// Whitelist — never forward Claude Code's internal headers to upstream
const SAFE_REQ_HEADERS = new Set(['content-type', 'anthropic-version', 'anthropic-beta', 'accept']);

function safeForwardHeaders(reqHeaders, overrides = {}) {
  const out = {};
  for (const [k, v] of Object.entries(reqHeaders)) {
    if (SAFE_REQ_HEADERS.has(k.toLowerCase())) out[k] = v;
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

// --- DeepSeek route: fix system-role messages injected by Claude Code 2.1.154+ ---

function fixSystemRoles(buf) {
  const data = JSON.parse(buf.toString());
  const sysMessages = (data.messages || []).filter(m => m.role === 'system');

  if (!sysMessages.length) return buf;

  const extra = sysMessages.map(m => contentToString(m.content, 'deepseek/system')).join('\n\n');
  if (typeof data.system === 'string') data.system = extra + '\n\n' + data.system;
  else if (Array.isArray(data.system)) data.system = [{ type: 'text', text: extra }, ...data.system];
  else data.system = extra;

  data.messages = data.messages.filter(m => m.role !== 'system');
  return Buffer.from(JSON.stringify(data));
}

async function handleDeepSeek(req, res, body, config) {
  const target = new URL(config.deepseek?.target || 'https://api.deepseek.com/anthropic');
  const upstreamPath = target.pathname.replace(/\/$/, '') + req.url.replace(/^\/deepseek/, '');
  const fixed = fixSystemRoles(body);

  const headers = safeForwardHeaders(req.headers, {
    authorization: req.headers['authorization'],
    'content-length': String(fixed.byteLength),
  });

  console.log(`[deepseek] ${req.method} ${upstreamPath}`);
  proxyPassthrough(target.hostname, target.port || 443, upstreamPath, req.method, headers, fixed, res, 'deepseek');
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

http.createServer(async (req, res) => {
  if (req.url === '/health') { res.writeHead(200); res.end('ok'); return; }
  try {
    const body = await collectBody(req);
    if (req.url.startsWith('/deepseek')) await handleDeepSeek(req, res, body, config);
    else { res.writeHead(404); res.end('Not found'); }
  } catch (err) {
    console.error(`[proxy] ${err.message}`);
    if (!res.headersSent) { res.writeHead(500); res.end(JSON.stringify({ error: { message: err.message } })); }
  }
}).listen(port, () => {
  console.log(`[proxy] Listening on http://localhost:${port}`);
  console.log(`[proxy]   /deepseek/* → ${config.deepseek?.target || 'https://api.deepseek.com/anthropic'}`);
});
