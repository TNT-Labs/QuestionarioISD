'use strict';
/*
 * Client minimale per Supabase (PostgREST RPC + Auth), senza librerie esterne:
 * nessuna risorsa caricata da CDN di terze parti.
 * Configurazione in config.js: window.QISD_CONFIG = { supabaseUrl, supabaseKey }.
 */
(function () {
  var cfg = window.QISD_CONFIG || {};
  var baseUrl = String(cfg.supabaseUrl || '').replace(/\/+$/, '');
  var key = String(cfg.supabaseKey || '');
  var SESSION_KEY = 'qisd_admin_session';

  function configured() { return !!(baseUrl && key); }

  function ApiError(message, status, code) {
    var e = new Error(message);
    e.status = status;
    e.code = code || null;
    return e;
  }

  function request(path, opts) {
    if (!configured()) return Promise.reject(ApiError('Applicazione non configurata: impostare supabaseUrl e supabaseKey in config.js.', 0));
    var headers = { apikey: key, 'Content-Type': 'application/json' };
    if (opts.token) headers.Authorization = 'Bearer ' + opts.token;
    return fetch(baseUrl + path, {
      method: opts.method || 'POST',
      headers: headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
    }).then(function (res) {
      return res.text().then(function (txt) {
        var data = null;
        if (txt) { try { data = JSON.parse(txt); } catch (e) { data = txt; } }
        if (!res.ok) {
          var code = data && typeof data === 'object' ? (data.error_code || data.code || data.error || null) : null;
          var msg = (data && (data.message || data.msg || data.error_description || data.error)) || ('Errore ' + res.status);
          // Funzione non presente nel database: lo schema SQL non è stato aggiornato.
          if (code === 'PGRST202') msg = 'Il servizio non è aggiornato: l\'amministratore deve rieseguire supabase/schema.sql su Supabase.';
          throw ApiError(String(msg), res.status, code);
        }
        return data;
      });
    }, function () {
      throw ApiError('Impossibile contattare il server. Controlla la connessione e riprova.', 0);
    });
  }

  // ----------------------------------------------------------- sessione admin

  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { return null; }
  }
  function saveSession(s) {
    try {
      if (s) sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch (e) { /* storage non disponibile: sessione solo in memoria */ }
    session = s;
  }
  var session = loadSession();
  var refreshing = null;

  function fromAuthResponse(d) {
    return {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: Date.now() + (Number(d.expires_in) || 3600) * 1000,
      email: d.user && d.user.email,
    };
  }

  function validToken() {
    if (!session) return Promise.resolve(null);
    if (session.expires_at - Date.now() > 60000) return Promise.resolve(session.access_token);
    if (!refreshing) {
      refreshing = request('/auth/v1/token?grant_type=refresh_token', { body: { refresh_token: session.refresh_token } })
        .then(function (d) { saveSession(fromAuthResponse(d)); return session.access_token; },
              function () { saveSession(null); return null; })
        .then(function (t) { refreshing = null; return t; });
    }
    return refreshing;
  }

  window.QISD = {
    configured: configured,

    /** Chiamata RPC. auth=true usa la sessione amministratore. */
    rpc: function (fn, args, auth) {
      var go = function (token) {
        if (auth && !token) throw ApiError('Sessione scaduta: effettua di nuovo l\'accesso.', 401);
        return request('/rest/v1/rpc/' + fn, { body: args || {}, token: token });
      };
      return auth ? validToken().then(go) : go(null);
    },

    login: function (email, password) {
      return request('/auth/v1/token?grant_type=password', { body: { email: email, password: password } })
        .then(function (d) { saveSession(fromAuthResponse(d)); return session; })
        .catch(function (e) {
          if (e.code === 'email_not_confirmed') {
            throw ApiError('Email non confermata: conferma l\'utente in Supabase (Authentication → Users).', 401, e.code);
          }
          if (e.status === 429) throw ApiError('Troppi tentativi di accesso: attendi qualche minuto e riprova.', 429, e.code);
          if (e.status === 400 || e.status === 401) throw ApiError('Email o password non corretti.', 401, e.code);
          throw e;
        });
    },

    logout: function () {
      var s = session;
      saveSession(null);
      if (!s) return Promise.resolve();
      return request('/auth/v1/logout', { token: s.access_token }).catch(function () {});
    },

    session: function () { return session; },

    h: h,
    clear: function (el) { while (el.firstChild) el.removeChild(el.firstChild); },
  };

  /**
   * Crea un elemento DOM. Il testo è sempre inserito come textContent (mai come HTML),
   * quindi i contenuti inseriti da admin e rispondenti non possono iniettare codice.
   */
  function h(tag, attrs) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) child.forEach(function (c) { append(el, c); });
    else el.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
})();
