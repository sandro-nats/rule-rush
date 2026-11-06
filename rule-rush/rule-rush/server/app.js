'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Core = require('../core.js');
const { openDb, getMeta, setMeta } = require('./db.js');
const Auth = require('./auth.js');

const TIERS = Object.keys(Core.CONFIG.TIERS);
const DAY_MS = 24 * 3600 * 1000;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/core.js': ['core.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/main.js': ['main.js', 'text/javascript; charset=utf-8'],
};

/* ---------------- date helpers (everything is UTC) ---------------- */
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const nextMidnight = (ms) => Math.floor(ms / DAY_MS) * DAY_MS + DAY_MS;
const validDay = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && dayKey(Date.parse(s + 'T00:00:00Z')) === s;
const addDays = (s, n) => dayKey(Date.parse(s + 'T00:00:00Z') + n * DAY_MS);
const isMonday = (s) => new Date(s + 'T00:00:00Z').getUTCDay() === 1;
function weekStart(s) {
  const dow = (new Date(s + 'T00:00:00Z').getUTCDay() + 6) % 7; // Monday = 0
  return addDays(s, -dow);
}
function rangeFor(period, key) {
  if (period === 'day') return [key, key];
  if (period === 'week') return [key, addDays(key, 6)];
  return ['0000-01-01', '9999-12-31'];
}

/* ---------------- tiny helpers ---------------- */
class HttpError extends Error {
  constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra; }
}
const fail = (status, code, extra) => { throw new HttpError(status, code, extra); };

function displayName(u) {
  const base = (u.first_name || '').trim();
  const initial = (u.last_name || '').trim().slice(0, 1);
  return (base ? base + (initial ? ' ' + initial + '.' : '') : u.username || 'Player').slice(0, 40);
}

