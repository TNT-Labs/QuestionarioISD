'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp, csvCell } = require('../src/app');

const PASSWORD = 'password-di-test';
let server, store, base, cookie;

async function req(method, path, { body, form, headers = {}, auth = true } = {}) {
  const h = { ...headers };
  if (auth && cookie) h.Cookie = cookie;
  let payload;
  if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (form !== undefined) {
    h['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = form;
  }
  if (method !== 'GET' && path.startsWith('/api') && !('X-Requested-With' in h)) h['X-Requested-With'] = 'fetch';
  const res = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual' });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, text, json, headers: res.headers };
}

async function setupQuestionnaire() {
  const created = await req('POST', '/api/questionnaires', { body: { title: 'Test', description: 'Intro' } });
  const id = created.json.id;
  const put = await req('PUT', `/api/questionnaires/${id}`, {
    body: {
      title: 'Test',
      description: 'Intro',
      questions: [
        { type: 'open', text: 'Commento?', required: true },
        { type: 'single', text: 'Colore?', required: true, options: ['Rosso', 'Blu'] },
        { type: 'multiple', text: 'Frutti?', required: false, options: ['Mela', 'Pera', 'Kiwi'] },
      ],
    },
  });
  assert.equal(put.status, 200, put.text);
  return put.json;
}

function form(q, { text = 'ciao', single = 0, multi = [] } = {}) {
  const [qo, qs, qm] = q.questions;
  const p = new URLSearchParams();
  if (text !== null) p.append(`q_${qo.id}`, text);
  if (single !== null) p.append(`q_${qs.id}`, String(qs.options[single].id));
  for (const m of multi) p.append(`q_${qm.id}`, String(qm.options[m].id));
  return p.toString();
}

before(async () => {
  const created = createApp({ dbFile: ':memory:', adminPassword: PASSWORD });
  store = created.store;
  await new Promise((resolve) => {
    server = created.app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  const login = await req('POST', '/api/login', { body: { password: PASSWORD } });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie').split(';')[0];
});

after(() => {
  server.close();
  store.close();
});

test('API admin protetta da login e da header anti-CSRF', async () => {
  assert.equal((await req('GET', '/api/questionnaires', { auth: false })).status, 401);
  assert.equal((await req('POST', '/api/login', { body: { password: 'sbagliata' }, auth: false })).status, 401);
  const csrf = await req('POST', '/api/questionnaires', { body: { title: 'x' }, headers: { 'X-Requested-With': '' } });
  assert.equal(csrf.status, 403);
  const origin = await req('POST', '/api/questionnaires', { body: { title: 'x' }, headers: { Origin: 'https://evil.example' } });
  assert.equal(origin.status, 403);
});

test('validazione domande: le chiuse richiedono almeno 2 risposte distinte', async () => {
  const { json } = await req('POST', '/api/questionnaires', { body: { title: 'V' } });
  const bad = await req('PUT', `/api/questionnaires/${json.id}`, {
    body: { title: 'V', questions: [{ type: 'single', text: 'X', options: ['Solo una'] }] },
  });
  assert.equal(bad.status, 400);
  const dup = await req('PUT', `/api/questionnaires/${json.id}`, {
    body: { title: 'V', questions: [{ type: 'multiple', text: 'X', options: ['A', 'a'] }] },
  });
  assert.equal(dup.status, 400);
  const empty = await req('POST', `/api/questionnaires/${json.id}/status`, { body: { status: 'open' } });
  assert.equal(empty.status, 400, 'non si apre un questionario senza domande');
});

test('link monouso: una sola risposta per link, non riutilizzabile', async () => {
  const q = await setupQuestionnaire();
  const { json: gen } = await req('POST', `/api/questionnaires/${q.id}/tokens`, { body: { count: 2 } });
  const [link1, link2] = gen.links.map((l) => new URL(l).pathname);

  // Questionario in bozza: link non ancora attivo
  assert.equal((await req('GET', link1, { auth: false })).status, 403);
  await req('POST', `/api/questionnaires/${q.id}/status`, { body: { status: 'open' } });

  const page = await req('GET', link1, { auth: false });
  assert.equal(page.status, 200);
  assert.match(page.text, /Commento\?/);
  assert.equal(page.headers.get('set-cookie'), null, 'nessun cookie per chi risponde');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');

  const ok = await req('POST', link1, { form: form(q, { multi: [0, 2] }), auth: false });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/grazie');

  assert.equal((await req('GET', link1, { auth: false })).status, 410);
  assert.equal((await req('POST', link1, { form: form(q), auth: false })).status, 410);

  // Link inesistente
  assert.equal((await req('GET', '/q/AAAAAAAAAAAAAAAAAAAAAA', { auth: false })).status, 404);

  // Il secondo link funziona ancora
  assert.equal((await req('POST', link2, { form: form(q, { single: 1 }), auth: false })).status, 303);

  const { json: res } = await req('GET', `/api/questionnaires/${q.id}/results`);
  assert.equal(res.total, 2);
  assert.deepEqual(res.questions[1].options.map((o) => o.count), [1, 1]);
  assert.deepEqual(res.questions[2].options.map((o) => o.count), [1, 0, 1]);
  assert.equal(res.questions[2].answered, 1);

  // Domande bloccate dopo la prima risposta
  await req('POST', `/api/questionnaires/${q.id}/status`, { body: { status: 'draft' } });
  const locked = await req('PUT', `/api/questionnaires/${q.id}`, { body: { title: 'T', questions: [] } });
  assert.equal(locked.status, 409);
  // ...ma titolo e descrizione restano modificabili
  assert.equal((await req('PUT', `/api/questionnaires/${q.id}`, { body: { title: 'Nuovo titolo' } })).status, 200);
});

test('invii concorrenti con lo stesso link: ne viene accettato solo uno', async () => {
  const q = await setupQuestionnaire();
  await req('POST', `/api/questionnaires/${q.id}/status`, { body: { status: 'open' } });
  const { json: gen } = await req('POST', `/api/questionnaires/${q.id}/tokens`, { body: { count: 1 } });
  const link = new URL(gen.links[0]).pathname;
  const results = await Promise.all(
    Array.from({ length: 10 }, () => req('POST', link, { form: form(q), auth: false }))
  );
  assert.equal(results.filter((r) => r.status === 303).length, 1);
  assert.equal(store.countResponses(q.id), 1);
});

test('risposte non valide: errore senza consumare il link', async () => {
  const q = await setupQuestionnaire();
  await req('POST', `/api/questionnaires/${q.id}/status`, { body: { status: 'open' } });
  const { json: gen } = await req('POST', `/api/questionnaires/${q.id}/tokens`, { body: { count: 1 } });
  const link = new URL(gen.links[0]).pathname;

  const missing = await req('POST', link, { form: form(q, { text: '   ' }), auth: false });
  assert.equal(missing.status, 422);
  assert.match(missing.text, /obbligatoria/);

  const [, qs] = q.questions;
  const forged = `q_${q.questions[0].id}=x&q_${qs.id}=999999`;
  assert.equal((await req('POST', link, { form: forged, auth: false })).status, 422);

  const twoSingle = `q_${q.questions[0].id}=x&q_${qs.id}=${qs.options[0].id}&q_${qs.id}=${qs.options[1].id}`;
  assert.equal((await req('POST', link, { form: twoSingle, auth: false })).status, 422);

  // Il link è ancora valido e ripopola i valori inseriti (con escape HTML)
  const xss = await req('POST', link, { form: form(q, { text: '<script>x</script>', single: null }), auth: false });
  assert.equal(xss.status, 422);
  assert.ok(!xss.text.includes('<script>x</script>'));
  assert.ok(xss.text.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.equal((await req('POST', link, { form: form(q), auth: false })).status, 303);
});

test('anonimato: nessun collegamento tra link e risposta nel database', async () => {
  const cols = (t) => store.db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.deepEqual(cols('tokens').sort(), ['questionnaire_id', 'token_hash', 'used']);
  assert.deepEqual(cols('responses').sort(), ['id', 'questionnaire_id']);
  for (const t of ['tokens', 'responses', 'answers_text', 'answers_choice']) {
    assert.ok(!cols(t).some((c) => /time|date|ip|agent|created/i.test(c)), `${t} senza dati temporali/identificativi`);
    // WITHOUT ROWID: nessun contatore sequenziale che riveli l'ordine di invio
    assert.throws(() => store.db.prepare(`SELECT rowid FROM ${t}`).all());
  }
  // I token sono salvati solo come hash
  const row = store.db.prepare('SELECT token_hash FROM tokens LIMIT 1').get();
  assert.match(row.token_hash, /^[0-9a-f]{64}$/);
});

test('export CSV e revoca link', async () => {
  const q = await setupQuestionnaire();
  await req('POST', `/api/questionnaires/${q.id}/status`, { body: { status: 'open' } });
  const { json: gen } = await req('POST', `/api/questionnaires/${q.id}/tokens`, { body: { count: 3 } });
  const link = new URL(gen.links[0]).pathname;
  await req('POST', link, { form: form(q, { text: '=1+1; "test"', multi: [1, 2] }), auth: false });

  const csv = await req('GET', `/api/questionnaires/${q.id}/export.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.text.includes(`"'=1+1; ""test"""`), 'escape + protezione formule');
  assert.ok(csv.text.includes('Pera; Kiwi'));

  const rev = await req('DELETE', `/api/questionnaires/${q.id}/tokens/unused`);
  assert.equal(rev.json.revoked, 2);
  assert.equal((await req('GET', new URL(gen.links[1]).pathname, { auth: false })).status, 404);
});

test('duplica ed elimina', async () => {
  const q = await setupQuestionnaire();
  const dup = await req('POST', `/api/questionnaires/${q.id}/duplicate`);
  assert.equal(dup.status, 201);
  assert.equal(dup.json.questions.length, 3);
  assert.equal(dup.json.status, 'draft');
  assert.deepEqual(dup.json.questions[2].options.map((o) => o.text), ['Mela', 'Pera', 'Kiwi']);
  assert.equal((await req('DELETE', `/api/questionnaires/${dup.json.id}`)).status, 200);
  assert.equal((await req('GET', `/api/questionnaires/${dup.json.id}`)).status, 404);
});

test('csvCell', () => {
  assert.equal(csvCell('ok'), 'ok');
  assert.equal(csvCell('a;b'), '"a;b"');
  assert.equal(csvCell('-2'), "'-2");
});
