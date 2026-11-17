'use strict';
/*
 * Test dello schema Supabase (supabase/schema.sql) eseguiti su PostgreSQL reale
 * (PGlite) con ruoli anon/authenticated come in Supabase.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createDb, createServer } = require('../dev/local-supabase');

let s, admin, user;

const QUESTIONS = [
  { type: 'open', text: 'Commento?', required: true },
  { type: 'single', text: 'Colore?', required: true, options: ['Rosso', 'Blu'] },
  { type: 'multiple', text: 'Frutti?', required: false, options: ['Mela', 'Pera', 'Kiwi'] },
];

const asAdmin = (fn, args) => s.rpc(fn, args, { sub: admin });
const asAnon = (fn, args) => s.rpc(fn, args);

async function openQuestionnaire(tokens = 1) {
  const id = await asAdmin('admin_create', { p_title: 'Test', p_description: 'Intro' });
  const q = await asAdmin('admin_update', { p_id: id, p_title: 'Test', p_description: 'Intro', p_questions: QUESTIONS });
  await asAdmin('admin_set_status', { p_id: id, p_status: 'open' });
  const toks = await asAdmin('admin_create_tokens', { p_id: id, p_count: tokens });
  return { id, q, toks };
}

function answers(q, { text = 'ciao', single = 0, multi = [] } = {}) {
  const [qo, qs, qm] = q.questions;
  const a = {};
  if (text !== null) a[qo.id] = text;
  if (single !== null) a[qs.id] = [qs.options[single].id];
  if (multi.length) a[qm.id] = multi.map((i) => qm.options[i].id);
  return a;
}

before(async () => {
  s = await createDb();
  admin = await s.addUser('admin@test.it', 'x', { admin: true });
  user = await s.addUser('user@test.it', 'x');
});
after(() => s.close());

test('permessi: anonimi e utenti non admin non accedono alle funzioni di gestione', async () => {
  await assert.rejects(asAnon('admin_list', {}), { code: '42501' });
  await assert.rejects(s.rpc('admin_list', {}, { sub: user }), /amministratori/);
  await assert.rejects(asAnon('_hash_token', { p_token: 'x' }), { code: '42501' });
  // Nessun accesso diretto alle tabelle
  await assert.rejects(
    s.db.transaction(async (tx) => {
      await tx.query("select set_config('role', 'anon', true)");
      await tx.query('select * from public.responses');
    }),
    /permission denied/
  );
  assert.deepEqual(await s.rpc('admin_whoami', {}, { sub: user }), { is_admin: false });
  assert.deepEqual(await asAdmin('admin_whoami', {}), { is_admin: true });
});

test('validazione domande', async () => {
  const id = await asAdmin('admin_create', { p_title: 'V' });
  const bad = (qs) => asAdmin('admin_update', { p_id: id, p_title: 'V', p_description: '', p_questions: qs });
  await assert.rejects(bad([{ type: 'single', text: 'X', options: ['Solo una'] }]), /almeno 2/);
  await assert.rejects(bad([{ type: 'multiple', text: 'X', options: ['A', 'a'] }]), /duplicate/);
  await assert.rejects(bad([{ type: 'boh', text: 'X' }]), /tipo non valido/);
  await assert.rejects(bad([{ type: 'open', text: '   ' }]), /testo è obbligatorio/);
  await assert.rejects(asAdmin('admin_create', { p_title: '  ' }), /titolo è obbligatorio/);
  await assert.rejects(asAdmin('admin_set_status', { p_id: id, p_status: 'open' }), /almeno una domanda/);
  // Opzioni vuote ignorate, ordine preservato
  const ok = await bad([{ type: 'single', text: 'X', options: ['B', '', 'A'] }]);
  assert.deepEqual(ok.questions[0].options.map((o) => o.text), ['B', 'A']);
});

test('link monouso: una sola risposta, poi il link non è più valido', async () => {
  const { id, q, toks } = await openQuestionnaire(2);
  const survey = await asAnon('get_survey', { p_token: toks[0] });
  assert.equal(survey.status, 'ok');
  assert.equal(survey.questionnaire.questions.length, 3);
  assert.equal(survey.questionnaire.id, undefined, 'l\'id interno non viene esposto');

  assert.deepEqual(await asAnon('submit_response', { p_token: toks[0], p_answers: answers(q, { multi: [0, 2] }) }), { status: 'ok' });
  assert.deepEqual(await asAnon('submit_response', { p_token: toks[0], p_answers: answers(q) }), { status: 'invalid' });
  assert.equal((await asAnon('get_survey', { p_token: toks[0] })).status, 'invalid');
  assert.equal((await asAnon('get_survey', { p_token: 'a'.repeat(32) })).status, 'invalid');
  assert.equal((await asAnon('get_survey', { p_token: "x' or 1=1 --" })).status, 'invalid');

  assert.deepEqual(await asAnon('submit_response', { p_token: toks[1], p_answers: answers(q, { single: 1 }) }), { status: 'ok' });

  const r = await asAdmin('admin_results', { p_id: id });
  assert.equal(r.total, 2);
  assert.deepEqual(r.questions[1].options.map((o) => o.count), [1, 1]);
  assert.deepEqual(r.questions[2].options.map((o) => o.count), [1, 0, 1]);
  assert.equal(r.questions[2].answered, 1);
  assert.deepEqual(r.questions[0].answers.sort(), ['ciao', 'ciao']);

  const g = await asAdmin('admin_get', { p_id: id });
  assert.equal(g.token_unused, 0);
  assert.equal(g.response_count, 2);
});

test('stato del questionario: bozza e chiuso non accettano risposte', async () => {
  const { id, q, toks } = await openQuestionnaire(1);
  await asAdmin('admin_set_status', { p_id: id, p_status: 'draft' });
  assert.equal((await asAnon('get_survey', { p_token: toks[0] })).status, 'draft');
  await asAdmin('admin_set_status', { p_id: id, p_status: 'closed' });
  assert.deepEqual(await asAnon('submit_response', { p_token: toks[0], p_answers: answers(q) }), { status: 'closed' });
  // Il link non è stato consumato: riaprendo funziona
  await asAdmin('admin_set_status', { p_id: id, p_status: 'open' });
  assert.deepEqual(await asAnon('submit_response', { p_token: toks[0], p_answers: answers(q) }), { status: 'ok' });
});

test('risposte non valide: errori per domanda e link non consumato', async () => {
  const { q, toks } = await openQuestionnaire(1);
  const [qo, qs, qm] = q.questions;
  const send = (a) => asAnon('submit_response', { p_token: toks[0], p_answers: a });

  let r = await send({ [qo.id]: '   ' });
  assert.equal(r.status, 'errors');
  assert.match(r.errors[qo.id], /obbligatoria/);
  assert.match(r.errors[qs.id], /obbligatoria/);
  assert.equal(r.errors[qm.id], undefined, 'facoltativa');

  r = await send({ [qo.id]: 'x', [qs.id]: [999999] });
  assert.match(r.errors[qs.id], /non valida/);
  r = await send({ [qo.id]: 'x', [qs.id]: [qm.options[0].id] });
  assert.match(r.errors[qs.id], /non valida/, 'opzione di un\'altra domanda');
  r = await send({ [qo.id]: 'x', [qs.id]: qs.options.map((o) => o.id) });
  assert.match(r.errors[qs.id], /una sola/);
  r = await send({ [qo.id]: 'x', [qs.id]: [qs.options[0].id + 0.5] });
  assert.match(r.errors[qs.id], /non valida/);
  r = await send({ [qo.id]: 'x', [qs.id]: 'testo' });
  assert.match(r.errors[qs.id], /non valida/);
  r = await send({ [qo.id]: 'x'.repeat(5001), [qs.id]: [qs.options[0].id] });
  assert.match(r.errors[qo.id], /5000/);
  r = await send({ [qo.id]: { a: 1 }, [qs.id]: [qs.options[0].id] });
  assert.match(r.errors[qo.id], /obbligatoria/);

  assert.deepEqual(await send(answers(q)), { status: 'ok' });
});

test('domande bloccate dopo la prima risposta o con raccolta aperta', async () => {
  const { id, q, toks } = await openQuestionnaire(1);
  const upd = (qs) => asAdmin('admin_update', { p_id: id, p_title: 'Nuovo', p_description: '', p_questions: qs });
  await assert.rejects(upd(QUESTIONS), /Sospendi/);
  await asAnon('submit_response', { p_token: toks[0], p_answers: answers(q) });
  await asAdmin('admin_set_status', { p_id: id, p_status: 'draft' });
  await assert.rejects(upd(QUESTIONS), /già state raccolte/);
  const meta = await asAdmin('admin_update', { p_id: id, p_title: 'Nuovo', p_description: 'd', p_questions: null });
  assert.equal(meta.title, 'Nuovo');
  assert.equal(meta.questions.length, 3);
});

test('anonimato: nessun collegamento tra link e risposta', async () => {
  const cols = async (t) => (await s.db.query(
    `select column_name from information_schema.columns where table_schema='public' and table_name=$1 order by 1`, [t]
  )).rows.map((r) => r.column_name);
  assert.deepEqual(await cols('tokens'), ['questionnaire_id', 'token_hash']);
  assert.deepEqual(await cols('responses'), ['id', 'questionnaire_id']);
  for (const t of ['tokens', 'responses', 'answers_text', 'answers_choice']) {
    const c = await cols(t);
    assert.ok(!c.some((x) => /time|date|ip|agent|created|token_id|user/i.test(x)), `${t}: ${c}`);
  }
  // Solo hash nel DB, mai il token in chiaro
  const { toks } = await openQuestionnaire(1);
  const rows = (await s.db.query('select token_hash from public.tokens')).rows;
  assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash)));
  assert.ok(!rows.some((r) => r.token_hash === toks[0]));
  assert.match(toks[0], /^[0-9a-f]{32}$/);
});

test('export, revoca, duplica ed elimina', async () => {
  const { id, q, toks } = await openQuestionnaire(3);
  await asAnon('submit_response', { p_token: toks[0], p_answers: answers(q, { text: '=1+1; "x"', multi: [1, 2] }) });
  const exp = await asAdmin('admin_export', { p_id: id });
  assert.deepEqual(exp.headers, ['Commento?', 'Colore?', 'Frutti?']);
  assert.deepEqual(exp.rows, [['=1+1; "x"', 'Rosso', 'Pera; Kiwi']]);

  assert.equal(await asAdmin('admin_revoke_tokens', { p_id: id }), 2);
  assert.equal((await asAnon('get_survey', { p_token: toks[1] })).status, 'invalid');

  const dupId = await asAdmin('admin_duplicate', { p_id: id });
  const dup = await asAdmin('admin_get', { p_id: dupId });
  assert.equal(dup.status, 'draft');
  assert.equal(dup.response_count, 0);
  assert.deepEqual(dup.questions.map((x) => x.text), QUESTIONS.map((x) => x.text));
  assert.deepEqual(dup.questions[2].options.map((o) => o.text), ['Mela', 'Pera', 'Kiwi']);

  await asAdmin('admin_delete', { p_id: id });
  await assert.rejects(asAdmin('admin_get', { p_id: id }), /non trovato/);
  assert.equal((await s.db.query('select count(*)::int n from public.answers_text where value = $1', ['=1+1; "x"'])).rows[0].n, 0);
});

test('token: limiti sul numero generato', async () => {
  const id = await asAdmin('admin_create', { p_title: 'T' });
  await assert.rejects(asAdmin('admin_create_tokens', { p_id: id, p_count: 0 }), /tra 1 e 2000/);
  await assert.rejects(asAdmin('admin_create_tokens', { p_id: id, p_count: 2001 }), /tra 1 e 2000/);
  const toks = await asAdmin('admin_create_tokens', { p_id: id, p_count: 50 });
  assert.equal(new Set(toks).size, 50);
});

test('HTTP: endpoint emulati di Supabase (auth + rpc)', async () => {
  const srv = await createServer({ port: 0 });
  try {
    await srv.store.addUser('a@b.it', 'pw', { admin: true });
    const post = (p, body, token) => fetch(srv.url + p, {
      method: 'POST',
      headers: { apikey: srv.apiKey, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    assert.equal((await post('/auth/v1/token?grant_type=password', { email: 'a@b.it', password: 'no' })).status, 400);
    const login = await (await post('/auth/v1/token?grant_type=password', { email: 'a@b.it', password: 'pw' })).json();
    assert.ok(login.access_token);
    assert.equal((await post('/rest/v1/rpc/admin_list', {})).status, 403);
    const list = await post('/rest/v1/rpc/admin_list', {}, login.access_token);
    assert.equal(list.status, 200);
    assert.deepEqual(await list.json(), []);
    const cfg = await (await fetch(srv.url + '/config.js')).text();
    assert.match(cfg, /supabaseUrl/);
    assert.equal((await fetch(srv.url + '/admin/')).status, 200);
  } finally {
    await srv.close();
  }
});

test('link pubblico: disattivato per default, risposte multiple, nessun consumo', async () => {
  const id = await asAdmin('admin_create', { p_title: 'Pubblico' });
  const q = await asAdmin('admin_update', { p_id: id, p_title: 'Pubblico', p_description: '', p_questions: QUESTIONS });
  assert.equal(q.public_slug, null, 'disattivato per default');

  const on = await asAdmin('admin_public_link', { p_id: id, p_action: 'enable' });
  const slug = on.public_slug;
  assert.match(slug, /^[0-9a-f]{32}$/);
  // enable è idempotente: non cambia il link esistente
  assert.equal((await asAdmin('admin_public_link', { p_id: id, p_action: 'enable' })).public_slug, slug);

  // Raccolta non aperta
  assert.equal((await asAnon('get_public_survey', { p_slug: slug })).status, 'draft');
  assert.equal((await asAnon('submit_public_response', { p_slug: slug, p_answers: answers(q) })).status, 'draft');
  await asAdmin('admin_set_status', { p_id: id, p_status: 'open' });

  const s1 = await asAnon('get_public_survey', { p_slug: slug });
  assert.equal(s1.status, 'ok');
  assert.equal(s1.questionnaire.questions.length, 3);
  assert.equal(s1.questionnaire.id, undefined, 'l\'id interno non viene esposto');

  // Stesso link, più risposte: il link non viene consumato
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(await asAnon('submit_public_response', { p_slug: slug, p_answers: answers(q, { single: i % 2 }) }), { status: 'ok' });
  }
  assert.equal((await asAnon('get_public_survey', { p_slug: slug })).status, 'ok');
  const r = await asAdmin('admin_results', { p_id: id });
  assert.equal(r.total, 3);
  assert.deepEqual(r.questions[1].options.map((o) => o.count), [2, 1]);

  // Stessa validazione dei link personali
  const [qo, qs] = q.questions;
  const bad = await asAnon('submit_public_response', { p_slug: slug, p_answers: { [qo.id]: ' ', [qs.id]: [999999] } });
  assert.equal(bad.status, 'errors');
  assert.match(bad.errors[qo.id], /obbligatoria/);
  assert.match(bad.errors[qs.id], /non valida/);
  assert.equal((await asAdmin('admin_get', { p_id: id })).response_count, 3, 'risposta non valida non salvata');

  // Il link pubblico non funziona come link personale e viceversa
  assert.equal((await asAnon('get_survey', { p_token: slug })).status, 'invalid');
  assert.equal((await asAnon('submit_response', { p_token: slug, p_answers: answers(q) })).status, 'invalid');
});

test('link pubblico: rigenera, disattiva, chiusura e coesistenza con i link personali', async () => {
  const { id, q, toks } = await openQuestionnaire(1);
  const slug1 = (await asAdmin('admin_public_link', { p_id: id, p_action: 'enable' })).public_slug;

  const slug2 = (await asAdmin('admin_public_link', { p_id: id, p_action: 'regenerate' })).public_slug;
  assert.notEqual(slug2, slug1);
  assert.equal((await asAnon('get_public_survey', { p_slug: slug1 })).status, 'invalid', 'il vecchio link non funziona più');
  assert.deepEqual(await asAnon('submit_public_response', { p_slug: slug2, p_answers: answers(q) }), { status: 'ok' });

  // I link personali continuano a funzionare in parallelo
  assert.deepEqual(await asAnon('submit_response', { p_token: toks[0], p_answers: answers(q) }), { status: 'ok' });
  assert.equal((await asAdmin('admin_get', { p_id: id })).response_count, 2);

  await asAdmin('admin_set_status', { p_id: id, p_status: 'closed' });
  assert.equal((await asAnon('submit_public_response', { p_slug: slug2, p_answers: answers(q) })).status, 'closed');
  await asAdmin('admin_set_status', { p_id: id, p_status: 'open' });

  assert.equal((await asAdmin('admin_public_link', { p_id: id, p_action: 'disable' })).public_slug, null);
  assert.equal((await asAnon('get_public_survey', { p_slug: slug2 })).status, 'invalid');
  assert.equal((await asAnon('submit_public_response', { p_slug: slug2, p_answers: answers(q) })).status, 'invalid');

  // La copia non eredita il link pubblico
  await asAdmin('admin_public_link', { p_id: id, p_action: 'enable' });
  const dup = await asAdmin('admin_get', { p_id: await asAdmin('admin_duplicate', { p_id: id }) });
  assert.equal(dup.public_slug, null);

  // Permessi e input non validi
  await assert.rejects(asAnon('admin_public_link', { p_id: id, p_action: 'enable' }), { code: '42501' });
  await assert.rejects(s.rpc('admin_public_link', { p_id: id, p_action: 'enable' }, { sub: user }), /amministratori/);
  await assert.rejects(asAdmin('admin_public_link', { p_id: id, p_action: 'boh' }), /Azione non valida/);
  await assert.rejects(asAnon('_store_answers', { p_id: id }), /./);
  assert.equal((await asAnon('get_public_survey', { p_slug: "x' or 1=1 --" })).status, 'invalid');
  assert.equal((await asAnon('get_public_survey', { p_slug: null })).status, 'invalid');
});
