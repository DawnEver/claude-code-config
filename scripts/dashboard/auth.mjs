// scripts/dashboard/auth.mjs — the two identities the gateway accepts (WebCrypto only: runs
// in the Worker and in Node tests alike).
//   Viewer: a Telegram Mini App user, opened from the dashboard bot. The raw `initData` is verified
//     by its Ed25519 `signature` (https://core.telegram.org/bots/webapps#validating-data-for-third-party-use):
//     only the dashboard bot's id and Telegram's public key are needed, never a bot token. Then
//     freshness by auth_date and the user id against the allowlist. initDataUnsafe and any
//     client-sent id are never trusted.
//   Host: a bridge daemon, by its own bearer token; the gateway holds only its SHA-256.

/** Telegram's Ed25519 key for production bots (same source). */
export const TELEGRAM_PUBLIC_KEY = 'e7bf03a2fa4602af4580703d88dda5bb59f32ed8b02a56c187fe7d34caed242d';

const enc = new TextEncoder();
const hexBytes = (hex) => Uint8Array.from(hex.match(/../g), (b) => parseInt(b, 16));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const base64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

export async function sha256(s) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
}

/** Constant-time over equal-length strings. */
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** -> {ok: true, userId} | {ok: false, status: 401|403} */
export async function verifyInitData(initData, { botId, allowedUserIds, maxAgeSeconds, now = Date.now(), publicKey = TELEGRAM_PUBLIC_KEY }) {
  const fail = { ok: false, status: 401 };
  if (typeof initData !== 'string' || !initData || initData.length > 8192) return fail;
  const params = new URLSearchParams(initData);
  const signature = params.get('signature');
  if (!/^[A-Za-z0-9_-]{80,90}$/.test(signature ?? '')) return fail;
  params.delete('hash');
  params.delete('signature');
  const check = `${botId}:WebAppData\n${[...params].map(([k, v]) => `${k}=${v}`).sort().join('\n')}`;
  let valid = false;
  try {
    const key = await crypto.subtle.importKey('raw', hexBytes(publicKey), { name: 'Ed25519' }, false, ['verify']);
    valid = await crypto.subtle.verify({ name: 'Ed25519' }, key, base64url(signature), enc.encode(check));
  } catch { return fail; }
  if (!valid) return fail;
  const age = now / 1000 - Number(params.get('auth_date'));
  if (!Number.isFinite(age) || age > maxAgeSeconds || age < -60) return fail;   // 60 s clock skew
  let userId;
  try { userId = Number(JSON.parse(params.get('user')).id); } catch { return fail; }
  if (!Number.isSafeInteger(userId)) return fail;
  return allowedUserIds.includes(userId) ? { ok: true, userId } : { ok: false, status: 403 };
}

/** Whether `header` carries the token of `hostId`, by its stored hash. */
export async function verifyHostToken(hostId, header, hostTokenHashes) {
  const token = /^Bearer (\S{16,256})$/.exec(header ?? '')?.[1];
  const want = hostTokenHashes[hostId];
  return !!(token && typeof want === 'string' && /^[a-f0-9]{64}$/.test(want) && same(await sha256(token), want));
}

export async function newHostToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return { token, hash: await sha256(token) };
}
