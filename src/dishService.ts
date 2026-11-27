// Stima del pasto, da foto o da descrizione: prova i servizi configurati nell'ordine di dishPlan
// (con Gemini per primo: Gemini scelto, Gemini Flash-Lite, OpenRouter) finché uno risponde.
import * as db from './db.js';
import { GeminiError, canTryNext, dishPlan, isAiProvider, modelLabel } from './dishAi.js';
import type { AiProvider, AiStep, Dish, DishInput } from './dishAi.js';
import { geminiAttempt, getGemini } from './gemini.js';
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
  /** Servizio provato per primo quando ci sono entrambe le chiavi. */
  first: AiProvider;
}

/** Servizio da provare per primo; predefinito Gemini. */
export async function getAiFirst(): Promise<AiProvider> {
  const r = (await db.get('kv', 'ai-prefs')) as db.AiPrefs | undefined;
  return isAiProvider(r?.first) ? r.first : 'gemini';
}

export async function setAiFirst(first: AiProvider): Promise<void> {
  if (isAiProvider(first)) await db.put('kv', { id: 'ai-prefs', first });
}

export async function dishProviders(): Promise<DishProviders> {
  const [g, o, first] = await Promise.all([getGemini(), getOpenRouter(), getAiFirst()]);
  return { gemini: !!g, openrouter: !!o, first };
}

const stepLabel = (s: AiStep): string => (s.provider === 'gemini' ? modelLabel(s.model) : `OpenRouter, ${orModelLabel(s.model)}`);

/**
 * Invia la foto o la descrizione e restituisce le voci stimate, già validate. Passa al tentativo
 * successivo solo per errori del servizio o del modello (sovraccarico, tempo scaduto, rete, limiti).
 */
export async function analyzeDish(input: DishInput, onFallback?: (from: string, to: string) => void): Promise<DishResult> {
  const [g, o, first] = await Promise.all([getGemini(), getOpenRouter(), getAiFirst()]);
  const plan = dishPlan(g?.model, o?.model, first);
  if (!plan.length) throw new GeminiError('Inserisci prima una chiave Gemini o OpenRouter in Impostazioni.');
  for (let i = 0; i < plan.length; i++) {
    const step = plan[i];
    try {
      let dish: Dish;
      let label = stepLabel(step);
      if (step.provider === 'gemini' && g) {
        dish = await geminiAttempt(g.apiKey, step.model, input);
      } else if (step.provider === 'openrouter' && o) {
        const r = await openRouterAttempt(o, input);
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