function createApp(options) {
  const cfg = Object.assign({
    dbPath: ':memory:',
    botToken: '',
    botUsername: '',
    adminToken: '',
    devAuth: false,
    cookieSecure: false,
    trustProxy: false,
    // Public hostname(s) the app is served on (comma-separated). Used for CSRF
    // Origin checks when behind a reverse proxy that rewrites Host.
    // Example: "rulerush.example.com" or "app.example.com,www.example.com"
    publicHost: '',
    dailyTrials: 1,
    seedSecret: '',
    maxAuthAgeSec: 24 * 3600,
    maxRunWindowMs: 90 * 1000,   // countdown (3 s) + run (45 s) + network/slow-device grace
    now: () => Date.now(),
    rootDir: path.join(__dirname, '..'),
    log: () => {},
  }, options || {});

  const db = openDb(cfg.dbPath);
  let seedSecret = cfg.seedSecret || getMeta(db, 'seed_secret');
  if (!seedSecret) {
    // Persisted so that today's daily seed survives restarts (otherwise players would see different "daily" runs).
    seedSecret = crypto.randomBytes(32).toString('hex');
    setMeta(db, 'seed_secret', seedSecret);
  }
  const dailySeed = (day, tier) => Auth.hmac(seedSecret, 'daily|' + day + '|' + tier).toString('hex').slice(0, 20);

  /* ---------------- rate limiting (in memory; per process) ---------------- */
  const hits = new Map();
  function rateLimit(key, max, windowMs) {
    const t = cfg.now();
    const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (arr.length >= max) { hits.set(key, arr); fail(429, 'rate_limited'); }
    arr.push(t);
    hits.set(key, arr);
    if (hits.size > 5000) for (const [k, v] of hits) if (!v.length || t - v[v.length - 1] > 3600000) hits.delete(k);
  }
  const clientIp = (req) => {
    if (cfg.trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    return req.socket.remoteAddress || '?';
  };

  // Host the client thinks it is talking to. Prefer X-Forwarded-Host when
  // TRUST_PROXY=1 so Origin CSRF checks still work behind nginx/Caddy/Cloudflare.
  const requestHost = (req) => {
    if (cfg.trustProxy && req.headers['x-forwarded-host']) {
      return String(req.headers['x-forwarded-host']).split(',')[0].trim().toLowerCase();
    }
    return String(req.headers.host || '').toLowerCase();
  };

  // Allowed hosts for Origin checks: request Host + optional PUBLIC_HOST list.
  const allowedHosts = (req) => {
    const set = new Set();
    const h = requestHost(req);
    if (h) set.add(h);
    if (cfg.publicHost) {
      for (const part of String(cfg.publicHost).split(',')) {
        const p = part.trim().toLowerCase();
        if (p) set.add(p);
      }
    }
    return set;
  };

  const originAllowed = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser clients / same-origin navigations
    let host = '';
    try { host = new URL(origin).host.toLowerCase(); } catch (e) { return false; }
    return allowedHosts(req).has(host);
  };

  /* ---------------- domain logic ---------------- */
  const publicUser = (u) => ({ name: displayName(u), photo: u.photo_url || '', username: u.username || '' });
  const meUser = (u) => Object.assign({}, publicUser(u), {
    phone: u.phone || '',
    hasPhone: Boolean(u.phone),
    language: u.language || '',
  });

  function trialsFor(userId, day) {
    const rows = db.prepare('SELECT tier, COUNT(*) AS n FROM runs WHERE user_id = ? AND day = ? GROUP BY tier').all(userId, day);
    const out = {};
    for (const t of TIERS) {
      const used = (rows.find((r) => r.tier === t) || { n: 0 }).n;
      out[t] = { used, left: Math.max(0, cfg.dailyTrials - used), total: cfg.dailyTrials };
    }
    return out;
  }

  function leaderboard(tier, from, to, limit) {
    return db.prepare(
      `SELECT u.id AS user_id, u.first_name, u.last_name, u.username, u.photo_url, b.score, b.run_id
         FROM (
           SELECT user_id, score, id AS run_id,
                  ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY score DESC, id ASC) AS rn
             FROM runs
            WHERE tier = ? AND day BETWEEN ? AND ? AND status = 'verified' AND score > 0 AND review_status IN ('none', 'approved')
         ) b JOIN users u ON u.id = b.user_id
        WHERE b.rn = 1 AND u.banned = 0
        ORDER BY b.score DESC, b.run_id ASC
        LIMIT ?`
    ).all(tier, from, to, limit);
  }

  function scopeRange(scope, today) {
    if (scope === 'day') return [today, today];
    if (scope === 'week') { const s = weekStart(today); return [s, addDays(s, 6)]; }
    return rangeFor('all');
  }

  function rankOf(userId, tier, from, to) {
    const rows = leaderboard(tier, from, to, 100000);
    const i = rows.findIndex((r) => r.user_id === userId);
    return i < 0 ? null : { rank: i + 1, score: rows[i].score, of: rows.length };
  }

  function issueSession(user, source) {
    // Mint a fresh long-lived token; prune previous sessions for this user+source.
    const token = Auth.createOrReuseSession
      ? Auth.createOrReuseSession(db, user.id, source, cfg.now())
      : Auth.createSession(db, user.id, source, cfg.now());
    const cookie = Auth.sessionCookieHeader(token, {
      secure: cfg.cookieSecure,
      maxAgeSec: Math.floor(Auth.SESSION_TTL_MS / 1000),
    });
    return { token, cookie };
  }

  function handleLogin(result, source) {
    if (!result.ok) fail(result.error === 'login_not_configured' ? 503 : 401, result.error);
    const user = Auth.upsertUser(db, result.user, cfg.now());
    if (user.banned) fail(403, 'banned');
    const { token, cookie } = issueSession(user, source);
    return { user, token, cookie };
  }

  /* ---------------- routes ---------------- */
  const routes = [];
  const route = (method, pattern, mode, fn) => routes.push({ method, re: new RegExp('^' + pattern + '$'), mode, fn });

  route('GET', '/api/config', null, () => ({
    json: {
      botUsername: cfg.botUsername,
      loginEnabled: Boolean(cfg.botToken && cfg.botUsername),
      devAuth: cfg.devAuth,
      tiers: Core.CONFIG.TIERS,
      dailyTrials: cfg.dailyTrials,
    },
  }));

  // Browser: Telegram Login Widget in redirect mode (data-auth-url). Telegram sends the browser here with the signed fields in the query.
  route('GET', '/auth/telegram/callback', null, (ctx) => {
    const data = Object.fromEntries(ctx.url.searchParams.entries());
    try {
      rateLimit('login:' + ctx.ip, 20, 60000);
      const { cookie } = handleLogin(Auth.verifyLoginWidget(data, cfg.botToken, Math.floor(cfg.now() / 1000), cfg.maxAuthAgeSec), 'widget');
      // Top-level redirect: cookie is first-party and sticks reliably.
      return { status: 302, headers: { Location: '/', 'Set-Cookie': cookie } };
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return { status: 302, headers: { Location: '/?login=failed' } };
    }
  });

  // Same check, JSON flavour (widget in callback mode, tests, custom clients).
  // Returns `session` so clients can keep a Bearer token when cookies are blocked.
  route('POST', '/api/auth/telegram', null, (ctx) => {
    rateLimit('login:' + ctx.ip, 20, 60000);
    const { user, token, cookie } = handleLogin(Auth.verifyLoginWidget(ctx.body, cfg.botToken, Math.floor(cfg.now() / 1000), cfg.maxAuthAgeSec), 'widget');
    return { json: { ok: true, user: publicUser(user), session: token }, headers: { 'Set-Cookie': cookie } };
  });

  // Mini App: inside Telegram the client sends window.Telegram.WebApp.initData.
  // Critical path for production. Always return `session` for Bearer fallback.
  route('POST', '/api/auth/webapp', null, (ctx) => {
    rateLimit('login:' + ctx.ip, 20, 60000);
    const initData = typeof ctx.body.initData === 'string' ? ctx.body.initData
      : (typeof ctx.body.init_data === 'string' ? ctx.body.init_data : null);
    const { user, token, cookie } = handleLogin(Auth.verifyWebAppInitData(initData, cfg.botToken, Math.floor(cfg.now() / 1000), cfg.maxAuthAgeSec), 'webapp');
    return { json: { ok: true, user: publicUser(user), session: token }, headers: { 'Set-Cookie': cookie } };
  });

  // Local development only (DEV_AUTH=1). Creates users with NEGATIVE ids that can never collide with real Telegram ids.
  route('POST', '/api/auth/dev', null, (ctx) => {
    if (!cfg.devAuth) fail(404, 'not_found');
    const n = Number(ctx.body.id);
    if (!Number.isSafeInteger(n) || n <= 0 || n > 1e9) fail(400, 'bad_id');
    const name = typeof ctx.body.name === 'string' && ctx.body.name.trim() ? ctx.body.name.trim().slice(0, 40) : 'Dev ' + n;
    const { user, token, cookie } = handleLogin({ ok: true, user: { tg_id: -n, first_name: name, last_name: '', username: '', photo_url: '', language: '' } }, 'dev');
    return { json: { ok: true, user: publicUser(user), session: token }, headers: { 'Set-Cookie': cookie } };
  });

  route('POST', '/api/auth/logout', null, (ctx) => {
    Auth.destroySession(db, ctx.token);
    return {
      json: { ok: true },
      headers: { 'Set-Cookie': Auth.clearSessionCookieHeader({ secure: cfg.cookieSecure }) },
    };
  });

  route('GET', '/api/me', 'user', (ctx) => {
    const now = cfg.now();
    const day = dayKey(now);
    const best = {};
    for (const t of TIERS) {
      const q = db.prepare(
        `SELECT MAX(CASE WHEN day = ? THEN score END) AS today, MAX(score) AS alltime FROM runs
          WHERE user_id = ? AND tier = ? AND status = 'verified' AND review_status IN ('none','approved')`
      ).get(day, ctx.user.id, t);
      best[t] = { today: q.today || 0, alltime: q.alltime || 0 };
    }
    const awards = db.prepare(
      `SELECT a.id, a.period_key, a.rank, a.status, p.tier, p.period, p.title, s.name AS sponsor
         FROM awards a JOIN prizes p ON p.id = a.prize_id JOIN sponsors s ON s.id = p.sponsor_id
        WHERE a.user_id = ? AND a.status != 'rejected' ORDER BY a.id DESC LIMIT 20`
    ).all(ctx.user.id);
    return { json: { user: meUser(ctx.user), trials: trialsFor(ctx.user.id, day), resetsAt: nextMidnight(now), best, awards } };
  });

  // Optional: attach phone after WebApp.requestContact (or any verified client that already has a session).
  route('POST', '/api/me/phone', 'user', (ctx) => {
    const phone = Auth.cleanPhone(String(ctx.body.phone || ctx.body.phone_number || ''));
    if (!phone) fail(400, 'bad_phone');
    const user = Auth.setUserPhone(db, ctx.user.id, phone, cfg.now());
    return { json: { ok: true, user: meUser(user) } };
  });

  route('POST', '/api/run/start', 'user', (ctx) => {
    const tier = ctx.body.tier;
    if (!TIERS.includes(tier)) fail(400, 'bad_tier');
    rateLimit('start:' + ctx.user.id, 12, 60000);
    const now = cfg.now();
    const day = dayKey(now);
    const used = db.prepare('SELECT COUNT(*) AS n FROM runs WHERE user_id = ? AND day = ? AND tier = ?').get(ctx.user.id, day, tier).n;
    if (used >= cfg.dailyTrials) fail(409, 'no_trials_left', { resetsAt: nextMidnight(now) });
    const seed = dailySeed(day, tier);
    let id;
    try {
      id = db.prepare('INSERT INTO runs (user_id, tier, day, attempt_no, seed, started_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(ctx.user.id, tier, day, used + 1, seed, now).lastInsertRowid;
    } catch (e) {
      fail(409, 'no_trials_left', { resetsAt: nextMidnight(now) }); // UNIQUE(user, day, tier, attempt_no) lost a race
    }
    return { json: { runId: Number(id), seed, tier, day, trialsLeft: Math.max(0, cfg.dailyTrials - used - 1) } };
  });

  route('POST', '/api/run/submit', 'user', (ctx) => {
    const runId = Number(ctx.body.runId);
    if (!Number.isSafeInteger(runId)) fail(400, 'bad_run');
    rateLimit('submit:' + ctx.user.id, 20, 60000);
    const run = db.prepare('SELECT * FROM runs WHERE id = ? AND user_id = ?').get(runId, ctx.user.id);
    if (!run) fail(404, 'run_not_found');
    if (run.status !== 'started') fail(409, 'already_submitted');

    const now = cfg.now();
    const elapsed = now - run.started_at;
    const close = (status, score, stats, flags, review) => {
      const r = db.prepare(
        `UPDATE runs SET status = ?, score = ?, submitted_at = ?, stats_json = ?, flags_json = ?, inputs_json = ?, review_status = ?
          WHERE id = ? AND status = 'started'`
      ).run(status, score, now, stats ? JSON.stringify(stats) : null, JSON.stringify(flags || []),
        Array.isArray(ctx.body.inputs) ? JSON.stringify(ctx.body.inputs).slice(0, 200000) : null, review, run.id);
      if (r.changes !== 1) fail(409, 'already_submitted');
    };

    if (elapsed > cfg.maxRunWindowMs) {
      close('expired', 0, null, [{ code: 'window_expired', severity: 'reject', detail: elapsed }], 'none');
      fail(410, 'run_expired');
    }

    const claimed = Number.isInteger(ctx.body.claimedScore) ? ctx.body.claimedScore : undefined;
    const result = Core.verifyRun(run.seed, ctx.body.inputs, { tier: run.tier, wallClockMs: elapsed, claimedScore: claimed });
    if (!result.ok) {
      close('rejected', 0, result.stats, result.flags, 'none');
      fail(422, 'run_rejected'); // reasons stay server-side so cheaters cannot tune against them
    }
    const pending = result.flags.some((f) => f.severity === 'review');
    close('verified', result.score, result.stats, result.flags, pending ? 'pending' : 'none');

    const today = dayKey(now);
    const rank = pending ? null : rankOf(ctx.user.id, run.tier, run.day, run.day);
    return { json: { status: 'verified', score: result.score, stats: result.stats, pendingReview: pending, rank, tier: run.tier } };
  });

  route('GET', '/api/leaderboard', null, (ctx) => {
    const tier = ctx.url.searchParams.get('tier') || Core.CONFIG.DEFAULT_TIER;
    const scope = ctx.url.searchParams.get('scope') || 'day';
    if (!TIERS.includes(tier)) fail(400, 'bad_tier');
    if (!['day', 'week', 'all'].includes(scope)) fail(400, 'bad_scope');
    const now = cfg.now();
    const [from, to] = scopeRange(scope, dayKey(now));
    const rows = leaderboard(tier, from, to, 100000);
    const me = ctx.user ? rows.findIndex((r) => r.user_id === ctx.user.id) : -1;
    return {
      json: {
        tier, scope, from, to,
        total: rows.length,
        entries: rows.slice(0, 50).map((r, i) => Object.assign({ rank: i + 1, score: r.score, me: ctx.user ? r.user_id === ctx.user.id : false }, publicUser(r))),
        me: me < 0 ? null : { rank: me + 1, score: rows[me].score },
      },
    };
  });

  route('GET', '/api/prizes', null, (ctx) => {
    const tier = ctx.url.searchParams.get('tier');
    if (tier && !TIERS.includes(tier)) fail(400, 'bad_tier');
    const today = dayKey(cfg.now());
    const rows = db.prepare(
      `SELECT p.id, p.tier, p.period, p.starts_day, p.ends_day, p.rank_from, p.rank_to, p.title, p.description,
              s.name AS sponsor, s.url AS sponsor_url
         FROM prizes p JOIN sponsors s ON s.id = p.sponsor_id
        WHERE p.active = 1 AND s.active = 1 AND p.ends_day >= ? AND (? IS NULL OR p.tier = ?)
        ORDER BY p.tier, p.period, p.rank_from`
    ).all(today, tier, tier);
    return { json: { prizes: rows } };
  });

  /* ---------------- admin (Authorization: Bearer ADMIN_TOKEN) ---------------- */

  route('GET', '/admin/reviews', 'admin', () => {
    const rows = db.prepare(
      `SELECT r.id, r.tier, r.day, r.score, r.stats_json, r.flags_json, r.started_at, r.submitted_at, u.tg_id, u.username, u.first_name
         FROM runs r JOIN users u ON u.id = r.user_id WHERE r.status = 'verified' AND r.review_status = 'pending' ORDER BY r.id`
    ).all();
    return { json: { reviews: rows.map((r) => Object.assign({}, r, { stats: JSON.parse(r.stats_json), flags: JSON.parse(r.flags_json), stats_json: undefined, flags_json: undefined })) } };
  });

  route('GET', '/admin/runs/(\\d+)', 'admin', (ctx) => {
    const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(Number(ctx.params[0]));
    if (!r) fail(404, 'run_not_found');
    return { json: { run: r } }; // includes inputs_json so the run can be re-verified or replayed by hand
  });

  route('POST', '/admin/reviews', 'admin', (ctx) => {
    const runId = Number(ctx.body.runId);
    const decision = ctx.body.decision;
    if (!Number.isSafeInteger(runId) || !['approve', 'reject'].includes(decision)) fail(400, 'bad_request');
    const r = db.prepare(`UPDATE runs SET review_status = ?, review_note = ? WHERE id = ? AND review_status = 'pending'`)
      .run(decision === 'approve' ? 'approved' : 'rejected', String(ctx.body.note || '').slice(0, 500), runId);
    if (r.changes !== 1) fail(404, 'no_pending_review');
    return { json: { ok: true } };
  });

  route('POST', '/admin/users/ban', 'admin', (ctx) => {
    const tgId = Number(ctx.body.tgId);
    if (!Number.isSafeInteger(tgId)) fail(400, 'bad_request');
    const r = db.prepare('UPDATE users SET banned = ? WHERE tg_id = ?').run(ctx.body.banned === false ? 0 : 1, tgId);
    if (r.changes !== 1) fail(404, 'user_not_found');
    if (ctx.body.banned !== false) db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE tg_id = ?)').run(tgId);
    return { json: { ok: true } };
  });

  route('GET', '/admin/sponsors', 'admin', () => ({ json: { sponsors: db.prepare('SELECT * FROM sponsors ORDER BY id').all() } }));

  route('POST', '/admin/sponsors', 'admin', (ctx) => {
    const name = String(ctx.body.name || '').trim().slice(0, 80);
    const url = String(ctx.body.url || '').trim().slice(0, 200);
    if (!name) fail(400, 'bad_request');
    if (url && !/^https:\/\//i.test(url)) fail(400, 'bad_url');
    const id = db.prepare('INSERT INTO sponsors (name, url, created_at) VALUES (?, ?, ?)').run(name, url, cfg.now()).lastInsertRowid;
    return { json: { id: Number(id) } };
  });

  route('POST', '/admin/prizes', 'admin', (ctx) => {
    const b = ctx.body;
    const rankFrom = Number(b.rankFrom);
    const rankTo = Number(b.rankTo || b.rankFrom);
    const title = String(b.title || '').trim().slice(0, 120);
    if (!TIERS.includes(b.tier) || !['day', 'week'].includes(b.period)) fail(400, 'bad_request');
    if (!validDay(b.startsDay) || !validDay(b.endsDay) || b.endsDay < b.startsDay) fail(400, 'bad_days');
    if (!Number.isInteger(rankFrom) || !Number.isInteger(rankTo) || rankFrom < 1 || rankTo < rankFrom || rankTo > 100 || !title) fail(400, 'bad_request');
    const sp = db.prepare('SELECT id FROM sponsors WHERE id = ?').get(Number(b.sponsorId));
    if (!sp) fail(404, 'sponsor_not_found');
    const id = db.prepare(
      `INSERT INTO prizes (sponsor_id, tier, period, starts_day, ends_day, rank_from, rank_to, title, description, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(sp.id, b.tier, b.period, b.startsDay, b.endsDay, rankFrom, rankTo, title, String(b.description || '').slice(0, 400), cfg.now()).lastInsertRowid;
    return { json: { id: Number(id) } };
  });

  // Turns a FINISHED leaderboard period into award records (status "pending") for the winners.
  route('POST', '/admin/finalize', 'admin', (ctx) => {
    const { tier, period, key } = ctx.body;
    if (!TIERS.includes(tier) || !['day', 'week'].includes(period) || !validDay(key)) fail(400, 'bad_request');
    if (period === 'week' && !isMonday(key)) fail(400, 'week_key_must_be_monday');
    const [from, to] = rangeFor(period, key);
    if (to >= dayKey(cfg.now())) fail(409, 'period_not_finished');
    const pending = db.prepare(
      `SELECT COUNT(*) AS n FROM runs WHERE tier = ? AND day BETWEEN ? AND ? AND status = 'verified' AND review_status = 'pending'`
    ).get(tier, from, to).n;
    if (pending > 0 && !ctx.body.ignorePending) fail(409, 'pending_reviews', { count: pending });
    const rows = leaderboard(tier, from, to, 1000);
    const prizes = db.prepare(
      `SELECT p.* FROM prizes p JOIN sponsors s ON s.id = p.sponsor_id
        WHERE p.tier = ? AND p.period = ? AND p.active = 1 AND s.active = 1 AND p.starts_day <= ? AND p.ends_day >= ?`
    ).all(tier, period, key, key);
    const ins = db.prepare('INSERT OR IGNORE INTO awards (prize_id, user_id, run_id, period_key, rank, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    let created = 0;
    for (const p of prizes) {
      for (let rank = p.rank_from; rank <= Math.min(p.rank_to, rows.length); rank++) {
        const w = rows[rank - 1];
        created += Number(ins.run(p.id, w.user_id, w.run_id, key, rank, cfg.now()).changes);
      }
    }
    return { json: { created, participants: rows.length, prizes: prizes.length } };
  });

  route('GET', '/admin/awards', 'admin', (ctx) => {
    const status = ctx.url.searchParams.get('status');
    const rows = db.prepare(
      `SELECT a.id, a.period_key, a.rank, a.status, a.note, a.run_id, p.tier, p.period, p.title, s.name AS sponsor,
              u.tg_id, u.username, u.first_name, r.score
         FROM awards a JOIN prizes p ON p.id = a.prize_id JOIN sponsors s ON s.id = p.sponsor_id
         JOIN users u ON u.id = a.user_id JOIN runs r ON r.id = a.run_id
        WHERE (? IS NULL OR a.status = ?) ORDER BY a.id DESC LIMIT 500`
    ).all(status, status);
    return { json: { awards: rows } };
  });

  route('POST', '/admin/awards/(\\d+)', 'admin', (ctx) => {
    if (!['approved', 'delivered', 'rejected'].includes(ctx.body.status)) fail(400, 'bad_request');
    const r = db.prepare('UPDATE awards SET status = ?, note = ? WHERE id = ?').run(ctx.body.status, String(ctx.body.note || '').slice(0, 500), Number(ctx.params[0]));
    if (r.changes !== 1) fail(404, 'award_not_found');
    return { json: { ok: true } };
  });

  /* ---------------- HTTP plumbing ---------------- */
  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  };
  const CSP = [
    "default-src 'self'",
    "script-src 'self' https://telegram.org https://*.telegram.org",
    "frame-src https://oauth.telegram.org https://telegram.org",
    "img-src 'self' data: https: blob:",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' https://telegram.org",
    // Allow embedding inside every Telegram Web / Desktop shell
    "frame-ancestors 'self' https://web.telegram.org https://webk.telegram.org https://webz.telegram.org https://telegram.org https://*.telegram.org",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');

  function send(res, status, body, headers) {
    res.writeHead(status, Object.assign({}, securityHeaders, headers));
    res.end(body);
  }

  function readJson(req, limit) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      let tooBig = false;
      req.on('data', (c) => { size += c.length; if (size > limit) tooBig = true; else chunks.push(c); });
      req.on('end', () => {
        if (tooBig) return reject(new HttpError(413, 'too_large'));
        if (!size) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(v && typeof v === 'object' ? v : {});
        } catch (e) { reject(new HttpError(400, 'bad_json')); }
      });
      req.on('error', reject);
    });
  }

  function sendIndex(res) {
    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': CSP,
    };
    return send(res, 200, fs.readFileSync(path.join(cfg.rootDir, 'index.html')), headers);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    // Normalize trailing slash (except root) so Mini App deep-links still match.
    let p = url.pathname || '/';
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

    // CORS preflight (rare for same-origin Mini App, harmless if present)
    if (req.method === 'OPTIONS') {
      return send(res, 204, '', {
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      });
    }

    if (req.method === 'GET' && STATIC[p]) {
      const [file, type] = STATIC[p];
      const headers = { 'Content-Type': type };
      if (file === 'index.html') headers['Content-Security-Policy'] = CSP;
      // Cache static JS/CSS briefly so Mini App reloads feel snappy; HTML stays no-store via securityHeaders.
      if (file !== 'index.html') headers['Cache-Control'] = 'public, max-age=300';
      return send(res, 200, fs.readFileSync(path.join(cfg.rootDir, file)), headers);
    }

    let matched = null;
    let params = [];
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(p);
      if (m) { matched = r; params = m.slice(1); break; }
    }

    // SPA catch-all for Telegram Mini App deep-links / path rewrites.
    // Only for clean, extension-less page paths — never for files or server/data paths.
    if (!matched) {
      const isGet = req.method === 'GET' || req.method === 'HEAD';
      const blocked =
        p.startsWith('/api') ||
        p.startsWith('/admin') ||
        p.startsWith('/auth') ||
        p.startsWith('/server') ||
        p.startsWith('/data') ||
        p.startsWith('/test') ||
        p === '/package.json' ||
        p === '/package-lock.json' ||
        p === '/README.md' ||
        /\.[a-zA-Z0-9]{1,8}$/.test(p); // any path that looks like a file (*.js, *.db, …)
      if (isGet && !blocked) {
        return sendIndex(res);
      }
      return send(res, 404, JSON.stringify({ error: 'not_found' }), { 'Content-Type': 'application/json' });
    }

    try {
      rateLimit('ip:' + clientIp(req), 300, 60000);
      // Cookie OR Authorization: Bearer <session> (Mini App cookie-fallback)
      const token = Auth.extractSessionToken(req);
      const ctx = { req, res, url, params, ip: clientIp(req), body: {}, token, user: null };
      ctx.user = Auth.userForToken(db, ctx.token, cfg.now());
      if (ctx.user && ctx.user.banned) ctx.user = null;

      if (req.method === 'POST') {
        // CSRF: Origin must match this host (or PUBLIC_HOST when behind a proxy).
        if (!originAllowed(req)) fail(403, 'bad_origin');
        if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) fail(415, 'json_required');
        ctx.body = await readJson(req, 200 * 1024);
      }

      if (matched.mode === 'user' && !ctx.user) fail(401, 'not_logged_in');
      if (matched.mode === 'admin') {
        if (!cfg.adminToken) fail(404, 'not_found');
        // Admin uses its own Bearer token; do not confuse with session Bearer.
        const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
        if (!m || !Auth.constantTimeStringEqual(m[1], cfg.adminToken)) fail(401, 'admin_only');
      }

      const out = matched.fn(ctx);
      const headers = Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, out.headers);
      return send(res, out.status || 200, out.json === undefined ? '' : JSON.stringify(out.json), headers);
    } catch (e) {
      if (e instanceof HttpError) {
        return send(res, e.status, JSON.stringify(Object.assign({ error: e.code }, e.extra)), { 'Content-Type': 'application/json; charset=utf-8' });
      }
      cfg.log('internal error', e);
      return send(res, 500, JSON.stringify({ error: 'internal' }), { 'Content-Type': 'application/json; charset=utf-8' });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { cfg.log('fatal', e); try { send(res, 500, '{"error":"internal"}', { 'Content-Type': 'application/json' }); } catch (e2) { /* ignore */ } });
  });

  return {
    server,
    db,
    dailySeed,
    listen: (port, host) => new Promise((resolve) => server.listen(port, host || '0.0.0.0', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => { server.close(() => { try { db.close(); } catch (e) { /* ignore */ } resolve(); }); if (server.closeAllConnections) server.closeAllConnections(); }),
  };
}

module.exports = { createApp, dayKey, weekStart, addDays };
