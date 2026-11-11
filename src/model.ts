// Modello dati. Ogni record sincronizzabile ha id, updatedAt e un eventuale
// flag deleted (tombstone): serve al merge tra dispositivi e all'import.

export type Meal = 'breakfast' | 'lunch' | 'dinner' | 'snack';

export const MEALS: ReadonlyArray<{ id: Meal; label: string }> = [
  { id: 'breakfast', label: 'Colazione' },
  { id: 'lunch', label: 'Pranzo' },
  { id: 'dinner', label: 'Cena' },
  { id: 'snack', label: 'Spuntino' },
];

export function isMeal(v: unknown): v is Meal {
  return typeof v === 'string' && MEALS.some((m) => m.id === v);
}

export function mealLabel(m: Meal): string {
  return MEALS.find((x) => x.id === m)?.label ?? m;
}

export type NutrientKey = 'kcal' | 'fat' | 'satFat' | 'carbs' | 'sugars' | 'fiber' | 'protein' | 'salt';

/** Valori per 100 g o 100 ml. Energia e tre macronutrienti obbligatori. */
export interface Nutrients {
  kcal: number;
  fat: number;
  carbs: number;
  protein: number;
  satFat?: number;
  sugars?: number;
  fiber?: number;
  salt?: number;
}

export interface NutrientDef {
  key: NutrientKey;
  label: string;
  unit: 'kcal' | 'g';
  required: boolean;
  sub?: boolean;
}

/** Stesso ordine della dichiarazione nutrizionale UE (Reg. 1169/2011). */
export const NUTRIENTS: ReadonlyArray<NutrientDef> = [
  { key: 'kcal', label: 'Energia', unit: 'kcal', required: true },
  { key: 'fat', label: 'Grassi', unit: 'g', required: true },
  { key: 'satFat', label: 'di cui saturi', unit: 'g', required: false, sub: true },
  { key: 'carbs', label: 'Carboidrati', unit: 'g', required: true },
  { key: 'sugars', label: 'di cui zuccheri', unit: 'g', required: false, sub: true },
  { key: 'fiber', label: 'Fibre', unit: 'g', required: false },
  { key: 'protein', label: 'Proteine', unit: 'g', required: true },
  { key: 'salt', label: 'Sale', unit: 'g', required: false },
];

export interface SyncRecord {
  id: string;
  updatedAt: number;
  deleted?: boolean;
}

export type Unit = 'g' | 'ml';

export interface Serving {
  label: string;
  qty: number;
}

/**
 * Provenienza di un alimento personale. Gli alimenti della banca dati svizzera ('ch')
 * e di Open Food Facts ('off') diventano personali al primo uso: una copia stabile,
 * modificabile, che non cambia se la fonte si aggiorna.
 */
export type FoodSource = 'custom' | 'ch' | 'off';

export const FOOD_SOURCES: ReadonlyArray<FoodSource> = ['custom', 'ch', 'off'];

export interface Food extends SyncRecord {
  name: string;
  brand?: string;
  barcode?: string;
  unit: Unit;
  per100: Nutrients;
  servings: Serving[];
  source: FoodSource;
  /** ID nella banca dati svizzera o codice a barre di Open Food Facts. */
  sourceId?: string;
  favorite?: boolean;
  createdAt: number;
}

export interface EntryServing {
  label: string;
  qty: number;
  count: number;
}

/**
 * Voce di diario. Copia i valori dell'alimento al momento dell'inserimento:
 * modificare o eliminare l'alimento non altera lo storico.
 */
export interface Entry extends SyncRecord {
  date: string;
  meal: Meal;
  foodId: string;
  name: string;
  brand?: string;
  unit: Unit;
  qty: number;
  per100: Nutrients;
  serving?: EntryServing;
  createdAt: number;
}

/** Un peso per giorno: id = data. */
export interface Weight extends SyncRecord {
  date: string;
  kg: number;
}

export type Sex = 'm' | 'f';
export type Goal = 'lose' | 'maintain' | 'gain';

export interface Targets {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface Profile extends SyncRecord {
  id: 'profile';
  sex: Sex;
  birthDate: string;
  heightCm: number;
  activity: number;
  goal: Goal;
  rateKgWeek: number;
  targetKg?: number;
  proteinPerKg: number;
  fatPct: number;
  manual: boolean;
  manualTargets?: Targets;
}

export const ACTIVITY_LEVELS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1.2, label: 'Sedentario, poco movimento' },
  { value: 1.375, label: 'Leggero, allenamento 1–3 volte a settimana' },
  { value: 1.55, label: 'Moderato, 3–5 volte a settimana' },
  { value: 1.725, label: 'Alto, 6–7 volte a settimana' },
  { value: 1.9, label: 'Molto alto, lavoro fisico e allenamento' },
];

export const RATES: ReadonlyArray<number> = [0.25, 0.5, 0.75, 1];

/** Rimuove le chiavi con valore undefined (copia superficiale). */
export function clean<T extends object>(obj: T): T {
  const out = { ...obj } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as T;
}
