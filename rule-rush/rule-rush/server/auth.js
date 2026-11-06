'use strict';
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length || a.length === 0 || !/^[0-9a-fA-F]+$/.test(a)) return false;
  return crypto.timingSafeEqual(Buffer.from(a.toLowerCase(), 'hex'), Buffer.from(b.toLowerCase(), 'hex'));
}

function dataCheckString(entries) {
  return entries
    .map(([k, v]) => k + '=' + v)
    .sort()
    .join('\n');
}

function freshness(authDate, nowSec, maxAgeSec) {
  const d = Number(authDate);
  if (!Number.isInteger(d) || d <= 0) return 'bad_auth_date';
  if (nowSec - d > maxAgeSec) return 'auth_expired';
  if (d - nowSec > 120) return 'auth_in_future';
  return null;
}

function cleanUser(u) {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  const id = Number(u.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
  let photo = str(u.photo_url, 300);
  // only ever store https image URLs (Telegram CDN / t.me)
  if (photo && !/^https:\/\//i.test(photo)) photo = '';
  return {
    tg_id: id,
    first_name: str(u.first_name, 64),
    last_name: str(u.last_name, 64),
    username: str(u.username, 64),
    photo_url: photo,
    language: str(u.language_code, 8),
  };
}

/**
 * Coerce a Telegram field value to the string form used in data_check_string.
 * Telegram Login Widget / initData may send numbers or (rarely) booleans.
 */
function fieldValue(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return null;
}

/**
 * Telegram Login Widget (browser login).
 * https://core.telegram.org/widgets/login#checking-authorization
 * secret = SHA256(bot_token); hash = HMAC_SHA256(secret, data_check_string)
 * `data` holds the widget fields (id, first_name, ..., auth_date, hash), as JSON body or callback query.
 */
function verifyLoginWidget(data, botToken, nowSec, maxAgeSec) {
  if (!botToken) return { ok: false, error: 'login_not_configured' };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, error: 'bad_payload' };
  const entries = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === 'hash') continue;
    const s = fieldValue(v);
    if (s === null) return { ok: false, error: 'bad_payload' };
    entries.push([k, s]);
  }
  if (typeof data.hash !== 'string' || data.hash.length !== 64) return { ok: false, error: 'bad_payload' };
  if (data.id === undefined || data.id === null || data.id === '') return { ok: false, error: 'bad_payload' };
  if (data.auth_date === undefined || data.auth_date === null || data.auth_date === '') return { ok: false, error: 'bad_payload' };
  const expected = hmac(sha256(botToken), dataCheckString(entries)).toString('hex');
  if (!safeEqualHex(data.hash, expected)) return { ok: false, error: 'bad_hash' };
  const stale = freshness(data.auth_date, nowSec, maxAgeSec);
  if (stale) return { ok: false, error: stale };
  // Login Widget puts user fields at the top level (id, first_name, …)
  const user = cleanUser(data);
  return user ? { ok: true, user } : { ok: false, error: 'bad_user' };
}

/**
 * Telegram Mini App (WebApp.initData) login.
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * secret = HMAC_SHA256(key = "WebAppData", message = bot_token)
 *
 * IMPORTANT (Bot API 8.0+): the `signature` field is an Ed25519 third-party
 * signature and MUST be excluded from data_check_string along with `hash`.
 * Including it makes authentic initData fail verification.
 */
function verifyWebAppInitData(initData, botToken, nowSec, maxAgeSec) {
  if (!botToken) return { ok: false, error: 'login_not_configured' };
  if (typeof initData !== 'string' || initData.length < 10 || initData.length > 8192) return { ok: false, error: 'bad_payload' };
  let params;
  try { params = new URLSearchParams(initData); } catch (e) { return { ok: false, error: 'bad_payload' }; }
  const hash = params.get('hash');
  if (!hash || hash.length !== 64) return { ok: false, error: 'bad_payload' };

  // Exclude BOTH hash and signature (Bot API 8.0+ third-party validation field)
  const entries = [];
  for (const [k, v] of params.entries()) {
    if (k === 'hash' || k === 'signature') continue;
    entries.push([k, v]);
  }
  if (entries.length === 0) return { ok: false, error: 'bad_payload' };

  const secret = hmac('WebAppData', botToken);
  const expected = hmac(secret, dataCheckString(entries)).toString('hex');
  if (!safeEqualHex(hash, expected)) return { ok: false, error: 'bad_hash' };

  const stale = freshness(params.get('auth_date'), nowSec, maxAgeSec);
  if (stale) return { ok: false, error: stale };

  const userRaw = params.get('user');
  if (!userRaw) return { ok: false, error: 'bad_user' };
  let raw;
  try { raw = JSON.parse(userRaw); } catch (e) { return { ok: false, error: 'bad_user' }; }
  const user = cleanUser(raw);
  return user ? { ok: true, user } : { ok: false, error: 'bad_user' };
}

