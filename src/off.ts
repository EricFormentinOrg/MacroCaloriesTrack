// Open Food Facts: URL, validazione delle risposte e limiti di frequenza. Modulo puro, testato in Node.
// Documentazione: https://openfoodfacts.github.io/openfoodfacts-server/api/
// - letture prodotto: 15 richieste al minuto per IP; ricerche: 10 al minuto per IP;
// - ricerca testuale solo con /cgi/search.pl (non disponibile nella API v2);
// - User-Agent "NomeApp/Versione (contatto)" richiesto.
// Dati sotto licenza ODbL; i valori sono inseriti da volontari e vanno controllati.
import type { Nutrients, NutrientKey, Serving, Unit } from './model.js';
import { checkFood } from './nutrition.js';

export const OFF_ORIGIN = 'https://world.openfoodfacts.org';
export const OFF_PRODUCT_LIMIT = 15;
export const OFF_SEARCH_LIMIT = 10;
export const OFF_PAGE_SIZE = 24;

const FIELDS = [
  'code', 'product_name', 'product_name_it', 'generic_name', 'generic_name_it', 'brands',
  'quantity', 'product_quantity_unit', 'serving_quantity', 'nutrition_data', 'nutriments',
].join(',');

export interface OffProduct {
  code: string;
  name: string;
  brand?: string;
  unit: Unit;
  per100: Partial<Nutrients>;
  /** Energia e i tre macronutrienti presenti. */
  complete: boolean;
  serving?: Serving;
}

export const isBarcode = (s: string): boolean => /^\d{8,14}$/.test(s.trim());

export function productUrl(code: string): string {
  if (!isBarcode(code)) throw new Error('Codice a barre non valido');
  return `${OFF_ORIGIN}/api/v2/product/${code.trim()}.json?fields=${FIELDS}`;
}

export function searchUrl(query: string): string {
  const q = new URLSearchParams({
    search_terms: query.trim().slice(0, 100),
    search_simple: '1',
    action: 'process',
    json: '1',
    page_size: String(OFF_PAGE_SIZE),
    lc: 'it',
    fields: FIELDS,
  });
  return `${OFF_ORIGIN}/cgi/search.pl?${q.toString()}`;
}

/** Il browser non permette di impostare User-Agent: il server accetta X-User-Agent (verificato nel preflight CORS). */
export function userAgent(version: string, appUrl: string): string {
  return `MacroCaloriesTrack/${version} (+${appUrl})`.replace(/[^\x20-\x7e]/g, '').slice(0, 200);
}

// ---- Validazione

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// Caratteri di controllo, invisibili e di direzione del testo (categorie Unicode Cc, Cf, Zl, Zp).
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** Testo dal server: niente caratteri di controllo, spazi compattati, lunghezza limitata. */
function text(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}

/** OFF restituisce numeri a volte come stringa. */
function num(v: unknown, max: number): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= max ? n : undefined;
}

const r1 = (n: number): number => Math.round(n * 10) / 10;
const r2 = (n: number): number => Math.round(n * 100) / 100;

function nutrients(v: unknown): Partial<Nutrients> {
  if (!isObj(v)) return {};
  const out: Partial<Record<NutrientKey, number>> = {};
  const kcal = num(v['energy-kcal_100g'], 1000);
  const kj = num(v['energy-kj_100g'], 4200) ?? (v.energy_unit === undefined || v.energy_unit === 'kJ' ? num(v.energy_100g, 4200) : undefined);
  if (kcal !== undefined) out.kcal = Math.round(kcal);
  else if (kj !== undefined) out.kcal = Math.round(kj / 4.184);
  const g = (k: string) => num(v[`${k}_100g`], 100);
  const set = (key: NutrientKey, val: number | undefined, round = r1) => {
    if (val !== undefined) out[key] = round(val);
  };
  set('fat', g('fat'));
  set('satFat', g('saturated-fat'));
  set('carbs', g('carbohydrates'));
  set('sugars', g('sugars'));
  set('fiber', g('fiber'));
  set('protein', g('proteins'));
  const sodium = g('sodium');
  set('salt', g('salt') ?? (sodium !== undefined ? sodium * 2.5 : undefined), r2);
  return out;
}

