# MacroCaloriesTrack: piano di implementazione

Ultimo aggiornamento: 11 novembre 2026.

## Obiettivo

Diario alimentare personale sul modello di FatSecret: registrazione per pasto (colazione, pranzo, cena, spuntino), obiettivo calorico e di macronutrienti da peso e obiettivo personali, database alimenti, lettura dei valori da foto dell'etichetta, storico, export e import. Ospitato su GitHub Pages, dati sincronizzati su Dropbox. Priorità assoluta: protezione dei dati personali.

## Decisioni prese

| Tema | Decisione | Motivo |
|---|---|---|
| Utenti | Più utenti, ciascuno sui propri dispositivi e con il proprio Dropbox; ognuno crea la propria app Dropbox e ne inserisce l'App key nell'app | Nessun backend e nessuna dipendenza da un'app Dropbox condivisa: niente limite di 500 utenti né revisione Dropbox oltre i 50. Prezzo: configurazione più tecnica per l'utente. Decisa il 12 novembre 2026 (prima: solo Eric). |
| Foto | Solo etichetta nutrizionale | La stima da foto del piatto richiede un modello vision e ha errori ampi sulle porzioni. |
| Motore foto | OCR locale (Tesseract.js), con correzione manuale sempre possibile | Gratuito e privato: l'immagine non lascia il dispositivo. |
| Stack | TypeScript strict, nessuna dipendenza a runtime, IndexedDB nativo, DOM nativo | Superficie d'attacco minima. TypeScript è solo strumento di sviluppo. Sostituisce Vite, Preact e Dexie del piano iniziale. |
| Fonte dei dati | IndexedDB sul dispositivo; Dropbox come replica cifrata | L'app funziona offline; Dropbox non vede mai dati in chiaro. |
| Storico | Ogni voce di diario copia i valori dell'alimento | Modificare o eliminare un alimento non altera i giorni passati. |
| Obiettivo dei giorni passati | Calcolato col peso valido in quel giorno | Lo storico non cambia quando il peso scende. |
| Alimenti generici | Banca dati svizzera dei valori nutritivi (USAV), versione italiana | Uso esplicitamente consentito anche in app di diario alimentare, con indicazione della fonte; nomi già in italiano; tutti gli 8 valori dell'etichetta UE. CREA scartato per licenza non chiara. |
| Alimenti esterni | Copiati tra gli alimenti personali al primo uso (`source`, `sourceId`) | Lo storico e le modifiche non dipendono dalla fonte; nessun doppione. |
| Origine web | Organizzazione GitHub dedicata `EricFormentinOrg`: app su https://ericformentinorg.github.io/MacroCaloriesTrack/, nessun altro sito nell'organizzazione | `formentineric.github.io` è condivisa con altri due siti Pages, uno con script da CDN: stessa origine = accesso a IndexedDB, chiave e token. Decisa il 12 novembre 2026, prima della Fase 3. |

## Architettura

- **Hosting**: GitHub Pages, deploy da GitHub Actions (build, test unitari, e2e in Chromium headless shell, pubblicazione di `dist/`). Action fissate agli SHA dei commit, permessi dichiarati per job. Routing su hash (`#/diario/2026-11-11`), nessuna riscrittura lato server.
- **App**: PWA installabile su iPhone dalla schermata Home, service worker con tutti i file in cache, funzionamento completo offline.
- **Sicurezza nel browser**:
  - CSP rigida via meta tag (GitHub Pages non permette header personalizzati): solo risorse dello stesso sito. Ogni dominio esterno futuro va aggiunto solo a `connect-src`.
  - Nessun `innerHTML`: il DOM si costruisce solo con `createElement` e `textContent`, quindi un nome alimento o un file importato non possono iniettare markup.
  - Nessuno script di terze parti; referrer disattivato.
- **Cifratura** (modulo già pronto e testato: `src/crypto.ts`):
  - Chiave derivata dalla passphrase con PBKDF2-SHA256 a 600.000 iterazioni, il valore OWASP per questo algoritmo.
  - Cifratura AES-GCM 256 con IV nuovo a ogni scrittura.
  - Il percorso del file entra come dato autenticato, quindi un file spostato o scambiato con un altro non si decifra.
  - Un valore di controllo verifica la passphrase senza toccare i dati.
  - La chiave è salvata in IndexedDB come non estraibile.
