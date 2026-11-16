'use strict';
/*
 * Pagina di compilazione. Il link personale è nel frammento dell'URL (#t=...):
 * il frammento non viene mai inviato a GitHub Pages, quindi non compare nei log
 * del server che ospita il sito. Nessun cookie né storage locale.
 */
(function () {
  var h = QISD.h;
  var app = document.getElementById('app');
  var MAX_TEXT = 5000;

  function tokenFromHash() {
    var m = location.hash.match(/^#(?:t=)?([A-Za-z0-9_-]{16,64})$/);
    return m ? m[1] : null;
  }

  function message(title, text, kind) {
    QISD.clear(app);
    var sec = h('section', { class: 'card message message-' + (kind || 'info') },
      h('h1', { text: title, tabindex: '-1' }),
      h('p', { text: text }));
    app.appendChild(sec);
    sec.querySelector('h1').focus();
  }

  function statusMessage(status) {
    if (status === 'invalid') {
      return message('Link non valido o già utilizzato',
        'Ogni link consente una sola compilazione. Se hai già risposto, grazie per la partecipazione! ' +
        'Altrimenti verifica di aver copiato il link per intero.', 'error');
    }
    if (status === 'closed') return message('Questionario chiuso', 'La raccolta delle risposte per questo questionario è terminata.');
    return message('Questionario non disponibile', 'Il questionario non è al momento disponibile. Riprova più tardi.');
  }

  /** Converte il testo in paragrafi (sempre come testo, mai HTML). */
  function paragraphs(text) {
    return String(text || '').split(/\n{2,}/).filter(function (p) { return p.trim(); }).map(function (p) {
      var el = h('p');
      p.split('\n').forEach(function (line, i) {
        if (i) el.appendChild(h('br'));
        el.appendChild(document.createTextNode(line));
      });
      return el;
    });
  }

  function load() {
    var token = tokenFromHash();
    if (!token) return message('Questionario', 'Per partecipare apri il link personale che hai ricevuto.');
    if (!QISD.configured()) return message('Configurazione mancante', 'Il servizio non è ancora configurato.', 'error');
    QISD.rpc('get_survey', { p_token: token }).then(function (res) {
      if (!res || res.status !== 'ok') return statusMessage(res && res.status);
      render(token, res.questionnaire);
    }).catch(function (e) {
      message('Errore', e.message, 'error');
    });
  }

  function render(token, q) {
    document.title = q.title;
    QISD.clear(app);
    var hasRequired = q.questions.some(function (x) { return x.required; });

    app.appendChild(h('header', { class: 'card intro' },
      h('h1', { text: q.title }),
      paragraphs(q.description),
      h('p', { class: 'privacy', text: 'Il questionario è anonimo: le risposte non vengono associate al link ricevuto né a dati che possano identificarti. Il link è personale e può essere usato una sola volta.' }),
      hasRequired ? h('p', { class: 'legend-req' }, h('span', { class: 'req', text: '*' }), ' domanda obbligatoria') : null
    ));

    var summary = h('div', { class: 'alert', role: 'alert', tabindex: '-1', hidden: true });
    app.appendChild(summary);

    var blocks = q.questions.map(function (question, i) { return questionBlock(question, i + 1); });
    var btn = h('button', { type: 'submit', class: 'btn', text: 'Invia risposte' });
    var form = h('form', { class: 'card', novalidate: true, autocomplete: 'off' },
      blocks.map(function (b) { return b.el; }),
      h('div', { class: 'actions' },
        h('p', { class: 'warn', text: 'Dopo l\'invio non sarà possibile modificare le risposte.' }),
        btn));
    app.appendChild(form);

    var sending = false;
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (sending) return;
      var answers = {};
      var errors = {};
      blocks.forEach(function (b) {
        var v = b.value();
        var qq = b.question;
        if (qq.type === 'open') {
          if (!v) { if (qq.required) errors[qq.id] = 'Questa domanda è obbligatoria.'; }
          else if (v.length > MAX_TEXT) errors[qq.id] = 'La risposta supera ' + MAX_TEXT + ' caratteri.';
          else answers[qq.id] = v;
        } else if (!v.length) {
          if (qq.required) errors[qq.id] = qq.type === 'single' ? 'Seleziona una risposta.' : 'Seleziona almeno una risposta.';
        } else answers[qq.id] = v;
      });
      if (showErrors(errors)) return;

      sending = true;
      btn.disabled = true;
      btn.textContent = 'Invio in corso…';
      QISD.rpc('submit_response', { p_token: token, p_answers: answers }).then(function (res) {
        if (res && res.status === 'ok') {
          // Rimuove il link dalla barra degli indirizzi: non serve più.
          try { history.replaceState(null, '', location.pathname + location.search); } catch (err) { /* ignora */ }
          document.title = 'Grazie!';
          return message('Grazie!', 'Le tue risposte sono state registrate in forma anonima. Puoi chiudere questa pagina.', 'success');
        }
        if (res && res.status === 'errors') {
          showErrors(res.errors || {});
        } else {
          return statusMessage(res && res.status);
        }
        reset();
      }).catch(function (err) {
        summary.textContent = err.message + ' Le risposte non sono state inviate.';
        summary.hidden = false;
        summary.focus();
        reset();
      });
    });

    function reset() {
      sending = false;
      btn.disabled = false;
      btn.textContent = 'Invia risposte';
    }

    function showErrors(errors) {
      var first = null;
      blocks.forEach(function (b) {
        var msg = errors[b.question.id];
        b.setError(msg || null);
        if (msg && !first) first = b;
      });
      if (!first) { summary.hidden = true; return false; }
      summary.textContent = 'Alcune risposte mancano o non sono valide: controlla i campi evidenziati.';
      summary.hidden = false;
      first.focus();
      return true;
    }
  }

  /** Crea il blocco di una domanda. Restituisce { el, question, value(), setError(), focus() }. */
  function questionBlock(q, n) {
    var id = 'q_' + q.id;
    var errId = id + '_err';
    var err = h('p', { class: 'field-error', id: errId, hidden: true });
    var title = [
      h('span', { class: 'q-num', text: n + '.' }), ' ', q.text,
      q.required ? h('span', { class: 'req', 'aria-hidden': 'true', text: '*' }) : null,
      q.required ? h('span', { class: 'sr-only', text: ' (obbligatoria)' }) : null,
    ];
    var el, inputs, value;

    if (q.type === 'open') {
      var ta = h('textarea', { id: id, rows: '4', maxlength: String(MAX_TEXT), 'aria-required': q.required ? 'true' : null });
      el = h('div', { class: 'question' }, h('label', { class: 'q-title', for: id }, title), err, ta);
      inputs = [ta];
      value = function () { return ta.value.replace(/\r\n/g, '\n').trim(); };
    } else {
      var type = q.type === 'single' ? 'radio' : 'checkbox';
      inputs = [];
      var choices = q.options.map(function (o) {
        var input = h('input', { type: type, id: id + '_' + o.id, name: id, value: String(o.id) });
        inputs.push(input);
        return h('label', { class: 'choice', for: id + '_' + o.id }, input, h('span', { text: o.text }));
      });
      el = h('fieldset', { class: 'question' },
        h('legend', { class: 'q-title' }, title,
          q.type === 'multiple' ? h('span', { class: 'q-hint', text: 'Puoi selezionare più risposte.' }) : null),
        err,
        h('div', { class: 'choices', role: q.type === 'single' ? 'radiogroup' : null }, choices));
      value = function () {
        return inputs.filter(function (i) { return i.checked; }).map(function (i) { return Number(i.value); });
      };
    }

    function setError(msg) {
      el.classList.toggle('has-error', !!msg);
      err.hidden = !msg;
      err.textContent = msg || '';
      inputs.forEach(function (i) {
        if (msg) { i.setAttribute('aria-invalid', 'true'); i.setAttribute('aria-describedby', errId); }
        else { i.removeAttribute('aria-invalid'); i.removeAttribute('aria-describedby'); }
      });
    }
    el.addEventListener('input', function () { if (el.classList.contains('has-error')) setError(null); });
    el.addEventListener('change', function () { if (el.classList.contains('has-error')) setError(null); });

    return {
      el: el, question: q, value: value, setError: setError,
      focus: function () { inputs[0].focus(); el.scrollIntoView({ block: 'center' }); },
    };
  }

  window.addEventListener('hashchange', load);
  load();
})();
