'use strict';
const crypto = require('crypto');
const Core = require('../core.js');
const { CONFIG, buildSchedule, makeRng } = Core;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Scripted player: reacts `reaction` ms (+/- jitter) after each valid target spawns. */
function botRun(seed, o) {
  const sch = buildSchedule(seed, o.tier);
  const rng = makeRng('bot|' + (o.id || 'x'));
  const noise = o.noise === undefined ? 20 : o.noise;
  const inputs = [];
  for (const tg of sch.targets) {
    const rt = Math.round(o.reaction + (rng() - 0.5) * 2 * (o.jitter || 0));
    const t = tg.t + rt;
    if (t >= tg.end) continue;
    if (tg.valid || rng() < (o.wrongRate || 0)) {
      inputs.push({
        t,
        x: clamp(Math.round(tg.x + (rng() - 0.5) * 2 * noise), 0, CONFIG.FIELD),
        y: clamp(Math.round(tg.y + (rng() - 0.5) * 2 * noise), 0, CONFIG.FIELD),
      });
    }
  }
  return inputs.sort((a, b) => a.t - b.t);
}

/** Builds a payload exactly like the Telegram Login Widget does (hash = HMAC(SHA256(token), data_check_string)). */
function signWidget(fields, botToken) {
  const dcs = Object.entries(fields).map(([k, v]) => k + '=' + v).sort().join('\n');
  const secret = crypto.createHash('sha256').update(botToken).digest();
  return Object.assign({}, fields, { hash: crypto.createHmac('sha256', secret).update(dcs).digest('hex') });
}

/** Builds Mini App initData exactly like Telegram does (secret = HMAC("WebAppData", token)). */
function signInitData(fields, botToken) {
  const dcs = Object.entries(fields).map(([k, v]) => k + '=' + v).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return new URLSearchParams(Object.assign({}, fields, { hash })).toString();
}

module.exports = { botRun, signWidget, signInitData, clamp };
