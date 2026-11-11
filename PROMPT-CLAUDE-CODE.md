# Prompt per continuare in Claude Code

Apri Claude Code nella cartella `MacroCaloriesTrack` e incolla il testo qui sotto. `CLAUDE.md` viene letto in automatico; il prompt dice da dove ripartire.

---

Stiamo continuando MacroCaloriesTrack, il mio diario alimentare personale (PWA su GitHub Pages, dati in IndexedDB, sync Dropbox cifrata in arrivo). Prima di tutto leggi `CLAUDE.md` e `docs/PIANO.md`: contengono architettura, regole non negoziabili e stato delle fasi. La Fase 1 è completa; Fase 0 e Fase 5 sono parziali.

Procedi in quest'ordine e fermati a fine di ogni blocco per riportarmi cosa hai fatto e verificato.

**1. Verifica dello stato di partenza**
- Esegui `npm install`, `npm run build`, `npm test`. Devono passare 24 test.
- Aggiungi Playwright come dipendenza di sviluppo con versione esatta, installa Chromium ed esegui `npm run e2e`.
- Decidi se il workflow di GitHub Actions deve eseguire anche l'e2e. Se sì, evita di scaricare browser inutili; se no, lascialo fuori dalla CI. Motiva la scelta.
- Controlla se in `.github/workflows/deploy.yml` esistono versioni più recenti delle action e proponi l'aggiornamento. Valuta di fissarle agli SHA dei commit.
- Inizializza git, se non c'è, con un primo commit che includa `package-lock.json`. Non fare push: il repository GitHub lo creo io. Dimmi i comandi.

**2. Fase 2: database alimenti.** Prima la ricerca, poi il codice.
- Verifica sul web, citando le fonti, la licenza di ridistribuzione delle tabelle di composizione degli alimenti CREA. Se non è chiaramente compatibile con un repository pubblico, la base diventa USDA FoodData Central (pubblico dominio), con nomi tradotti in italiano.
- Presentami le opzioni con pro e contro: dimensione del dataset, numero di alimenti, qualità dei nomi italiani. Aspetta la mia scelta.
- Implementa:
  - dataset come JSON statico in `public/`, in precache, con ricerca locale;
  - ricerca su Open Food Facts per i confezionati, con validazione rigorosa delle risposte e cache locale (aggiungi solo `https://world.openfoodfacts.org` a `connect-src`);
  - preferiti;
  - copia come alimento personale al primo uso.
- Verifica nella documentazione di Open Food Facts i limiti di frequenza e l'header User-Agent richiesto.
- Aggiorna test unitari, e2e e `docs/PIANO.md`.

**3. Poi fermati.** Prima della Fase 3 (Dropbox) ti dirò se ho creato l'app nella Dropbox App Console (passaggi nel README) e ti darò l'App key. Ti riporterò anche i risultati delle prove su iPhone elencate in "Da verificare" del piano.

Regole di lavoro: se trovi errori nel codice esistente, dichiarali e correggili. Se un dato (licenza, limite di API, versione, valore nutrizionale) non è verificato, dillo esplicitamente invece di assumerlo. Per dubbi su architettura o stack, chiedimi prima di procedere.
