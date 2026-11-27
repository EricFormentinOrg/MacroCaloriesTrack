// OpenRouter per la stima del pasto (foto o descrizione), come riserva di Gemini, al suo posto o prima di lui:
// richiesta, risposta, errori.
// Modulo puro, testato in Node. Formato verificato sulla documentazione di OpenRouter il 26/11/2026
// (Chat Completions con `response_format` json_schema e `provider.require_parameters`).
import { DISH_SCHEMA, GeminiError, promptFor, refusal } from './dishAi.js';
import type { DishInput, DishKind } from './dishAi.js';

export const OPENROUTER_ORIGIN = 'https://openrouter.ai';
export const OPENROUTER_URL = `${OPENROUTER_ORIGIN}/api/v1/chat/completions`;

/** Router dei modelli gratuiti: sceglie un modello gratuito che accetta foto e schema JSON. */
export const OR_DEFAULT_MODEL = 'openrouter/free';
/** Modelli verificati nel catalogo il 26/11/2026: accettano immagini e structured outputs. */
export const OR_MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'openrouter/free', label: 'Modelli gratuiti (scelta automatica)' },
  { id: 'anthropic/claude-haiku-5.5', label: 'Claude Haiku 5.5 (a pagamento, economico)' },
  { id: 'openai/gpt-6-luna', label: 'GPT-6 Luna (a pagamento, economico)' },
  { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5 (a pagamento, più accurato)' },
];

/** Formato degli id di OpenRouter: "autore/modello", con varianti come ":free". */
export const isOrModelId = (s: string): boolean => /^[a-z0-9][a-z0-9._-]{0,40}\/[a-z0-9][a-z0-9._:~-]{0,80}$/.test(s);

/** Nome leggibile: l'etichetta per i modelli noti (senza la nota tra parentesi), altrimenti l'id. */
export const orModelLabel = (id: string): string => OR_MODELS.find((m) => m.id === id)?.label.replace(/\s*\(.*\)$/, '') ?? id;

export function orRequestBody(input: DishInput, model: string, withSchema = true): unknown {
  if (!isOrModelId(model)) throw new Error('Modello non valido');
  const text = { type: 'text', text: promptFor(input) };
  return {
    model,
    messages: [{
      role: 'user',
      // Senza foto il router dei modelli gratuiti può scegliere anche modelli solo testuali.
      content: input.kind === 'photo'
        ? [text, { type: 'image_url', image_url: { url: `data:${input.mimeType};base64,${input.base64}` } }]
        : [text],
    }],
    // Schema come indicazione forte, non "strict": secondo la documentazione le modalità rigide limitano
    // le funzioni di JSON Schema usabili, e lo schema ha campi facoltativi. La risposta passa comunque da parseDish.
    response_format: withSchema
      ? { type: 'json_schema', json_schema: { name: 'piatto', strict: false, schema: DISH_SCHEMA } }
      : { type: 'json_object' },
    // Solo fornitori che supportano davvero tutti i parametri della richiesta (foto, se c'è, e formato JSON).
    provider: { require_parameters: true },
    temperature: 0.2,
    max_tokens: 8000,
  };
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

const clip = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 300);

/**
 * Messaggio per l'utente da uno stato HTTP e dal corpo dell'errore di OpenRouter.
 * I casi particolari vengono da risposte vere del 26/11/2026.
 */
