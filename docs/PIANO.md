# MacroCaloriesTrack: piano di implementazione

Ultimo aggiornamento: 11 novembre 2026.

## Obiettivo

Diario alimentare personale sul modello di FatSecret: registrazione per pasto (colazione, pranzo, cena, spuntino), obiettivo calorico e di macronutrienti da peso e obiettivo personali, database alimenti, lettura dei valori da foto dell'etichetta, storico, export e import. Ospitato su GitHub Pages, dati sincronizzati su Dropbox. Priorità assoluta: protezione dei dati personali.

## Decisioni prese

| Tema | Decisione | Motivo |
|---|---|---|
| Utenti | Solo Eric | L'app Dropbox resta in modalità sviluppo, senza revisione; nessun backend. |
| Foto | Solo etichetta nutrizionale | La stima da foto del piatto richiede un modello vision e ha errori ampi sulle porzioni. |
| Motore foto | OCR locale (Tesseract.js), con correzione manuale sempre possibile | Gratuito e privato: l'immagine non lascia il dispositivo. |
| Stack | TypeScript strict, nessuna dipendenza a runtime, IndexedDB nativo, DOM nativo | Superficie d'attacco minima. TypeScript è solo strumento di sviluppo. Sostituisce Vite, Preact e Dexie del piano iniziale. |
| Fonte dei dati | IndexedDB sul dispositivo; Dropbox come replica cifrata | L'app funziona offline; Dropbox non vede mai dati in chiaro. |
| Storico | Ogni voce di diario copia i valori dell'alimento | Modificare o eliminare un alimento non altera i giorni passati. |
| Obiettivo dei giorni passati | Calcolato col peso valido in quel giorno | Lo storico non cambia quando il peso scende. |

## Architettura

- **Hosting**: GitHub Pages, deploy da GitHub Actions (build, test, pubblicazione di `dist/`). Routing su hash (`#/diario/2026-11-11`), nessuna riscrittura lato server.
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
- [ ] Login Dropbox da PWA installata su iPhone. È il punto più incerto: va provato prima di costruire la sync.
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

### Fase 2: database alimenti (prossima)
- [ ] Verificare la licenza di ridistribuzione delle tabelle CREA (composizione degli alimenti). Se non è compatibile, usare USDA FoodData Central (pubblico dominio) con nomi tradotti in italiano.
- [ ] Includere il dataset generico nel repo come JSON statico in cache, con ricerca locale.
- [ ] Ricerca su Open Food Facts (prodotti confezionati), con cache locale. Va aggiunto `https://world.openfoodfacts.org` a `connect-src`.
- [ ] Preferiti.
- [ ] Gli alimenti presi da una fonte vengono copiati come alimenti personali al primo uso, così lo storico resta stabile.

### Fase 3: sincronizzazione Dropbox
- [ ] OAuth PKCE con `state` contro CSRF, token in IndexedDB, rinnovo automatico.
- [ ] Prima configurazione: passphrase e controllo; sugli altri dispositivi, verifica col valore di controllo.
- [ ] Upload e download dei file mensili, merge, upload condizionato alla revisione, coda delle modifiche offline, indicatore di stato.
- [ ] Domini da aggiungere a `connect-src`: `https://api.dropboxapi.com`, `https://content.dropboxapi.com`.

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
- **iPhone**: l'app va installata sulla schermata Home e va concessa l'archiviazione persistente, altrimenti Safari può cancellare i dati dopo giorni di inattività.
- **Repository pubblico**: con il piano GitHub gratuito, Pages richiede un repository pubblico. Il codice è visibile, i dati no.

## Da verificare

- **Su iPhone reale**, perché non testabile in Chromium headless:
  - il foglio della quantità sopra la tastiera (c'è una correzione basata su `visualViewport`);
  - l'export dal foglio di condivisione;
  - il selettore della data toccando il titolo;
  - l'installazione della PWA e l'archiviazione persistente.
- **Licenza CREA**: non verificata.
- **Peso dei modelli Tesseract** per lingua: da misurare.
- **Limiti di frequenza di Open Food Facts**: da verificare nella loro documentazione.
- **GitHub Actions**: il workflow usa `checkout@v4`, `setup-node@v4`, `upload-pages-artifact@v3`, `deploy-pages@v4`. Potrebbero esistere versioni più recenti; per irrobustire, si possono fissare gli SHA dei commit.
- **Formato dei numeri**: in Chromium `it-IT` non mette il separatore delle migliaia sotto 10.000 ("1270"); Safari potrebbe mostrare "1.270". Non cambia i calcoli.