/* ---------------- users & sessions ---------------- */

function upsertUser(db, u, now) {
  db.prepare(
    `INSERT INTO users (tg_id, first_name, last_name, username, photo_url, language, created_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tg_id) DO UPDATE SET
       first_name = excluded.first_name, last_name = excluded.last_name, username = excluded.username,
       photo_url = excluded.photo_url, language = excluded.language, last_login_at = excluded.last_login_at`
  ).run(u.tg_id, u.first_name, u.last_name, u.username, u.photo_url, u.language, now, now);
  return db.prepare('SELECT * FROM users WHERE tg_id = ?').get(u.tg_id);
}

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const hashToken = (t) => sha256(t).toString('hex');

function createSession(db, userId, source, now) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, source) VALUES (?, ?, ?, ?, ?)')
    .run(hashToken(token), userId, now, now + SESSION_TTL_MS, source);
  return token;
}

function userForToken(db, token, now) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const row = db.prepare(
    `SELECT u.*, s.expires_at AS s_exp FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
  ).get(hashToken(token));
  if (!row) return null;
  if (row.s_exp <= now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    return null;
  }
  return row;
}

function destroySession(db, token) {
  if (typeof token === 'string' && token.length >= 20) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    let val = part.slice(i + 1).trim();
    try { val = decodeURIComponent(val); } catch (e) { /* keep raw */ }
    out[key] = val;
  }
  return out;
}

/**
 * Extract the session token from either:
 *  1) rr_session HttpOnly cookie (preferred)
 *  2) Authorization: Bearer <token>  (fallback when third-party cookies are blocked
 *     inside Telegram Web / some Desktop Mini App shells)
 * Cookie wins if both are present.
 */
function extractSessionToken(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.rr_session) return cookies.rr_session;
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (m && m[1] && m[1].length >= 20 && m[1].length <= 100) return m[1];
  return null;
}

function constantTimeStringEqual(a, b) {
  return crypto.timingSafeEqual(sha256(String(a)), sha256(String(b)));
}

/**
 * Build Set-Cookie header for the session token.
 * - HttpOnly so JS cannot steal it
 * - SameSite=None; Secure when HTTPS (required for Telegram Web iframe Mini Apps
 *   where the document is third-party relative to web.telegram.org)
 * - SameSite=Lax when not Secure (local HTTP dev)
 * - Partitioned for CHIPS-compatible third-party storage when Secure
 */
function sessionCookieHeader(token, { secure, maxAgeSec }) {
  const parts = [
    'rr_session=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'Max-Age=' + String(maxAgeSec),
  ];
  if (secure) {
    // Mini App may run in an iframe under web.telegram.org → third-party context.
    // SameSite=Lax cookies are often dropped there; None+Secure is required.
    parts.push('SameSite=None', 'Secure');
    // CHIPS: store cookie in a partition keyed by top-level site (Telegram Web).
    // Harmless where unsupported; helps where third-party cookies are blocked.
    parts.push('Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  return parts.join('; ');
}

function clearSessionCookieHeader({ secure }) {
  const parts = ['rr_session=', 'Path=/', 'HttpOnly', 'Max-Age=0'];
  if (secure) {
    parts.push('SameSite=None', 'Secure', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  return parts.join('; ');
}

module.exports = {
  verifyLoginWidget, verifyWebAppInitData, upsertUser, createSession, userForToken, destroySession,
  parseCookies, extractSessionToken, constantTimeStringEqual, sessionCookieHeader, clearSessionCookieHeader,
  SESSION_TTL_MS, sha256, hmac,
};