- **Sincronizzazione** (Fase 3): OAuth PKCE con refresh token, permesso limitato alla cartella dell'app. File remoti:
  - `meta.json`: salt, parametri della derivazione e valore di controllo, in chiaro.
  - `profile.enc`, `foods.enc`, `weights.enc`.
  - `diary/AAAA-MM.enc`: un file per mese.

  Il merge per record (`src/merge.ts`, già pronto) usa `id`, `updatedAt` e i tombstone per le cancellazioni. Ogni upload è condizionato alla revisione del file remoto; se fallisce, l'app scarica, unisce e riprova.

## Modello dati (`src/model.ts`)

- **Food**: nome, marca, barcode facoltativo, unità (g o ml), valori per 100 g/ml, porzioni.
- **Entry**: data locale, pasto, riferimento all'alimento, quantità in g o ml, copia dei valori per 100, porzione usata.
- **Weight**: una pesata al giorno, con id uguale alla data.
- **Profile**:
  - sesso, data di nascita, altezza, livello di attività;
  - obiettivo (perdere, mantenere, aumentare), ritmo in kg a settimana, peso obiettivo;
  - proteine in g/kg (predefinito 1,8) e grassi in % delle calorie (predefinito 25);
  - obiettivi impostati a mano, in alternativa al calcolo.
- Nutrienti nell'ordine dell'etichetta UE (Reg. 1169/2011): energia, grassi, di cui saturi, carboidrati, di cui zuccheri, fibre, proteine, sale.

## Fasi

### Fase 0: prove tecniche (parziale)
- [x] Ciclo cifra, decifra e verifica passphrase (test in Node).
- [x] Login Dropbox da PWA installata su iPhone, con il codice da copiare (nessun ritorno da redirect, che su iOS rischiava di aprirsi in Safari invece che nella PWA). "Prova la connessione" riuscita il 12 novembre 2026, riferito da Eric.
- [ ] Tesseract.js su circa 10 etichette reali, per misurare la qualità di lettura prima di investire nel parser.

### Fase 1: diario (completata)
- [x] Profilo e calcolo degli obiettivi (Mifflin-St Jeor, fattori di attività da 1,2 a 1,9, circa 7700 kcal per kg), con obiettivi manuali.
- [x] Giornata con quattro pasti, budget per pasto, macro, valori extra, navigazione tra i giorni con selettore della data.
- [x] Alimenti personali:
  - valori nell'ordine dell'etichetta, energia inseribile in kJ;
  - porzioni;
  - controlli di plausibilità: kcal contro macro, saturi non oltre i grassi, zuccheri non oltre i carboidrati, somma entro 100 g.
- [x] Aggiunta rapida: ricerca senza accenti, alimenti recenti, ultima quantità proposta, creazione di un alimento dalla ricerca.
- [x] Modifica ed eliminazione delle voci, con "Annulla".

### Fase 2: database alimenti (completata)
- [x] Verificare la licenza di ridistribuzione delle tabelle CREA (composizione degli alimenti). Esito dell'11 novembre 2026: nessuna licenza formale; il sito vieta la riproduzione "senza una chiara indicazione della fonte originale" e non offre download (832 schede da estrarre una per una). Non chiaramente compatibile. Alternative valutate: Banca dati svizzera dei valori nutritivi, Ciqual, USDA FoodData Central, BDA. Scelta: banca dati svizzera.
- [x] Dataset generico come JSON statico in precache, con ricerca locale:
  - `public/data/alimenti-ch.json`: 1.216 alimenti, versione 7.1 del 1° luglio 2026, 126 KB (32 KB gzip);
  - generato da `scripts/import-ch.mjs` dal file Excel ufficiale; "tr." e "<x" valgono 0, "nd" resta vuoto;
  - validato all'avvio (`src/catalog.ts`), ricerca senza accenti su nome, sinonimi e categoria.
- [x] Open Food Facts (`src/off.ts`, `src/sources.ts`):
  - ricerca testuale con `/cgi/search.pl` su richiesta esplicita (pulsante), ricerca per codice a barre con `/api/v2/product`;
  - risposte validate campo per campo, testo ripulito da caratteri di controllo e invisibili;
  - limiti lato client sotto quelli documentati (12 letture e 8 ricerche al minuto), timeout di 12 secondi;
  - cache in IndexedDB (store `cache`, database versione 2): ricerche 7 giorni, prodotti 30, al massimo 300 voci; senza rete usa la copia scaduta; non entra nel backup; "Cancella tutti i dati" la svuota;
  - prodotti incompleti o incoerenti aprono l'editor con un avviso prima del primo uso;
  - solo `https://world.openfoodfacts.org` aggiunto a `connect-src`.
