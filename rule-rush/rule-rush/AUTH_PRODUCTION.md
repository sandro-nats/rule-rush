# Rule Rush — Telegram Auth Production Fixes

## What was broken (and why live Telegram login failed)

### 1. Critical: `signature` field not excluded from Mini App hash (Bot API 8.0+)
Real Telegram clients now append an Ed25519 `signature` field to `initData`.
Telegram’s data-check-string is built from **all fields except `hash` and `signature`**.

The old code only skipped `hash`. Authentic live `initData` therefore failed with `bad_hash`.
This is the #1 reason “tests pass, production Mini App login fails.”

**Fix:** `server/auth.js` → `verifyWebAppInitData` skips both `hash` and `signature`.

### 2. Critical: HttpOnly cookies with `SameSite=Lax` drop inside Telegram Web / some Desktop shells
Mini Apps often run in a cross-origin iframe under `web.telegram.org`.
Browsers treat your cookies as third-party → `SameSite=Lax` is not stored/sent.

**Symptoms:** `/api/auth/webapp` returns 200, then `/api/me` returns 401; user appears logged out;
profile never binds.

**Fix:**
- When `COOKIE_SECURE=1`: cookie is `HttpOnly; SameSite=None; Secure; Partitioned`
- Login JSON also returns `session` (raw token)
- Client stores it and sends `Authorization: Bearer <token>` as fallback
- Server accepts **cookie OR Bearer** (`Auth.extractSessionToken`)

### 3. Production CSRF Origin vs reverse-proxy Host mismatch
```js
// old: host from Origin must equal raw req.headers.host
if (host !== req.headers.host) fail(403, 'bad_origin');
```
Behind nginx/Caddy/Cloudflare, `Host` may be internal (`127.0.0.1:8080`) while
`Origin` is `https://game.example.com` → every POST login fails with `403 bad_origin`.

**Fix:**
- `TRUST_PROXY=1` uses `X-Forwarded-Host`
- `PUBLIC_HOST=game.example.com` allows that origin even if Host is rewritten

### 4. Silent Mini App login failure on the client
Old frontend ignored failed `/api/auth/webapp` responses (no toast/error).

**Fix:** show login error, log reason, re-auth on 401 using initData (`recoverSession`).

### 5. Logout cookie did not clear Secure cookies
Clearing with `SameSite=Lax` does not remove a cookie that was set with `SameSite=None; Secure`.

**Fix:** `clearSessionCookieHeader` mirrors the attributes used at set time.

---

## Production environment checklist

```bash
BOT_TOKEN=...                 # from BotFather (never ship to client)
BOT_USERNAME=YourBot          # without @
ADMIN_TOKEN=$(openssl rand -hex 32)
COOKIE_SECURE=1               # HTTPS required
TRUST_PROXY=1                 # if behind nginx/Caddy/Railway/Fly/Cloudflare
PUBLIC_HOST=your.domain.com   # public hostname for Origin checks
DB_PATH=/var/data/rulerush.db
PORT=8080
HOST=0.0.0.0
# DEV_AUTH must NOT be set in production
```

### BotFather
1. `/setdomain` → your domain (Login Widget)
2. Mini App / Menu Button URL → `https://your.domain.com`
3. Serve the **same** Node process over HTTPS (static + API together)

### Reverse proxy (example Caddy)
```
your.domain.com {
  reverse_proxy 127.0.0.1:8080
}
```
Ensure `Host` and `X-Forwarded-Host` / `X-Forwarded-For` / `X-Forwarded-Proto` are passed.

---

## Session model (after fix)

| Layer | Behaviour |
|---|---|
| Cookie `rr_session` | HttpOnly, SHA-256 hashed in SQLite, 30 days |
| Cookie flags (HTTPS) | `SameSite=None; Secure; Partitioned` |
| JSON `session` | Returned on login; client keeps as Bearer fallback |
| Lookup order | Cookie first, then `Authorization: Bearer` |
| Storage | Only token **hash** in DB — raw token never stored |

---

## Admin API notes / improvements

Current structure is solid:
- Bearer `ADMIN_TOKEN` (constant-time compare)
- Reviews → approve/reject pending anti-cheat flags
- Finalize awards only after period ends and pending reviews clear
- Ban invalidates sessions

Suggested next steps (not required for login):
1. **Simple HTML admin page** at `/admin` gated by the same token (or basic auth) for reviews.
2. **Audit log table** for ban/review/finalize actions.
3. **GET /admin/stats** — users today, pending reviews, top scores.
4. **Rotate ADMIN_TOKEN** via env without code change (already supported).
5. Keep admin off the public SPA; never put `ADMIN_TOKEN` in frontend JS.

---

## Files changed
- `server/auth.js` — signature exclusion, cookie helpers, Bearer extract
- `server/app.js` — session issue, Origin/proxy, login returns `session`
- `server/index.js` — `PUBLIC_HOST`, clearer warnings
- `main.js` — sessionStore, Bearer header, Mini App login + recover
- `test/server.test.js` — signature, Bearer, Secure cookie tests

All 16 core + 22 server tests pass on Node ≥ 22.13.
