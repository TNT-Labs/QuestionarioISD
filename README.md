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
- Due modi di distribuzione, utilizzabili anche insieme:
  - **link personali monouso**: ne generi N, da copiare o scaricare (`.csv`/`.txt`); ognuno vale una sola compilazione. Puoi revocare quelli non ancora usati;
  - **link pubblico unico**, uguale per tutti: si attiva, rigenera o disattiva in qualsiasi momento e non si consuma.
- Risultati aggregati (conteggi e percentuali, elenco delle risposte aperte) ed export CSV.
- Dopo la prima risposta le domande sono bloccate, per non alterare i dati: per una nuova versione usa **Duplica**.

**Pagina di risposta** (`<sito>/#t=<codice>` per i link personali, `<sito>/#p=<codice>` per il link pubblico)
- Accessibile, adatta a smartphone e al tema scuro, con contatore dei caratteri nelle risposte aperte.
- Se la risposta è incompleta il link personale non viene consumato.
- Con il link pubblico, dopo l'invio il browser ricorda (in `localStorage`, solo il valore "compilato" per quel link) di aver già risposto e non mostra di nuovo il modulo. È un deterrente, non una garanzia: un altro browser o la navigazione privata permettono di rispondere ancora. Il server non effettua alcun controllo.

## Anonimato

| Misura | Effetto |
|---|---|
| Nel database ogni link è salvato solo come **hash SHA-256** e viene **eliminato quando viene usato** | Nessuna traccia di quale link abbia risposto |
| Le risposte hanno un **ID casuale**, **nessun timestamp** e nessun riferimento al link | Non si può collegare una risposta a un link o a una persona |
| Il codice del link è nel **frammento `#` dell'URL** | Il browser non lo invia a GitHub Pages, quindi non finisce nei log del sito |
| Nessun cookie e nessuna risorsa di terze parti (font o CDN) per chi risponde; `no-referrer` | Nessun tracciamento |
| Link pubblico: l'indicatore "già compilato" resta nel browser di chi risponde, non contiene identificativi e non viene mai inviato | Il blocco delle compilazioni ripetute non permette di riconoscere nessuno |
| Risultati ed export in **ordine casuale** | L'ordine non rivela chi ha risposto per primo |

Limiti intrinseci, da comunicare con trasparenza:
- Con il link pubblico non si sa nemmeno *chi* ha risposto; per contro chiunque abbia il link può rispondere più volte cambiando browser. Se serve la garanzia "una persona, una risposta", usa i link personali.
- Chi distribuisce i link personali sa a chi ha dato ciascun link. Dal numero di link residui può quindi capire *se* qualcuno ha risposto, ma **non cosa** ha risposto.
- Come ogni servizio web, Supabase registra nei propri log tecnici IP e orario delle chiamate API. Questi log non contengono il link né le risposte. Chi ha accesso amministrativo al progetto Supabase e incrocia log e dati interni del database (ad es. l'ordine di scrittura) potrebbe ridurre l'anonimato: limita l'accesso al progetto Supabase alle persone strettamente necessarie.
- Con pochissimi partecipanti, le risposte possono essere riconoscibili dal loro contenuto.

## Sicurezza

**Protezioni nel codice**
- Le tabelle non sono raggiungibili dall'API: solo funzioni che validano ogni input. Le funzioni di gestione verificano che l'utente sia in `admins`, quindi un utente registrato qualsiasi non può fare nulla.
- I link personali sono salvati solo come hash e i codici hanno 122 bit casuali: non si possono indovinare.
- Il sito non usa librerie esterne, ha una CSP restrittiva e inserisce sempre i testi come testo, mai come HTML: nessuna iniezione di script.
- I CSV esportati sono protetti dalle formule malevole.
- Il sito non si avvia se incorporato in un frame di un altro sito (protezione dal clickjacking, necessaria perché GitHub Pages non consente l'header `X-Frame-Options`).
- Nel repository non ci sono segreti: la chiave in `config.js` è quella pubblica (publishable/anon).

**Impostazioni da verificare (non controllabili dal codice)**
| Dove | Impostazione |
|---|---|
| Supabase → Authentication → Sign In / Providers | *Allow new users to sign up* **disattivato**; *Anonymous sign-ins* **disattivato** |
| Supabase → Authentication → Passwords | Lunghezza minima ≥ 12; se disponibile, *Leaked password protection* attivo |
| Supabase → Project Settings → General | Regione **UE** (dati in Europa, GDPR) |
| Supabase → Organization → Team | Solo le persone indispensabili: chi amministra il progetto vede dati e log tecnici |
| Account Supabase e GitHub | **Autenticazione a due fattori** per tutti i membri: chi controlla il repository può modificare il codice del sito |
| GitHub → Settings → Branches | Protezione del branch `main` (modifiche solo tramite pull request) |
| GitHub → Settings → Pages | *Enforce HTTPS* attivo |
| Mai | Non usare né pubblicare la chiave **secret / service_role** |

**Buone pratiche**
- I file `.csv`/`.txt` dei link personali sono "chiavi" valide finché non vengono usate: conservali con cura ed eliminali dopo l'invio.
- A raccolta conclusa esporta i risultati ed elimina il questionario, se non serve più.
- Nell'informativa ai partecipanti cita che GitHub (hosting del sito) e Supabase (database) registrano, nei propri log tecnici, l'indirizzo IP delle richieste. L'applicazione non li registra e non li associa alle risposte.

## Messa in produzione

### 1. Supabase
1. Crea un progetto su [supabase.com](https://supabase.com) (regione UE consigliata).
2. **SQL Editor** → incolla ed esegui tutto `supabase/schema.sql`. Lo script si può rieseguire per gli aggiornamenti: conserva i dati esistenti.

   > **Aggiornamenti:** quando una nuova versione modifica `supabase/schema.sql`, riesegui lo script **prima** di pubblicare il sito aggiornato.
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
`.github/workflows/keepalive.yml` esegue ogni 2 giorni una chiamata innocua al database. Usa le variabili del repository `SUPABASE_URL`/`SUPABASE_KEY` oppure, se assenti (es. definite solo nell'ambiente `github-pages`), legge gli stessi valori pubblici dal `config.js` pubblicato.
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

I test eseguono lo schema SQL su PostgreSQL e coprono: permessi (anon, utente non admin, admin), link monouso, stati del questionario, validazione di domande e risposte (inclusi input manipolati), blocco delle domande dopo la prima risposta, struttura anonima del database, export, revoca, duplicazione ed eliminazione, link pubblico (attivazione, risposte multiple, rigenerazione, disattivazione, coesistenza con i link personali).

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
