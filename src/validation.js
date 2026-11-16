'use strict';

const { QUESTION_TYPES } = require('./db');

const LIMITS = {
  title: 200,
  description: 5000,
  questionText: 1000,
  optionText: 300,
  maxQuestions: 200,
  maxOptions: 50,
  answerText: 5000,
};

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function validateMeta(body) {
  const title = str(body && body.title);
  const description = str(body && body.description);
  if (!title) throw new ValidationError('Il titolo è obbligatorio.');
  if (title.length > LIMITS.title) throw new ValidationError(`Il titolo supera ${LIMITS.title} caratteri.`);
  if (description.length > LIMITS.description) {
    throw new ValidationError(`La descrizione supera ${LIMITS.description} caratteri.`);
  }
  return { title, description };
}

/** Valida l'elenco di domande inviato dall'editor amministratore. */
function validateQuestions(list) {
  if (!Array.isArray(list)) throw new ValidationError('Elenco domande non valido.');
  if (list.length > LIMITS.maxQuestions) throw new ValidationError(`Massimo ${LIMITS.maxQuestions} domande.`);
  return list.map((raw, i) => {
    const n = i + 1;
    const type = raw && raw.type;
    if (!QUESTION_TYPES.includes(type)) throw new ValidationError(`Domanda ${n}: tipo non valido.`);
    const text = str(raw.text);
    if (!text) throw new ValidationError(`Domanda ${n}: il testo è obbligatorio.`);
    if (text.length > LIMITS.questionText) {
      throw new ValidationError(`Domanda ${n}: il testo supera ${LIMITS.questionText} caratteri.`);
    }
    const required = raw.required !== false;
    let options = [];
    if (type !== 'open') {
      if (!Array.isArray(raw.options)) throw new ValidationError(`Domanda ${n}: opzioni mancanti.`);
      options = raw.options.map(str).filter(Boolean);
      if (options.length < 2) throw new ValidationError(`Domanda ${n}: servono almeno 2 risposte possibili.`);
      if (options.length > LIMITS.maxOptions) {
        throw new ValidationError(`Domanda ${n}: massimo ${LIMITS.maxOptions} risposte possibili.`);
      }
      if (options.some((o) => o.length > LIMITS.optionText)) {
        throw new ValidationError(`Domanda ${n}: una risposta supera ${LIMITS.optionText} caratteri.`);
      }
      const seen = new Set(options.map((o) => o.toLocaleLowerCase('it')));
      if (seen.size !== options.length) throw new ValidationError(`Domanda ${n}: risposte possibili duplicate.`);
    }
    return { type, text, required, options };
  });
}

/**
 * Valida le risposte del modulo pubblico rispetto alla struttura del questionario.
 * `body` è il risultato di express.urlencoded (chiavi `q_<id>`, valori stringa o array).
 * Ritorna { errors: Map<questionId, msg>, values: Map<questionId, string|string[]>, answers }.
 */
function validateSubmission(questionnaire, body) {
  const errors = new Map();
  const values = new Map();
  const answers = { text: [], choice: [] };
  body = body || {};

  for (const q of questionnaire.questions) {
    const raw = body[`q_${q.id}`];
    const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];

    if (q.type === 'open') {
      const value = typeof list[0] === 'string' ? list[0].replace(/\r\n/g, '\n').trim() : '';
      values.set(q.id, value);
      if (!value) {
        if (q.required) errors.set(q.id, 'Questa domanda è obbligatoria.');
        continue;
      }
      if (value.length > LIMITS.answerText) {
        errors.set(q.id, `La risposta supera ${LIMITS.answerText} caratteri.`);
        continue;
      }
      answers.text.push({ questionId: q.id, value });
      continue;
    }

    const validIds = new Set(q.options.map((o) => String(o.id)));
    const picked = [...new Set(list.filter((v) => typeof v === 'string'))];
    values.set(q.id, picked);
    if (picked.some((v) => !validIds.has(v))) {
      errors.set(q.id, 'Risposta non valida.');
      continue;
    }
    if (q.type === 'single' && picked.length > 1) {
      errors.set(q.id, 'Seleziona una sola risposta.');
      continue;
    }
    if (picked.length === 0) {
      if (q.required) errors.set(q.id, 'Questa domanda è obbligatoria.');
      continue;
    }
    for (const v of picked) answers.choice.push({ questionId: q.id, optionId: Number(v) });
  }
  return { errors, values, answers };
}

module.exports = { validateMeta, validateQuestions, validateSubmission, ValidationError, LIMITS };
