'use strict';
// Entry point. All configuration comes from environment variables (see README).
const fs = require('fs');
const path = require('path');
const { createApp } = require('./app.js');

const env = process.env;
const dbPath = env.DB_PATH || path.join(__dirname, '..', 'data', 'rulerush.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const app = createApp({
  dbPath,
  botToken: env.BOT_TOKEN || '',
  botUsername: (env.BOT_USERNAME || '').replace(/^@/, ''),
  adminToken: env.ADMIN_TOKEN || '',
  devAuth: env.DEV_AUTH === '1',
  // Must be 1 on HTTPS production. Enables SameSite=None; Secure; Partitioned for Mini Apps.
  cookieSecure: env.COOKIE_SECURE === '1',
  trustProxy: env.TRUST_PROXY === '1',
  // Comma-separated public hostnames for Origin CSRF checks behind reverse proxies.
  // Example: PUBLIC_HOST=game.example.com
  publicHost: env.PUBLIC_HOST || '',
  dailyTrials: Math.max(1, parseInt(env.DAILY_TRIALS || '1', 10) || 1),
  seedSecret: env.SEED_SECRET || '',
  log: (...a) => console.error('[rule-rush]', ...a),
});

const port = parseInt(env.PORT || '8080', 10);
const host = env.HOST || '127.0.0.1';
app.listen(port, host).then((p) => {
  console.log('Rule Rush listening on http://' + host + ':' + p);
  if (!env.BOT_TOKEN || !env.BOT_USERNAME) console.warn('! BOT_TOKEN / BOT_USERNAME not set: Telegram login is disabled.');
  if (env.DEV_AUTH === '1') console.warn('! DEV_AUTH=1: anyone can log in as any dev user. Never enable this in production.');
  if (!env.ADMIN_TOKEN) console.warn('! ADMIN_TOKEN not set: admin API is disabled.');
  if (env.COOKIE_SECURE !== '1') console.warn('! COOKIE_SECURE is not 1: set it when serving over HTTPS (required for Telegram Mini App cookies).');
  if (env.TRUST_PROXY === '1' && !env.PUBLIC_HOST) console.warn('! TRUST_PROXY=1 without PUBLIC_HOST: set PUBLIC_HOST to your public domain so Origin CSRF checks succeed behind the proxy.');
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => app.close().then(() => process.exit(0)));
