// scripts/fleet-gateway/auth.mjs — the two identities the gateway accepts.
//   Viewer: a Telegram Mini App user. The raw `initData` string is verified server-side
//     (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app):
//     HMAC-SHA256 with key HMAC-SHA256("WebAppData", botToken), freshness by auth_date, then
//     the user id against the allowlist. initDataUnsafe and any client-sent id are never trusted.
//   Host: a bridge daemon, by its own bearer token; the gateway stores only its SHA-256.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';

const sameHex = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** -> {ok: true, userId} | {ok: false, status: 401|403} */
export function verifyInitData(initData, { botToken, allowedUserIds, maxAgeSeconds, now = Date.now() }) {
  const fail = { ok: false, status: 401 };
  if (typeof initData !== 'string' || !initData || initData.length > 8192) return fail;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!/^[a-f0-9]{64}$/.test(hash ?? '')) return fail;
  params.delete('hash');
  const check = [...params].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  if (!sameHex(createHmac('sha256', secret).update(check).digest('hex'), hash)) return fail;
  const authDate = Number(params.get('auth_date'));
  const age = now / 1000 - authDate;
  if (!Number.isFinite(authDate) || age > maxAgeSeconds || age < -60) return fail;   // 60 s clock skew
  let userId;
  try { userId = Number(JSON.parse(params.get('user')).id); } catch { return fail; }
  if (!Number.isSafeInteger(userId)) return fail;
  return allowedUserIds.includes(userId) ? { ok: true, userId } : { ok: false, status: 403 };
}

/** The host whose token this is, by its stored hash. */
export function verifyHostToken(hostId, header, hostTokenHashes) {
  const token = /^Bearer (\S{16,256})$/.exec(header ?? '')?.[1];
  const want = hostTokenHashes[hostId];
  return !!(token && typeof want === 'string' && /^[a-f0-9]{64}$/.test(want) && sameHex(sha256(token), want));
}

export function newHostToken() {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}
