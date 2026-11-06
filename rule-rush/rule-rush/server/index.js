'use strict';
// Entry point. All configuration comes from environment variables (see README).
const fs = require('fs');
const path = require('path');
const { createApp } = require('./app.js');

const env = process.env;
const dbPath = env.DB_PATH || path.join(__dirname, '..', 'data', 'rulerush.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// Render / Railway / Fly set these. Auto-enable production cookie + proxy behaviour
// when we detect a hosted environment so Mini App sessions work without foot-guns.
const onRender = Boolean(env.RENDER || env.RENDER_EXTERNAL_URL || env.RAILWAY_ENVIRONMENT || env.FLY_APP_NAME);
const cookieSecure = env.COOKIE_SECURE === '1' || (onRender && env.COOKIE_SECURE !== '0');
const trustProxy = env.TRUST_PROXY === '1' || (onRender && env.TRUST_PROXY !== '0');

// PUBLIC_HOST: explicit env, or derive from Render's external URL.
let publicHost = env.PUBLIC_HOST || '';
if (!publicHost && env.RENDER_EXTERNAL_URL) {
  try { publicHost = new URL(env.RENDER_EXTERNAL_URL).host; } catch (e) { /* ignore */ }
}
if (!publicHost && env.RENDER_EXTERNAL_HOSTNAME) publicHost = env.RENDER_EXTERNAL_HOSTNAME;

const app = createApp({
  dbPath,
  botToken: env.BOT_TOKEN || '',
  botUsername: (env.BOT_USERNAME || '').replace(/^@/, ''),
  adminToken: env.ADMIN_TOKEN || '',
  devAuth: env.DEV_AUTH === '1',
  cookieSecure,
  trustProxy,
  publicHost,
  dailyTrials: Math.max(1, parseInt(env.DAILY_TRIALS || '1', 10) || 1),
  seedSecret: env.SEED_SECRET || '',
  // initData is only used to mint a long-lived session; 24h is Telegram's recommended window.
  maxAuthAgeSec: parseInt(env.MAX_AUTH_AGE_SEC || String(24 * 3600), 10) || (24 * 3600),
  log: (...a) => console.error('[rule-rush]', ...a),
});

// Render injects PORT and expects bind on 0.0.0.0 (never 127.0.0.1).
const port = parseInt(env.PORT || '8080', 10);
const host = env.HOST || '0.0.0.0';
app.listen(port, host).then((p) => {
  console.log('Rule Rush listening on http://' + host + ':' + p);
  console.log('cookieSecure=' + cookieSecure + ' trustProxy=' + trustProxy + ' publicHost=' + (publicHost || '(none)'));
  if (!env.BOT_TOKEN || !env.BOT_USERNAME) console.warn('! BOT_TOKEN / BOT_USERNAME not set: Telegram login is disabled.');
  if (env.DEV_AUTH === '1') console.warn('! DEV_AUTH=1: anyone can log in as any dev user. Never enable this in production.');
  if (!env.ADMIN_TOKEN) console.warn('! ADMIN_TOKEN not set: admin API is disabled.');
  if (!cookieSecure) console.warn('! COOKIE_SECURE is off: set COOKIE_SECURE=1 on HTTPS (required for Telegram Mini App cookies).');
  if (trustProxy && !publicHost) console.warn('! TRUST_PROXY without PUBLIC_HOST: set PUBLIC_HOST to your public domain (e.g. rule-rush.onrender.com).');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
