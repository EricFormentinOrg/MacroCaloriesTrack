// Stima di un piatto da foto con Gemini (chiave dell'utente): richiesta, validazione della risposta,
// abbinamento con la banca dati. Modulo puro, testato in Node.
//
// Verificato il 25/11/2026 (documentazione Google e prove reali di CORS dall'origine dell'app):
// - POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent, chiave
//   nell'header x-goog-api-key (il preflight CORS lo accetta); immagine in contents[].parts[].inline_data;
// - JSON con generationConfig.responseMimeType = application/json e responseJsonSchema;
// - testo generato in candidates[0].content.parts[].text.
// L'endpoint più recente "interactions" richiede l'header Api-Revision, che il preflight CORS rifiuta.
// Le stime da foto sono approssimative: quantità e condimenti nascosti. Si salvano solo dopo conferma.
import { searchCatalog } from './catalog.js';
import type { CatalogItem } from './catalog.js';
import type { NutrientKey, Nutrients, Unit } from './model.js';
import { checkFood } from './nutrition.js';
import { tokens } from './search.js';

export const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';
export const DEFAULT_MODEL = 'gemini-3.8-flash';
/** Modello di riserva: il 26/11/2026 rispondeva mentre i Flash erano sovraccarichi (503). */
export const FALLBACK_MODEL = 'gemini-3.5-flash-lite';
export const MODELS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (consigliato)' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (più economico)' },
];

/** Nome leggibile del modello, senza la nota tra parentesi. */
export const modelLabel = (id: string): string => MODELS.find((m) => m.id === id)?.label.replace(/\s*\(.*\)$/, '') ?? id;

/**
 * Formato delle chiavi non documentato (le "auth keys" create in AI Studio dal 28/05/2026 sono diverse
 * dalle vecchie "AIza…"): solo caratteri stampabili senza spazi, che un header HTTP accetta.
 * La verifica vera la fa Google alla prima richiesta.
 */
export const isGeminiKey = (s: string): boolean => /^[\x21-\x7e]{20,512}$/.test(s);

