'use strict';
// Run with: node test/server.test.js   (spins up the real HTTP server on a random port with an in-memory DB)
const assert = require('assert');
const Core = require('../core.js');
const { createApp, dayKey } = require('../server/app.js');
const { botRun, signWidget, signInitData } = require('./helpers.js');

const BOT_TOKEN = '123456:TEST-bot-token';
const ADMIN = 'admin-secret-for-tests';
const DAY = 24 * 3600 * 1000;

let passed = 0;
const failures = [];

async function main() {
  const clock = { t: Date.UTC(2026, 10, 5, 12, 0, 0) }; // Thu 2026-11-05 12:00 UTC (a Thursday)
  const app = createApp({
    dbPath: ':memory:', botToken: BOT_TOKEN, botUsername: 'RuleRushBot', adminToken: ADMIN,
    now: () => clock.t, dailyTrials: 1,
  });
  const port = await app.listen(0);
  const base = 'http://127.0.0.1:' + port;

  async function call(method, path, o) {
    o = o || {};
    const headers = {};
    if (o.cookie) headers.Cookie = o.cookie;
    if (o.admin) headers.Authorization = 'Bearer ' + (o.adminToken || ADMIN);
    let body;
    if (method === 'POST') { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.body || {}); }
    const r = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    let json = null;
    try { json = await r.json(); } catch (e) { /* not json */ }
    return { status: r.status, json, headers: r.headers };
  }

  let nextId = 1000;
  /** Log in through the real Login Widget signature check and return the session cookie. */
  async function login(name) {
    const id = nextId++;
    const payload = signWidget({ id, first_name: name, last_name: 'Tester', username: name.toLowerCase(), auth_date: Math.floor(clock.t / 1000) }, BOT_TOKEN);
    const r = await call('POST', '/api/auth/telegram', { body: payload });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const cookie = r.headers.get('set-cookie').split(';')[0];
    return { cookie, id, name };
  }

  /** Start an official run, play it with a scripted player, advance the clock like a real run would, submit. */
  async function play(user, tier, bot, opts) {
    opts = opts || {};
    const s = await call('POST', '/api/run/start', { cookie: user.cookie, body: { tier } });
    if (s.status !== 200) return { start: s };
    const inputs = opts.inputs || botRun(s.json.seed, Object.assign({ tier, id: user.name }, bot));
    clock.t += opts.waitMs === undefined ? 50000 : opts.waitMs;
    const r = await call('POST', '/api/run/submit', { cookie: user.cookie, body: { runId: s.json.runId, inputs, claimedScore: opts.claimedScore } });
    return { start: s, submit: r, inputs, seed: s.json.seed, runId: s.json.runId };
  }

  async function test(name, fn) {
    try { await fn(); passed++; console.log('  ok    ' + name); } catch (e) {
      process.exitCode = 1; failures.push(name);
      console.error('  FAIL  ' + name + '\n' + ((e && e.stack) || e));
    }
  }

  console.log('Rule Rush server tests');

  /* ---------- authentication ---------- */

  await test('Telegram Login Widget: valid signature logs in and sets an HttpOnly cookie', async () => {
    const payload = signWidget({ id: 42, first_name: 'Nino', last_name: 'Beridze', username: 'nino', photo_url: 'https://t.me/i/userpic/320/x.jpg', auth_date: Math.floor(clock.t / 1000) }, BOT_TOKEN);
    const r = await call('POST', '/api/auth/telegram', { body: payload });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.user.name, 'Nino B.');
    assert.ok(typeof r.json.session === 'string' && r.json.session.length >= 20);
    const sc = r.headers.get('set-cookie');
    assert.ok(/HttpOnly/i.test(sc) && /SameSite=Lax/i.test(sc), sc); // non-Secure => Lax (local/dev)
    const me = await call('GET', '/api/me', { cookie: sc.split(';')[0] });
    assert.strictEqual(me.status, 200);
    assert.strictEqual(me.json.user.username, 'nino');
  });

  await test('COOKIE_SECURE=1 issues SameSite=None; Secure; Partitioned for Mini App iframes', async () => {
    const secureApp = createApp({
      dbPath: ':memory:', botToken: BOT_TOKEN, botUsername: 'RuleRushBot', adminToken: ADMIN,
      cookieSecure: true, now: () => clock.t,
    });
    const p = await secureApp.listen(0);
    const payload = signWidget({ id: 4242, first_name: 'Secure', auth_date: Math.floor(clock.t / 1000) }, BOT_TOKEN);
    const r = await fetch('http://127.0.0.1:' + p + '/api/auth/telegram', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.strictEqual(r.status, 200);
    const sc = r.headers.get('set-cookie');
    assert.ok(/SameSite=None/i.test(sc) && /Secure/i.test(sc) && /Partitioned/i.test(sc) && /HttpOnly/i.test(sc), sc);
    await secureApp.close();
  });

  await test('login is rejected for a forged hash, tampered fields, another bot token, stale or missing data', async () => {
    const fields = { id: 43, first_name: 'Eve', auth_date: Math.floor(clock.t / 1000) };
    const good = signWidget(fields, BOT_TOKEN);

    let r = await call('POST', '/api/auth/telegram', { body: Object.assign({}, good, { hash: '0'.repeat(64) }) });
    assert.strictEqual(r.status, 401); assert.strictEqual(r.json.error, 'bad_hash');

    r = await call('POST', '/api/auth/telegram', { body: Object.assign({}, good, { id: 44 }) }); // swap the id, keep the hash
    assert.strictEqual(r.json.error, 'bad_hash');

    r = await call('POST', '/api/auth/telegram', { body: signWidget(fields, 'other-bots-token') });
    assert.strictEqual(r.json.error, 'bad_hash');

    r = await call('POST', '/api/auth/telegram', { body: signWidget({ id: 45, first_name: 'Old', auth_date: Math.floor(clock.t / 1000) - 2 * 24 * 3600 }, BOT_TOKEN) });
    assert.strictEqual(r.json.error, 'auth_expired');

    r = await call('POST', '/api/auth/telegram', { body: signWidget({ id: 46, first_name: 'Future', auth_date: Math.floor(clock.t / 1000) + 3600 }, BOT_TOKEN) });
    assert.strictEqual(r.json.error, 'auth_in_future');

    r = await call('POST', '/api/auth/telegram', { body: { id: 47 } });
    assert.strictEqual(r.status, 401);
    r = await call('POST', '/api/auth/telegram', { body: { id: { a: 1 }, auth_date: 1, hash: 'ab' } });
    assert.strictEqual(r.json.error, 'bad_payload');
  });

  await test('redirect-mode widget callback (GET) logs in, and failures redirect without a cookie', async () => {
    const q = new URLSearchParams(signWidget({ id: 50, first_name: 'Gela', auth_date: Math.floor(clock.t / 1000) }, BOT_TOKEN)).toString();
    let r = await call('GET', '/auth/telegram/callback?' + q);
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get('location'), '/');
    assert.ok(r.headers.get('set-cookie'));
    r = await call('GET', '/auth/telegram/callback?id=50&first_name=Gela&auth_date=1&hash=' + '1'.repeat(64));
    assert.strictEqual(r.headers.get('location'), '/?login=failed');
    assert.strictEqual(r.headers.get('set-cookie'), null);
  });

  await test('Mini App initData login validates the Telegram signature', async () => {
    const user = JSON.stringify({ id: 777, first_name: 'Mari', username: 'mari', language_code: 'ka' });
    const initData = signInitData({ auth_date: Math.floor(clock.t / 1000), query_id: 'AAH', user }, BOT_TOKEN);
    let r = await call('POST', '/api/auth/webapp', { body: { initData } });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.user.name, 'Mari');
    assert.ok(typeof r.json.session === 'string' && r.json.session.length >= 20, 'session token must be returned');
    r = await call('POST', '/api/auth/webapp', { body: { initData: initData.replace('Mari', 'Hax') } });
    assert.strictEqual(r.status, 401);
    r = await call('POST', '/api/auth/webapp', { body: { initData: signInitData({ auth_date: Math.floor(clock.t / 1000), user }, 'wrong-token') } });
    assert.strictEqual(r.json.error, 'bad_hash');
  });

  await test('Mini App initData with Bot API 8.0 signature field still validates (signature excluded from check string)', async () => {
    // Real Telegram clients (Bot API 8.0+) append an Ed25519 `signature` field.
    // Hash is computed WITHOUT signature. Including it in data_check_string must not happen.
    const user = JSON.stringify({ id: 778, first_name: 'Luka', username: 'luka' });
    const base = signInitData({ auth_date: Math.floor(clock.t / 1000), query_id: 'AAH2', user }, BOT_TOKEN);
    // Append a fake signature field the way Telegram would (not part of the bot-token hash)
    const withSig = base + '&signature=TYJxVcisqbWjtodPepiJ6ghziUL94-KNpG8Pau-X7oNNLNBM72APCpi_RKiUlBvcqo5L-LAxIc3dnTzcZX_PDg';
    const r = await call('POST', '/api/auth/webapp', { body: { initData: withSig } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.user.name, 'Luka');
  });

  await test('session works via Authorization Bearer when cookies are unavailable', async () => {
    const user = JSON.stringify({ id: 779, first_name: 'BearerUser' });
    const initData = signInitData({ auth_date: Math.floor(clock.t / 1000), user }, BOT_TOKEN);
    const r = await call('POST', '/api/auth/webapp', { body: { initData } });
    assert.strictEqual(r.status, 200);
    const token = r.json.session;
    // No Cookie header — only Bearer
    const me = await fetch(base + '/api/me', { headers: { Authorization: 'Bearer ' + token } });
    assert.strictEqual(me.status, 200);
    const body = await me.json();
    assert.strictEqual(body.user.name, 'BearerUser');
    // Forged bearer must fail
    const bad = await fetch(base + '/api/me', { headers: { Authorization: 'Bearer ' + 'x'.repeat(43) } });
    assert.strictEqual(bad.status, 401);
  });

  await test('dev login is disabled by default; protected routes need a session; logout invalidates it', async () => {
    let r = await call('POST', '/api/auth/dev', { body: { id: 1 } });
    assert.strictEqual(r.status, 404);
    r = await call('GET', '/api/me');
    assert.strictEqual(r.status, 401);
    r = await call('POST', '/api/run/start', { body: { tier: 'easy' } });
    assert.strictEqual(r.status, 401);
    const u = await login('Temp');
    r = await call('POST', '/api/auth/logout', { cookie: u.cookie });
    assert.strictEqual(r.status, 200);
    r = await call('GET', '/api/me', { cookie: u.cookie });
    assert.strictEqual(r.status, 401);
  });

  await test('POSTs must be JSON and same-origin', async () => {
    let r = await fetch(base + '/api/auth/telegram', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
    assert.strictEqual(r.status, 415);
    r = await fetch(base + '/api/auth/telegram', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
    assert.strictEqual(r.status, 403);
  });

  await test('static files are whitelisted; server code and the database are not exposed', async () => {
    for (const p of ['/', '/core.js', '/main.js', '/style.css', '/i18n.js']) assert.strictEqual((await fetch(base + p)).status, 200, p);
    for (const p of ['/server/app.js', '/data/rulerush.db', '/package.json', '/../server/app.js', '/test/core.test.js']) {
      assert.strictEqual((await fetch(base + p)).status, 404, p);
    }
    const idx = await fetch(base + '/');
    assert.ok(/script-src 'self' https:\/\/telegram\.org/.test(idx.headers.get('content-security-policy')));
  });

  /* ---------- official runs ---------- */

  const alice = await login('Alice');
  const bob = await login('Bob');
  const cara = await login('Cara');

  await test('daily trial: one official attempt per tier per day; other tiers and the next day are available', async () => {
    let r = await call('POST', '/api/run/start', { cookie: alice.cookie, body: { tier: 'easy' } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.trialsLeft, 0);
    assert.strictEqual(r.json.seed.length, 20);
    r = await call('POST', '/api/run/start', { cookie: alice.cookie, body: { tier: 'easy' } });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.json.error, 'no_trials_left');
    assert.ok(r.json.resetsAt > clock.t);
    r = await call('POST', '/api/run/start', { cookie: alice.cookie, body: { tier: 'hard' } });
    assert.strictEqual(r.status, 200);
    r = await call('POST', '/api/run/start', { cookie: alice.cookie, body: { tier: 'nightmare' } });
    assert.strictEqual(r.status, 400);

    const me = await call('GET', '/api/me', { cookie: alice.cookie });
    assert.strictEqual(me.json.trials.easy.left, 0);
    assert.strictEqual(me.json.trials.medium.left, 1);

    clock.t += DAY; // the next UTC day: new trials and new seeds
    const next = await call('POST', '/api/run/start', { cookie: alice.cookie, body: { tier: 'easy' } });
    assert.strictEqual(next.status, 200);
    clock.t -= DAY; // (runs started on a later "day" are cleaned up by moving the clock back is not needed again)
  });

  await test('everyone gets the same seed for the same tier and day; seeds differ across tiers and days', async () => {
    const day = dayKey(clock.t);
    assert.strictEqual(app.dailySeed(day, 'medium'), app.dailySeed(day, 'medium'));
    assert.notStrictEqual(app.dailySeed(day, 'medium'), app.dailySeed(day, 'easy'));
    assert.notStrictEqual(app.dailySeed(day, 'medium'), app.dailySeed(dayKey(clock.t + DAY), 'medium'));
    const a = await call('POST', '/api/run/start', { cookie: bob.cookie, body: { tier: 'medium' } });
    const b = await call('POST', '/api/run/start', { cookie: cara.cookie, body: { tier: 'medium' } });
    assert.strictEqual(a.json.seed, b.json.seed);
    assert.notStrictEqual(a.json.runId, b.json.runId);
  });

  // Bob and Cara already hold started medium runs from the previous test; use them.
  await test('a verified run is scored by the SERVER and matches an independent replay', async () => {
    const start = (await call('POST', '/api/run/start', { cookie: alice.cookie, body: { tier: 'medium' } }));
    assert.strictEqual(start.status, 200);
    const inputs = botRun(start.json.seed, { tier: 'medium', id: 'alice', reaction: 330, jitter: 70, wrongRate: 0.05 });
    clock.t += 50000;
    const r = await call('POST', '/api/run/submit', { cookie: alice.cookie, body: { runId: start.json.runId, inputs } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const replay = Core.verifyRun(start.json.seed, inputs, { tier: 'medium' });
    assert.strictEqual(r.json.score, replay.score);
    assert.ok(r.json.score > 2500);
    assert.strictEqual(r.json.rank.rank, 1);

    // cannot be submitted twice
    const again = await call('POST', '/api/run/submit', { cookie: alice.cookie, body: { runId: start.json.runId, inputs } });
    assert.strictEqual(again.status, 409);
  });

  await test("another player cannot submit or read someone else's run", async () => {
    const start = await call('POST', '/api/run/start', { cookie: alice.cookie, body: { tier: 'easy' } });
    assert.strictEqual(start.status, 409); // her easy attempt is already used today: make a run to steal from a fresh user
    const dave = await login('Dave');
    const s = await call('POST', '/api/run/start', { cookie: dave.cookie, body: { tier: 'easy' } });
    const inputs = botRun(s.json.seed, { tier: 'easy', id: 'dave', reaction: 300, jitter: 50 });
    clock.t += 50000;
    const stolen = await call('POST', '/api/run/submit', { cookie: bob.cookie, body: { runId: s.json.runId, inputs } });
    assert.strictEqual(stolen.status, 404);
    const own = await call('POST', '/api/run/submit', { cookie: dave.cookie, body: { runId: s.json.runId, inputs } });
    assert.strictEqual(own.status, 200);
  });

  /* ---------- anti-cheat at the API level ---------- */

  await test('cheating attempts are rejected and never reach the leaderboard', async () => {
    const day = dayKey(clock.t);
    const before = (await call('GET', '/api/leaderboard?tier=medium&scope=day')).json.total;

    // 1) forged score
    const u1 = await login('Cheater1');
    const s1 = await call('POST', '/api/run/start', { cookie: u1.cookie, body: { tier: 'medium' } });
    const in1 = botRun(s1.json.seed, { tier: 'medium', id: 'c1', reaction: 400, jitter: 80 });
    clock.t += 50000;
    let r = await call('POST', '/api/run/submit', { cookie: u1.cookie, body: { runId: s1.json.runId, inputs: in1, claimedScore: 999999 } });
    assert.strictEqual(r.status, 422); assert.strictEqual(r.json.error, 'run_rejected');
    assert.strictEqual(r.json.flags, undefined, 'reasons must not leak to the client');

    // 2) superhuman reaction times
    const u2 = await login('Cheater2');
    const p2 = await play(u2, 'medium', { reaction: 30, jitter: 5, noise: 0 });
    assert.strictEqual(p2.submit.status, 422);

    // 3) instant submit (no real time passed)
    const u3 = await login('Cheater3');
    const p3 = await play(u3, 'medium', { reaction: 400, jitter: 80 }, { waitMs: 4000 });
    assert.strictEqual(p3.submit.status, 422);

    // 4) the same inputs replayed against a different seed (e.g. the day before) do not carry over
    const u4 = await login('Cheater4');
    const p4 = await play(u4, 'medium', {}, { inputs: botRun(app.dailySeed(dayKey(clock.t - DAY), 'medium'), { tier: 'medium', id: 'old', reaction: 380, jitter: 60 }) });
    assert.strictEqual(p4.submit.status, 200);
    assert.ok(p4.submit.json.score < 1200, 'yesterday inputs scored ' + p4.submit.json.score);

    // 5) malformed payloads
    const u5 = await login('Cheater5');
    const s5 = await call('POST', '/api/run/start', { cookie: u5.cookie, body: { tier: 'medium' } });
    clock.t += 50000;
    r = await call('POST', '/api/run/submit', { cookie: u5.cookie, body: { runId: s5.json.runId, inputs: [{ t: 'x', x: 1, y: 1 }] } });
    assert.strictEqual(r.status, 422);

    // 6) a run that is submitted far too late
    const u6 = await login('Cheater6');
    const s6 = await call('POST', '/api/run/start', { cookie: u6.cookie, body: { tier: 'medium' } });
    clock.t += 10 * 60 * 1000;
    r = await call('POST', '/api/run/submit', { cookie: u6.cookie, body: { runId: s6.json.runId, inputs: [] } });
    assert.strictEqual(r.status, 410);

    // rejected attempts still consume the daily trial
    r = await call('POST', '/api/run/start', { cookie: u1.cookie, body: { tier: 'medium' } });
    assert.strictEqual(r.status, 409);

    const rows = app.db.prepare("SELECT status FROM runs WHERE tier='medium' AND day = ? AND user_id IN (SELECT id FROM users WHERE first_name LIKE 'Cheater%')").all(day);
    assert.ok(rows.some((x) => x.status === 'rejected') && rows.some((x) => x.status === 'expired'));
    const after = (await call('GET', '/api/leaderboard?tier=medium&scope=day')).json.total;
    assert.ok(after - before <= 1, 'only the replayed-old-seed player (a legitimate, low score) may appear');
  });

  /* ---------- leaderboards ---------- */

  await test('separate leaderboards per tier, ordered by score, with "me" highlighting', async () => {
    // fresh day so the board is clean and everyone has trials again
    clock.t = Date.UTC(2026, 10, 6, 9, 0, 0);
    const players = [['Alice', 280], ['Bob', 420], ['Cara', 650]];
    const scores = {};
    for (const [name, reaction] of players) {
      const u = { Alice: alice, Bob: bob, Cara: cara }[name];
      const p = await play(u, 'medium', { reaction, jitter: 60 });
      assert.strictEqual(p.submit.status, 200, JSON.stringify(p.submit.json));
      scores[name] = p.submit.json.score;
    }
    const hardRun = await play(alice, 'hard', { reaction: 300, jitter: 50 });
    assert.strictEqual(hardRun.submit.status, 200);

    const med = (await call('GET', '/api/leaderboard?tier=medium&scope=day', { cookie: bob.cookie })).json;
    assert.deepStrictEqual(med.entries.map((e) => e.name.split(' ')[0]), ['Alice', 'Bob', 'Cara']);
    assert.deepStrictEqual(med.entries.map((e) => e.score), [scores.Alice, scores.Bob, scores.Cara].sort((a, b) => b - a));
    assert.ok(med.entries.find((e) => e.me).name.startsWith('Bob'));
    assert.strictEqual(med.me.rank, 2);
    assert.ok(!('username' in med.entries[0]) || med.entries[0].username !== undefined);

    const hard = (await call('GET', '/api/leaderboard?tier=hard&scope=day')).json;
    assert.strictEqual(hard.total, 1);
    const easy = (await call('GET', '/api/leaderboard?tier=easy&scope=day')).json;
    assert.strictEqual(easy.total, 0);

    const week = (await call('GET', '/api/leaderboard?tier=medium&scope=week')).json;
    assert.ok(week.total >= 3 && week.from === '2026-11-02' && week.to === '2026-11-08', week.from + ' ' + week.to);
    const all = (await call('GET', '/api/leaderboard?tier=medium&scope=all')).json;
    assert.ok(all.total >= 3);
    assert.strictEqual((await call('GET', '/api/leaderboard?tier=zzz')).status, 400);
  });

  await test('banned players disappear from boards and lose their session', async () => {
    const before = (await call('GET', '/api/leaderboard?tier=medium&scope=day')).json.total;
    let r = await call('POST', '/admin/users/ban', { admin: true, body: { tgId: cara.id } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await call('GET', '/api/leaderboard?tier=medium&scope=day')).json.total, before - 1);
    assert.strictEqual((await call('GET', '/api/me', { cookie: cara.cookie })).status, 401);
    await call('POST', '/admin/users/ban', { admin: true, body: { tgId: cara.id, banned: false } });
  });

  /* ---------- hard tier ---------- */

  await test('hard: a run that ends on the first mistake is accepted; inputs after the end are rejected', async () => {
    const u = await login('HardPlayer');
    const s = await call('POST', '/api/run/start', { cookie: u.cookie, body: { tier: 'hard' } });
    const sch = Core.buildSchedule(s.json.seed, 'hard');
    const first = sch.targets.find((t) => t.valid);
    const good = { t: first.t + 300, x: first.x, y: first.y };
    const stray = { t: first.t + 900, x: first.x < 500 ? 990 : 10, y: first.y < 500 ? 990 : 10 };
    clock.t += 50000;
    const r = await call('POST', '/api/run/submit', { cookie: u.cookie, body: { runId: s.json.runId, inputs: [good, stray] } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.stats.ended, true);

    const u2 = await login('HardCheater');
    const s2 = await call('POST', '/api/run/start', { cookie: u2.cookie, body: { tier: 'hard' } });
    const sch2 = Core.buildSchedule(s2.json.seed, 'hard');
    const f2 = sch2.targets.find((t) => t.valid);
    const inputs2 = [{ t: f2.t + 300, x: f2.x, y: f2.y }, { t: f2.t + 900, x: f2.x < 500 ? 990 : 10, y: f2.y < 500 ? 990 : 10 }, { t: f2.t + 1500, x: f2.x, y: f2.y }];
    clock.t += 50000;
    const r2 = await call('POST', '/api/run/submit', { cookie: u2.cookie, body: { runId: s2.json.runId, inputs: inputs2 } });
    assert.strictEqual(r2.status, 422);
  });

  /* ---------- manual review for suspicious-but-not-impossible runs ---------- */

  await test('statistically suspicious runs wait for review, stay off the board, then count once approved', async () => {
    const u = await login('Metronome');
    const p = await play(u, 'medium', { reaction: 300, jitter: 0, noise: 0 });
    assert.strictEqual(p.submit.status, 200, JSON.stringify(p.submit.json));
    assert.strictEqual(p.submit.json.pendingReview, true);
    assert.strictEqual(p.submit.json.rank, null);
    const board = (await call('GET', '/api/leaderboard?tier=medium&scope=day')).json;
    assert.ok(!board.entries.some((e) => e.name.startsWith('Metronome')));

    assert.strictEqual((await call('GET', '/admin/reviews')).status, 401);
    assert.strictEqual((await call('GET', '/admin/reviews', { admin: true, adminToken: 'nope' })).status, 401);
    const q = await call('GET', '/admin/reviews', { admin: true });
    const item = q.json.reviews.find((x) => x.first_name === 'Metronome');
    assert.ok(item && item.flags.some((f) => f.code === 'robotic_consistency'));

    const run = await call('GET', '/admin/runs/' + item.id, { admin: true });
    assert.ok(JSON.parse(run.json.run.inputs_json).length > 10, 'raw inputs are kept for audit');

    await call('POST', '/admin/reviews', { admin: true, body: { runId: item.id, decision: 'approve', note: 'looked at the replay' } });
    const board2 = (await call('GET', '/api/leaderboard?tier=medium&scope=day')).json;
    assert.ok(board2.entries.some((e) => e.name.startsWith('Metronome')));
    assert.strictEqual((await call('POST', '/admin/reviews', { admin: true, body: { runId: item.id, decision: 'approve' } })).status, 404);
  });

  /* ---------- sponsors, prizes, awards ---------- */

  await test('sponsor prizes: public listing, finalization of a finished day, awards workflow', async () => {
    let r = await call('POST', '/admin/sponsors', { admin: true, body: { name: 'Acme Gifts', url: 'javascript:alert(1)' } });
    assert.strictEqual(r.status, 400);
    r = await call('POST', '/admin/sponsors', { admin: true, body: { name: 'Acme Gifts', url: 'https://acme.example' } });
    const sponsorId = r.json.id;
    r = await call('POST', '/admin/prizes', { admin: true, body: { sponsorId, tier: 'medium', period: 'day', startsDay: '2026-11-01', endsDay: '2026-11-30', rankFrom: 1, rankTo: 2, title: '$20 gift card', description: 'Digital code' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual((await call('POST', '/admin/prizes', { admin: true, body: { sponsorId, tier: 'medium', period: 'day', startsDay: '2026-11-30', endsDay: '2026-11-01', rankFrom: 1, title: 'x' } })).status, 400);

    const pub = await call('GET', '/api/prizes?tier=medium');
    assert.strictEqual(pub.json.prizes.length, 1);
    assert.strictEqual(pub.json.prizes[0].sponsor, 'Acme Gifts');
    assert.strictEqual((await call('GET', '/api/prizes?tier=easy')).json.prizes.length, 0);

    // today's board is not finished yet
    r = await call('POST', '/admin/finalize', { admin: true, body: { tier: 'medium', period: 'day', key: dayKey(clock.t) } });
    assert.strictEqual(r.json.error, 'period_not_finished');

    // an unreviewed suspicious run blocks finalization until it is reviewed
    const sus = await login('Suspect');
    const sp = await play(sus, 'medium', { reaction: 310, jitter: 0, noise: 0 });
    assert.strictEqual(sp.submit.json.pendingReview, true);

    const finishedDay = dayKey(clock.t);
    clock.t += DAY;
    r = await call('POST', '/admin/finalize', { admin: true, body: { tier: 'medium', period: 'day', key: finishedDay } });
    assert.strictEqual(r.status, 409); assert.strictEqual(r.json.error, 'pending_reviews');
    const pend = (await call('GET', '/admin/reviews', { admin: true })).json.reviews.find((x) => x.first_name === 'Suspect');
    await call('POST', '/admin/reviews', { admin: true, body: { runId: pend.id, decision: 'reject', note: 'bot-like' } });

    r = await call('POST', '/admin/finalize', { admin: true, body: { tier: 'medium', period: 'day', key: finishedDay } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.strictEqual(r.json.created, 2);
    r = await call('POST', '/admin/finalize', { admin: true, body: { tier: 'medium', period: 'day', key: finishedDay } });
    assert.strictEqual(r.json.created, 0, 'finalizing twice must not duplicate awards');

    const aw = (await call('GET', '/admin/awards?status=pending', { admin: true })).json.awards;
    assert.strictEqual(aw.length, 2);
    assert.deepStrictEqual(aw.map((a) => a.rank).sort(), [1, 2]);
    const winner = aw.find((a) => a.rank === 1);
    assert.ok(!aw.some((a) => a.first_name === 'Suspect'), 'a rejected run can never win');
    await call('POST', '/admin/awards/' + winner.id, { admin: true, body: { status: 'approved', note: 'code sent' } });

    const winnerUser = { Alice: alice, Bob: bob, Cara: cara, Metronome: null }[winner.first_name];
    if (winnerUser) {
      const me = (await call('GET', '/api/me', { cookie: winnerUser.cookie })).json;
      assert.ok(me.awards.some((a) => a.title === '$20 gift card' && a.status === 'approved' && a.rank === 1));
    }
  });

  await test('admin API is closed without a configured token', async () => {
    const bare = createApp({ dbPath: ':memory:', botToken: BOT_TOKEN, adminToken: '', now: () => clock.t });
    const p = await bare.listen(0);
    const r = await fetch('http://127.0.0.1:' + p + '/admin/reviews', { headers: { Authorization: 'Bearer ' } });
    assert.strictEqual(r.status, 404);
    await bare.close();
  });

  await test('login reports "not configured" instead of accepting anything when no bot token is set', async () => {
    const bare = createApp({ dbPath: ':memory:', now: () => clock.t });
    const p = await bare.listen(0);
    const r = await fetch('http://127.0.0.1:' + p + '/api/auth/telegram', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signWidget({ id: 1, auth_date: Math.floor(clock.t / 1000) }, '')) });
    assert.strictEqual(r.status, 503);
    await bare.close();
  });

  await app.close();
  console.log(process.exitCode ? '\n' + failures.length + ' failed: ' + failures.join('; ') : '\nAll ' + passed + ' server tests passed.');
}

main().catch((e) => { console.error(e); process.exit(1); });
