# Questionario ISD

Applicazione web per raccogliere **in forma anonima** le risposte a questionari.
Ogni destinatario riceve un **link personale monouso**: può rispondere una sola volta,
ma la risposta non è in alcun modo collegabile al link né alla persona.

## Funzionalità

**Area amministratore** (`/admin`, protetta da password)
- Crea, modifica, duplica ed elimina questionari.
- Domande di tre tipi: **risposta aperta**, **scelta singola**, **scelta multipla**
  (per le chiuse si definiscono le risposte possibili, minimo 2). Ogni domanda può essere obbligatoria o facoltativa e riordinata.
- Stati: **Bozza** (modificabile, link non attivi) → **Raccolta aperta** → **Chiuso** (riapribile).
- Generazione di N link monouso, con copia e download `.csv`/`.txt`; revoca dei link non usati.
- Risultati aggregati (conteggi e percentuali, elenco delle risposte aperte) ed export CSV.
- Dopo la prima risposta le domande vengono bloccate per non alterare i dati: per una nuova versione usare **Duplica**.

**Pagina di risposta** (`/q/<link>`)
- Funziona anche senza JavaScript, è accessibile e ottimizzata per smartphone (anche in tema scuro).
- Validazione lato server; in caso di errore il link non viene consumato.

## Anonimato: come è garantito

| Misura | Effetto |
|---|---|
| Nel DB del link si salva solo l'**hash SHA-256** e un flag `usato` (nessun timestamp) | Chi accede al DB non può ricavare i link né sapere quando sono stati usati |
| Le risposte hanno un **ID casuale**, **nessun timestamp**, nessun riferimento al link; tabelle `WITHOUT ROWID` | Impossibile collegare una risposta a un link o ricostruire l'ordine di invio |
| Consumo del link e salvataggio della risposta nella **stessa transazione atomica** | Esattamente una risposta per link, anche con invii simultanei |
| Nessun cookie, IP, user-agent o log di richiesta per chi risponde; nessuna risorsa esterna (font/CDN) | Nessun tracciamento né esposizione a terze parti |
| `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, CSP restrittiva | Il link non trapela verso altri siti né resta in cache |
| Risultati ed export in **ordine casuale** | L'ordine non rivela chi ha risposto per primo |

Limiti intrinseci da tenere presenti:
- Chi distribuisce i link sa *chi* ha ricevuto quale link e quindi può sapere *se* una persona ha risposto
  (il numero di link usati è visibile), ma **non cosa** ha risposto.
- Con pochissimi partecipanti le risposte possono essere riconoscibili per il loro contenuto.
- Se si usa un reverse proxy (nginx, ecc.) disattivare o anonimizzare i suoi log di accesso per i percorsi `/q/`.

## Avvio

Requisiti: **Node.js ≥ 22.13** (usa il modulo integrato `node:sqlite`, nessuna dipendenza nativa).

```bash
npm install
```

```bash
ADMIN_PASSWORD='una-password-robusta' npm start
```

Aprire `http://localhost:3000/admin`. Se `ADMIN_PASSWORD` non è impostata viene generata una password
temporanea stampata in console (cambia a ogni riavvio).

### Variabili d'ambiente

| Variabile | Default | Descrizione |
|---|---|---|
| `ADMIN_PASSWORD` | *(casuale)* | Password dell'area amministratore |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Porta e interfaccia di ascolto |
| `DB_FILE` | `data/questionario.db` | Percorso del database SQLite |
| `PUBLIC_BASE_URL` | *(dalla richiesta)* | URL pubblico usato per comporre i link, es. `https://questionari.esempio.it` |
| `TRUST_PROXY` | `false` | `1` se l'app è dietro un reverse proxy HTTPS |
| `COOKIE_SECURE` | `false` | `1` per inviare il cookie admin solo su HTTPS (consigliato in produzione) |

In produzione: servire l'app in **HTTPS**, impostare `PUBLIC_BASE_URL`, `TRUST_PROXY=1`, `COOKIE_SECURE=1`
e fare backup periodici della cartella `data/`.

## Test

```bash
npm test
```

Coprono: link monouso e invii concorrenti, validazione (domande e risposte), escape HTML,
struttura anonima del DB, protezione CSRF/login, export CSV (incluso formula-injection), duplica/elimina.

## Struttura

```
src/
  server.js      avvio e configurazione da variabili d'ambiente
  app.js         rotte pubbliche, API admin, sicurezza
  db.js          schema SQLite e accesso ai dati
  validation.js  validazione domande e risposte
  auth.js        login amministratore e sessioni
  views.js       HTML della pagina di risposta (server-side)
public/
  admin/index.html          area amministratore (SPA)
  assets/admin.{js,css}
  assets/survey.{js,css}    pagina di risposta
test/app.test.js
```