/** Toglie spazi, a capo e virgolette incollati per errore insieme alla chiave. */
export const normalizeGeminiKey = (s: string): string => s.replace(/\s+/g, '').replace(/^["'`]+|["'`]+$/g, '');
export const isModelId = (s: string): boolean => /^gemini-[a-z0-9.-]{2,40}$/.test(s);

const KEYS: ReadonlyArray<NutrientKey> = ['kcal', 'fat', 'satFat', 'carbs', 'sugars', 'fiber', 'protein', 'salt'];

/** Schema JSON della risposta: i nomi dei campi sono quelli che poi validiamo. */
export const DISH_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Nome in italiano, breve e specifico (es. "Spaghetti al pomodoro")' },
          search: { type: 'string', description: 'Nome generico come in una tabella di composizione (es. "riso bollito", "olio d\'oliva")' },
          grams: { type: 'number', description: 'Quantità stimata nel piatto' },
          unit: { type: 'string', enum: ['g', 'ml'] },
          confidence: { type: 'string', enum: ['alta', 'media', 'bassa'] },
          per100: {
            type: 'object',
            properties: Object.fromEntries(KEYS.map((k) => [k, { type: 'number' }])),
            required: ['kcal', 'fat', 'carbs', 'protein'],
          },
          note: { type: 'string' },
        },
        required: ['name', 'search', 'grams', 'unit', 'confidence', 'per100'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['items'],
} as const;

export function prompt(hint: string): string {
  const h = hint.trim().slice(0, 300);
  return [
    'Sei un dietista. Nella foto c’è un pasto. Elenca ogni alimento o bevanda visibile come voce separata,',
    'compresi condimenti probabili (olio, burro, sughi, formaggio grattugiato) con confidenza "bassa" se non sono visibili.',
    'Per ogni voce stima la quantità nel piatto in grammi (ml per le bevande), considerando dimensioni del piatto e posate,',
    'e i valori nutrizionali per 100 g o 100 ml dell’alimento come appare (cotto, condito o crudo):',
    'kcal, grassi (fat), di cui saturi (satFat), carboidrati (carbs), di cui zuccheri (sugars), fibre (fiber), proteine (protein), sale (salt).',
    'Nel campo "search" scrivi un nome generico italiano come in una tabella di composizione degli alimenti.',
    'Non inventare cibi che non vedi. Se la foto non mostra cibo, restituisci un elenco vuoto e spiega in "notes".',
    h ? `Indicazioni dell’utente: ${h}` : '',
  ].filter(Boolean).join(' ');
}

export function requestUrl(model: string): string {
  if (!isModelId(model)) throw new Error('Modello non valido');
  return `${GEMINI_ORIGIN}/v1beta/models/${model}:generateContent`;
}

export function requestBody(imageBase64: string, mimeType: string, hint: string, withSchema = true): unknown {
  return {
    contents: [{
      parts: [
        { text: prompt(hint) },
        { inline_data: { mime_type: mimeType, data: imageBase64 } },
      ],
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      ...(withSchema ? { responseJsonSchema: DISH_SCHEMA } : {}),
      temperature: 0.2,
    },
  };
}

// ---- Risposte

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export class GeminiError extends Error {
  /** Lo schema JSON non è accettato: si riprova lo stesso modello senza. */
  readonly retryWithoutSchema: boolean;
  /** Errore del servizio o del modello (sovraccarico, tempo scaduto, rete, limite): si può provare il modello di riserva. */
  readonly tryOtherModel: boolean;
  constructor(message: string, opts: { retryWithoutSchema?: boolean; tryOtherModel?: boolean } = {}) {
    super(message);
    this.retryWithoutSchema = opts.retryWithoutSchema ?? false;
    this.tryOtherModel = opts.tryOtherModel ?? false;
  }
}

/** Modello da provare dopo un errore del modello scelto, se ha senso. */
export function fallbackFor(model: string, err: unknown): string | undefined {
  return err instanceof GeminiError && err.tryOtherModel && model !== FALLBACK_MODEL ? FALLBACK_MODEL : undefined;
}

/** Messaggio per l'utente da uno stato HTTP e dal corpo dell'errore. */
export function geminiError(status: number, body: string): GeminiError {
  let msg = '';
  try {
    const j: unknown = JSON.parse(body);
    if (isObj(j) && isObj(j.error) && typeof j.error.message === 'string') msg = j.error.message.slice(0, 300);
  } catch {
    /* corpo non JSON */
  }
  if (/api key not valid|api_key_invalid/i.test(msg)) return new GeminiError('La chiave Gemini non è valida: controllala in Impostazioni.');
  if (status === 400 && /schema|unknown name|invalid json payload/i.test(msg)) return new GeminiError(msg, { retryWithoutSchema: true });
  if (status === 403) return new GeminiError('La chiave Gemini non può usare questa API: in Google AI Studio abilitala per la Gemini API e controlla le restrizioni.');
  // I limiti del piano gratuito e la disponibilità valgono per modello: con un altro modello può andare.
  const other = { tryOtherModel: true };
  if (status === 404) return new GeminiError('Modello Gemini non disponibile per questa chiave: scegline un altro in Impostazioni.', other);
  if (status === 429) return new GeminiError('Limite di richieste Gemini raggiunto (sul piano gratuito è basso): riprova tra un minuto.', other);
  if (status === 503 || /high demand|overloaded/i.test(msg)) return new GeminiError('Gemini è sovraccarico in questo momento: riprova tra qualche minuto.', other);
  if (status >= 500) return new GeminiError('Gemini non risponde: riprova più tardi.', other);
  return new GeminiError(`Richiesta a Gemini non riuscita (${status}${msg ? `: ${msg}` : ''}).`);
}

/** Testo generato dalla risposta di generateContent, o un errore leggibile se il modello ha rifiutato. */
export function responseText(v: unknown): string {
  if (!isObj(v)) throw new GeminiError('Risposta di Gemini non valida.');
  const fb = v.promptFeedback;
  if (isObj(fb) && typeof fb.blockReason === 'string') throw new GeminiError('Gemini ha rifiutato la foto: provane un’altra.');
  const c = Array.isArray(v.candidates) ? v.candidates[0] : undefined;
  if (!isObj(c)) throw new GeminiError('Gemini non ha restituito risultati: riprova.');
  if (c.finishReason === 'SAFETY' || c.finishReason === 'PROHIBITED_CONTENT') throw new GeminiError('Gemini ha rifiutato la foto: provane un’altra.');
  if (c.finishReason === 'MAX_TOKENS') throw new GeminiError('Risposta di Gemini troncata: riprova con una foto di un solo piatto.');
  const parts = isObj(c.content) && Array.isArray(c.content.parts) ? c.content.parts : [];
  const text = parts.map((p) => (isObj(p) && typeof p.text === 'string' && p.thought !== true ? p.text : '')).join('');
  if (!text.trim()) throw new GeminiError('Gemini non ha restituito risultati: riprova.');
  return text;
}

export type Confidence = 'alta' | 'media' | 'bassa';

export interface DishItem {
  name: string;
  search: string;
  qty: number;
  unit: Unit;
  confidence: Confidence;
  per100: Nutrients;
  note?: string;
  /** Avvisi di coerenza sui valori stimati. */
  warnings: string[];
}

export interface Dish {
  items: DishItem[];
  notes?: string;
  /** Voci scartate perché non valide. */
  dropped: number;
}

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}
const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
const r1 = (n: number): number => Math.round(n * 10) / 10;

function item(v: unknown): DishItem | undefined {
  if (!isObj(v)) return undefined;
  const name = text(v.name, 120);
  const qty = num(v.grams, 1, 3000);
  const unit: Unit = v.unit === 'ml' ? 'ml' : 'g';
  const p = v.per100;
  if (!name || qty === undefined || !isObj(p)) return undefined;
  const per100: Partial<Record<NutrientKey, number>> = {};
  for (const k of KEYS) {
    const max = k === 'kcal' ? 950 : 100;
    const x = num(p[k], 0, max);
    if (x !== undefined) per100[k] = k === 'kcal' ? Math.round(x) : k === 'salt' ? Math.round(x * 100) / 100 : r1(x);
  }
  if (per100.kcal === undefined || per100.fat === undefined || per100.carbs === undefined || per100.protein === undefined) return undefined;
  const confidence: Confidence = v.confidence === 'alta' || v.confidence === 'bassa' ? v.confidence : 'media';
  const n = per100 as Nutrients;
  const note = text(v.note, 200);
  return {
    name,
    search: text(v.search, 60) ?? name,
    qty: Math.round(qty),
    unit,
    confidence,
    per100: n,
    ...(note ? { note } : {}),
    warnings: checkFood(n, unit),
  };
}

/** Valida il JSON prodotto dal modello. Le voci non valide sono scartate e contate. */
export function parseDish(jsonText: string): Dish {
  let v: unknown;
  try {
    v = JSON.parse(jsonText.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch {
    throw new GeminiError('Risposta di Gemini non leggibile: riprova.');
  }
  if (!isObj(v) || !Array.isArray(v.items)) throw new GeminiError('Risposta di Gemini non valida.');
  const raw = v.items.slice(0, 20);
  const items = raw.map(item).filter((x): x is DishItem => !!x);
  const notes = text(v.notes, 500);
  return { items, ...(notes ? { notes } : {}), dropped: raw.length - items.length + Math.max(0, v.items.length - 20) };
}

// ---- Abbinamento con la banca dati

export interface Match {
  item: CatalogItem;
  /** Quanto le parole cercate coprono il nome trovato (0–1): sotto 0,5 l'abbinamento non è proposto. */
  coverage: number;
}

/**
 * Cerca nella banca dati svizzera l'alimento generico indicato dal modello. Solo voci che contengono
 * tutte le parole cercate; tra queste, quella con il nome più vicino. Per i piatti composti di solito
 * non c'è abbinamento e restano i valori stimati.
 */
export function matchCatalog(search: string, items: ReadonlyArray<CatalogItem>): Match | undefined {
  const toks = tokens(search).filter((t) => t.length > 2 && !['con', 'del', 'della', 'alla', 'allo'].includes(t));
  if (!toks.length) return undefined;
  const hit = searchCatalog(items, toks, 1)[0];
  if (!hit) return undefined;
  const nameToks = tokens(hit.name).filter((t) => t.length > 2);
  const coverage = nameToks.length ? toks.filter((t) => nameToks.some((n) => n.startsWith(t) || t.startsWith(n))).length / nameToks.length : 0;
  return coverage >= 0.5 ? { item: hit, coverage } : undefined;
}

export const totalKcal = (per100: Nutrients, qty: number): number => Math.round((per100.kcal * qty) / 100);
