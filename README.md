# MacroCaloriesTrack

Diario alimentare personale: calorie e macronutrienti per pasto, obiettivo calcolato da profilo e peso, storico, backup. Funziona offline come app installata sulla schermata Home dell'iPhone. I dati restano sul dispositivo.

Stato: Fase 1 completata. La sincronizzazione Dropbox, il database alimenti e l'OCR delle etichette sono le prossime fasi. Il dettaglio è in [docs/PIANO.md](docs/PIANO.md).

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

### Test end-to-end (facoltativo)

```
npm i -D playwright
npx playwright install chromium
npm run build && npm run e2e
```

Il test percorre l'intero flusso in Chromium con viewport da iPhone e fallisce su qualunque errore JavaScript o violazione della CSP. Le schermate finiscono in `tests/e2e/screens/`.

## Pubblicazione su GitHub Pages

1. Crea un repository su GitHub e carica il contenuto di questa cartella sul branch `main`. Con il piano GitHub gratuito, Pages richiede un repository pubblico: il codice è visibile, i tuoi dati no, perché non stanno mai nel repository.
2. Al primo `npm install` viene creato `package-lock.json`: aggiungilo al commit.
3. Su GitHub apri **Settings → Pages** e in **Build and deployment** scegli **GitHub Actions** come sorgente.
4. A ogni push su `main` il workflow `.github/workflows/deploy.yml` compila, esegue i test e pubblica. L'indirizzo è `https://<utente>.github.io/<repository>/`.

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

- La CSP permette solo risorse dello stesso sito: nessuno script, font o servizio esterno.
- Nessun `innerHTML` nel codice: testi e file importati non possono iniettare markup.
- Il backup importato viene validato campo per campo; i campi sconosciuti vengono scartati.
- Il CSV esportato neutralizza le formule (celle che iniziano con `=`, `+`, `-`, `@`).
- Con la Fase 3 i file su Dropbox saranno cifrati con AES-GCM 256, con chiave derivata da una passphrase che non lascia il dispositivo.

## Preparazione per la Fase 3 (Dropbox)

Da fare quando si arriva alla sincronizzazione. Le etichette della console Dropbox potrebbero differire leggermente da queste.

1. Vai su https://www.dropbox.com/developers/apps e crea un'app con **Scoped access** e accesso **App folder**.
2. In **Permissions** abilita `files.metadata.read`, `files.content.read` e `files.content.write`, poi salva.
3. In **Settings → OAuth 2**:
   - aggiungi come redirect URI l'indirizzo GitHub Pages dell'app (`https://<utente>.github.io/<repository>/`) e `http://localhost:8080/` per lo sviluppo;
   - abilita i client pubblici (PKCE).
4. Annota l'**App key**. È pubblica per natura con PKCE e va nel codice. L'**App secret** non serve e non va mai inserito nell'app.

## Licenze

Il font Lora (`public/fonts/Lora-Variable.ttf`) è distribuito senza modifiche ed è soggetto alla SIL Open Font License 1.1 (https://scripts.sil.org/OFL, l’indirizzo riportato nei metadati del font). Copyright 2011 The Lora Project Authors. La licenza è riportata anche nei metadati del file.
