// Impostazioni → Dropbox: App key dell'utente, login con codice, prova della connessione, disconnessione.
import { DropboxError, beginLogin, disconnect, finishLogin, getAuth, isConnected, pendingLoginUrl, testConnection } from '../dropboxClient.js';
import { MIN_PASSPHRASE, disable as disableSync, enableExisting, enableNew, onStatus as onSyncStatus, remoteSetupState, status as syncStatus, syncNow } from '../syncService.js';
import { WrongPassphrase } from '../sync.js';
import { confirmSheet, field, h, toast } from '../ui.js';

const CONSOLE_URL = 'https://www.dropbox.com/developers/apps';

const message = (e: unknown): string =>
  e instanceof DropboxError || e instanceof WrongPassphrase ? e.message : e instanceof Error && e.message ? e.message : 'Operazione non riuscita: riprova.';

function howTo(): HTMLElement {
  return h('details', { class: 'howto' },
    h('summary', null, 'Come creare la tua app Dropbox'),
    h('ol', { class: 'steps' },
      h('li', null, 'Apri ', h('a', { href: CONSOLE_URL, target: '_blank', rel: 'noopener noreferrer' }, 'dropbox.com/developers/apps'), ' e premi “Create app”.'),
      h('li', null, 'Scegli “Scoped access” e “App folder”, poi un nome a piacere: diventa la cartella Apps/<nome> nel tuo Dropbox.'),
      h('li', null, 'Nella scheda “Permissions” abilita files.metadata.read, files.content.read e files.content.write, poi premi “Submit”.'),
      h('li', null, 'Nella scheda “Settings” copia l’App key e incollala qui sotto. L’App secret non serve: non inserirlo mai.'),
    ),
    h('p', { class: 'muted' }, 'Ogni persona usa la propria app e il proprio Dropbox: i dati non passano da nessun server dell’app.'),
  );
}

