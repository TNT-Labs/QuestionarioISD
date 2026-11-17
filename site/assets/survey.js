'use strict';
/*
 * Pagina di compilazione. Due tipi di link, sempre nel frammento dell'URL
 * (il frammento non viene mai inviato a GitHub Pages, quindi non compare nei log
 * del server che ospita il sito):
 *   #t=<codice>  link personale monouso (controllato e consumato dal database)
 *   #p=<codice>  link pubblico unico per tutti (nessun controllo lato server)
 * Per il link pubblico, dopo l'invio il browser salva in localStorage solo
 * l'indicazione "questionario già compilato", per impedire una seconda
 * compilazione dallo stesso browser. Il dato non lascia mai il dispositivo
 * (a differenza di un cookie, che verrebbe inviato a ogni richiesta) e non
 * contiene alcun identificativo. Nessun cookie.
 */
(function () {
  var h = QISD.h;
  var app = document.getElementById('app');
  var MAX_TEXT = 5000;

  /** Legge il link dal frammento: { mode: 'token' | 'public', code } oppure null. */
  function linkFromHash() {
    var m = location.hash.match(/^#(?:([tp])=)?([A-Za-z0-9_-]{16,64})$/);
    if (!m) return null;
    return { mode: m[1] === 'p' ? 'public' : 'token', code: m[2] };
  }

  // Indicatore locale "già compilato" (solo link pubblico). Lettura/scrittura protette:
  // in navigazione privata o con storage bloccato la pagina funziona comunque.
  var DONE_PREFIX = 'qisd_compilato_';
  function alreadyDone(code) {
    try { return localStorage.getItem(DONE_PREFIX + code) === '1'; } catch (e) { return false; }
  }
  function markDone(code) {
    try { localStorage.setItem(DONE_PREFIX + code, '1'); } catch (e) { /* storage non disponibile */ }
  }
  function alreadyDoneMessage() {
    message('Hai già compilato questo questionario',
      'Da questo browser risulta già inviata una risposta. Grazie per la partecipazione!', 'info');
  }

  function message(title, text, kind) {
    QISD.clear(app);
    var sec = h('section', { class: 'card message message-' + (kind || 'info') },
      h('h1', { text: title, tabindex: '-1' }),
      h('p', { text: text }));
    app.appendChild(sec);
    sec.querySelector('h1').focus();
  }

  function statusMessage(status, mode) {
    if (status === 'invalid' && mode === 'public') {
      return message('Link non valido o non più attivo',
        'Il link potrebbe essere stato disattivato. Verifica di averlo copiato per intero.', 'error');
    }
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
    var link = linkFromHash();
    if (!link) return message('Questionario', 'Per partecipare apri il link che hai ricevuto.');
    if (!QISD.configured()) return message('Configurazione mancante', 'Il servizio non è ancora configurato.', 'error');
    if (link.mode === 'public' && alreadyDone(link.code)) return alreadyDoneMessage();
    var fn = link.mode === 'public' ? 'get_public_survey' : 'get_survey';
    var args = link.mode === 'public' ? { p_slug: link.code } : { p_token: link.code };
    QISD.rpc(fn, args).then(function (res) {
      if (!res || res.status !== 'ok') return statusMessage(res && res.status, link.mode);
      render(link, res.questionnaire);
    }).catch(function (e) {
      message('Errore', e.message, 'error');
    });
  }

  function render(link, q) {
    var isPublic = link.mode === 'public';
    document.title = q.title;
    QISD.clear(app);
    var hasRequired = q.questions.some(function (x) { return x.required; });

    app.appendChild(h('header', { class: 'card intro' },
      h('h1', { text: q.title }),
      paragraphs(q.description),
      h('p', { class: 'privacy', text: isPublic
        ? 'Il questionario è anonimo: le risposte non vengono associate a dati che possano identificarti. ' +
          'Per evitare compilazioni ripetute, dopo l\'invio questo browser ricorderà soltanto che il questionario è già stato compilato: ' +
          'l\'informazione resta sul tuo dispositivo e non viene mai inviata.'
        : 'Il questionario è anonimo: le risposte non vengono associate al link ricevuto né a dati che possano identificarti. Il link è personale e può essere usato una sola volta.' }),
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
      // Compilato nel frattempo da un'altra scheda dello stesso browser
      if (isPublic && alreadyDone(link.code)) return alreadyDoneMessage();

      sending = true;
      btn.disabled = true;
      btn.textContent = 'Invio in corso…';
      var call = isPublic
        ? QISD.rpc('submit_public_response', { p_slug: link.code, p_answers: answers })
        : QISD.rpc('submit_response', { p_token: link.code, p_answers: answers });
      call.then(function (res) {
        if (res && res.status === 'ok') {
          if (isPublic) {
            markDone(link.code);
          } else {
            // Link personale consumato: lo rimuove dalla barra degli indirizzi.
            try { history.replaceState(null, '', location.pathname + location.search); } catch (err) { /* ignora */ }
          }
          document.title = 'Grazie!';
          return message('Grazie!', 'Le tue risposte sono state registrate in forma anonima. Puoi chiudere questa pagina.', 'success');
        }
        if (res && res.status === 'errors') {
          showErrors(res.errors || {});
        } else {
          return statusMessage(res && res.status, link.mode);
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
    var describedBy = null; // id descrittivi sempre associati al campo (es. contatore)

    if (q.type === 'open') {
      var counterId = id + '_count';
      describedBy = counterId;
      var ta = h('textarea', { id: id, rows: '4', maxlength: String(MAX_TEXT), 'aria-required': q.required ? 'true' : null, 'aria-describedby': counterId });
      var counter = charCounter(ta, counterId);
      el = h('div', { class: 'question' }, h('label', { class: 'q-title', for: id }, title), err, ta, counter);
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
        var ids = [msg ? errId : null, describedBy].filter(Boolean).join(' ');
        if (msg) i.setAttribute('aria-invalid', 'true');
        else i.removeAttribute('aria-invalid');
        if (ids) i.setAttribute('aria-describedby', ids);
        else i.removeAttribute('aria-describedby');
      });
    }
    el.addEventListener('input', function () { if (el.classList.contains('has-error')) setError(null); });
    el.addEventListener('change', function () { if (el.classList.contains('has-error')) setError(null); });

    return {
      el: el, question: q, value: value, setError: setError,
      focus: function () { inputs[0].focus(); el.scrollIntoView({ block: 'center' }); },
    };
  }

  /**
   * Contatore dei caratteri sotto il campo di testo libero.
   * Conta come l'attributo maxlength del browser, così arriva al massimo esattamente
   * quando il campo smette di accettare testo. Ai lettori di schermo il valore è
   * disponibile come descrizione del campo; gli avvisi vocali scattano solo alle
   * soglie (500 e 100 caratteri rimanenti, limite raggiunto) per non disturbare a ogni tasto.
   */
  function charCounter(ta, counterId) {
    var fmt = function (n) { return n.toLocaleString('it-IT'); };
    var text = h('span', { id: counterId });
    var live = h('span', { class: 'sr-only', 'aria-live': 'polite' });
    var box = h('div', { class: 'char-count' }, text, live);
    var lastBand = null;
    function update() {
      var used = ta.value.length;
      var left = MAX_TEXT - used;
      text.textContent = fmt(used) + ' / ' + fmt(MAX_TEXT) + ' caratteri' +
        (left <= 0 ? ' · limite raggiunto' : left <= MAX_TEXT * 0.1 ? ' · ne restano ' + fmt(left) : '');
      box.classList.toggle('near', left > 0 && left <= MAX_TEXT * 0.1);
      box.classList.toggle('full', left <= 0);
      var band = left <= 0 ? 0 : left <= 100 ? 100 : left <= 500 ? 500 : null;
      if (band !== lastBand && band !== null && (lastBand === null || band < lastBand)) {
        live.textContent = band === 0 ? 'Limite di ' + fmt(MAX_TEXT) + ' caratteri raggiunto.' : 'Restano ' + fmt(left) + ' caratteri.';
      }
      lastBand = band;
    }
    ta.addEventListener('input', update);
    update();
    return box;
  }

  window.addEventListener('hashchange', load);
  load();
})();
