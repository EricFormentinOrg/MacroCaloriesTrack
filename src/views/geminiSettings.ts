// Impostazioni → Foto del piatto: chiave Gemini dell'utente, modello, note sulla privacy.
import { GeminiError, MODELS } from '../dishAi.js';
import { DEFAULT_MODEL, clearGemini, getGemini, saveGemini, setGeminiModel } from '../gemini.js';
import { confirmSheet, field, h, toast } from '../ui.js';

const STUDIO = 'https://aistudio.google.com';

function modelSelect(current: string, onChange: (v: string) => void): HTMLSelectElement {
  const known = MODELS.some((m) => m.id === current);
  return h('select', { value: current, onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value) },
    ...MODELS.map((m) => h('option', { value: m.id }, m.label)),
    known ? null : h('option', { value: current }, current),
  );
}

function privacy(): HTMLElement {
  return h('details', { class: 'howto' },
    h('summary', null, 'Cosa viene inviato e a chi'),
    h('ul', { class: 'steps' },
      h('li', null, 'Solo la foto del piatto e l’eventuale descrizione, direttamente dal telefono a Google. Prima dell’invio la foto viene ridotta e ripulita dei metadati, compresa la posizione GPS. L’app non la conserva.'),
      h('li', null, 'Con una chiave gratuita Google può usare foto e risposte per migliorare i suoi prodotti e farle leggere a revisori umani. Con la fatturazione attiva sul progetto Google Cloud non le usa per questo. Non fotografare persone o documenti.'),
      h('li', null, 'Le stime sono approssimative, soprattutto su quantità e condimenti: controlla sempre prima di aggiungere.'),
    ),
  );
}

export async function geminiSection(): Promise<HTMLElement> {
  const root = h('section', { class: 'section gemini-set' });
  const error = h('p', { class: 'form-error', role: 'alert' });

  async function render(): Promise<void> {
    const s = await getGemini();
    error.textContent = '';
    const blocks: Node[] = [h('h2', null, 'Foto del piatto')];
    if (s) {
      blocks.push(
        h('p', null, `Chiave Gemini salvata su questo dispositivo, che termina con “…${s.apiKey.slice(-4)}”.`),
        field('Modello', modelSelect(s.model, async (v) => {
          await setGeminiModel(v);
          toast('Modello aggiornato');
        })),
        privacy(),
        h('button', {
          type: 'button',
          class: 'btn btn-quiet',
          onClick: async () => {
            const ok = await confirmSheet({
              title: 'Eliminare la chiave Gemini?',
              message: 'La chiave viene cancellata da questo dispositivo. Per revocarla del tutto eliminala anche in Google AI Studio.',
              confirm: 'Elimina',
              danger: true,
            });
            if (!ok) return;
            await clearGemini();
            toast('Chiave eliminata');
            await render();
          },
        }, 'Elimina la chiave'),
      );
    } else {
      const key = h('input', { type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: 64 });
      let model = DEFAULT_MODEL;
      const save: HTMLButtonElement = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Salva la chiave');
      blocks.push(
        h('p', null, 'Fotografa il piatto e Gemini stima alimenti, quantità e valori: tu controlli e aggiungi al diario. Serve una tua chiave Gemini.'),
        h('details', { class: 'howto' },
          h('summary', null, 'Come creare la chiave'),
          h('ol', { class: 'steps' },
            h('li', null, 'Apri ', h('a', { href: STUDIO, target: '_blank', rel: 'noopener noreferrer' }, 'Google AI Studio'), ' con il tuo account Google e crea una API key.'),
            h('li', null, 'Limitala alla sola Gemini API (“Restrict to Gemini API”): Google rifiuta le chiavi senza restrizioni.'),
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
            saveGemini(key.value, model)
              .then(async () => {
                toast('Chiave Gemini salvata');
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
          field('Chiave Gemini', key),
          field('Modello', modelSelect(model, (v) => { model = v; })),
          save,
        ),
      );
    }
    root.replaceChildren(...blocks, error);
  }

  await render();
  return root;
}
