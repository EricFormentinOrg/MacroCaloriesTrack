// Impostazioni → Stima del pasto: cosa fa e quale servizio provare per primo tra Gemini e OpenRouter.
import type { AiProvider } from '../dishAi.js';
import { getAiFirst, setAiFirst } from '../dishService.js';
import { h, segmented, toast } from '../ui.js';

export async function aiSection(): Promise<HTMLElement> {
  const first = await getAiFirst();
  return h('section', { class: 'section ai-set' },
    h('h2', null, 'Stima del pasto'),
    h('p', null, 'Fotografa il piatto o descrivi cosa hai mangiato: Gemini o OpenRouter stimano alimenti, quantità e valori, tu controlli e correggi prima di aggiungere. Servono le tue chiavi, nelle sezioni qui sotto.'),
    segmented<AiProvider>('Prova per primo', [{ value: 'gemini', label: 'Gemini' }, { value: 'openrouter', label: 'OpenRouter' }], first, (v) => {
      void setAiFirst(v).then(() => toast(v === 'gemini' ? 'Gemini verrà provato per primo' : 'OpenRouter verrà provato per primo'));
    }),
    h('p', { class: 'muted' }, 'Vale quando hai entrambe le chiavi. Se il primo servizio non risponde (sovraccarico, limiti, rete), l’app prova da sola l’altro; con una sola chiave usa quella.'),
  );
}