- [x] Preferiti (`favorite` sull'alimento, sincronizzato come gli altri campi): stella negli elenchi, sezione "Preferiti" in Aggiungi e in Alimenti.
- [x] Copia come alimento personale al primo uso (aggiunta al diario o preferito), con provenienza mostrata nell'editor. Le modifiche successive non toccano la fonte.

### Fase 3: sincronizzazione Dropbox (implementata, da provare con due dispositivi reali)
- [x] App key inserita dall'utente in Impostazioni e salvata in IndexedDB (non è un segreto). Accesso OAuth PKCE con codice da copiare: nessun redirect URI da configurare e nessun problema di ritorno nella PWA su iOS. Token in IndexedDB, rinnovo automatico, disconnessione con revoca. Il challenge resta lo stesso se l'app si ricarica durante il login. "Prova la connessione" scrive, rilegge e cancella un file. Moduli: `src/dropbox.ts` (puro, testato), `src/dropboxClient.ts`, `src/views/dropboxSettings.ts`. Login provato su iPhone il 12 novembre 2026.
- [x] Prima configurazione: passphrase (almeno 12 caratteri, ripetuta) e `meta.json` con salt e valore di controllo, creato in modo esclusivo (se un altro dispositivo lo crea nello stesso momento, si passa alla verifica). Sugli altri dispositivi la passphrase è verificata col valore di controllo prima di toccare i dati. La chiave è una `CryptoKey` non estraibile in IndexedDB; se il browser non la sa salvare resta in memoria e alla riapertura serve di nuovo la passphrase.
- [x] Motore puro `src/sync.ts`, testato in Node con due dispositivi e un Dropbox in memoria:
  - per ogni file: download se la revisione remota è cambiata, decifratura, validazione con le regole del backup (record, mese giusto, niente duplicati), merge per record in locale;
  - upload se l'impronta (SHA-256 del JSON canonico) differisce da quella remota nota, condizionato alla revisione (`strict_conflict`); su conflitto rilegge, unisce e riprova (fino a 4 volte);
  - nessuna coda esplicita: le modifiche fatte offline risultano diverse dall'ultima impronta e partono al giro successivo.
- [x] `src/syncService.ts`: sincronizzazione 3 secondi dopo ogni modifica, all'apertura, al ritorno online e quando l'app torna in primo piano. Stato in Impostazioni (ultima sincronizzazione, errore), "Sincronizza ora", avviso quando arrivano modifiche. Il ridisegno automatico tocca solo Diario e Alimenti, per non cancellare ciò che si sta scrivendo.
- [x] e2e con due dispositivi su un Dropbox simulato condiviso: passphrase diverse rifiutate, dati cifrati (nessun nome in chiaro sui file), invio automatico, ricezione, scollegamento che revoca il token e dimentica la chiave.
- [x] Domini aggiunti a `connect-src`: `https://api.dropboxapi.com`, `https://content.dropboxapi.com` (CORS verificato: entrambi accettano l'origine dell'app ed espongono `Dropbox-API-Result`).

### Fase 4: etichetta via OCR
- [ ] Foto o file, ritaglio manuale, pre-elaborazione (scala di grigi, contrasto, ingrandimento).
- [ ] Tesseract.js self-hosted: worker, core WASM e modelli di lingua serviti da `public/`, caricati solo al primo uso. Lingue iniziali: italiano, inglese, tedesco, francese.
- [ ] Parser con dizionario multilingua delle voci (energia, grassi, saturi, carboidrati, zuccheri, fibre, proteine, sale), ordine UE come aiuto. Riconoscimento delle colonne "per 100 g" e "per porzione".
- [ ] Controlli di plausibilità come nell'editor attuale.
- [ ] Risultato precompilato nell'editor alimento esistente, con la foto accanto e i campi dubbi evidenziati. Correzione sempre possibile.
- [ ] La CSP potrebbe richiedere `'wasm-unsafe-eval'` in `script-src` per il WASM di Tesseract. Va verificato e motivato.

### Fase 5: storico e portabilità (parziale)
- [x] Export JSON completo, con i tombstone.
- [x] Import con validazione rigorosa: file intero rifiutato se un record non è valido, campi sconosciuti scartati, anteprima, poi "Unisci" o "Sostituisci".
- [x] CSV del diario per Excel in italiano: separatore `;`, virgola decimale, formule neutralizzate.
- [ ] Calendario, medie settimanali, grafici di peso e calorie.

### Fase 6: rifiniture
- [ ] Ricette e pasti salvati, copia di un giorno.
- [ ] Lettura del codice a barre con Open Food Facts: per i confezionati è più affidabile dell'OCR.

## Limiti da accettare

- **OCR**: su confezioni curve, lucide o con testo piccolo le correzioni saranno frequenti. La Fase 0 dirà quanto.
- **Passphrase**: se la perdi, i dati su Dropbox sono irrecuperabili. L'export JSON in chiaro è l'unico paracadute.
- **Open Food Facts**: le ricerche rivelano al loro server cosa cerchi. I valori sono inseriti da volontari e vanno controllati.
- **Ricerca testuale su Open Food Facts**: l'11 novembre 2026 `/cgi/search.pl` rispondeva quasi sempre 503 ("sovraccarico o non disponibile agli utenti anonimi"), senza header CORS. La ricerca per codice a barre funzionava. Search-a-licious (`search.openfoodfacts.org`) risponde, ma senza `Access-Control-Allow-Origin` per origini esterne: dal browser non è usabile.
- **Banca dati svizzera**: nomi in italiano svizzero ("pane bigio", "Olio d'oliva" senza "extravergine"), qualche refuso della fonte lasciato com'è. I valori sono per 100 g anche per le bevande. 24 alimenti, quasi tutti alcolici, fanno scattare l'avviso kcal/macro dell'editor perché l'energia dell'alcol non è nei macronutrienti.
- **iPhone**: l'app va installata sulla schermata Home e va concessa l'archiviazione persistente, altrimenti Safari può cancellare i dati dopo giorni di inattività.
- **Repository pubblico**: con il piano GitHub gratuito, Pages richiede un repository pubblico. Il codice è visibile, i dati no.

- **Sincronizzazione**:
  - vince la modifica più recente per record (`updatedAt`): con gli orologi dei dispositivi sfasati, due modifiche quasi simultanee allo stesso record possono risolversi a favore di quella "sbagliata";
  - cambiare la passphrase non è ancora possibile (richiede di cifrare di nuovo tutti i file);
  - "Cancella tutti i dati" agisce solo sul dispositivo: ricollegando Dropbox i dati tornano;
  - "Importa → Sostituisci" su un dispositivo sincronizzato: alla sync successiva tornano i record remoti più recenti;
  - Dropbox vede nomi, dimensioni e date dei file (quali mesi hanno dati), mai il contenuto.

## Da verificare

- **Su iPhone reale**, perché non testabile in Chromium headless:
  - il foglio della quantità sopra la tastiera (c'è una correzione basata su `visualViewport`);
  - l'export dal foglio di condivisione;
  - il selettore della data toccando il titolo;
  - l'installazione della PWA e l'archiviazione persistente.
- **Licenza CREA**: verificata l'11 novembre 2026, non chiaramente compatibile (vedi Fase 2). Una conferma scritta del CREA la renderebbe utilizzabile.
- **Sincronizzazione reale**: due dispositivi con lo stesso Dropbox vero. Su Safari iOS: salvataggio della `CryptoKey` in IndexedDB (se non riesce, l'app lo dice e chiede la passphrase a ogni apertura) e durata della derivazione PBKDF2 a 600.000 iterazioni.
- **Peso dei modelli Tesseract** per lingua: da misurare.
- **Open Food Facts**: limiti verificati nella documentazione l'11 novembre 2026: 15 richieste al minuto per IP sulle schede prodotto, 10 sulle ricerche; oltre i limiti globali risponde 503. Ricerca testuale solo con `/cgi/search.pl`. Richiede un User-Agent `NomeApp/Versione (email)`. Verificato in Chromium: `fetch` ignora un `User-Agent` personalizzato; l'app invia `X-User-Agent: MacroCaloriesTrack/<versione> (+<indirizzo dell'app>)`, accettato dal preflight CORS. Che OFF lo consideri equivalente non è documentato. Al posto dell'email c'è l'indirizzo dell'app, per non pubblicare un contatto personale. Comportamento su Safari iOS: da verificare.
- **GitHub Actions**: aggiornate l'11 novembre 2026 a `checkout` v7.0.1, `setup-node` v7.1.0, `upload-pages-artifact` v5.0.0, `deploy-pages` v5.0.1, `upload-artifact` v7.0.2, fissate agli SHA. Primo run (11 novembre 2026): build e test unitari ok; `playwright install --with-deps` fallito dopo 10 minuti perché i mirror apt di Ubuntu non si risolvevano. Corretto: runner `ubuntu-24.04` esplicito, installazione senza `--with-deps` (le librerie ci sono già con Chrome preinstallato), timeout di 5 minuti sugli step di Playwright. Verificato col run di `7a718c2`: verde in 51 secondi, e2e compreso; il sito pubblicato serve solo `dist/`.
- **Formato dei numeri**: in Chromium `it-IT` non mette il separatore delle migliaia sotto 10.000 ("1270"); Safari potrebbe mostrare "1.270". Non cambia i calcoli.
