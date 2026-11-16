'use strict';

const { LIMITS } = require('./validation');

function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Converte il testo in paragrafi preservando gli a capo. */
function paragraphs(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function layout(title, body) {
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/assets/survey.css">
</head>
<body>
<main class="wrap">
${body}
</main>
<script src="/assets/survey.js" defer></script>
</body>
</html>`;
}

function messagePage(title, message, kind = 'info') {
  return layout(
    title,
    `<section class="card message message-${esc(kind)}">
  <h1>${esc(title)}</h1>
  <p>${esc(message)}</p>
</section>`
  );
}

function renderQuestion(q, index, value, error) {
  const id = `q_${q.id}`;
  const errId = `${id}_err`;
  const req = q.required ? '<span class="req" aria-hidden="true">*</span>' : '';
  const reqSr = q.required ? '<span class="sr-only"> (obbligatoria)</span>' : '';
  const errHtml = error ? `<p class="field-error" id="${errId}">${esc(error)}</p>` : '';
  const invalid = error ? ` aria-invalid="true" aria-describedby="${errId}"` : '';
  const cls = `question${error ? ' has-error' : ''}`;

  if (q.type === 'open') {
    return `<div class="${cls}">
  <label class="q-title" for="${id}"><span class="q-num">${index}.</span> ${esc(q.text)}${req}${reqSr}</label>
  ${errHtml}
  <textarea id="${id}" name="${id}" rows="4" maxlength="${LIMITS.answerText}"${q.required ? ' required' : ''}${invalid}>${esc(value || '')}</textarea>
</div>`;
  }

  const picked = new Set(Array.isArray(value) ? value : []);
  const inputType = q.type === 'single' ? 'radio' : 'checkbox';
  const hint = q.type === 'multiple' ? '<span class="q-hint">Puoi selezionare più risposte.</span>' : '';
  const opts = q.options
    .map((o) => {
      const oid = `${id}_${o.id}`;
      const checked = picked.has(String(o.id)) ? ' checked' : '';
      const reqAttr = q.required && q.type === 'single' ? ' required' : '';
      return `<label class="choice" for="${oid}"><input type="${inputType}" id="${oid}" name="${id}" value="${o.id}"${checked}${reqAttr}><span>${esc(o.text)}</span></label>`;
    })
    .join('\n    ');
  const groupReq = q.required && q.type === 'multiple' ? ' data-required-group="1"' : '';
  return `<fieldset class="${cls}"${groupReq}${invalid}>
  <legend class="q-title"><span class="q-num">${index}.</span> ${esc(q.text)}${req}${reqSr}${hint}</legend>
  ${errHtml}
  <div class="choices">
    ${opts}
  </div>
</fieldset>`;
}

/**
 * Pagina del questionario. `action` è l'URL relativo di invio (contiene il token).
 * values/errors: Map<questionId, ...> per ripopolare il modulo dopo un errore.
 */
function surveyPage(q, action, values = new Map(), errors = new Map()) {
  const hasRequired = q.questions.some((x) => x.required);
  const summary = errors.size
    ? `<div class="alert" role="alert" tabindex="-1" id="error-summary">Alcune risposte non sono valide o mancano: controlla i campi evidenziati.</div>`
    : '';
  const body = `<header class="card intro">
  <h1>${esc(q.title)}</h1>
  ${paragraphs(q.description)}
  <p class="privacy">🔒 Il questionario è anonimo: le tue risposte non vengono associate al link ricevuto né a dati che possano identificarti. Il link è personale e può essere usato una sola volta.</p>
  ${hasRequired ? '<p class="legend-req"><span class="req">*</span> domanda obbligatoria</p>' : ''}
</header>
${summary}
<form class="card" method="post" action="${esc(action)}" autocomplete="off">
${q.questions.map((x, i) => renderQuestion(x, i + 1, values.get(x.id), errors.get(x.id))).join('\n')}
  <div class="actions">
    <p class="warn">Dopo l'invio non sarà possibile modificare le risposte.</p>
    <button type="submit" class="btn">Invia risposte</button>
  </div>
</form>`;
  return layout(q.title, body);
}

module.exports = { surveyPage, messagePage, esc };
