// Impostazioni → Dropbox: App key dell'utente, login con codice, prova della connessione, disconnessione.
import { DropboxError, beginLogin, disconnect, finishLogin, getAuth, isConnected, pendingLoginUrl, testConnection } from '../dropboxClient.js';
import { confirmSheet, field, h, toast } from '../ui.js';

const CONSOLE_URL = 'https://www.dropbox.com/developers/apps';

const message = (e: unknown): string => (e instanceof DropboxError ? e.message : 'Operazione non riuscita: riprova.');

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
      if (!(e instanceof DropboxError)) console.error(e);
      error.textContent = message(e);
    } finally {
      btn.disabled = false;
    }
  }

  async function render(): Promise<void> {
    const auth = await getAuth();
    const loginUrl = await pendingLoginUrl();
    error.textContent = '';
    status.textContent = '';
    const blocks: Node[] = [h('h2', null, 'Sincronizzazione con Dropbox')];

    if (isConnected(auth)) {
      const since = auth?.connectedAt ? new Date(auth.connectedAt).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
      const test: HTMLButtonElement = h('button', {
        type: 'button',
        class: 'btn btn-secondary',
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
            message: 'Questo dispositivo smette di accedere al tuo Dropbox. I file già su Dropbox e i dati su questo dispositivo restano.',
            confirm: 'Scollega',
          });
          if (!ok) return;
          await disconnect();
          toast('Dropbox scollegato');
          await render();
        }),
      }, 'Scollega Dropbox');
      blocks.push(
        h('p', null, `Collegato${since ? ` dal ${since}` : ''}, con l’App key ${auth?.appKey}.`),
        h('p', { class: 'muted' }, 'La sincronizzazione dei dati arriva nel prossimo passo: per ora puoi verificare che lettura e scrittura funzionino.'),
        h('div', { class: 'stack' }, test, off),
      );
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
