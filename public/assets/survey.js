'use strict';
// Miglioramenti progressivi del modulo pubblico (il server valida comunque tutto).
(function () {
  var form = document.querySelector('form[method="post"]');
  var summary = document.getElementById('error-summary');
  if (summary) summary.focus();
  if (!form) return;

  // Gruppi di checkbox obbligatori: almeno una scelta.
  var groups = Array.prototype.slice.call(form.querySelectorAll('[data-required-group]'));
  function syncGroup(group) {
    var boxes = group.querySelectorAll('input[type="checkbox"]');
    var any = Array.prototype.some.call(boxes, function (b) { return b.checked; });
    if (boxes[0]) boxes[0].setCustomValidity(any ? '' : 'Seleziona almeno una risposta.');
  }
  groups.forEach(function (g) {
    syncGroup(g);
    g.addEventListener('change', function () { syncGroup(g); });
  });

  // Rimuove l'evidenziazione d'errore quando la domanda viene corretta.
  form.addEventListener('input', function (e) {
    var q = e.target.closest('.question');
    if (q && q.classList.contains('has-error')) {
      q.classList.remove('has-error');
      q.removeAttribute('aria-invalid');
      q.querySelectorAll('[aria-invalid]').forEach(function (el) { el.removeAttribute('aria-invalid'); });
      var err = q.querySelector('.field-error');
      if (err) err.remove();
    }
  });

  // Evita invii multipli (doppio clic).
  var sending = false;
  form.addEventListener('submit', function (e) {
    if (sending) { e.preventDefault(); return; }
    sending = true;
    var btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Invio in corso…'; }
  });
  // Ripristino se la pagina torna dalla cache "indietro/avanti" del browser.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    sending = false;
    var btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = false; btn.textContent = 'Invia risposte'; }
  });
})();
