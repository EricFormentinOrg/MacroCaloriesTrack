# MacroCaloriesTrack

Diario alimentare personale: calorie e macronutrienti per pasto, obiettivo calcolato da profilo e peso, storico, backup. Funziona offline come app installata sulla schermata Home dell'iPhone. I dati restano sul dispositivo; solo le ricerche su Open Food Facts escono, e solo quando le chiedi.

Stato: Fasi 1 e 2 completate (diario, alimenti generici della banca dati svizzera, prodotti di Open Food Facts, preferiti). Le prossime fasi sono la sincronizzazione Dropbox e l'OCR delle etichette. Il dettaglio è in [docs/PIANO.md](docs/PIANO.md).

## Requisiti

- Node.js 22 o successivo (serve solo per compilare; l'app pubblicata non ha dipendenze).

## Avvio in locale

```
npm install
npm run build
npm test
npm run serve
```

Poi apri http://localhost:8080. Su localhost il service worker e la crittografia del browser funzionano anche senza HTTPS.

Durante lo sviluppo, `npm run watch` ricompila il TypeScript a ogni modifica. Dopo un cambio in `public/`, rilancia `npm run build`.

### Test end-to-end

Playwright è tra le dipendenze di sviluppo con versione esatta. Il browser va scaricato una volta:

```
npx playwright install chromium
npm run build && npm run e2e
```

Il test percorre l'intero flusso in Chromium con viewport da iPhone e fallisce su qualunque errore JavaScript o violazione della CSP. Le schermate finiscono in `tests/e2e/screens/`. Lo stesso test gira anche in GitHub Actions prima di ogni pubblicazione.

## Pubblicazione su GitHub Pages

1. Crea un repository su GitHub e carica il contenuto di questa cartella sul branch `main`. Con il piano GitHub gratuito, Pages richiede un repository pubblico: il codice è visibile, i tuoi dati no, perché non stanno mai nel repository.
2. `package-lock.json` è nel repository: la CI installa con `npm ci`, quindi esattamente le versioni del lockfile.
3. Su GitHub apri **Settings → Pages** e in **Build and deployment** scegli **GitHub Actions** come sorgente.
4. A ogni push su `main` il workflow `.github/workflows/deploy.yml` compila, esegue test unitari ed end-to-end e pubblica solo se passano. L'indirizzo è https://ericformentinorg.github.io/MacroCaloriesTrack/. Le action del workflow sono fissate allo SHA del commit: per aggiornarle va cambiato lo SHA, non solo il numero di versione.

## Installazione su iPhone

1. Apri l'indirizzo in Safari.
2. Tocca **Condividi → Aggiungi alla schermata Home**.
3. Apri l'app dall'icona. Da Safari, senza installazione, iOS può cancellare i dati dopo giorni di inattività.
4. In **Impostazioni** dell'app controlla che l'archiviazione risulti persistente.

## Backup

**Impostazioni → Esporta backup** produce un file JSON con tutti i dati in chiaro. Su iPhone si apre il foglio di condivisione, da cui puoi salvare in File o in Dropbox. **Importa backup** mostra cosa contiene il file e ti fa scegliere:

- **Unisci**: tiene la versione più recente di ogni record.
- **Sostituisci**: cancella i dati del dispositivo e li sostituisce con quelli del file.

Finché la sincronizzazione non è pronta, il backup è l'unico modo per non perdere dati se cambi dispositivo.

## Sicurezza

- La CSP permette solo risorse dello stesso sito: nessuno script o font esterno. L’unica eccezione sono le chiamate API a `https://world.openfoodfacts.org` (`connect-src`).
- Le risposte di Open Food Facts vengono validate campo per campo, come i backup.
- Nessun `innerHTML` nel codice: testi e file importati non possono iniettare markup.
- Il backup importato viene validato campo per campo; i campi sconosciuti vengono scartati.
- Il CSV esportato neutralizza le formule (celle che iniziano con `=`, `+`, `-`, `@`).
- I file su Dropbox sono cifrati con AES-GCM 256, con chiave derivata dalla passphrase (PBKDF2-SHA256, 600.000 iterazioni). La passphrase non lascia mai il dispositivo; la chiave resta in IndexedDB come `CryptoKey` non estraibile. Il percorso del file è dato autenticato: un file spostato o scambiato non si decifra. Ogni file scaricato viene validato come un backup.
- Dropbox: login OAuth con PKCE e codice da copiare, permesso limitato alla cartella dell'app, nessun segreto nell'app; `connect-src` include solo `api.dropboxapi.com` e `content.dropboxapi.com`.

## Collegare Dropbox

Ogni persona usa il proprio Dropbox tramite una propria app Dropbox: i dati non passano da nessun server dell'app. Le etichette della console Dropbox potrebbero differire leggermente da queste.

1. Vai su https://www.dropbox.com/developers/apps e premi **Create app**.
2. Scegli **Scoped access** e **App folder**, poi un nome: diventa la cartella `Apps/<nome>` nel tuo Dropbox.
3. In **Permissions** abilita `files.metadata.read`, `files.content.read` e `files.content.write`, poi premi **Submit**.
4. In **Settings** copia l'**App key**. L'**App secret** non serve e non va mai inserito nell'app.
5. Nell'app apri **Impostazioni → Sincronizzazione con Dropbox**, incolla l'App key, premi **Apri Dropbox**, consenti l'accesso e incolla il codice che Dropbox mostra.

Non serve configurare redirect URI: il login usa il codice da copiare (OAuth con PKCE). Se Dropbox rifiuta il login dicendo che i client pubblici non sono consentiti, attivali in **Settings → OAuth 2** (non verificato se sia già attivo per le app nuove).

Su ogni dispositivo si ripete il passo 5 con la stessa App key. Token e App key restano nel dispositivo (IndexedDB); "Scollega Dropbox" revoca il token.

### Sincronizzazione tra dispositivi

- **Primo dispositivo**: dopo il collegamento l'app chiede di creare una passphrase. Se la dimentichi, i dati su Dropbox non si recuperano: conservala in un gestore di password.
- **Altri dispositivi**: stessa App key, stesso Dropbox, stessa passphrase. I dati del dispositivo e quelli su Dropbox vengono uniti.
- Le modifiche partono da sole pochi secondi dopo, all'apertura dell'app e al ritorno della connessione; offline l'app funziona e recupera al primo collegamento. In **Impostazioni** c'è lo stato e "Sincronizza ora".
- Nella cartella `Apps/<nome>` trovi `meta.json` (salt e valore di controllo, in chiaro), `profile.enc`, `foods.enc`, `weights.enc` e `diary/AAAA-MM.enc`: non modificarli a mano.

## Aggiornare la banca dati degli alimenti

1. Scarica il file Excel da https://naehrwertdaten.ch/it/downloads/ (versione italiana).
2. `node scripts/import-ch.mjs <percorso del file .xlsx>` riscrive `public/data/alimenti-ch.json` e si ferma su qualunque dato inatteso.
3. `npm run build && npm test`, poi controlla il diff: una riga per alimento.

Gli alimenti già usati restano com'erano: sono copie personali.

## Licenze

Il font Lora (`public/fonts/Lora-Variable.ttf`) è distribuito senza modifiche ed è soggetto alla SIL Open Font License 1.1 (https://scripts.sil.org/OFL, l’indirizzo riportato nei metadati del font). Copyright 2011 The Lora Project Authors. La licenza è riportata anche nei metadati del file.

Alimenti generici: Banca dati svizzera dei valori nutritivi, Ufficio federale della sicurezza alimentare e di veterinaria (USAV), https://naehrwertdaten.ch. L'uso, anche in applicazioni di diario alimentare, è consentito con l'indicazione della fonte; il file `public/data/alimenti-ch.json` ne è una conversione in JSON.

Prodotti confezionati: Open Food Facts, https://world.openfoodfacts.org, banca dati sotto Open Database License (ODbL). L'app interroga il servizio e conserva in locale solo i prodotti cercati.
