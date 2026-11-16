'use strict';

const path = require('node:path');
const express = require('express');
const { Store, STATUSES } = require('./db');
const { createAuth } = require('./auth');
const { validateMeta, validateQuestions, validateSubmission, ValidationError } = require('./validation');
const { surveyPage, messagePage } = require('./views');

const MAX_TOKENS_PER_REQUEST = 2000;

function createApp({ dbFile, adminPassword, publicBaseUrl = '', trustProxy = false, secureCookies = false }) {
  const store = new Store(dbFile);
  const auth = createAuth({ password: adminPassword, secureCookies });
  const app = express();

  app.disable('x-powered-by');
  app.set('etag', false);
  if (trustProxy) app.set('trust proxy', 1);

  // Intestazioni di sicurezza e privacy su tutte le risposte.
  // Nessuna risorsa esterna (font/CDN) per non esporre i rispondenti a terze parti.
  app.use((req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
    );
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
    next();
  });

  app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets'), { maxAge: '1h' }));

  // ------------------------------------------------------------- area pubblica

  const noStore = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  };

  app.get('/', (req, res) => {
    res.type('html').send(
      messagePage('Questionario', 'Per partecipare usa il link personale che hai ricevuto.')
    );
  });

  /** Carica il token e il questionario, gestendo i casi non validi. */
  function resolveToken(req, res) {
    const info = store.lookupToken(req.params.token);
    if (!info) {
      res.status(404).type('html').send(
        messagePage('Link non valido', 'Il link non è valido o è stato revocato. Verifica di averlo copiato per intero.', 'error')
      );
      return null;
    }
    if (info.used) {
      res.status(410).type('html').send(
        messagePage('Hai già risposto', 'Questo link è già stato utilizzato: ogni link consente una sola compilazione. Grazie per la partecipazione!', 'info')
      );
      return null;
    }
    const q = store.getQuestionnaire(info.questionnaire_id);
    if (!q || q.status !== 'open') {
      const msg = q && q.status === 'closed'
        ? 'La raccolta delle risposte per questo questionario è terminata.'
        : 'Il questionario non è al momento disponibile. Riprova più tardi.';
      res.status(403).type('html').send(messagePage('Questionario non disponibile', msg, 'info'));
      return null;
    }
    return q;
  }

  app.get('/q/:token', noStore, (req, res) => {
    const q = resolveToken(req, res);
    if (!q) return;
    res.type('html').send(surveyPage(q, `/q/${encodeURIComponent(req.params.token)}`));
  });

  app.post(
    '/q/:token',
    noStore,
    express.urlencoded({ extended: false, limit: '1mb', parameterLimit: 10000 }),
    (req, res) => {
      const q = resolveToken(req, res);
      if (!q) return;
      const { errors, values, answers } = validateSubmission(q, req.body);
      if (errors.size) {
        return res
          .status(422)
          .type('html')
          .send(surveyPage(q, `/q/${encodeURIComponent(req.params.token)}`, values, errors));
      }
      const outcome = store.submitResponse(req.params.token, q.id, answers);
      if (outcome === 'ok') return res.redirect(303, '/grazie');
      if (outcome === 'used') {
        return res.status(410).type('html').send(
          messagePage('Hai già risposto', 'Questo link è già stato utilizzato: ogni link consente una sola compilazione.', 'info')
        );
      }
      if (outcome === 'closed') {
        return res.status(403).type('html').send(
          messagePage('Questionario non disponibile', 'Il questionario non accetta più risposte.', 'info')
        );
      }
      return res.status(404).type('html').send(messagePage('Link non valido', 'Il link non è valido.', 'error'));
    }
  );

  app.get('/grazie', noStore, (req, res) => {
    res.type('html').send(
      messagePage('Grazie!', 'Le tue risposte sono state registrate in forma anonima. Puoi chiudere questa pagina.', 'success')
    );
  });

  // -------------------------------------------------------- area amministratore

  app.get(['/admin', '/admin/'], noStore, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
  });

  const api = express.Router();
  api.use(noStore);
  api.use(express.json({ limit: '2mb' }));

  // Protezione CSRF: le richieste che modificano dati devono avere un header
  // personalizzato (impossibile da inviare cross-origin senza CORS) e Origin coerente.
  api.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (req.get('X-Requested-With') !== 'fetch') return res.status(403).json({ error: 'Richiesta non consentita.' });
    const origin = req.get('Origin');
    if (origin) {
      let host;
      try {
        host = new URL(origin).host;
      } catch {
        host = null;
      }
      if (host !== req.get('host')) return res.status(403).json({ error: 'Origine non consentita.' });
    }
    next();
  });

  api.post('/login', auth.login);
  api.post('/logout', auth.logout);
  api.get('/session', (req, res) => res.json({ authenticated: auth.isLoggedIn(req) }));

  api.use(auth.requireAdmin);

  const loadQ = (req, res, next) => {
    const id = Number(req.params.id);
    const row = Number.isInteger(id) && id > 0 ? store.getQuestionnaireRow(id) : null;
    if (!row) return res.status(404).json({ error: 'Questionario non trovato.' });
    req.q = row;
    next();
  };

  api.get('/questionnaires', (req, res) => res.json(store.listQuestionnaires()));

  api.post('/questionnaires', (req, res) => {
    const meta = validateMeta(req.body);
    const id = store.createQuestionnaire(meta);
    res.status(201).json(store.getQuestionnaire(id));
  });

  api.get('/questionnaires/:id', loadQ, (req, res) => res.json(store.getQuestionnaire(req.q.id)));

  api.put('/questionnaires/:id', loadQ, (req, res) => {
    const meta = validateMeta(req.body);
    const hasQuestions = Array.isArray(req.body.questions);
    const questions = hasQuestions ? validateQuestions(req.body.questions) : null;
    store.tx(() => {
      if (hasQuestions) {
        if (store.countResponses(req.q.id) > 0) {
          throw httpError(409, 'Le domande non sono modificabili perché sono già state raccolte risposte. Duplica il questionario per crearne una nuova versione.');
        }
        const status = store.getQuestionnaireRow(req.q.id).status;
        if (status === 'open') {
          throw httpError(409, 'Sospendi la raccolta (stato "Bozza") prima di modificare le domande.');
        }
        store.replaceQuestions(req.q.id, questions);
      }
      store.updateMeta(req.q.id, meta);
    });
    res.json(store.getQuestionnaire(req.q.id));
  });

  api.post('/questionnaires/:id/status', loadQ, (req, res) => {
    const status = req.body && req.body.status;
    if (!STATUSES.includes(status)) throw httpError(400, 'Stato non valido.');
    if (status === 'open') {
      const full = store.getQuestionnaire(req.q.id);
      if (full.questions.length === 0) throw httpError(400, 'Aggiungi almeno una domanda prima di aprire la raccolta.');
    }
    store.setStatus(req.q.id, status);
    res.json(store.getQuestionnaire(req.q.id));
  });

  api.post('/questionnaires/:id/duplicate', loadQ, (req, res) => {
    const src = store.getQuestionnaire(req.q.id);
    const id = store.tx(() => {
      const newId = store.createQuestionnaire({ title: `${src.title} (copia)`.slice(0, 200), description: src.description });
      store.replaceQuestions(
        newId,
        src.questions.map((x) => ({ type: x.type, text: x.text, required: x.required, options: x.options.map((o) => o.text) }))
      );
      return newId;
    });
    res.status(201).json(store.getQuestionnaire(id));
  });

  api.delete('/questionnaires/:id', loadQ, (req, res) => {
    store.deleteQuestionnaire(req.q.id);
    res.json({ ok: true });
  });

  api.post('/questionnaires/:id/tokens', loadQ, (req, res) => {
    const count = Number(req.body && req.body.count);
    if (!Number.isInteger(count) || count < 1 || count > MAX_TOKENS_PER_REQUEST) {
      throw httpError(400, `Indica un numero di link tra 1 e ${MAX_TOKENS_PER_REQUEST}.`);
    }
    const base = (publicBaseUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const tokens = store.createTokens(req.q.id, count);
    res.status(201).json({ links: tokens.map((t) => `${base}/q/${t}`) });
  });

  api.delete('/questionnaires/:id/tokens/unused', loadQ, (req, res) => {
    res.json({ revoked: store.revokeUnusedTokens(req.q.id) });
  });

  api.get('/questionnaires/:id/results', loadQ, (req, res) => res.json(store.getResults(req.q.id)));

  api.get('/questionnaires/:id/export.csv', loadQ, (req, res) => {
    const { questionnaire, rows } = store.getResponseRows(req.q.id);
    const header = questionnaire.questions.map((x, i) => `D${i + 1}. ${x.text}`);
    const csv = [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n');
    const name = `risposte-${questionnaire.id}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send('﻿' + csv + '\r\n');
  });

  api.use((req, res) => res.status(404).json({ error: 'Risorsa non trovata.' }));

  app.use('/api', api);

  // ------------------------------------------------------------ gestione errori

  app.use((req, res) => {
    res.status(404).type('html').send(messagePage('Pagina non trovata', 'La pagina richiesta non esiste.', 'error'));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    if (err.type === 'entity.too.large') status = 413;
    // Non si registra l'URL della richiesta: potrebbe contenere il token del link.
    if (status >= 500) console.error('Errore interno:', err && err.message);
    const message = status >= 500 ? 'Errore interno del server.' : err.expose !== false && err.message ? err.message : 'Richiesta non valida.';
    if (req.path.startsWith('/api/')) return res.status(status).json({ error: message });
    res.status(status).type('html').send(messagePage('Errore', status >= 500 ? 'Si è verificato un errore. Riprova.' : message, 'error'));
  });

  return { app, store };
}

function httpError(status, message) {
  const e = new ValidationError(message);
  e.status = status;
  return e;
}

/** Cella CSV con escape e protezione da formula injection. */
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = { createApp, csvCell };
