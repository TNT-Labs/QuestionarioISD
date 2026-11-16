# Questionario ISD

Applicazione per raccogliere **in forma anonima** le risposte a questionari, pubblicata su
**GitHub Pages** con database **Supabase**.
Ogni destinatario riceve un **link personale monouso**: può rispondere una sola volta,
ma la risposta non è in alcun modo collegabile al link né alla persona.

## Architettura

GitHub Pages ospita solo file statici, quindi i dati e la logica stanno su Supabase (PostgreSQL gestito, piano gratuito sufficiente):

```
Browser ──► GitHub Pages (site/: HTML, CSS, JS, nessuna libreria esterna)
   │
   └──────► Supabase: funzioni SQL (supabase/schema.sql) + login amministratori
```

- Il frontend chiama **solo funzioni SQL** (`get_survey`, `submit_response`, `admin_*`). Le tabelle non sono accessibili direttamente dall'API.
- Le funzioni validano ogni input; consumo del link e salvataggio della risposta avvengono in un'**unica transazione**.
- Gli amministratori accedono con email e password (Supabase Auth). Possono gestire i questionari solo gli utenti presenti nella tabella `admins`.

## Funzionalità

**Area amministratore** (`<sito>/admin/`)
- Crea, modifica, duplica ed elimina questionari.
- Tre tipi di domanda: **risposta aperta**, **scelta singola**, **scelta multipla**. Per le domande chiuse si indicano le risposte possibili (minimo 2). Ogni domanda può essere obbligatoria o facoltativa e si può riordinare.
- Stati: **Bozza** → **Raccolta aperta** → **Chiuso** (riapribile).
- Genera N link monouso, da copiare o scaricare (`.csv`/`.txt`). Puoi revocare i link non ancora usati.
- Risultati aggregati (conteggi e percentuali, elenco delle risposte aperte) ed export CSV.
- Dopo la prima risposta le domande sono bloccate, per non alterare i dati: per una nuova versione usa **Duplica**.

**Pagina di risposta** (`<sito>/#t=<codice>`)
- Accessibile, adatta a smartphone e al tema scuro.
- Se la risposta è incompleta il link non viene consumato.

## Anonimato

| Misura | Effetto |
|---|---|
| Nel database ogni link è salvato solo come **hash SHA-256** e viene **eliminato quando viene usato** | Nessuna traccia di quale link abbia risposto |
| Le risposte hanno un **ID casuale**, **nessun timestamp** e nessun riferimento al link | Non si può collegare una risposta a un link o a una persona |
| Il codice del link è nel **frammento `#` dell'URL** | Il browser non lo invia a GitHub Pages, quindi non finisce nei log del sito |
| Nessun cookie, nessuno storage locale e nessuna risorsa di terze parti (font o CDN) per chi risponde; `no-referrer` | Nessun tracciamento |
| Risultati ed export in **ordine casuale** | L'ordine non rivela chi ha risposto per primo |

Limiti intrinseci, da comunicare con trasparenza:
- Chi distribuisce i link sa a chi ha dato ciascun link. Dal numero di link residui può quindi capire *se* qualcuno ha risposto, ma **non cosa** ha risposto.
- Come ogni servizio web, Supabase registra nei propri log tecnici IP e orario delle chiamate API. Questi log non contengono il link né le risposte. Chi ha accesso amministrativo al progetto Supabase e incrocia log e dati interni del database (ad es. l'ordine di scrittura) potrebbe ridurre l'anonimato: limita l'accesso al progetto Supabase alle persone strettamente necessarie.
- Con pochissimi partecipanti, le risposte possono essere riconoscibili dal loro contenuto.

## Messa in produzione

### 1. Supabase
1. Crea un progetto su [supabase.com](https://supabase.com) (regione UE consigliata).
2. **SQL Editor** → incolla ed esegui tutto `supabase/schema.sql`. Lo script si può rieseguire per gli aggiornamenti.
3. **Authentication → Sign In / Providers**: disattiva *Allow new users to sign up*.
4. **Authentication → Users → Add user**: crea l'amministratore (email e password).
5. Abilitalo come amministratore dal SQL Editor:
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'admin@tuodominio.it';
   ```
6. **Project Settings → API**: copia il *Project URL* e la chiave *anon* / *publishable*. Questa chiave è pubblica per progettazione: i permessi li impone il database.

### 2. GitHub Pages
1. Nel repository: **Settings → Secrets and variables → Actions → Variables**: crea `SUPABASE_URL` e `SUPABASE_KEY`.
2. **Settings → Pages → Source: GitHub Actions**.
3. Fai un push su `main`, oppure avvia a mano il workflow *Deploy su GitHub Pages*: esegue i test e pubblica la cartella `site/`.
4. L'area amministratore è su `https://<utente>.github.io/<repository>/admin/`.

In alternativa al workflow, puoi scrivere URL e chiave direttamente in `site/config.js`.

### 3. Evitare la sospensione (piano gratuito)
Il piano gratuito di Supabase sospende il progetto dopo circa 7 giorni senza attività. Il workflow
`.github/workflows/keepalive.yml` esegue ogni 2 giorni una chiamata innocua al database (usa le stesse variabili del deploy).
- Si può avviare a mano da **Actions → Keep-alive Supabase → Run workflow**, utile per verificarlo subito.
- GitHub disattiva i workflow pianificati dopo 60 giorni senza commit nel repository e lo segnala via email: in quel caso riattivalo dalla scheda Actions.
- Se il workflow fallisce, il progetto potrebbe essere già in pausa: riattivalo con **Restore** dalla dashboard di Supabase.
- Per un uso continuativo è preferibile il piano Pro, che non va in pausa e include i backup giornalieri.

> Se usi un dominio personalizzato per Supabase (non `*.supabase.co`), aggiornane l'host nel meta `Content-Security-Policy` di `site/index.html` e `site/admin/index.html`.

## Sviluppo locale e test

Serve Node.js ≥ 20.

```bash
npm install
```

```bash
npm run dev
```

Il comando avvia `http://127.0.0.1:8787` con un emulatore di Supabase: un vero PostgreSQL in WebAssembly (PGlite) con lo stesso `schema.sql`. Admin: `admin@example.com` / `admin12345`. I dati restano in memoria.

```bash
npm test
```

I test eseguono lo schema SQL su PostgreSQL e coprono: permessi (anon, utente non admin, admin), link monouso, stati del questionario, validazione di domande e risposte (inclusi input manipolati), blocco delle domande dopo la prima risposta, struttura anonima del database, export, revoca, duplicazione ed eliminazione.

## Struttura

```
site/                     sito pubblicato su GitHub Pages
  index.html              pagina di risposta
  admin/index.html        area amministratore
  config.js               URL e chiave Supabase (rigenerato dal workflow)
  assets/api.js           client Supabase minimale (RPC + Auth), nessuna dipendenza
  assets/survey.{js,css}  pagina di risposta
  assets/admin.{js,css}   area amministratore
  assets/logo.webp, favicon.png, apple-touch-icon.png
supabase/schema.sql       tabelle, permessi e funzioni
dev/local-supabase.js     emulatore locale (PGlite) per sviluppo e test
test/schema.test.js
.github/workflows/pages.yml
```
