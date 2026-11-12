# CLAUDE.md

Istruzioni per Claude Code su questo repository. Leggi anche `docs/PIANO.md`: contiene decisioni, architettura e stato delle fasi.

## Progetto

MacroCaloriesTrack è un diario alimentare personale di Eric, ispirato a FatSecret. È una PWA statica su GitHub Pages; i dati stanno in IndexedDB e in futuro saranno sincronizzati su Dropbox, cifrati lato client. Più persone possono usarla, ciascuna sui propri dispositivi e con il proprio Dropbox (App key personale inserita nell'app): nessun dato condiviso, nessun backend. Interfaccia e documentazione sono in italiano.

## Comandi

- `npm install`: installa le dipendenze di sviluppo (TypeScript e Playwright, versioni esatte).
- `npm run build`: pulisce `dist/`, compila `src/` in `dist/js/`, copia `public/` e scrive versione e precache nel service worker (`scripts/build.mjs`).
- `npm test`: test unitari con `node --test` sui moduli compilati in `dist/js/`. Richiede prima la build.
- `npm run serve`: server statico su http://localhost:8080.
- `npm run e2e`: flusso completo in Chromium. Playwright è già in `devDependencies` (versione esatta); il browser si scarica una volta con `npx playwright install chromium`. Gira anche in CI.

Dopo ogni modifica: `npm run build && npm test`. Dopo modifiche alla UI esegui anche `npm run e2e`.

## Struttura

- `src/model.ts`: tipi, pasti, nutrienti nell'ordine dell'etichetta UE, `clean()`.
- Moduli puri, senza DOM, testati in Node:
  - `src/dates.ts`, `src/format.ts`, `src/nutrition.ts`, `src/search.ts`;
  - `src/crypto.ts`, `src/merge.ts`, `src/backup.ts`;
  - `src/catalog.ts` (banca dati svizzera), `src/off.ts` (Open Food Facts: URL, validazione, limiti);
  - `src/dropbox.ts` (Dropbox: PKCE, URL, validazione delle risposte, classificazione degli errori);
  - `src/sync.ts` (motore di sincronizzazione con adattatori: meta, cifratura dei file, merge, conflitti);
  - `src/label.ts` (lettura della tabella nutrizionale da testo: voci multilingua, valori per 100 g, dubbi).
- `src/sources.ts`: caricamento della banca dati e chiamate a Open Food Facts con cache in IndexedDB.
- `src/dropboxClient.ts`: login con codice, token in IndexedDB (`kv`: `dropbox`, `dropbox-pending`), rinnovo, RPC, upload condizionato, download.
- `src/syncService.ts`: adattatori IndexedDB e Dropbox per `sync.ts`, chiave (`kv`: `sync-key`) e stato (`sync-state`), sincronizzazione automatica. Le scritture della sync usano `putBatch(..., silent)` per non rilanciarla.
- `src/db.ts`: IndexedDB nativo. `src/repo.ts`: operazioni di dominio.
- `src/ui.ts`: helper `h()`, toast, fogli modali (`<dialog>`), controlli. `src/components.ts`: elementi condivisi.
- `src/router.ts`: routing su hash. `src/nav.ts`: `refresh()` della vista corrente.
- `src/views/*`: diario, aggiunta, elenco alimenti, editor alimento, profilo, impostazioni (con `dropboxSettings.ts`), foglio quantità.
- `public/`: `index.html` (con la CSP), `sw.js`, `css/app.css`, font, icone, manifest, `data/alimenti-ch.json` (generato da `scripts/import-ch.mjs`, non modificarlo a mano).
- `tests/*.test.mjs`: test unitari. `tests/e2e/flow.e2e.mjs`: test end-to-end; Open Food Facts e Dropbox sono sempre simulati con `route`, mai chiamati davvero.

## Regole non negoziabili

1. **Nessuna dipendenza a runtime.** Una libreria esterna (Tesseract.js per l'OCR) va proposta a Eric prima di aggiungerla, motivata, servita da `public/` con versione fissata, mai da CDN.
2. **CSP**: resta rigida. Un dominio esterno va solo in `connect-src`, e solo quando serve. Niente `'unsafe-inline'` o `'unsafe-eval'`. Se il WASM richiede `'wasm-unsafe-eval'`, chiedi prima.
3. **Mai `innerHTML`, `outerHTML`, `insertAdjacentHTML` o `document.write`.** Solo `h()` e `textContent`. Gli stili dinamici passano dalla prop `style` di `h()` (CSSOM); l'attributo `style` è bloccato dalla CSP.
4. **Date locali** con `todayISO()` e `toISODate()`; mai `toISOString()` per le date del diario.
5. **Le voci di diario copiano i valori dell'alimento**: non legarle a valori correnti dell'alimento.
6. **Ogni record sincronizzabile** ha `id`, `updatedAt` e `deleted` (tombstone): niente cancellazioni fisiche dei dati utente, tranne "Cancella tutti i dati".
7. **Validazione rigorosa di ogni dato esterno** (file importati, Dropbox, Open Food Facts, OCR), sul modello di `src/backup.ts`.
8. **Segreti**: l'App key di Dropbox la inserisce l'utente e sta in IndexedDB (non è un segreto); l'App secret mai, né nel codice né nell'app. Token e chiavi solo in IndexedDB; la chiave AES come `CryptoKey` non estraibile.
9. **Test** per ogni modulo puro nuovo; aggiorna l'e2e per ogni flusso nuovo.
10. **Classi CSS**: controlla collisioni prima di introdurne di nuove. `.seg` è già il controllo segmentato. Un errore di questo tipo ha già causato un bug: la barra del giorno usa `.day-seg` e `.tone-*`.

## Design

- Palette in `public/css/app.css` (`:root`, con tema scuro sotto `prefers-color-scheme`).
- Macro con colori fissi: proteine `--protein` (rosso bresaola), carboidrati `--carbs` (grano duro), grassi `--fat` (olio).
- Titoli in Lora, numeri nel font di sistema con cifre tabulari.
- Niente card con ombra: liste su superfici piatte separate da righe.
- Input a 16 px o più, perché sotto iOS ingrandisce la pagina al focus.
- Bersagli toccabili di almeno 44 px.
- Testi dell'interfaccia: italiano, frasi brevi in sentence case. Gli errori dicono cosa correggere.

## Come lavorare con Eric

- Rispondi in italiano, in modo diretto e denso, senza preamboli.
- Distingui ciò che hai verificato (test eseguiti, documentazione letta) da ciò che deduci o non sai. Non inventare valori nutrizionali, limiti di API o versioni: verificali o dichiara che non li hai verificati.
- Se una sua premessa è sbagliata o c'è una strada migliore, dillo prima di procedere.
- Prima di cambiare architettura, stack o modello dati, chiedi. Per il resto procedi e riporta cosa hai fatto e verificato.
- Se scopri un errore in un lavoro precedente, dichiaralo esplicitamente e correggilo.
- Aggiorna le caselle di stato in `docs/PIANO.md` quando chiudi un punto.
