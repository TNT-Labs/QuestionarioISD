'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const QUESTION_TYPES = ['open', 'single', 'multiple'];
const STATUSES = ['draft', 'open', 'closed'];

/*
 * Note sull'anonimato (vedi anche README):
 * - La tabella `tokens` contiene solo l'hash SHA-256 del link e un flag `used`:
 *   nessun timestamp, nessun riferimento alla risposta.
 * - Le tabelle `responses`/`answers_*` non hanno timestamp né rowid
 *   (WITHOUT ROWID con chiave casuale), quindi l'ordine fisico delle righe non
 *   rivela l'ordine di invio e non è possibile collegare una risposta a un link.
 * - secure_delete sovrascrive i dati cancellati.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS questionnaires (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  status      TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  questionnaire_id INTEGER NOT NULL REFERENCES questionnaires(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  type             TEXT    NOT NULL CHECK (type IN ('open','single','multiple')),
  text             TEXT    NOT NULL,
  required         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_questions_q ON questions(questionnaire_id, position);

CREATE TABLE IF NOT EXISTS options (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  text        TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_options_q ON options(question_id, position);

CREATE TABLE IF NOT EXISTS tokens (
  token_hash       TEXT    PRIMARY KEY,
  questionnaire_id INTEGER NOT NULL REFERENCES questionnaires(id) ON DELETE CASCADE,
  used             INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_tokens_q ON tokens(questionnaire_id, used);

CREATE TABLE IF NOT EXISTS responses (
  id               TEXT    PRIMARY KEY,
  questionnaire_id INTEGER NOT NULL REFERENCES questionnaires(id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_responses_q ON responses(questionnaire_id);

CREATE TABLE IF NOT EXISTS answers_text (
  response_id TEXT    NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  value       TEXT    NOT NULL,
  PRIMARY KEY (response_id, question_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_answers_text_q ON answers_text(question_id);

CREATE TABLE IF NOT EXISTS answers_choice (
  response_id TEXT    NOT NULL REFERENCES responses(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  option_id   INTEGER NOT NULL REFERENCES options(id) ON DELETE CASCADE,
  PRIMARY KEY (response_id, option_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_answers_choice_q ON answers_choice(question_id);
`;

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function generateToken() {
  // 128 bit di entropia, codifica URL-safe (22 caratteri)
  return crypto.randomBytes(16).toString('base64url');
}

class Store {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA secure_delete = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  /** Esegue fn in una transazione IMMEDIATE (lock in scrittura acquisito subito). */
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---------------------------------------------------------------- questionari

  listQuestionnaires() {
    return this.db.prepare(`
      SELECT q.id, q.title, q.description, q.status, q.created_at,
        (SELECT COUNT(*) FROM questions  WHERE questionnaire_id = q.id)             AS question_count,
        (SELECT COUNT(*) FROM tokens     WHERE questionnaire_id = q.id)             AS token_count,
        (SELECT COUNT(*) FROM tokens     WHERE questionnaire_id = q.id AND used = 0) AS token_unused,
        (SELECT COUNT(*) FROM responses  WHERE questionnaire_id = q.id)             AS response_count
      FROM questionnaires q
      ORDER BY q.id DESC
    `).all().map(plain);
  }

  getQuestionnaireRow(id) {
    const row = this.db.prepare('SELECT * FROM questionnaires WHERE id = ?').get(id);
    return row ? plain(row) : null;
  }

  /** Questionario completo con domande e opzioni. */
  getQuestionnaire(id) {
    const q = this.getQuestionnaireRow(id);
    if (!q) return null;
    const questions = this.db
      .prepare('SELECT id, type, text, required FROM questions WHERE questionnaire_id = ? ORDER BY position, id')
      .all(id)
      .map(plain);
    const optStmt = this.db.prepare('SELECT id, text FROM options WHERE question_id = ? ORDER BY position, id');
    for (const question of questions) {
      question.required = !!question.required;
      question.options = question.type === 'open' ? [] : optStmt.all(question.id).map(plain);
    }
    q.questions = questions;
    q.response_count = this.countResponses(id);
    q.token_count = this.db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE questionnaire_id = ?').get(id).n;
    q.token_unused = this.db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE questionnaire_id = ? AND used = 0').get(id).n;
    return q;
  }

  countResponses(id) {
    return this.db.prepare('SELECT COUNT(*) AS n FROM responses WHERE questionnaire_id = ?').get(id).n;
  }

  createQuestionnaire({ title, description }) {
    const r = this.db
      .prepare('INSERT INTO questionnaires (title, description) VALUES (?, ?)')
      .run(title, description || '');
    return Number(r.lastInsertRowid);
  }

  updateMeta(id, { title, description }) {
    this.db.prepare('UPDATE questionnaires SET title = ?, description = ? WHERE id = ?').run(title, description || '', id);
  }

  /** Sostituisce l'intera struttura delle domande (consentito solo senza risposte). */
  replaceQuestions(id, questions) {
    this.db.prepare('DELETE FROM questions WHERE questionnaire_id = ?').run(id);
    const insQ = this.db.prepare(
      'INSERT INTO questions (questionnaire_id, position, type, text, required) VALUES (?, ?, ?, ?, ?)'
    );
    const insO = this.db.prepare('INSERT INTO options (question_id, position, text) VALUES (?, ?, ?)');
    questions.forEach((question, i) => {
      const qid = Number(insQ.run(id, i, question.type, question.text, question.required ? 1 : 0).lastInsertRowid);
      if (question.type !== 'open') {
        question.options.forEach((opt, j) => insO.run(qid, j, opt));
      }
    });
  }

  setStatus(id, status) {
    this.db.prepare('UPDATE questionnaires SET status = ? WHERE id = ?').run(status, id);
  }

  deleteQuestionnaire(id) {
    this.db.prepare('DELETE FROM questionnaires WHERE id = ?').run(id);
  }

  // --------------------------------------------------------------------- token

  /** Genera `count` nuovi link monouso. Restituisce i token in chiaro (non vengono salvati). */
  createTokens(questionnaireId, count) {
    const ins = this.db.prepare('INSERT INTO tokens (token_hash, questionnaire_id) VALUES (?, ?)');
    const tokens = [];
    this.tx(() => {
      for (let i = 0; i < count; i++) {
        const t = generateToken();
        ins.run(hashToken(t), questionnaireId);
        tokens.push(t);
      }
    });
    return tokens;
  }

  revokeUnusedTokens(questionnaireId) {
    return Number(this.db.prepare('DELETE FROM tokens WHERE questionnaire_id = ? AND used = 0').run(questionnaireId).changes);
  }

  /** Stato di un token: null se inesistente, altrimenti { questionnaire_id, used }. */
  lookupToken(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) return null;
    const row = this.db.prepare('SELECT questionnaire_id, used FROM tokens WHERE token_hash = ?').get(hashToken(token));
    return row ? { questionnaire_id: row.questionnaire_id, used: !!row.used } : null;
  }

  /**
   * Consuma il token e salva la risposta in modo atomico.
   * `answers` è già validato: { text: [{questionId, value}], choice: [{questionId, optionId}] }.
   * Ritorna 'ok' | 'used' | 'invalid' | 'closed'.
   */
  submitResponse(token, questionnaireId, answers) {
    const hash = hashToken(token);
    return this.tx(() => {
      const q = this.db.prepare('SELECT status FROM questionnaires WHERE id = ?').get(questionnaireId);
      if (!q) return 'invalid';
      if (q.status !== 'open') return 'closed';
      const upd = this.db
        .prepare('UPDATE tokens SET used = 1 WHERE token_hash = ? AND questionnaire_id = ? AND used = 0')
        .run(hash, questionnaireId);
      if (Number(upd.changes) !== 1) {
        const exists = this.db.prepare('SELECT 1 FROM tokens WHERE token_hash = ?').get(hash);
        return exists ? 'used' : 'invalid';
      }
      // Identificativo casuale: nessuna relazione con il token né con l'ordine di arrivo.
      const responseId = crypto.randomUUID();
      this.db.prepare('INSERT INTO responses (id, questionnaire_id) VALUES (?, ?)').run(responseId, questionnaireId);
      const insT = this.db.prepare('INSERT INTO answers_text (response_id, question_id, value) VALUES (?, ?, ?)');
      const insC = this.db.prepare('INSERT INTO answers_choice (response_id, question_id, option_id) VALUES (?, ?, ?)');
      for (const a of answers.text) insT.run(responseId, a.questionId, a.value);
      for (const a of answers.choice) insC.run(responseId, a.questionId, a.optionId);
      return 'ok';
    });
  }

  // ------------------------------------------------------------------ risultati

  getResults(id) {
    const q = this.getQuestionnaire(id);
    if (!q) return null;
    const total = q.response_count;
    const choiceCounts = this.db.prepare(
      'SELECT option_id, COUNT(*) AS n FROM answers_choice WHERE question_id = ? GROUP BY option_id'
    );
    const choiceRespondents = this.db.prepare(
      'SELECT COUNT(DISTINCT response_id) AS n FROM answers_choice WHERE question_id = ?'
    );
    // Ordinamento per id casuale: l'ordine non riflette l'ordine di invio.
    const texts = this.db.prepare('SELECT value FROM answers_text WHERE question_id = ? ORDER BY response_id');
    const questions = q.questions.map((question) => {
      if (question.type === 'open') {
        const values = texts.all(question.id).map((r) => r.value);
        return { ...question, answered: values.length, answers: values };
      }
      const counts = new Map(choiceCounts.all(question.id).map((r) => [r.option_id, r.n]));
      return {
        ...question,
        answered: choiceRespondents.get(question.id).n,
        options: question.options.map((o) => ({ ...o, count: counts.get(o.id) || 0 })),
      };
    });
    return { id: q.id, title: q.title, status: q.status, total, questions };
  }

  /** Righe per l'export: una per risposta, in ordine casuale (per id). */
  getResponseRows(id) {
    const q = this.getQuestionnaire(id);
    if (!q) return null;
    const ids = this.db
      .prepare('SELECT id FROM responses WHERE questionnaire_id = ? ORDER BY id')
      .all(id)
      .map((r) => r.id);
    const text = new Map();
    for (const r of this.db.prepare(`
      SELECT a.response_id, a.question_id, a.value FROM answers_text a
      JOIN responses r ON r.id = a.response_id WHERE r.questionnaire_id = ?`).all(id)) {
      text.set(`${r.response_id}|${r.question_id}`, r.value);
    }
    const choice = new Map();
    for (const r of this.db.prepare(`
      SELECT a.response_id, a.question_id, o.text FROM answers_choice a
      JOIN responses r ON r.id = a.response_id
      JOIN options o ON o.id = a.option_id
      WHERE r.questionnaire_id = ? ORDER BY o.position`).all(id)) {
      const k = `${r.response_id}|${r.question_id}`;
      if (!choice.has(k)) choice.set(k, []);
      choice.get(k).push(r.text);
    }
    const rows = ids.map((rid) =>
      q.questions.map((question) => {
        const k = `${rid}|${question.id}`;
        return question.type === 'open' ? text.get(k) || '' : (choice.get(k) || []).join('; ');
      })
    );
    return { questionnaire: q, rows };
  }
}

/** Converte gli oggetti a prototipo nullo restituiti da node:sqlite in oggetti semplici. */
function plain(row) {
  return { ...row };
}

module.exports = { Store, QUESTION_TYPES, STATUSES, hashToken, generateToken };