function unitOf(p: Obj): Unit {
  if (p.product_quantity_unit === 'ml') return 'ml';
  if (p.product_quantity_unit === 'g') return 'g';
  const q = typeof p.quantity === 'string' ? p.quantity : '';
  return /\d\s*(ml|cl|dl|l)\b/i.test(q) ? 'ml' : 'g';
}

/** Restituisce undefined se il prodotto non ha codice o nome utilizzabili. */
export function parseOffProduct(v: unknown): OffProduct | undefined {
  if (!isObj(v)) return undefined;
  const code = typeof v.code === 'number' ? String(v.code) : typeof v.code === 'string' ? v.code.trim() : '';
  if (!/^\d{6,14}$/.test(code)) return undefined;
  const name = text(v.product_name_it, 200) ?? text(v.product_name, 200) ?? text(v.generic_name_it, 200) ?? text(v.generic_name, 200);
  if (!name) return undefined;
  const brandsRaw = Array.isArray(v.brands) ? v.brands[0] : v.brands;
  const brand = typeof brandsRaw === 'string' ? text(brandsRaw.split(',')[0], 200) : undefined;
  const per100 = v.nutrition_data === 'off' ? {} : nutrients(v.nutriments);
  const complete = per100.kcal !== undefined && per100.fat !== undefined && per100.carbs !== undefined && per100.protein !== undefined;
  const sq = num(v.serving_quantity, 5000);
  const unit = unitOf(v);
  return {
    code,
    name,
    ...(brand ? { brand } : {}),
    unit,
    per100,
    complete,
    ...(sq && sq > 0 ? { serving: { label: 'porzione', qty: r1(sq) } } : {}),
  };
}

/** null = prodotto non trovato. Lancia un errore se la risposta non ha la forma attesa. */
export function parseProductResponse(v: unknown): OffProduct | null {
  if (!isObj(v)) throw new Error('Risposta di Open Food Facts non valida.');
  if (v.status === 0) return null;
  if (v.status !== 1) throw new Error('Risposta di Open Food Facts non valida.');
  return parseOffProduct(v.product) ?? null;
}

export function parseSearchResponse(v: unknown): { count: number; products: OffProduct[] } {
  if (!isObj(v) || !Array.isArray(v.products) || v.products.length > 200) throw new Error('Risposta di Open Food Facts non valida.');
  const products: OffProduct[] = [];
  const seen = new Set<string>();
  for (const p of v.products) {
    const x = parseOffProduct(p);
    if (x && !seen.has(x.code)) {
      seen.add(x.code);
      products.push(x);
    }
  }
  const count = num(v.count, 1e9) ?? products.length;
  return { count, products };
}

/** Avvisi da mostrare prima di usare i valori: dati mancanti o incoerenti. */
export function reviewNotes(p: OffProduct): string[] {
  if (!p.complete) return ['Mancano alcuni valori obbligatori: completali dall’etichetta.'];
  return checkFood(p.per100 as Nutrients, p.unit);
}

export function offFood(p: OffProduct): { name: string; brand?: string; barcode: string; unit: Unit; per100: Partial<Nutrients>; servings: Serving[]; source: 'off'; sourceId: string } {
  return {
    name: p.name,
    ...(p.brand ? { brand: p.brand } : {}),
    barcode: p.code,
    unit: p.unit,
    per100: { ...p.per100 },
    servings: p.serving ? [{ ...p.serving }] : [],
    source: 'off',
    sourceId: p.code,
  };
}

// ---- Limite di frequenza lato client: resta sotto i limiti documentati anche con più ricerche ravvicinate.

export class RateLimiter {
  private stamps: number[] = [];
  constructor(private readonly max: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** 0 se la richiesta può partire (e la registra), altrimenti i millisecondi da attendere. */
  take(): number {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < this.windowMs);
    if (this.stamps.length >= this.max) return this.windowMs - (t - this.stamps[0]);
    this.stamps.push(t);
    return 0;
  }
}
