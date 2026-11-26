// Stima del piatto da foto: prova i servizi configurati nell'ordine di dishPlan
// (Gemini scelto, Gemini Flash-Lite, OpenRouter) finché uno risponde.
import { GeminiError, canTryNext, dishPlan, modelLabel } from './dishAi.js';
import type { AiStep, Dish } from './dishAi.js';
import { geminiAttempt, getGemini } from './gemini.js';
import type { PreparedImage } from './gemini.js';
import { orModelLabel } from './openrouter.js';
import { getOpenRouter, openRouterAttempt } from './openrouterClient.js';

export interface DishResult extends Dish {
  /** Servizio e modello che hanno prodotto la stima, per l'utente. */
  source: string;
  /** Presente se il primo tentativo non ha risposto. */
  fallbackFrom?: string;
}

export interface DishProviders {
  gemini: boolean;
  openrouter: boolean;
}

export async function dishProviders(): Promise<DishProviders> {
  const [g, o] = await Promise.all([getGemini(), getOpenRouter()]);
  return { gemini: !!g, openrouter: !!o };
}

const stepLabel = (s: AiStep): string => (s.provider === 'gemini' ? modelLabel(s.model) : `OpenRouter, ${orModelLabel(s.model)}`);

/**
 * Invia la foto e restituisce le voci stimate, già validate. Passa al tentativo successivo solo
 * per errori del servizio o del modello (sovraccarico, tempo scaduto, rete, limiti).
 */
export async function analyzeDish(img: PreparedImage, hint: string, onFallback?: (from: string, to: string) => void): Promise<DishResult> {
  const [g, o] = await Promise.all([getGemini(), getOpenRouter()]);
  const plan = dishPlan(g?.model, o?.model);
  if (!plan.length) throw new GeminiError('Inserisci prima una chiave Gemini o OpenRouter in Impostazioni.');
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    try {
      let dish: Dish;
      let label = stepLabel(step);
      if (step.provider === 'gemini' && g) {
        dish = await geminiAttempt(g.apiKey, step.model, img, hint);
      } else if (step.provider === 'openrouter' && o) {
        const r = await openRouterAttempt(o, img, hint);
        dish = r.dish;
        // Con il router dei modelli gratuiti si mostra il modello scelto da OpenRouter.
        if (r.model && r.model !== o.model) label = `OpenRouter, ${orModelLabel(r.model)}`;
      } else {
        continue;
      }
      return { ...dish, source: label, ...(i > 0 ? { fallbackFrom: stepLabel(plan[0]) } : {}) };
    } catch (e) {
      const next = plan[i + 1];
      if (next && canTryNext(e)) {
        onFallback?.(stepLabel(step), stepLabel(next));
        continue;
      }
      if (i > 0 && canTryNext(e) && e instanceof GeminiError) {
        throw new GeminiError(`Nessun servizio ha risposto (${plan.map(stepLabel).join(', ')}). Ultimo errore: ${e.message}`);
      }
      throw e;
    }
  }
  throw new GeminiError('Analisi non riuscita: riprova.');
}
