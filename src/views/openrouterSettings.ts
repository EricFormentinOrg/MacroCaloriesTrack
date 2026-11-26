// Impostazioni → OpenRouter: chiave dell'utente per la foto del piatto, come riserva di Gemini o al suo posto.
import { GeminiError } from '../dishAi.js';
import { OR_DEFAULT_MODEL, OR_MODELS } from '../openrouter.js';
import { clearOpenRouter, getOpenRouter, saveOpenRouter, setOpenRouterModel } from '../openrouterClient.js';
import { confirmSheet, field, h, toast } from '../ui.js';

const SITE = 'https://openrouter.ai';

function modelSelect(current: string, onChange: (v: string) => void): HTMLSelectElement {
  const known = OR_MODELS.some((m) => m.id === current);
  return h('select', { value: current, onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
    ...OR_MODELS.map((m) => h('option', { value: m.id }, m.label)),
    known ? null : h('option', { value: current }, current),
  );
}

const role = (): HTMLElement =>
  h('p', { class: 'muted' }, 'Usato quando Gemini non risponde, oppure da solo se non hai una chiave Gemini.');

function privacy(): HTMLElement {
  return h('details', { class: 'howto' },
    h('summary', null, 'Costi, limiti e dati'),
    h('ul', { class: 'steps' },
      h('li', null, 'Modelli gratuiti: nessun costo, al massimo 20 richieste al minuto e 50 al giorno (1000 al giorno se hai acquistato almeno 10 crediti). OpenRouter sceglie ogni volta un modello gratuito che sa leggere le foto.'),
      h('li', null, 'Modelli a pagamento: paghi a consumo con il credito del tuo account OpenRouter, solo il modello che ha risposto.'),
      h('li', null, 'La foto, ridotta e senza metadati, passa da OpenRouter al fornitore del modello. OpenRouter non conserva i contenuti, a meno che tu non attivi il log nel tuo account.'),
      h('li', null, 'Alcuni fornitori possono usare i dati per addestrare i modelli: puoi escluderli nelle impostazioni privacy del tuo account OpenRouter, con opzioni separate per modelli gratuiti e a pagamento. Se li escludi per i gratuiti, quelli che leggono le foto diventano pochissimi e spesso al limite. Non fotografare persone o documenti.'),
    ),
  );
}

export async function openRouterSection(): Promise<HTMLElement> {
  const root = h('section', { class: 'section openrouter-set' });
  const error = h('p', { class: 'form-error', role: 'alert' });

  async function render(): Promise<void> {
    const s = await getOpenRouter();
    error.textContent = '';
    const blocks: Node[] = [h('h2', null, 'OpenRouter')];
    if (s) {
      blocks.push(
        h('p', null, `Chiave OpenRouter salvata su questo dispositivo, che termina con “…${s.apiKey.slice(-4)}”.`),
        field('Modello', modelSelect(s.model, async (v) => {
          await setOpenRouterModel(v);
          toast('Modello aggiornato');
        })),
        role(),
        privacy(),
        h('button', {
          type: 'button',
          class: 'btn btn-quiet',
          onClick: async () => {
            const ok = await confirmSheet({
              title: 'Eliminare la chiave OpenRouter?',
              message: 'La chiave viene cancellata da questo dispositivo. Per revocarla del tutto eliminala anche su OpenRouter.',
              confirm: 'Elimina',
              danger: true,
            });
            if (!ok) return;
            await clearOpenRouter();
            toast('Chiave eliminata');
            await render();
          },
        }, 'Elimina la chiave'),
      );
    } else {
      // Stesso limite di isApiKey: un maxlength più corto taglierebbe la chiave in silenzio.
      const key = h('input', { type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: 512 });
      let model = OR_DEFAULT_MODEL;
      const save: HTMLButtonElement = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Salva la chiave');
      blocks.push(
        h('p', null, 'Un secondo servizio per la foto del piatto, quando Gemini è sovraccarico. Con i modelli gratuiti non paghi nulla.'),
        h('details', { class: 'howto' },
          h('summary', null, 'Come creare la chiave'),
          h('ol', { class: 'steps' },
            h('li', null, 'Apri ', h('a', { href: SITE, target: '_blank', rel: 'noopener noreferrer' }, 'OpenRouter'), ' e crea un account.'),
            h('li', null, 'Nella pagina delle chiavi (Keys) crea una API key. Se userai modelli a pagamento, imposta un limite di spesa.'),
            h('li', null, 'Copiala e incollala qui. Resta solo su questo dispositivo: non va nel backup né su Dropbox.'),
          ),
        ),
        privacy(),
        h('form', {
          class: 'form',
          novalidate: true,
          onSubmit: (e: Event) => {
            e.preventDefault();
            save.disabled = true;
            error.textContent = '';
            saveOpenRouter(key.value, model)
              .then(async () => {
                toast('Chiave OpenRouter salvata');
                await render();
              })
              .catch((err: unknown) => {
                error.textContent = err instanceof GeminiError ? err.message : 'Salvataggio non riuscito.';
              })
              .finally(() => {
                save.disabled = false;
              });
          },
        },
          field('Chiave OpenRouter', key),
          field('Modello', modelSelect(model, (v) => { model = v; })),
          role(),
          save,
        ),
      );
    }
    root.replaceChildren(...blocks, error);
  }

  await render();
  return root;
}
