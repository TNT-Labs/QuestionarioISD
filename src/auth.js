'use strict';

const crypto = require('node:crypto');

const COOKIE = 'qisd_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 ore
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;

/**
 * Autenticazione dell'amministratore: password singola (ADMIN_PASSWORD),
 * sessioni in memoria con cookie HttpOnly + SameSite=Strict.
 * Riguarda SOLO l'area admin: chi compila il questionario non riceve cookie.
 */
function createAuth({ password, secureCookies }) {
  const passwordDigest = sha256(password);
  const sessions = new Map(); // sid -> scadenza
  const failures = new Map(); // ip -> { count, until } (solo login admin, in memoria)

  function sha256(v) {
    return crypto.createHash('sha256').update(String(v)).digest();
  }

  function parseCookies(header) {
    const out = {};
    for (const part of String(header || '').split(';')) {
      const i = part.indexOf('=');
      if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
  }

  function cookieAttrs(req) {
    const secure = secureCookies || req.secure ? '; Secure' : '';
    return `; Path=/; HttpOnly; SameSite=Strict${secure}`;
  }

  function currentSession(req) {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    if (!sid) return null;
    const exp = sessions.get(sid);
    if (!exp) return null;
    if (exp < Date.now()) {
      sessions.delete(sid);
      return null;
    }
    return sid;
  }

  function login(req, res) {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const f = failures.get(key);
    if (f && f.until > now) {
      const secs = Math.ceil((f.until - now) / 1000);
      return res.status(429).json({ error: `Troppi tentativi. Riprova tra ${secs} secondi.` });
    }
    const given = req.body && typeof req.body.password === 'string' ? req.body.password : '';
    if (!crypto.timingSafeEqual(sha256(given), passwordDigest)) {
      const lockExpired = f && f.until && f.until <= now;
      const count = (f && !lockExpired ? f.count : 0) + 1;
      failures.set(key, { count, until: count >= MAX_FAILS ? now + LOCK_MS : 0 });
      return res.status(401).json({ error: 'Password errata.' });
    }
    failures.delete(key);
    const sid = crypto.randomBytes(32).toString('base64url');
    sessions.set(sid, now + SESSION_TTL_MS);
    res.setHeader('Set-Cookie', `${COOKIE}=${sid}${cookieAttrs(req)}; Max-Age=${SESSION_TTL_MS / 1000}`);
    res.json({ ok: true });
  }

  function logout(req, res) {
    const sid = currentSession(req);
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', `${COOKIE}=${cookieAttrs(req)}; Max-Age=0`);
    res.json({ ok: true });
  }

  function requireAdmin(req, res, next) {
    const sid = currentSession(req);
    if (!sid) return res.status(401).json({ error: 'Sessione non valida o scaduta.' });
    sessions.set(sid, Date.now() + SESSION_TTL_MS); // scadenza scorrevole
    next();
  }

  // Pulizia periodica di sessioni e blocchi scaduti
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, exp] of sessions) if (exp < now) sessions.delete(k);
    for (const [k, f] of failures) if (f.until < now) failures.delete(k);
  }, 10 * 60 * 1000);
  timer.unref();

  return { login, logout, requireAdmin, isLoggedIn: (req) => !!currentSession(req) };
}

module.exports = { createAuth };