export function orError(status: number, body: string): GeminiError {
  let msg = '';
  let raw = '';
  let limitSource = '';
  try {
    const j: unknown = JSON.parse(body);
    if (isObj(j) && isObj(j.error)) {
      if (typeof j.error.message === 'string') msg = clip(j.error.message);
      const m = j.error.metadata;
      if (isObj(m)) {
        if (typeof m.raw === 'string') raw = clip(m.raw);
        if (typeof m.limit_source === 'string') limitSource = m.limit_source;
      }
    }
  } catch {
    /* corpo non JSON */
  }
  const other = { tryOtherModel: true };
  if (status === 400 && /response_format|json_schema|structured/i.test(msg)) return new GeminiError(msg, { retryWithoutSchema: true });
  if (status === 401) return new GeminiError('La chiave OpenRouter non è valida: controllala in Impostazioni.');
  if (status === 402) return new GeminiError('Credito OpenRouter esaurito: ricaricalo o scegli i modelli gratuiti in Impostazioni.');
  if (status === 403) return new GeminiError(`OpenRouter ha bloccato la richiesta${msg ? `: ${msg}` : '.'}`);
  if (status === 404 && /data policy|privacy|training/i.test(msg)) {
    return new GeminiError('Nessun modello OpenRouter disponibile con le tue impostazioni privacy: su openrouter.ai, in Settings → Privacy, permetti i fornitori dei modelli gratuiti che addestrano sui dati, oppure scegli un modello a pagamento in Impostazioni.');
  }
  if (status === 404 && /requested parameters/i.test(msg)) {
    return new GeminiError('Il modello scelto su OpenRouter non supporta ciò che serve (foto o risposta JSON): scegline un altro in Impostazioni.');
  }
  if (status === 408) return new GeminiError('OpenRouter non ha risposto in tempo: riprova tra qualche minuto.', other);
  if (status === 429 && (/^upstream/.test(limitSource) || /upstream/i.test(raw))) {
    return new GeminiError('Il modello gratuito è al limite presso il suo fornitore: riprova tra poco, oppure scegli un modello a pagamento in Impostazioni.', other);
  }
  if (status === 429) return new GeminiError('Limite di richieste OpenRouter raggiunto: con i modelli gratuiti sono 20 al minuto e 50 al giorno senza crediti acquistati. Riprova più tardi.', other);
  if (status >= 500) return new GeminiError('Il modello su OpenRouter non è disponibile ora: riprova tra qualche minuto.', other);
  return new GeminiError(`Richiesta a OpenRouter non riuscita (${status}${msg ? `: ${msg}` : ''}).`);
}

/** Nuovi tentativi sullo stesso servizio dopo un limite o un errore temporaneo del fornitore. */
export const OR_RETRIES = 2;

/**
 * Attesa in millisecondi prima del nuovo tentativo `attempt` (0, 1, …), o undefined se non conviene
 * riprovare. Con il router gratuito un nuovo tentativo può finire su un altro modello: il 26/11/2026,
 * dopo un 429 del fornitore, la richiesta successiva è riuscita.
 */
export function orRetryDelay(status: number, retryAfter: string | null, attempt: number): number | undefined {
  if (attempt >= OR_RETRIES || ![429, 502, 503].includes(status)) return undefined;
  if (retryAfter && /^\d+$/.test(retryAfter.trim())) {
    const s = Number(retryAfter.trim());
    // Un'attesa lunga non vale la pena: meglio l'errore chiaro o il tentativo successivo.
    return s <= 10 ? Math.max(1, s) * 1000 : undefined;
  }
  return (attempt + 1) * 3000;
}

export interface OrText {
  text: string;
  /** Modello che ha risposto (con il router gratuito è quello scelto da OpenRouter); vuoto se non valido. */
  model: string;
}

/** Testo generato da una risposta Chat Completions, o un errore leggibile. */
export function orResponseText(v: unknown, kind: DishKind = 'photo'): OrText {
  const r = refusal(kind);
  if (!isObj(v)) throw new GeminiError('Risposta di OpenRouter non valida.');
  // Un errore del fornitore durante la generazione può arrivare con stato 200.
  if (isObj(v.error)) {
    const code = typeof v.error.code === 'number' && v.error.code >= 400 && v.error.code < 600 ? v.error.code : 502;
    throw orError(code, JSON.stringify(v));
  }
  const c = Array.isArray(v.choices) ? v.choices[0] : undefined;
  if (!isObj(c)) throw new GeminiError('OpenRouter non ha restituito risultati: riprova.', { tryOtherModel: true });
  if (c.finish_reason === 'content_filter') throw new GeminiError(`Il modello ha rifiutato ${r.refused}`);
  if (c.finish_reason === 'length') throw new GeminiError(`Risposta troncata: ${r.truncated}`);
  if (c.finish_reason === 'error') throw new GeminiError('Il modello su OpenRouter si è interrotto: riprova.', { tryOtherModel: true });
  const content = isObj(c.message) ? c.message.content : undefined;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((p) => (isObj(p) && p.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('')
      : '';
  if (!text.trim()) throw new GeminiError('OpenRouter non ha restituito risultati: riprova.', { tryOtherModel: true });
  const model = typeof v.model === 'string' && isOrModelId(v.model) ? v.model : '';
  return { text, model };
}
