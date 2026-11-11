// Banca dati svizzera dei valori nutritivi (USAV), servita come JSON statico da public/data/.
// Il file è nostro, ma viene validato come ogni dato esterno: un errore di generazione
// non deve mai arrivare nel diario.
import type { FoodSource, NutrientKey, Nutrients, Serving, Unit } from './model.js';
import { matchesAll, norm, rank } from './search.js';

export const CATALOG_URL = './data/alimenti-ch.json';
const NUTRIENT_ORDER: ReadonlyArray<NutrientKey> = ['kcal', 'fat', 'satFat', 'carbs', 'sugars', 'fiber', 'protein', 'salt'];
const REQUIRED = new Set<NutrientKey>(['kcal', 'fat', 'carbs', 'protein']);

export interface CatalogItem {
  id: string;
  name: string;
  synonyms?: string;
  category: string;
  per100: Nutrients;
  /** Nome, sinonimi e categoria normalizzati per la ricerca. */
  hay: string;
}

export interface Catalog {
  source: string;
  publisher: string;
  version: string;
  released: string;
  url: string;
  unit: Unit;
  items: CatalogItem[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v: unknown, what: string, max: number, allowEmpty = false): string {
  if (typeof v !== 'string' || v.length > max || (!allowEmpty && !v.trim())) throw new Error(`banca dati: ${what} non valido`);
  return v;
}

function item(t: unknown, i: number): CatalogItem {
  if (!Array.isArray(t) || t.length !== 5) throw new Error(`banca dati: alimento ${i} non valido`);
  const [id, name, syn, cat, vals] = t as unknown[];
  if (typeof id !== 'string' || !/^\d{1,8}$/.test(id)) throw new Error(`banca dati: ID dell'alimento ${i} non valido`);
  const nm = str(name, `nome dell'alimento ${id}`, 200);
  const synonyms = str(syn, `sinonimi dell'alimento ${id}`, 300, true);
  const category = str(cat, `categoria dell'alimento ${id}`, 100, true);
  if (!Array.isArray(vals) || vals.length !== NUTRIENT_ORDER.length) throw new Error(`banca dati: valori dell'alimento ${id} non validi`);
  const per100: Partial<Record<NutrientKey, number>> = {};
  NUTRIENT_ORDER.forEach((k, j) => {
    const v: unknown = vals[j];
    if (v === null && !REQUIRED.has(k)) return;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1000) throw new Error(`banca dati: ${k} dell'alimento ${id} non valido`);
    per100[k] = v;
  });
  return {
    id,
    name: nm,
    ...(synonyms ? { synonyms } : {}),
    category,
    per100: per100 as Nutrients,
    hay: norm(`${nm} ${synonyms} ${category}`),
  };
}

export function parseCatalog(v: unknown): Catalog {
  if (!isObj(v) || v.format !== 1) throw new Error('banca dati: formato non riconosciuto');
  if (v.unit !== 'g') throw new Error('banca dati: unità non valida');
  if (!Array.isArray(v.nutrients) || v.nutrients.join() !== NUTRIENT_ORDER.join()) throw new Error('banca dati: elenco dei nutrienti inatteso');
  if (!Array.isArray(v.foods) || v.foods.length === 0 || v.foods.length > 20000) throw new Error('banca dati: elenco degli alimenti non valido');
  const items = v.foods.map(item);
  if (new Set(items.map((x) => x.id)).size !== items.length) throw new Error('banca dati: ID duplicati');
  return {
    source: str(v.source, 'nome della fonte', 200),
    publisher: str(v.publisher, 'editore', 200),
    version: str(v.version, 'versione', 20),
    released: str(v.released, 'data', 10),
    url: str(v.url, 'indirizzo', 200),
    unit: 'g',
    items,
  };
}

/** Risultati ordinati per pertinenza; `exclude` contiene gli ID già copiati tra gli alimenti personali. */
export function searchCatalog(items: ReadonlyArray<CatalogItem>, toks: ReadonlyArray<string>, limit = 40, exclude?: ReadonlySet<string>): CatalogItem[] {
  if (!toks.length) return [];
  return items
    .filter((x) => !exclude?.has(x.id) && matchesAll(x.hay, toks))
    .map((x) => ({ x, s: rank(x.name, toks) }))
    .sort((a, b) => b.s - a.s || a.x.name.localeCompare(b.x.name, 'it'))
    .slice(0, limit)
    .map((r) => r.x);
}

/** Campi dell'alimento personale creato al primo uso. */
export function catalogFood(x: CatalogItem): { name: string; unit: Unit; per100: Nutrients; servings: Serving[]; source: FoodSource; sourceId: string } {
  return { name: x.name, unit: 'g', per100: { ...x.per100 }, servings: [], source: 'ch', sourceId: x.id };
}
