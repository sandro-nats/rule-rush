/* Rule Rush: browser / Telegram Mini App client. */
(function () {
  'use strict';

  const Core = window.RuleRushCore;
  const I18N = window.RR_I18N;
  const C = Core.CONFIG;
  const TIERS = Object.keys(C.TIERS);
  const tg = (window.Telegram && window.Telegram.WebApp) || null;

  const COLOR_HEX = { red: '#ff4d5e', blue: '#3fa0ff', green: '#2ee59d', yellow: '#ffd93d' };
  const COUNTDOWN_MS = 3000;

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const fmt = (n) => Number(n).toLocaleString('en-US');

  /* ---------------- storage ---------------- */
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    del(k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  // Session token fallback when HttpOnly cookies are blocked (Telegram Web iframe,
  // some Desktop Mini App shells). Prefer sessionStorage (cleared when WebView closes).
  const SESSION_KEY = 'rr_session_token';
  const sessionStore = {
    get() {
      try { return window.sessionStorage.getItem(SESSION_KEY) || window.localStorage.getItem(SESSION_KEY); }
      catch (e) { return null; }
    },
    set(t) {
      try {
        if (t) {
          window.sessionStorage.setItem(SESSION_KEY, t);
          window.localStorage.setItem(SESSION_KEY, t); // survive cold WebView restarts in Mini Apps
        } else {
          window.sessionStorage.removeItem(SESSION_KEY);
          window.localStorage.removeItem(SESSION_KEY);
        }
      } catch (e) { /* private mode / quota */ }
    },
    clear() { this.set(null); },
  };

  /* ---------------- state ---------------- */
  const S = {
    config: {},
    me: null,
    tier: TIERS.includes(store.get('rr_tier')) ? store.get('rr_tier') : 'medium',
    boardTier: 'medium',
    boardScope: 'day',
    lastMode: 'practice',
    pending: null,       // official run waiting for the server's verdict
    boardReq: 0,
    authing: false,      // true while Mini App initData login is in flight
  };

  /* ---------------- language ---------------- */
  let lang = store.get('rr_lang');
  if (lang !== 'en' && lang !== 'ka') {
    const u = tg && tg.initDataUnsafe && tg.initDataUnsafe.user;
    lang = u && u.language_code === 'ka' ? 'ka' : 'en';
  }
  const tr = (key, vars) => {
    let s = (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
    if (vars) for (const k of Object.keys(vars)) s = s.split('{' + k + '}').join(String(vars[k]));
    return s;
  };
  const tierName = (t) => tr('tier' + t.charAt(0).toUpperCase() + t.slice(1));

  /* ---------------- Telegram integration ---------------- */
  /** True when running inside a real Telegram client Mini App (has signed initData). */
  const isMiniApp = Boolean(tg && typeof tg.initData === 'string' && tg.initData.length > 0);
  const isTelegramShell = Boolean(tg);

  if (tg) {
    try { tg.ready(); tg.expand(); } catch (e) { /* ignore */ }
    try { tg.setHeaderColor('#0b1020'); tg.setBackgroundColor('#0b1020'); } catch (e) { /* ignore */ }
    try { if (typeof tg.disableVerticalSwipes === 'function') tg.disableVerticalSwipes(); } catch (e) { /* ignore */ }
    try {
      // Tell Telegram this is a full-height app; avoids half-sheet clipping.
      if (typeof tg.setHeaderColor === 'function') tg.setHeaderColor('#0b1020');
      if (typeof tg.isVerticalSwipesEnabled === 'boolean' && tg.isVerticalSwipesEnabled && typeof tg.disableVerticalSwipes === 'function') {
        tg.disableVerticalSwipes();
      }
    } catch (e) { /* ignore */ }
  }

  /** Wait until Telegram injects initData (can be empty on the first paint). */
  function waitForInitData(maxMs) {
    return new Promise((resolve) => {
      if (!tg) return resolve('');
      if (tg.initData) return resolve(tg.initData);
      const start = Date.now();
      const tick = () => {
        if (tg.initData) return resolve(tg.initData);
        if (Date.now() - start >= (maxMs || 2500)) return resolve(tg.initData || '');
        setTimeout(tick, 50);
      };
      tick();
    });
  }
  function haptic(kind) {
    try {
      const h = tg && tg.HapticFeedback;
      if (!h) return;
      if (kind === 'hit') h.impactOccurred('light');
      else if (kind === 'perfect') h.impactOccurred('medium');
      else if (kind === 'wrong') h.notificationOccurred('error');
      else if (kind === 'done') h.notificationOccurred('success');
    } catch (e) { /* ignore */ }
  }
  function closingConfirmation(on) {
    try {
      if (!tg) return;
      if (on && tg.enableClosingConfirmation) tg.enableClosingConfirmation();
      if (!on && tg.disableClosingConfirmation) tg.disableClosingConfirmation();
    } catch (e) { /* ignore */ }
  }
  function confirmAsync(msg) {
    return new Promise((resolve) => {
      if (tg && tg.initData && typeof tg.showConfirm === 'function') {
        try { tg.showConfirm(msg, (ok) => resolve(Boolean(ok))); return; } catch (e) { /* fall through */ }
      }
      resolve(window.confirm(msg));
    });
  }
  function setAppHeight() {
    const h = (tg && tg.viewportStableHeight) || window.innerHeight;
    document.documentElement.style.setProperty('--app-h', h + 'px');
  }

  /* ---------------- server API ---------------- */
  async function api(path, body) {
    const headers = {};
    const token = sessionStore.get();
    // Bearer fallback for environments that strip third-party cookies (Telegram Web / some Desktop shells).
    // Cookie still takes precedence server-side when present.
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const opt = {
      // include: ensure cookies travel even in odd Mini App WebView edge cases
      credentials: 'include',
      headers,
    };
    if (body !== undefined) {
      opt.method = 'POST';
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    try {
      const r = await fetch(path, opt);
      let data = null;
      try { data = await r.json(); } catch (e) { /* empty body */ }
      // Persist session token returned by login endpoints
      if (r.ok && data && typeof data.session === 'string' && data.session.length >= 20) {
        sessionStore.set(data.session);
      }
      return { ok: r.ok, status: r.status, data: data || {} };
    } catch (e) {
      return { ok: false, status: 0, data: { error: 'network' } };
    }
  }

  async function loadMe() {
    const r = await api('/api/me');
    if (r.ok) {
      S.me = r.data;
      return S.me;
    }
    // Dead session token → drop it so we can re-auth with initData
    if (r.status === 401) sessionStore.clear();
    S.me = null;
    return null;
  }

  /**
   * Mini App auto-login using Telegram.WebApp.initData.
   * Never prompts for phone — Telegram already identified the user.
   */
  async function loginWithWebApp(force, initDataOverride) {
    const initData = initDataOverride || (tg && tg.initData) || '';
    if (!initData) return { ok: false, reason: 'no_initdata' };
    if (S.me && !force) return { ok: true, already: true };
    if (S.authing) return { ok: false, reason: 'busy' };
    S.authing = true;
    try {
      const r = await api('/api/auth/webapp', { initData });
      if (!r.ok) {
        console.warn('[rule-rush] webapp login failed', r.status, r.data && r.data.error);
        return { ok: false, reason: (r.data && r.data.error) || 'login_failed', status: r.status };
      }
      // api() already persisted data.session into sessionStore
      await loadMe();
      return { ok: Boolean(S.me) };
    } finally {
      S.authing = false;
    }
  }

  /**
   * Canonical Mini App entry path:
   *  1) wait for initData
   *  2) silent server login (upserts user by tg_id, issues long-lived session)
   *  3) load profile
   * Never shows Login Widget / phone UI when initData is available.
   */
  async function ensureMiniAppSession() {
    const hint = $('#tg-autologin');
    if (hint) hint.hidden = false;
    const initData = await waitForInitData(3000);
    if (!initData) {
      if (hint) hint.hidden = true;
      return { ok: false, reason: 'no_initdata' };
    }
    // Always re-bind with live initData so relaunches pick up the same Telegram identity
    // even if a stale Bearer token from another account was in localStorage.
    const r = await loginWithWebApp(true, initData);
    if (hint) hint.hidden = true;
    return r;
  }

  /** On 401 during play: try one silent re-login via initData, then reload me. */
  async function recoverSession() {
    sessionStore.clear();
    S.me = null;
    if (tg) {
      const r = await ensureMiniAppSession();
      if (r.ok) return true;
    }
    renderAccount();
    renderMenu();
    return false;
  }

  /** Optionally request phone contact once (does not block auto-login). */
  function maybeRequestPhone() {
    if (!tg || !S.me || (S.me.user && S.me.user.hasPhone)) return;
    if (store.get('rr_phone_asked') === '1') return;
    // Only if the client exposes requestContact (Bot API 6.9+)
    if (typeof tg.requestContact !== 'function') return;
    store.set('rr_phone_asked', '1');
    try {
      tg.requestContact((shared) => {
        // Newer clients: event-based. Older: callback may not fire; also listen.
        if (!shared) return;
      });
    } catch (e) { /* ignore */ }
    try {
      if (typeof tg.onEvent === 'function') {
        tg.onEvent('contactRequested', async (ev) => {
          try {
            const status = ev && (ev.status || ev);
            // status can be "sent" | "cancelled" depending on client
            if (status && String(status).toLowerCase().indexOf('cancel') >= 0) return;
            // Some clients put phone on initDataUnsafe after share — re-auth to pick nothing;
            // phone is delivered via the event payload when available.
            const phone = (ev && (ev.response || ev.contact || ev).phone_number) ||
              (ev && ev.phone_number) || '';
            if (phone) {
              const r = await api('/api/me/phone', { phone: String(phone) });
              if (r.ok) { S.me = Object.assign({}, S.me, { user: r.data.user }); renderAccount(); }
            }
          } catch (err) { /* ignore */ }
        });
      }
    } catch (e) { /* ignore */ }
  }

  /* ---------------- helpers ---------------- */
  function utcDate() {
    const d = new Date();
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }
  const practiceKey = (tier) => 'rr_best_practice_' + tier;
  const getPracticeBest = (tier) => parseInt(store.get(practiceKey(tier)) || '0', 10) || 0;

  function showScreen(name) {
    $$('.screen').forEach((el) => el.classList.toggle('active', el.id === 'screen-' + name));
  }

  let toastTimer = 0;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  function formatLeft(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return h + ':' + String(m).padStart(2, '0');
  }

  // Names come from Telegram users: always insert them as text, never as HTML.
  function avatarEl(photo, name) {
    const span = document.createElement('span');
    span.className = 'avatar';
    if (photo && /^https:\/\//i.test(photo)) {
      const img = document.createElement('img');
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = photo;
      img.addEventListener('error', () => { img.remove(); span.textContent = (name || '?').trim().charAt(0).toUpperCase(); });
      span.appendChild(img);
    } else {
      span.textContent = (name || '?').trim().charAt(0).toUpperCase();
    }
    return span;
  }

  /* ---------------- account / menu ---------------- */
  let widgetMounted = false;

  function mountTelegramWidget() {
    if (widgetMounted || !S.config.loginEnabled || !S.config.botUsername) return;
    widgetMounted = true;
    const s = document.createElement('script');
    s.async = true;
    s.src = 'https://telegram.org/js/telegram-widget.js?22';
    s.setAttribute('data-telegram-login', S.config.botUsername);
    s.setAttribute('data-size', 'large');
    s.setAttribute('data-radius', '12');
    s.setAttribute('data-userpic', 'false');
    s.setAttribute('data-auth-url', location.origin + '/auth/telegram/callback');
    $('#tg-widget').appendChild(s);
  }

  function renderAccount() {
    const loggedIn = Boolean(S.me);
    $('#acc-out').hidden = loggedIn;
    $('#acc-in').hidden = !loggedIn;
    if (loggedIn) {
      const holder = $('#acc-avatar');
      const fresh = avatarEl(S.me.user.photo, S.me.user.name);
      holder.replaceWith(fresh);
      fresh.id = 'acc-avatar';
      $('#acc-name').textContent = S.me.user.name;
    } else if (isTelegramShell) {
      // Inside Telegram: never force Login Widget / phone entry — auto-login handles it.
      $('#tg-widget').hidden = true;
      $('#login-hint').hidden = true;
      $('#dev-form').hidden = !S.config.devAuth;
      const auto = $('#tg-autologin');
      if (auto) auto.hidden = false;
    } else {
      // Plain browser: show Login Widget
      $('#tg-widget').hidden = false;
      const auto = $('#tg-autologin');
      if (auto) auto.hidden = true;
      mountTelegramWidget();
      $('#login-hint').hidden = Boolean(S.config.loginEnabled);
      $('#dev-form').hidden = !S.config.devAuth;
    }
  }

  function renderAwards() {
    const list = (S.me && S.me.awards) || [];
    $('#awards').hidden = list.length === 0;
    const ul = $('#award-list');
    ul.textContent = '';
    for (const a of list) {
      const li = document.createElement('li');
      li.textContent = a.title + ' · ' + a.sponsor;
      const small = document.createElement('small');
      small.textContent = tierName(a.tier) + ' · #' + a.rank + ' · ' + a.period_key + ' · ' + tr('status_' + a.status);
      li.appendChild(small);
      ul.appendChild(li);
    }
  }

  function renderMenu() {
    const tier = S.tier;
    $$('#menu-tiers [data-tier]').forEach((b) => {
      b.textContent = tierName(b.dataset.tier);
      b.setAttribute('aria-pressed', String(b.dataset.tier === tier));
    });
    $('#tier-desc').textContent = tr('tierDesc_' + tier);

    const daily = $('#btn-daily');
    const sub = $('#daily-sub');
    const best = $('#best-daily');
    if (!S.me) {
      daily.disabled = true;
      sub.textContent = tr('dailyLogin');
      best.textContent = '';
    } else {
      const t = S.me.trials[tier];
      daily.disabled = t.left <= 0;
      sub.textContent = t.left > 0
        ? tr(t.left === 1 ? 'dailyLeft' : 'dailyLeftPlural', { n: t.left })
        : tr('dailyNext', { t: formatLeft(S.me.resetsAt - Date.now()) });
      best.textContent = tr('bestToday') + ': ' + fmt(S.me.best[tier].today);
    }
    $('#best-practice').textContent = tr('bestPractice') + ': ' + fmt(getPracticeBest(tier));
    renderAwards();
  }

  function applyLang() {
    document.documentElement.lang = lang;
    $$('[data-i18n]').forEach((el) => { el.textContent = tr(el.getAttribute('data-i18n')); });
    $$('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === lang)));
    renderAccount();
    renderMenu();
    if ($('#screen-board').classList.contains('active')) renderBoardChrome();
  }

  /* ---------------- rule banner (icons + text) ---------------- */
  function glyph(shape, color) {
    const fill = color ? COLOR_HEX[color] : 'none';
    let el;
    if (shape === 'square') el = '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/>';
    else if (shape === 'triangle') el = '<polygon points="12,3 21.5,19.5 2.5,19.5" stroke-linejoin="round"/>';
    else el = '<circle cx="12" cy="12" r="8.5"/>';
    return '<g fill="' + fill + '" stroke="#fff" stroke-width="1.8">' + el + '</g>';
  }
  function chip(inner, negate) {
    const slash = negate
      ? '<line x1="4" y1="20" x2="20" y2="4" stroke="#0b1020" stroke-width="5" stroke-linecap="round"/>' +
        '<line x1="4" y1="20" x2="20" y2="4" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>'
      : '';
    return '<svg class="chip" viewBox="0 0 24 24" aria-hidden="true">' + inner + slash + '</svg>';
  }
  function ruleChips(rule) {
    switch (rule.kind) {
      case 'color': return chip(glyph('circle', rule.color), false);
      case 'shape': return chip(glyph(rule.shape, null), false);
      case 'not_color': return chip(glyph('circle', rule.color), true);
      case 'not_shape': return chip(glyph(rule.shape, null), true);
      case 'both': return chip(glyph(rule.shape, rule.color), false);
      default: return '';
    }
  }

  /* ---------------- canvas ---------------- */
  const canvas = $('#field');
  const ctx = canvas.getContext('2d');
  let cssSize = 300;
  let dpr = 1;

  function resizeCanvas() {
    const wrap = $('.field-wrap');
    const size = Math.max(200, Math.floor(wrap.clientWidth));
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    cssSize = size;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
  }

  function pathShape(shape, cx, cy, r) {
    ctx.beginPath();
    if (shape === 'circle') {
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
    } else if (shape === 'square') {
      const s = r * 0.86;
      const rad = r * 0.22;
      ctx.moveTo(cx - s + rad, cy - s);
      ctx.arcTo(cx + s, cy - s, cx + s, cy + s, rad);
      ctx.arcTo(cx + s, cy + s, cx - s, cy + s, rad);
      ctx.arcTo(cx - s, cy + s, cx - s, cy - s, rad);
      ctx.arcTo(cx - s, cy - s, cx + s, cy - s, rad);
      ctx.closePath();
    } else {
      const rr = r * 1.12;
      ctx.moveTo(cx, cy - rr);
      ctx.lineTo(cx + rr * 0.866, cy + rr * 0.5);
      ctx.lineTo(cx - rr * 0.866, cy + rr * 0.5);
      ctx.closePath();
    }
  }

  const easeOutBack = (x) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  };

  function drawTarget(target, t, k) {
    const age = t - target.t;
    const remaining = target.end - t;
    const scale = 0.4 + 0.6 * easeOutBack(clamp(age / 140, 0, 1));
    const alpha = clamp(remaining / 160, 0, 1) * clamp(age / 60, 0.25, 1);
    const cx = target.x * k;
    const cy = target.y * k;
    const r = C.TARGET_R * k * scale;
    const hex = COLOR_HEX[target.color];

    ctx.save();
    ctx.globalAlpha = alpha;
    // timing ring: shrinks towards the target and touches it when time runs out
    ctx.beginPath();
    ctx.arc(cx, cy, C.TARGET_R * k * (1 + 1.1 * (remaining / target.life)), 0, Math.PI * 2);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.stroke();
    ctx.shadowColor = hex;
    ctx.shadowBlur = 16;
    pathShape(target.shape, cx, cy, r);
    ctx.fillStyle = hex;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.stroke();
    ctx.restore();
  }

  function drawEffects(now, k) {
    const list = game.effects;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      const p = (now - e.t0) / e.dur;
      if (p >= 1) { list.splice(i, 1); continue; }
      const x = e.x * k;
      const y = e.y * k;
      ctx.save();
      if (e.type === 'burst') {
        ctx.globalAlpha = 1 - p;
        ctx.strokeStyle = e.color;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(x, y, C.TARGET_R * k * (0.9 + 1.3 * p), 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = e.color;
        for (let j = 0; j < 8; j++) {
          const a = (j * Math.PI) / 4 + 0.4;
          const d = C.TARGET_R * k * (0.9 + 1.8 * p);
          ctx.beginPath();
          ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, 3 * (1 - p) + 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (e.type === 'text') {
        ctx.globalAlpha = 1 - p * p;
        ctx.font = '800 ' + (e.size || 20) + 'px system-ui, "Noto Sans Georgian", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(8,12,30,0.85)';
        ctx.fillStyle = e.color;
        const yy = y - 22 - (e.oy || 0) - p * 30;
        ctx.strokeText(e.text, x, yy);
        ctx.fillText(e.text, x, yy);
      } else if (e.type === 'cross') {
        ctx.globalAlpha = 1 - p;
        ctx.strokeStyle = '#ff4d5e';
        ctx.lineWidth = 5;
        ctx.lineCap = 'round';
        const s = 16 + p * 6;
        ctx.beginPath();
        ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s);
        ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s);
        ctx.stroke();
      } else if (e.type === 'ripple') {
        ctx.globalAlpha = 0.5 * (1 - p);
        ctx.strokeStyle = '#93a0d0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, 8 + 24 * p, 0, Math.PI * 2);
        ctx.stroke();
      } else if (e.type === 'miss') {
        ctx.globalAlpha = 0.6 * (1 - p);
        ctx.strokeStyle = '#ffffff';
        ctx.setLineDash([6, 6]);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, C.TARGET_R * k * (1 - 0.25 * p), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  function render(now, t) {
    const g = game;
    const k = cssSize / C.FIELD;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssSize, cssSize);
    ctx.save();
    if (now < g.shakeUntil) {
      const p = (g.shakeUntil - now) / 220;
      ctx.translate(Math.sin(now * 0.09) * 6 * p, Math.cos(now * 0.11) * 4 * p);
    }
    if (t >= 0 && !g.engine.ended) {
      const tgs = g.schedule.targets;
      for (let i = 0; i < tgs.length; i++) {
        const target = tgs[i];
        if (target.t > t) break;
        if (t >= target.end || g.engine.state[i] !== 0) continue;
        drawTarget(target, t, k);
      }
    }
    drawEffects(now, k);
    ctx.restore();
    if (now < g.flashUntil) {
      ctx.fillStyle = 'rgba(255,77,94,' + (0.28 * ((g.flashUntil - now) / 200)).toFixed(3) + ')';
      ctx.fillRect(0, 0, cssSize, cssSize);
    }
  }

  /* ---------------- game flow ---------------- */
  let game = null;
  const hudCache = { score: -1, combo: -1, mult: '', time: -1, fill: -1, cd: null, rule: -1, warn: null };

  function setRuleUI(idx, animate) {
    const rule = game.schedule.rules[idx];
    $('#rule-chips').innerHTML = ruleChips(rule); // static markup built from fixed enums only
    $('#rule-text').textContent = I18N.ruleText(lang, rule);
    const box = $('#rule');
    if (animate) {
      box.classList.remove('flash');
      void box.offsetWidth;
      box.classList.add('flash');
    }
    hudCache.rule = idx;
  }

  function onEngineEvent(ev) {
    if (!game) return;
    if (ev.type === 'miss') {
      game.effects.push({ type: 'miss', x: ev.x, y: ev.y, t0: performance.now(), dur: 380 });
    }
  }

  /** o = { mode: 'daily' | 'practice', tier, seed, runId? } */
  function startGame(o) {
    const schedule = Core.buildSchedule(o.seed, o.tier);
    game = {
      mode: o.mode,
      tier: o.tier,
      seed: o.seed,
      runId: o.runId || null,
      schedule,
      engine: new Core.Engine(schedule, onEngineEvent),
      inputs: [],
      startAt: performance.now() + COUNTDOWN_MS,
      effects: [],
      shakeUntil: 0,
      flashUntil: 0,
      endAt: 0,
      done: false,
      raf: 0,
    };
    Object.assign(hudCache, { score: -1, combo: -1, mult: '', time: -1, fill: -1, cd: null, rule: -1, warn: null });
    $('#hud-time-lbl').textContent = tr('time') + ' · ' + tierName(o.tier);
    showScreen('game');
    setAppHeight();
    resizeCanvas();
    setRuleUI(0, true);
    closingConfirmation(true);
    game.raf = requestAnimationFrame(frame);
  }

  function startPractice() {
    startGame({ mode: 'practice', tier: S.tier, seed: 'practice-' + Math.random().toString(36).slice(2, 10) });
  }

  async function startOfficial() {
    if (!S.me) return;
    const tier = S.tier;
    const t = S.me.trials[tier];
    if (!t || t.left <= 0) { toast(tr('noTrials')); return; }
    const ok = await confirmAsync(tr('confirmDaily', { tier: tierName(tier), n: t.total }));
    if (!ok) return;
    const r = await api('/api/run/start', { tier });
    if (r.status === 401) {
      const recovered = await recoverSession();
      if (recovered) {
        const r2 = await api('/api/run/start', { tier });
        if (r2.ok) { startGame({ mode: 'daily', tier, seed: r2.data.seed, runId: r2.data.runId }); return; }
      }
      toast(tr('sessionExpired'));
      return;
    }
    if (r.status === 409) { await loadMe(); renderMenu(); toast(tr('noTrials')); return; }
    if (!r.ok) { toast(r.status === 0 ? tr('netError') : tr('serverError')); return; }
    startGame({ mode: 'daily', tier, seed: r.data.seed, runId: r.data.runId });
  }

  function updateHUD(t) {
    const g = game;
    const e = g.engine;

    const score = Math.max(0, e.score);
    if (score !== hudCache.score) { $('#hud-score').textContent = fmt(score); hudCache.score = score; }
    if (e.combo !== hudCache.combo) { $('#hud-combo').textContent = String(e.combo); hudCache.combo = e.combo; }
    const mult = '×' + (1 + C.SCORE.COMBO_STEP * Math.min(e.combo, C.SCORE.COMBO_CAP)).toFixed(1);
    if (mult !== hudCache.mult) { $('#hud-mult').textContent = mult; hudCache.mult = mult; }

    const left = Math.max(0, Math.ceil((C.DURATION - Math.max(t, 0)) / 1000));
    if (left !== hudCache.time) { $('#hud-time').textContent = String(left); hudCache.time = left; }
    const fill = Math.round(clamp(t / C.DURATION, 0, 1) * 1000) / 10;
    if (fill !== hudCache.fill) { $('#timebar-fill').style.width = fill + '%'; hudCache.fill = fill; }

    const idx = t < 0 ? 0 : Core.ruleIndexAt(t);
    if (idx !== hudCache.rule) setRuleUI(idx, true);
    const rule = g.schedule.rules[idx];
    const warn = t >= 0 && !e.ended && idx < g.schedule.rules.length - 1 && rule.end - t < 1300;
    if (warn !== hudCache.warn) { $('#rule').classList.toggle('warn', warn); hudCache.warn = warn; }

    let cd = '';
    if (e.ended) cd = tr('runOver');
    else if (t < 0) cd = String(Math.ceil(-t / 1000));
    else if (t < 500) cd = tr('go');
    if (cd !== hudCache.cd) {
      const el = $('#countdown');
      el.textContent = cd;
      el.classList.toggle('text', Boolean(cd) && !/^\d+$/.test(cd) && cd !== tr('go'));
      el.style.display = cd ? 'grid' : 'none';
      hudCache.cd = cd;
    }
  }

  function frame(now) {
    const g = game;
    if (!g || g.done) return;
    const t = now - g.startAt;
    if (g.engine.ended) {
      updateHUD(t);
      render(now, t);
      if (now >= g.endAt) { finish(); return; }
      g.raf = requestAnimationFrame(frame);
      return;
    }
    if (t >= C.DURATION) { finish(); return; }
    if (t >= 0) g.engine.advance(Math.floor(t));
    updateHUD(t);
    render(now, t);
    g.raf = requestAnimationFrame(frame);
  }

  function onPointerDown(e) {
    const g = game;
    if (!g || g.done || g.engine.ended) return;
    const ts = e.timeStamp > 1e12 ? performance.now() : e.timeStamp;
    const tNow = ts - g.startAt;
    if (tNow < 0 || tNow > C.DURATION) return;
    if (g.inputs.length >= C.ANTICHEAT.MAX_TAPS) return;
    e.preventDefault();

    const rect = canvas.getBoundingClientRect();
    const x = clamp(Math.round(((e.clientX - rect.left) / rect.width) * C.FIELD), 0, C.FIELD);
    const y = clamp(Math.round(((e.clientY - rect.top) / rect.height) * C.FIELD), 0, C.FIELD);

    const ev = g.engine.tap(Math.round(tNow), x, y);
    if (ev.type === 'ended') return;
    g.inputs.push({ t: ev.t, x, y });

    const now = performance.now();
    if (ev.type === 'hit') {
      const target = g.schedule.targets[ev.targetId];
      g.effects.push({ type: 'burst', x: target.x, y: target.y, t0: now, dur: 420, color: COLOR_HEX[target.color] });
      g.effects.push({ type: 'text', x: target.x, y: target.y, t0: now, dur: 650, text: '+' + ev.delta, color: '#ffffff', size: 22 });
      if (ev.perfect) {
        g.effects.push({ type: 'text', x: target.x, y: target.y, t0: now, dur: 650, text: tr('perfectTag'), color: '#ffd93d', size: 13, oy: 22 });
      }
      haptic(ev.perfect ? 'perfect' : 'hit');
    } else if (ev.type === 'wrong') {
      g.effects.push({ type: 'cross', x, y, t0: now, dur: 420 });
      g.effects.push({ type: 'text', x, y, t0: now, dur: 650, text: String(ev.delta), color: '#ff4d5e', size: 22 });
      g.shakeUntil = now + 220;
      g.flashUntil = now + 200;
      haptic('wrong');
    } else {
      g.effects.push({ type: 'ripple', x, y, t0: now, dur: 320 });
      g.effects.push({ type: 'text', x, y, t0: now, dur: 500, text: String(ev.delta), color: '#93a0d0', size: 14 });
      g.shakeUntil = now + 160;
      g.flashUntil = now + 160;
      haptic('wrong');
    }
    if (ev.ended) g.endAt = now + 1000; // hard tier: show the mistake, then finish
  }

  /* ---------------- results ---------------- */
  let lastMode = 'practice';

  function setNote(text, kind) {
    const el = $('#res-note');
    el.hidden = !text;
    el.textContent = text || '';
    el.className = 'note' + (kind ? ' ' + kind : '');
  }

  function setStatsTiles(s) {
    $('#res-hits').textContent = s.hits + '/' + s.validTargets;
    $('#res-perfects').textContent = String(s.perfects);
    $('#res-combo').textContent = String(s.maxCombo);
    $('#res-acc').textContent = Math.round(s.accuracy * 100) + '%';
    $('#res-wrong').textContent = String(s.wrongs);
    $('#res-miss').textContent = String(s.misses);
    $('#res-react').textContent = String(s.avgReaction);
  }

  function showResultScreen(g, stats) {
    $('#res-title').textContent = tr(stats.ended ? 'resultOver' : 'resultTitle');
    $('#res-mode').textContent = (g.mode === 'daily' ? tr('modeDaily') + ' · ' + utcDate() : tr('modePractice')) + ' · ' + tierName(g.tier);
    $('#res-score').textContent = fmt(stats.score);
    $('#res-best').textContent = '';
    $('#res-best').classList.remove('new');
    setStatsTiles(stats);
    $('#btn-retry').hidden = true;
    $('#btn-again').textContent = tr(g.mode === 'daily' ? 'practiceAgain' : 'playAgain');
    lastMode = g.mode;
    showScreen('result');
  }

  function finish() {
    const g = game;
    g.done = true;
    cancelAnimationFrame(g.raf);
    closingConfirmation(false);
    g.engine.advance(C.DURATION + C.LIFE_START * 2);
    const stats = g.engine.stats();
    haptic('done');
    game = null;
    showResultScreen(g, stats);

    if (g.mode === 'practice') {
      const prev = getPracticeBest(g.tier);
      const isBest = stats.score > prev;
      if (isBest) store.set(practiceKey(g.tier), String(stats.score));
      const el = $('#res-best');
      el.textContent = isBest ? tr('newBest') : tr('prevBest') + ': ' + fmt(Math.max(prev, stats.score));
      el.classList.toggle('new', isBest);
      setNote('', '');
      return;
    }

    // Official run: the SERVER replays the inputs and decides the score.
    S.pending = { runId: g.runId, inputs: g.inputs, claimedScore: stats.score, tier: g.tier };
    setNote(tr('verifying'), '');
    submitPending();
  }

  async function submitPending() {
    const p = S.pending;
    if (!p) return;
    $('#btn-retry').hidden = true;
    const r = await api('/api/run/submit', { runId: p.runId, inputs: p.inputs, claimedScore: p.claimedScore });
    if (S.pending !== p) return;
    if (r.ok) {
      S.pending = null;
      const d = r.data;
      $('#res-score').textContent = fmt(d.score);
      setStatsTiles(d.stats);
      if (d.pendingReview) setNote(tr('pendingReview'), '');
      else if (d.rank) setNote(tr('rankLine', { r: d.rank.rank, n: d.rank.of, tier: tierName(d.tier) }), 'ok');
      else setNote('', '');
      await loadMe();
      renderMenu();
      return;
    }
    if (r.status === 0) { setNote(tr('netError'), 'bad'); $('#btn-retry').hidden = false; return; }
    S.pending = null;
    $('#res-score').textContent = '—';
    if (r.status === 422) setNote(tr('rejected'), 'bad');
    else if (r.status === 410) setNote(tr('expired'), 'bad');
    else if (r.status === 401) setNote(tr('sessionExpired'), 'bad');
    else if (r.status === 409) setNote(tr('alreadySubmitted'), 'bad');
    else setNote(tr('serverError'), 'bad');
    await loadMe();
    renderMenu();
  }

  function cancelRun(messageKey) {
    if (!game) return;
    const official = game.mode === 'daily';
    cancelAnimationFrame(game.raf);
    game.done = true;
    game = null;
    closingConfirmation(false);
    showScreen('menu');
    renderMenu();
    toast(tr(official ? 'interruptedOfficial' : messageKey));
    if (official) loadMe().then(renderMenu); // the attempt was consumed when the run started
  }

  /* ---------------- leaderboard ---------------- */
  function renderBoardChrome() {
    $$('#board-tiers [data-btier]').forEach((b) => {
      b.textContent = tierName(b.dataset.btier);
      b.setAttribute('aria-pressed', String(b.dataset.btier === S.boardTier));
    });
    $$('#board-scopes [data-scope]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.scope === S.boardScope)));
  }

  function openBoard(tier) {
    S.boardTier = tier || S.tier;
    showScreen('board');
    loadBoard();
  }

  async function loadBoard() {
    renderBoardChrome();
    const req = ++S.boardReq;
    const [lb, pz] = await Promise.all([
      api('/api/leaderboard?tier=' + S.boardTier + '&scope=' + S.boardScope),
      api('/api/prizes?tier=' + S.boardTier),
    ]);
    if (req !== S.boardReq) return; // a newer request superseded this one

    const list = $('#board-list');
    list.textContent = '';
    const entries = lb.ok ? lb.data.entries : [];
    $('#board-empty').hidden = entries.length > 0;
    for (const e of entries) {
      const li = document.createElement('li');
      if (e.me) li.className = 'me';
      const rk = document.createElement('span'); rk.className = 'rk'; rk.textContent = String(e.rank);
      const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = e.name;
      const sc = document.createElement('b'); sc.className = 'sc'; sc.textContent = fmt(e.score);
      li.append(rk, avatarEl(e.photo, e.name), nm, sc);
      list.appendChild(li);
    }

    const meEl = $('#board-me');
    if (lb.ok && lb.data.me) { meEl.hidden = false; meEl.textContent = tr('yourRank', { r: lb.data.me.rank, s: fmt(lb.data.me.score) }); }
    else if (S.me) { meEl.hidden = false; meEl.textContent = tr('notRanked'); }
    else meEl.hidden = true;

    const prizes = pz.ok ? pz.data.prizes : [];
    $('#prizes').hidden = prizes.length === 0;
    const ul = $('#prize-list');
    ul.textContent = '';
    for (const p of prizes) {
      const li = document.createElement('li');
      const strong = document.createElement('strong');
      strong.textContent = p.title;
      li.appendChild(strong);
      li.appendChild(document.createTextNode(' · '));
      if (p.sponsor_url && /^https:\/\//i.test(p.sponsor_url)) {
        const a = document.createElement('a');
        a.href = p.sponsor_url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = p.sponsor;
        li.appendChild(a);
      } else {
        li.appendChild(document.createTextNode(p.sponsor));
      }
      const small = document.createElement('small');
      const ranks = p.rank_from === p.rank_to ? '#' + p.rank_from : '#' + p.rank_from + '–' + p.rank_to;
      small.textContent = tr('prizeRanks', { r: ranks }) + ' · ' + tr(p.period === 'week' ? 'periodWeek' : 'periodDay');
      li.appendChild(small);
      ul.appendChild(li);
    }
  }

  /* ---------------- wiring ---------------- */
  $$('[data-lang]').forEach((b) => b.addEventListener('click', () => {
    lang = b.dataset.lang;
    store.set('rr_lang', lang);
    applyLang();
  }));
  $$('#menu-tiers [data-tier]').forEach((b) => b.addEventListener('click', () => {
    S.tier = b.dataset.tier;
    store.set('rr_tier', S.tier);
    renderMenu();
  }));
  $$('#board-tiers [data-btier]').forEach((b) => b.addEventListener('click', () => { S.boardTier = b.dataset.btier; loadBoard(); }));
  $$('#board-scopes [data-scope]').forEach((b) => b.addEventListener('click', () => { S.boardScope = b.dataset.scope; loadBoard(); }));

  $('#btn-daily').addEventListener('click', startOfficial);
  $('#btn-practice').addEventListener('click', startPractice);
  $('#btn-board').addEventListener('click', () => openBoard(S.tier));
  $('#btn-board-back').addEventListener('click', () => { renderMenu(); showScreen('menu'); });
  $('#btn-again').addEventListener('click', startPractice);
  $('#btn-retry').addEventListener('click', submitPending);
  $('#btn-result-board').addEventListener('click', () => openBoard(S.tier));
  $('#btn-menu').addEventListener('click', () => { renderMenu(); showScreen('menu'); });

  $('#btn-logout').addEventListener('click', async () => {
    await api('/api/auth/logout', {});
    sessionStore.clear();
    S.me = null;
    renderAccount();
    renderMenu();
  });
  $('#dev-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#dev-name').value.trim() || 'Dev';
    // stable fake id per name so the same dev name returns to the same account
    let h = 7;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 900000000;
    const r = await api('/api/auth/dev', { id: h + 1, name });
    if (r.ok) { await loadMe(); renderAccount(); renderMenu(); } else toast(tr('loginFailed'));
  });

  canvas.addEventListener('pointerdown', onPointerDown, { passive: false });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  // A run cannot be paused: leaving the app mid-run cancels it (otherwise players could study the pattern).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game && !game.done) cancelRun('interrupted');
  });

  function onResize() {
    setAppHeight();
    if (game) resizeCanvas();
  }
  window.addEventListener('resize', onResize);
  if (tg && typeof tg.onEvent === 'function') tg.onEvent('viewportChanged', onResize);

  // keep the "next attempt in H:MM" label fresh and pick up the new day's trials
  setInterval(() => {
    if (!$('#screen-menu').classList.contains('active') || !S.me) return;
    if (Date.now() > S.me.resetsAt) loadMe().then(renderMenu); else renderMenu();
  }, 30000);

  async function init() {
    setAppHeight();
    applyLang();
    showScreen('menu');

    // Normalize any deep-link path Telegram may open to "/" without a full reload of assets
    // (server already SPA-fallbacks; this keeps the address bar clean).
    try {
      if (location.pathname !== '/' && location.pathname !== '/index.html' &&
          !location.pathname.startsWith('/api') && !location.pathname.startsWith('/admin')) {
        history.replaceState(null, '', '/' + (location.search || '') + (location.hash || ''));
      }
    } catch (e) { /* ignore */ }

    const cfg = await api('/api/config');
    if (cfg.ok) S.config = cfg.data;

    if (isTelegramShell) {
      // Mini App path: silent auto-login with initData — no phone number UI.
      renderAccount(); // show "Signing in with Telegram…"
      const r = await ensureMiniAppSession();
      if (!r.ok) {
        // Fallback: try existing Bearer/cookie session
        await loadMe();
      }
      if (!S.me) {
        $('#login-error').hidden = false;
        console.warn('[rule-rush] Mini App login failed:', r.reason || r.status);
      } else {
        maybeRequestPhone(); // optional, non-blocking
      }
    } else {
      // Browser: restore long-lived session; Login Widget available if logged out
      await loadMe();
    }

    renderAccount();
    renderMenu();
    if (/[?&]login=failed/.test(location.search)) {
      $('#login-error').hidden = false;
      try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
    }
  }

  // Boot even if DOM is still parsing (scripts are at end of body, so this is fine)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }
}());
