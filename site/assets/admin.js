'use strict';

(function () {
  var h = QISD.h;
  var clear = QISD.clear;
  var app = document.getElementById('app');
  var logoutBtn = document.getElementById('logout');
  var userEmail = document.getElementById('user-email');
  var toastEl = document.getElementById('toast');

  var TYPE_LABELS = { open: 'Risposta aperta', single: 'Scelta singola', multiple: 'Scelta multipla' };
  var STATUS_LABELS = { draft: 'Bozza', open: 'Raccolta aperta', closed: 'Chiuso' };

  // Stato dell'editor domande (modifiche non salvate)
  var editor = null; // { id, dirty, data: { title, description, questions } }

  // ------------------------------------------------------------------ utilità

  var toastTimer;
  function toast(msg, kind) {
    toastEl.textContent = msg;
    toastEl.className = 'toast' + (kind ? ' toast-' + kind : '');
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, kind === 'error' ? 6000 : 3000);
  }

  /** RPC amministrativa: in caso di sessione scaduta torna al login. */
  function rpc(fn, args) {
    return QISD.rpc(fn, args, true).catch(function (e) {
      if (e.status === 401) {
        editor = null;
        QISD.logout();
        renderLogin('Sessione scaduta: effettua di nuovo l\'accesso.');
      }
      throw e;
    });
  }

  function fail(err) { toast(err.message || String(err), 'error'); }

  function badge(status) {
    return h('span', { class: 'badge badge-' + status, text: STATUS_LABELS[status] || status });
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function metaText(q) {
    return plural(q.questions.length, 'domanda', 'domande') + ' · ' +
      plural(q.token_unused, 'link disponibile', 'link disponibili') + ' · ' +
      (q.public_slug ? 'link pubblico attivo · ' : '') +
      plural(q.response_count, 'risposta', 'risposte');
  }

  function publicLink(slug) { return surveyBaseUrl() + '#p=' + slug; }

  function confirmLeave() {
    return !(editor && editor.dirty) || window.confirm('Ci sono modifiche non salvate. Abbandonarle?');
  }

  window.addEventListener('beforeunload', function (e) {
    if (editor && editor.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // ------------------------------------------------------------------ routing

  var currentHash = location.hash;
  window.addEventListener('hashchange', function () {
    if (!confirmLeave()) {
      history.replaceState(null, '', currentHash || '#/');
      return;
    }
    editor = null;
    currentHash = location.hash;
    route();
  });

  function route() {
    if (!QISD.session()) return renderLogin();
    var m = location.hash.match(/^#\/q\/(\d+)(?:\/(domande|link|risultati))?$/);
    if (m) return renderDetail(Number(m[1]), m[2] || 'domande');
    return renderList();
  }

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  // -------------------------------------------------------------------- login

  function renderLogin(notice) {
    logoutBtn.hidden = true;
    userEmail.textContent = '';
    clear(app);
    if (!QISD.configured()) {
      app.appendChild(h('div', { class: 'card login' },
        h('h1', { text: 'Configurazione mancante' }),
        h('p', { text: 'Impostare supabaseUrl e supabaseKey in config.js (vedi README).' })));
      return;
    }
    var email = h('input', { type: 'email', id: 'email', name: 'email', autocomplete: 'username', required: true });
    var pwd = h('input', { type: 'password', id: 'pwd', name: 'password', autocomplete: 'current-password', required: true });
    var err = h('p', { class: 'form-error', role: 'alert', hidden: !notice, text: notice || '' });
    var btn = h('button', { type: 'submit', class: 'btn', text: 'Accedi' });
    var form = h('form', { class: 'card login', onsubmit: function (e) {
      e.preventDefault();
      btn.disabled = true;
      err.hidden = true;
      QISD.login(email.value.trim(), pwd.value)
        .then(function () { return QISD.rpc('admin_whoami', {}, true); })
        .then(function (who) {
          if (!who || !who.is_admin) {
            QISD.logout();
            throw new Error('Questo utente non è abilitato come amministratore.');
          }
          onLoggedIn();
        })
        .catch(function (e2) { err.textContent = e2.message; err.hidden = false; btn.disabled = false; pwd.select(); });
    } },
      h('h1', { text: 'Accesso amministratore' }),
      h('label', { for: 'email', text: 'Email' }), email,
      h('label', { for: 'pwd', text: 'Password' }), pwd,
      err, btn
    );
    app.appendChild(form);
    email.focus();
  }

  function onLoggedIn() {
    logoutBtn.hidden = false;
    var s = QISD.session();
    userEmail.textContent = (s && s.email) || '';
    route();
  }

  logoutBtn.addEventListener('click', function () {
    if (!confirmLeave()) return;
    editor = null;
    QISD.logout().then(function () { renderLogin(); });
  });

  // ---------------------------------------------------------- elenco questionari

  function renderList() {
    rpc('admin_list', {}).then(function (list) {
      clear(app);
      var title = h('input', { id: 'new-title', maxlength: '200', required: true, placeholder: 'Es. Questionario di soddisfazione 2026' });
      var desc = h('textarea', { id: 'new-desc', rows: '2', maxlength: '5000', placeholder: 'Introduzione mostrata a chi risponde (facoltativa)' });
      var newBtn;
      var newForm = h('form', { class: 'card new-form', hidden: true, onsubmit: function (e) {
        e.preventDefault();
        rpc('admin_create', { p_title: title.value, p_description: desc.value })
          .then(function (id) { toast('Questionario creato'); go('#/q/' + id + '/domande'); })
          .catch(fail);
      } },
        h('h2', { text: 'Nuovo questionario' }),
        h('label', { for: 'new-title', text: 'Titolo' }), title,
        h('label', { for: 'new-desc', text: 'Descrizione' }), desc,
        h('div', { class: 'row-actions' },
          h('button', { type: 'submit', class: 'btn', text: 'Crea' }),
          h('button', { type: 'button', class: 'btn btn-ghost', text: 'Annulla', onclick: function () { newForm.hidden = true; newBtn.hidden = false; } })
        )
      );
      newBtn = h('button', { type: 'button', class: 'btn', text: '+ Nuovo questionario', onclick: function () {
        newForm.hidden = false; newBtn.hidden = true; title.focus();
      } });

      app.appendChild(h('div', { class: 'page-head' }, h('h1', { text: 'Questionari' }), newBtn));
      app.appendChild(newForm);

      if (!list.length) {
        app.appendChild(h('div', { class: 'card empty' },
          h('p', { text: 'Non ci sono ancora questionari. Creane uno per iniziare.' })));
        return;
      }
      app.appendChild(h('ul', { class: 'q-list' }, list.map(function (q) {
        return h('li', null, h('a', { class: 'card q-item', href: '#/q/' + q.id },
          h('div', { class: 'q-item-head' }, h('strong', { class: 'q-item-title', text: q.title }), badge(q.status)),
          h('div', { class: 'q-item-stats' },
            h('span', { text: plural(q.question_count, 'domanda', 'domande') }),
            h('span', { text: plural(q.token_unused, 'link disponibile', 'link disponibili') }),
            q.public_slug ? h('span', { class: 'chip chip-public', text: 'Link pubblico' }) : null,
            h('span', { text: plural(q.response_count, 'risposta', 'risposte') })
          )
        ));
      })));
    }).catch(fail);
  }

  // ---------------------------------------------------------- dettaglio

  function renderDetail(id, tab) {
    rpc('admin_get', { p_id: id }).then(function (q) {
      clear(app);
      app.appendChild(h('p', { class: 'back' }, h('a', { href: '#/', text: '← Tutti i questionari' })));

      var actions = h('div', { class: 'status-actions' });
      function statusBtn(label, status, cls) {
        return h('button', { type: 'button', class: 'btn btn-sm ' + (cls || ''), text: label, onclick: function () {
          if (!confirmLeave()) return;
          if (status === 'closed' && !window.confirm('Chiudere la raccolta? I link non ancora usati non saranno più accettati (potrai riaprirla).')) return;
          rpc('admin_set_status', { p_id: id, p_status: status })
            .then(function () { editor = null; toast('Stato aggiornato: ' + STATUS_LABELS[status]); route(); })
            .catch(fail);
        } });
      }
      if (q.status !== 'open') actions.appendChild(statusBtn(q.status === 'closed' ? 'Riapri raccolta' : 'Apri raccolta', 'open'));
      if (q.status === 'open') actions.appendChild(statusBtn('Sospendi (bozza)', 'draft', 'btn-ghost'));
      if (q.status !== 'closed') actions.appendChild(statusBtn('Chiudi raccolta', 'closed', 'btn-ghost'));
      actions.appendChild(h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Duplica', onclick: function () {
        if (!confirmLeave()) return;
        rpc('admin_duplicate', { p_id: id }).then(function (newId) {
          editor = null; toast('Copia creata'); go('#/q/' + newId + '/domande');
        }).catch(fail);
      } }));
      actions.appendChild(h('button', { type: 'button', class: 'btn btn-sm btn-danger', text: 'Elimina', onclick: function () {
        var msg = 'Eliminare definitivamente "' + q.title + '"?\nVerranno cancellati domande, link e ' + plural(q.response_count, 'risposta', 'risposte') + '.';
        if (!window.confirm(msg)) return;
        rpc('admin_delete', { p_id: id }).then(function () { editor = null; toast('Questionario eliminato'); go('#/'); }).catch(fail);
      } }));

      app.appendChild(h('div', { class: 'detail-head' },
        h('div', { class: 'detail-title' }, h('h1', { text: q.title }), badge(q.status)),
        h('p', { class: 'muted', id: 'detail-meta', text: metaText(q) }),
        actions
      ));

      var tabs = [['domande', 'Domande'], ['link', 'Link di accesso'], ['risultati', 'Risultati']];
      app.appendChild(h('nav', { class: 'tabs', 'aria-label': 'Sezioni' }, tabs.map(function (t) {
        return h('a', { href: '#/q/' + id + '/' + t[0], class: 'tab' + (t[0] === tab ? ' active' : ''), 'aria-current': t[0] === tab ? 'page' : null, text: t[1] });
      })));

      var panel = h('section', { class: 'panel' });
      app.appendChild(panel);
      if (tab === 'domande') renderQuestionsTab(panel, q);
      else if (tab === 'link') renderLinksTab(panel, q);
      else renderResultsTab(panel, q);
    }).catch(function (e) {
      fail(e);
      if (/non trovato/i.test(e.message)) go('#/');
    });
  }

  // ---------------------------------------------------------- tab domande

  function renderQuestionsTab(panel, q) {
    var locked = q.response_count > 0 || q.status === 'open';
    if (!editor || editor.id !== q.id) {
      editor = {
        id: q.id,
        dirty: false,
        data: {
          title: q.title,
          description: q.description,
          questions: q.questions.map(function (x) {
            return { type: x.type, text: x.text, required: x.required, options: x.options.map(function (o) { return o.text; }) };
          }),
        },
      };
    }
    var d = editor.data;
    var saveBtn, dirtyNote;
    function markDirty() { editor.dirty = true; saveBtn.disabled = false; dirtyNote.hidden = false; }

    if (locked) {
      panel.appendChild(h('div', { class: 'notice' }, q.response_count > 0
        ? 'Sono già state raccolte risposte: le domande non sono più modificabili per non alterare i dati. Puoi modificare titolo e descrizione, oppure usare "Duplica" per creare una nuova versione.'
        : 'La raccolta è aperta: per modificare le domande usa prima "Sospendi (bozza)". Titolo e descrizione restano modificabili.'));
    }

    panel.appendChild(h('div', { class: 'card' },
      h('label', { for: 'q-title', text: 'Titolo' }),
      h('input', { id: 'q-title', maxlength: '200', value: d.title, oninput: function (e) { d.title = e.target.value; markDirty(); } }),
      h('label', { for: 'q-desc', text: 'Descrizione / introduzione' }),
      h('textarea', { id: 'q-desc', rows: '3', maxlength: '5000', value: d.description, oninput: function (e) { d.description = e.target.value; markDirty(); } })
    ));

    var listEl = h('div', { class: 'questions' });
    panel.appendChild(listEl);

    function renderQuestions(focusId) {
      clear(listEl);
      if (!d.questions.length) {
        listEl.appendChild(h('div', { class: 'card empty' }, h('p', { text: locked ? 'Nessuna domanda.' : 'Nessuna domanda: aggiungine una con i pulsanti qui sotto.' })));
      }
      d.questions.forEach(function (question, i) {
        listEl.appendChild(locked ? readOnlyQuestion(question, i) : editableQuestion(question, i));
      });
      if (focusId) {
        var t = document.getElementById(focusId);
        if (t) { t.focus(); t.scrollIntoView({ block: 'center' }); }
      }
    }

    function readOnlyQuestion(question, i) {
      return h('div', { class: 'card q-card' },
        h('div', { class: 'q-card-head' },
          h('span', { class: 'q-index', text: 'Domanda ' + (i + 1) }),
          h('span', { class: 'chip', text: TYPE_LABELS[question.type] }),
          h('span', { class: 'chip' + (question.required ? ' chip-req' : ''), text: question.required ? 'Obbligatoria' : 'Facoltativa' })
        ),
        h('p', { class: 'q-text', text: question.text }),
        question.type !== 'open' ? h('ol', { class: 'opt-ro' }, question.options.map(function (o) { return h('li', { text: o }); })) : null
      );
    }

    function editableQuestion(question, i) {
      var n = d.questions.length;
      var typeSel = h('select', { id: 'qtype-' + i, onchange: function (e) {
        question.type = e.target.value;
        while (question.type !== 'open' && question.options.length < 2) question.options.push('');
        markDirty();
        renderQuestions('qtype-' + i);
      } }, Object.keys(TYPE_LABELS).map(function (k) {
        return h('option', { value: k, selected: k === question.type, text: TYPE_LABELS[k] });
      }));

      var head = h('div', { class: 'q-card-head' },
        h('span', { class: 'q-index', text: 'Domanda ' + (i + 1) }),
        h('div', { class: 'q-tools' },
          h('button', { type: 'button', class: 'icon-btn', title: 'Sposta su', 'aria-label': 'Sposta su la domanda ' + (i + 1), disabled: i === 0, text: '↑', onclick: function () { move(i, -1); } }),
          h('button', { type: 'button', class: 'icon-btn', title: 'Sposta giù', 'aria-label': 'Sposta giù la domanda ' + (i + 1), disabled: i === n - 1, text: '↓', onclick: function () { move(i, 1); } }),
          h('button', { type: 'button', class: 'icon-btn icon-danger', title: 'Elimina domanda', 'aria-label': 'Elimina la domanda ' + (i + 1), text: '✕', onclick: function () {
            if (question.text.trim() && !window.confirm('Eliminare la domanda ' + (i + 1) + '?')) return;
            d.questions.splice(i, 1); markDirty(); renderQuestions();
          } })
        )
      );

      var body = h('div', { class: 'q-edit' },
        h('div', { class: 'q-edit-row' },
          h('div', { class: 'field' },
            h('label', { for: 'qt-' + i, text: 'Testo della domanda' }),
            h('textarea', { id: 'qt-' + i, rows: '2', maxlength: '1000', value: question.text, oninput: function (e) { question.text = e.target.value; markDirty(); } })
          ),
          h('div', { class: 'field' },
            h('label', { for: 'qtype-' + i, text: 'Tipo' }),
            typeSel
          )
        ),
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: question.required, onchange: function (e) { question.required = e.target.checked; markDirty(); } }),
          ' Risposta obbligatoria'
        )
      );

      if (question.type !== 'open') {
        var optList = h('ol', { class: 'opts' });
        question.options.forEach(function (o, j) {
          optList.appendChild(h('li', null,
            h('input', { id: 'qo-' + i + '-' + j, 'aria-label': 'Risposta possibile ' + (j + 1), maxlength: '300', value: o, placeholder: 'Risposta ' + (j + 1),
              oninput: function (e) { question.options[j] = e.target.value; markDirty(); },
              onkeydown: function (e) {
                if (e.key === 'Enter') { e.preventDefault(); addOption(question, i, j + 1); }
              } }),
            h('button', { type: 'button', class: 'icon-btn icon-danger', title: 'Rimuovi risposta', 'aria-label': 'Rimuovi risposta ' + (j + 1),
              disabled: question.options.length <= 2, text: '✕', onclick: function () {
                question.options.splice(j, 1); markDirty(); renderQuestions();
              } })
          ));
        });
        body.appendChild(h('div', { class: 'opts-box' },
          h('span', { class: 'opts-label', text: question.type === 'single' ? 'Risposte possibili (se ne può scegliere una)' : 'Risposte possibili (se ne possono scegliere più di una)' }),
          optList,
          h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: '+ Aggiungi risposta', onclick: function () { addOption(question, i, question.options.length); } })
        ));
      }
      return h('div', { class: 'card q-card' }, head, body);
    }

    function addOption(question, i, at) {
      question.options.splice(at, 0, '');
      markDirty();
      renderQuestions('qo-' + i + '-' + at);
    }

    function move(i, delta) {
      var j = i + delta;
      var tmp = d.questions[i]; d.questions[i] = d.questions[j]; d.questions[j] = tmp;
      markDirty();
      renderQuestions();
      var card = listEl.querySelectorAll('.q-card')[j];
      if (card) card.scrollIntoView({ block: 'nearest' });
    }

    if (!locked) {
      var addBar = h('div', { class: 'add-bar' }, Object.keys(TYPE_LABELS).map(function (k) {
        return h('button', { type: 'button', class: 'btn btn-ghost', text: '+ ' + TYPE_LABELS[k], onclick: function () {
          d.questions.push({ type: k, text: '', required: true, options: k === 'open' ? [] : ['', ''] });
          markDirty();
          renderQuestions('qt-' + (d.questions.length - 1));
        } });
      }));
      panel.appendChild(addBar);
    }

    dirtyNote = h('span', { class: 'dirty-note', text: 'Modifiche non salvate', hidden: !editor.dirty });
    saveBtn = h('button', { type: 'button', class: 'btn', text: 'Salva', disabled: !editor.dirty, onclick: function () {
      var args = { p_id: q.id, p_title: d.title, p_description: d.description, p_questions: null };
      if (!locked) {
        args.p_questions = d.questions.map(function (x) {
          return { type: x.type, text: x.text, required: x.required, options: x.type === 'open' ? [] : x.options.filter(function (o) { return o.trim(); }) };
        });
      }
      saveBtn.disabled = true;
      rpc('admin_update', args).then(function () {
        editor = null;
        toast('Salvato');
        route();
      }).catch(function (e) { saveBtn.disabled = false; fail(e); });
    } });
    panel.appendChild(h('div', { class: 'save-bar' }, dirtyNote, saveBtn));

    renderQuestions();
  }

  // ---------------------------------------------------------- tab link

  function surveyBaseUrl() {
    // L'area admin è in <sito>/admin/: la pagina del questionario è la radice del sito.
    var u = new URL('../', location.href);
    u.hash = '';
    u.search = '';
    return u.href;
  }

  function renderLinksTab(panel, q) {
    var statsEl = h('div', { class: 'stats' });
    function renderStats(fresh) {
      clear(statsEl);
      statsEl.appendChild(stat('Risposte ricevute', fresh.response_count));
      statsEl.appendChild(stat('Link personali disponibili', fresh.token_unused));
      statsEl.appendChild(stat('Link pubblico', fresh.public_slug ? 'Attivo' : 'Disattivo'));
    }
    function refreshHeader(fresh) {
      renderStats(fresh);
      var meta = document.getElementById('detail-meta');
      if (meta) meta.textContent = metaText(fresh);
    }
    renderStats(q);
    panel.appendChild(statsEl);

    if (q.status !== 'open') {
      panel.appendChild(h('div', { class: 'notice notice-warn', text: 'La raccolta non è aperta: i link funzioneranno solo dopo aver cliccato "Apri raccolta".' }));
    }

    // --- Link pubblico (unico per tutti)
    var publicCard = h('section', { class: 'card public-card', 'aria-labelledby': 'public-title' });
    panel.appendChild(publicCard);
    function renderPublic(slug) {
      clear(publicCard);
      publicCard.appendChild(h('h2', { id: 'public-title', text: 'Link pubblico (uguale per tutti)' }));
      publicCard.appendChild(h('p', { class: 'muted', text:
        'Un solo link da condividere con tutti (email, intranet, QR code…). Non si consuma: chiunque lo abbia può rispondere ' +
        'e il server non effettua alcun controllo su chi risponde. Per evitare compilazioni ripetute, il browser di chi risponde ' +
        'ricorda soltanto di aver già inviato il questionario: è un deterrente, non una garanzia (basta un altro browser o la navigazione privata).' }));
      function act(action, confirmMsg, okMsg) {
        return function () {
          if (confirmMsg && !window.confirm(confirmMsg)) return;
          var btns = publicCard.querySelectorAll('button');
          btns.forEach(function (b) { b.disabled = true; });
          rpc('admin_public_link', { p_id: q.id, p_action: action }).then(function (fresh) {
            renderPublic(fresh.public_slug);
            refreshHeader(fresh);
            toast(okMsg);
          }).catch(function (e) { btns.forEach(function (b) { b.disabled = false; }); fail(e); });
        };
      }
      if (!slug) {
        publicCard.appendChild(h('button', { type: 'button', class: 'btn', text: 'Attiva link pubblico',
          onclick: act('enable', null, 'Link pubblico attivato') }));
        return;
      }
      var url = publicLink(slug);
      var input = h('input', { id: 'public-url', class: 'link-input', readonly: true, value: url, 'aria-label': 'Link pubblico',
        onfocus: function (e) { e.target.select(); } });
      publicCard.appendChild(h('div', { class: 'link-row' }, input,
        h('button', { type: 'button', class: 'btn btn-sm', text: 'Copia link', onclick: function () { copy(url, input, 'Link copiato negli appunti'); } })));
      publicCard.appendChild(h('div', { class: 'row-actions' },
        h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Rigenera link',
          onclick: act('regenerate', 'Generare un nuovo link pubblico? Quello attuale smetterà subito di funzionare.', 'Nuovo link pubblico generato') }),
        h('button', { type: 'button', class: 'btn btn-sm btn-danger', text: 'Disattiva link pubblico',
          onclick: act('disable', 'Disattivare il link pubblico? Chi lo apre vedrà "link non valido". Le risposte già raccolte restano.', 'Link pubblico disattivato') })));
    }
    renderPublic(q.public_slug);

    // --- Link personali monouso
    panel.appendChild(h('h2', { class: 'section-title', text: 'Link personali monouso' }));
    panel.appendChild(h('div', { class: 'notice' },
      'Ogni link è personale e consente una sola compilazione: dopo l\'uso viene eliminato. ' +
      'I link vengono mostrati solo al momento della generazione (nel database ne resta soltanto un\'impronta crittografica): scaricali o copiali subito. ' +
      'Le risposte non sono in alcun modo collegate al link usato.'));

    var count = h('input', { id: 'tok-count', type: 'number', min: '1', max: '2000', value: '10', inputmode: 'numeric' });
    var output = h('div', { class: 'links-out' });
    var genBtn = h('button', { type: 'submit', class: 'btn', text: 'Genera link' });
    panel.appendChild(h('form', { class: 'card gen-form', onsubmit: function (e) {
      e.preventDefault();
      var n = Number(count.value);
      if (!Number.isInteger(n) || n < 1 || n > 2000) { fail(new Error('Indica un numero di link tra 1 e 2000.')); return; }
      genBtn.disabled = true;
      rpc('admin_create_tokens', { p_id: q.id, p_count: n }).then(function (tokens) {
        genBtn.disabled = false;
        var base = surveyBaseUrl();
        showLinks(output, tokens.map(function (t) { return base + '#t=' + t; }), q);
        rpc('admin_get', { p_id: q.id }).then(refreshHeader).catch(function () {});
      }).catch(function (e2) { genBtn.disabled = false; fail(e2); });
    } },
      h('h3', { text: 'Genera nuovi link personali' }),
      h('div', { class: 'inline-form' },
        h('div', { class: 'field' }, h('label', { for: 'tok-count', text: 'Quanti link (uno per destinatario)' }), count),
        genBtn
      ),
      output
    ));

    if (q.token_unused > 0) {
      panel.appendChild(h('div', { class: 'card danger-zone' },
        h('h3', { text: 'Revoca link personali non usati' }),
        h('p', { class: 'muted', text: 'Invalida tutti i ' + q.token_unused + ' link non ancora utilizzati (es. se sono stati diffusi per errore). Le risposte già raccolte non vengono toccate.' }),
        h('button', { type: 'button', class: 'btn btn-danger', text: 'Revoca ' + plural(q.token_unused, 'link', 'link'), onclick: function () {
          if (!window.confirm('Revocare tutti i link non ancora usati? L\'operazione è irreversibile.')) return;
          rpc('admin_revoke_tokens', { p_id: q.id }).then(function (n) {
            toast(plural(n, 'link revocato', 'link revocati')); route();
          }).catch(fail);
        } })
      ));
    }
  }

  function stat(label, value) {
    return h('div', { class: 'stat' }, h('span', { class: 'stat-value', text: value }), h('span', { class: 'stat-label', text: label }));
  }

  function showLinks(container, links, q) {
    clear(container);
    var text = links.join('\n');
    var area = h('textarea', { class: 'links-area', rows: String(Math.min(10, links.length + 1)), readonly: true, value: text, 'aria-label': 'Link generati' });
    var base = 'link-questionario-' + q.id + '-' + new Date().toISOString().slice(0, 10);
    container.appendChild(h('div', { class: 'notice notice-ok', text: plural(links.length, 'link generato', 'link generati') + '. Salvali ora: non sarà possibile visualizzarli di nuovo.' }));
    container.appendChild(area);
    container.appendChild(h('div', { class: 'row-actions' },
      h('button', { type: 'button', class: 'btn btn-sm', text: 'Copia tutti', onclick: function () { copy(text, area); } }),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Scarica .csv', onclick: function () {
        download(base + '.csv', '﻿link\r\n' + links.join('\r\n') + '\r\n', 'text/csv;charset=utf-8');
      } }),
      h('button', { type: 'button', class: 'btn btn-sm btn-ghost', text: 'Scarica .txt', onclick: function () {
        download(base + '.txt', text + '\n', 'text/plain;charset=utf-8');
      } })
    ));
  }

  function copy(text, fallbackEl, okMsg) {
    okMsg = okMsg || 'Link copiati negli appunti';
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, function () { manualCopy(fallbackEl, okMsg); });
    } else manualCopy(fallbackEl, okMsg);
  }
  function manualCopy(el, okMsg) {
    el.focus(); el.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    toast(ok ? okMsg : 'Seleziona il testo e premi Ctrl+C per copiarlo', ok ? null : 'error');
  }
  function download(name, content, type) {
    var url = URL.createObjectURL(new Blob([content], { type: type }));
    var a = h('a', { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /** Cella CSV con escape e protezione da formula injection (separatore ";"). */
  function csvCell(v) {
    var s = String(v === null || v === undefined ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = '\'' + s;
    return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // ---------------------------------------------------------- tab risultati

  function renderResultsTab(panel, q) {
    rpc('admin_results', { p_id: q.id }).then(function (r) {
      var exportBtn = r.total > 0 ? h('button', { type: 'button', class: 'btn btn-sm', text: 'Esporta CSV', onclick: function () {
        exportBtn.disabled = true;
        rpc('admin_export', { p_id: q.id }).then(function (data) {
          var header = data.headers.map(function (t, i) { return 'D' + (i + 1) + '. ' + t; });
          var csv = [header].concat(data.rows).map(function (row) { return row.map(csvCell).join(';'); }).join('\r\n');
          download('risposte-questionario-' + q.id + '.csv', '﻿' + csv + '\r\n', 'text/csv;charset=utf-8');
        }).catch(fail).then(function () { exportBtn.disabled = false; });
      } }) : null;

      panel.appendChild(h('div', { class: 'results-head' },
        h('div', { class: 'stats' }, stat('Risposte ricevute', r.total)),
        h('div', { class: 'row-actions' },
          h('button', { type: 'button', class: 'btn btn-ghost btn-sm', text: 'Aggiorna', onclick: route }),
          exportBtn
        )
      ));
      if (!r.total) {
        panel.appendChild(h('div', { class: 'card empty' }, h('p', { text: 'Nessuna risposta ancora ricevuta.' })));
        return;
      }
      panel.appendChild(h('p', { class: 'muted small', text: 'Le risposte sono anonime e mostrate in ordine casuale, non in ordine di arrivo.' }));
      r.questions.forEach(function (question, i) {
        var card = h('div', { class: 'card result' },
          h('div', { class: 'q-card-head' },
            h('span', { class: 'q-index', text: 'Domanda ' + (i + 1) }),
            h('span', { class: 'chip', text: TYPE_LABELS[question.type] }),
            h('span', { class: 'muted small', text: question.answered + ' su ' + r.total + ' hanno risposto' })
          ),
          h('p', { class: 'q-text', text: question.text })
        );
        if (question.type === 'open') {
          card.appendChild(question.answers.length
            ? h('ul', { class: 'open-answers' }, question.answers.map(function (a) { return h('li', { text: a }); }))
            : h('p', { class: 'muted', text: 'Nessuna risposta.' }));
        } else {
          card.appendChild(h('div', { class: 'bars' }, question.options.map(function (o) {
            var pct = question.answered ? (o.count / question.answered) * 100 : 0;
            return h('div', { class: 'bar-row' },
              h('span', { class: 'bar-label', text: o.text }),
              h('span', { class: 'bar-track', 'aria-hidden': 'true' }, barFill(pct)),
              h('span', { class: 'bar-value', text: o.count + ' (' + String(Math.round(pct * 10) / 10).replace('.', ',') + '%)' })
            );
          })));
          if (question.type === 'multiple') {
            card.appendChild(h('p', { class: 'muted small note', text: 'Scelta multipla: le percentuali sono calcolate su chi ha risposto e possono superare il 100% in totale.' }));
          }
        }
        panel.appendChild(card);
      });
    }).catch(fail);
  }

  /** Larghezza impostata via CSSOM: consentito dalla CSP, a differenza dell'attributo style. */
  function barFill(pct) {
    var el = h('span', { class: 'bar-fill' });
    el.style.width = pct + '%';
    return el;
  }

  // ---------------------------------------------------------- avvio

  if (QISD.session()) onLoggedIn();
  else renderLogin();
})();