export async function dropboxSection(): Promise<HTMLElement> {
  const root = h('section', { class: 'section dropbox' });
  const status = h('p', { class: 'muted', role: 'status' });
  const error = h('p', { class: 'form-error', role: 'alert' });

  async function busy(btn: HTMLButtonElement, fn: () => Promise<void>): Promise<void> {
    btn.disabled = true;
    error.textContent = '';
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof DropboxError || e instanceof WrongPassphrase)) console.warn(e);
      error.textContent = message(e);
    } finally {
      btn.disabled = false;
    }
  }

  // ---- Stato della sincronizzazione, aggiornato dal servizio mentre la vista è aperta

  const syncLine = h('p', { class: 'sync-line', role: 'status' });
  async function paintSyncLine(): Promise<void> {
    const s = await syncStatus();
    const when = s.lastSync
      ? new Date(s.lastSync).toLocaleString('it-IT', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
      : '';
    syncLine.classList.toggle('form-error', !!s.lastError);
    syncLine.textContent = s.running
      ? 'Sincronizzazione in corso…'
      : s.lastError
        ? `Ultimo tentativo non riuscito: ${s.lastError}`
        : when ? `Ultima sincronizzazione: ${when}.` : 'Non ancora sincronizzato.';
  }
  const unsubscribe = onSyncStatus(() => {
    if (!root.isConnected) unsubscribe();
    else void paintSyncLine();
  });

  // ---- Passphrase

  const passwordInput = (autocomplete: string) =>
    h('input', { type: 'password', autocomplete, autocapitalize: 'off', spellcheck: 'false', minlength: MIN_PASSPHRASE, maxlength: 512 });

  async function afterEnable(keyStored: boolean): Promise<void> {
    status.textContent = 'Prima sincronizzazione…';
    await syncNow();
    toast(keyStored ? 'Sincronizzazione attiva' : 'Sincronizzazione attiva fino alla chiusura dell’app');
    await render();
  }

  function newPassphraseForm(): HTMLElement {
    const pass = passwordInput('new-password');
    const again = passwordInput('new-password');
    const go: HTMLButtonElement = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Attiva la sincronizzazione');
    return h('form', {
      class: 'form',
      novalidate: true,
      onSubmit: (e: Event) => {
        e.preventDefault();
        void busy(go, async () => {
          if (pass.value.length < MIN_PASSPHRASE) throw new Error(`La passphrase deve avere almeno ${MIN_PASSPHRASE} caratteri.`);
          if (pass.value !== again.value) throw new Error('Le due passphrase non coincidono.');
          status.textContent = 'Calcolo della chiave…';
          const r = await enableNew(pass.value);
          if (!r.created) {
            status.textContent = '';
            toast('Un altro dispositivo ha appena attivato la sincronizzazione: usa la sua passphrase.');
            await render();
            return;
          }
          await afterEnable(r.keyStored);
        });
      },
    },
      h('p', null, 'Scegli una passphrase: cifra i dati prima che arrivino su Dropbox. Sugli altri dispositivi userai la stessa.'),
      h('p', { class: 'warn' }, 'Se la dimentichi, i dati su Dropbox non si possono recuperare. Conservala in un gestore di password.'),
      field('Passphrase', pass, `Almeno ${MIN_PASSPHRASE} caratteri; meglio 4 o 5 parole a caso.`),
      field('Ripeti la passphrase', again),
      go,
    );
  }

  function joinForm(): HTMLElement {
    const pass = passwordInput('current-password');
    const go: HTMLButtonElement = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Sblocca e sincronizza');
    return h('form', {
      class: 'form',
      novalidate: true,
      onSubmit: (e: Event) => {
        e.preventDefault();
        void busy(go, async () => {
          status.textContent = 'Verifica della passphrase…';
          const r = await enableExisting(pass.value);
          await afterEnable(r.keyStored);
        });
      },
    },
      h('p', null, 'Su questo Dropbox ci sono già dati di MacroCaloriesTrack. Inserisci la passphrase usata sugli altri dispositivi: i dati verranno uniti a quelli di questo dispositivo.'),
      field('Passphrase', pass),
      go,
    );
  }

  async function render(): Promise<void> {
    const auth = await getAuth();
    const loginUrl = await pendingLoginUrl();
    error.textContent = '';
    status.textContent = '';
    const blocks: Node[] = [h('h2', null, 'Sincronizzazione con Dropbox')];

    if (isConnected(auth)) {
      const since = auth?.connectedAt ? new Date(auth.connectedAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
      const st = await syncStatus();
      const test: HTMLButtonElement = h('button', {
        type: 'button',
        class: 'btn btn-quiet',
        onClick: () => busy(test, async () => {
          status.textContent = 'Prova in corso…';
          status.textContent = await testConnection();
        }),
      }, 'Prova la connessione');
      const off: HTMLButtonElement = h('button', {
        type: 'button',
        class: 'btn btn-quiet',
        onClick: () => busy(off, async () => {
          const ok = await confirmSheet({
            title: 'Scollegare Dropbox?',
            message: 'Questo dispositivo smette di sincronizzarsi. I file già su Dropbox e i dati su questo dispositivo restano.',
            confirm: 'Scollega',
          });
          if (!ok) return;
          await disableSync();
          await disconnect();
          toast('Dropbox scollegato');
          await render();
        }),
      }, 'Scollega Dropbox');
      blocks.push(h('p', null, `Collegato${since ? ` dal ${since}` : ''}, con l’App key ${auth?.appKey}.`));

      if (st.enabled) {
        const now: HTMLButtonElement = h('button', {
          type: 'button',
          class: 'btn btn-secondary',
          onClick: () => busy(now, async () => {
            status.textContent = 'Sincronizzazione in corso…';
            const n = await syncNow();
            status.textContent = n === undefined
              ? 'Sincronizzazione non avviata: sei offline o ce n’è già una in corso.'
              : n ? `Sincronizzato: ${n === 1 ? 'arrivata 1 modifica' : `arrivate ${n} modifiche`} dagli altri dispositivi.` : 'Sincronizzato: tutto aggiornato.';
          }),
        }, 'Sincronizza ora');
        blocks.push(syncLine, h('p', { class: 'muted' }, 'Le modifiche si sincronizzano da sole pochi secondi dopo, all’apertura dell’app e al ritorno della connessione.'));
        if (st.keyInMemoryOnly) blocks.push(h('p', { class: 'warn' }, 'Questo browser non salva la chiave: alla prossima apertura servirà di nuovo la passphrase.'));
        blocks.push(h('div', { class: 'stack' }, now, test, off));
        await paintSyncLine();
      } else {
        let mode: 'new' | 'existing' | undefined;
        try {
          mode = await remoteSetupState();
        } catch (e) {
          error.textContent = message(e);
        }
        if (mode) blocks.push(mode === 'new' ? newPassphraseForm() : joinForm());
        blocks.push(h('div', { class: 'stack' }, test, off));
      }
    } else if (loginUrl) {
      const code = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'done', 'aria-describedby': 'dbx-code-hint' });
      // Link vero, non window.open dopo un await: Safari bloccherebbe il popup.
      const link = h('a', { class: 'btn btn-secondary', href: loginUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Apri Dropbox');
      const connect: HTMLButtonElement = h('button', {
        type: 'submit',
        class: 'btn btn-primary',
      }, 'Collega');
      const cancel: HTMLButtonElement = h('button', {
        type: 'button',
        class: 'btn btn-quiet',
        onClick: () => busy(cancel, async () => {
          await disconnect();
          await render();
        }),
      }, 'Annulla');
      blocks.push(
        h('p', null, '1. Apri Dropbox e consenti l’accesso alla tua app.'),
        link,
        h('form', {
          class: 'form dbx-code',
          novalidate: true,
          onSubmit: (e: Event) => {
            e.preventDefault();
            void busy(connect, async () => {
              await finishLogin(code.value);
              toast('Dropbox collegato');
              await render();
            });
          },
        },
          field('2. Incolla il codice che Dropbox ti mostra', code),
          h('div', { class: 'stack' }, connect, cancel),
        ),
        h('p', { class: 'muted', id: 'dbx-code-hint' }, `App key: ${auth?.appKey ?? ''}. Il codice vale pochi minuti e una sola volta.`),
      );
      // Il link si apre in una nuova scheda: al ritorno qui, il campo del codice è già pronto.
      link.addEventListener('click', () => setTimeout(() => code.focus(), 300));
    } else {
      const key = h('input', { type: 'text', value: auth?.appKey ?? '', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'next', maxlength: 40 });
      const next: HTMLButtonElement = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Continua');
      blocks.push(
        h('p', null, 'Salva i tuoi dati nel tuo Dropbox, cifrati con una passphrase che non lascia mai il dispositivo, e tieni sincronizzati più dispositivi.'),
        howTo(),
        h('form', {
          class: 'form',
          novalidate: true,
          onSubmit: (e: Event) => {
            e.preventDefault();
            void busy(next, async () => {
              await beginLogin(key.value);
              await render();
            });
          },
        },
          field('App key della tua app Dropbox', key),
          next,
        ),
      );
    }
    root.replaceChildren(...blocks, status, error);
  }

  await render();
  return root;
}
