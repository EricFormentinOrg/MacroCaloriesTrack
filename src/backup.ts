import { isISODate } from './dates.js';
import { FOOD_SOURCES, MEALS, clean, isMeal, mealLabel } from './model.js';
import type { Entry, EntryServing, Food, FoodSource, Goal, NutrientKey, Nutrients, Profile, Serving, SyncRecord, Targets, Weight } from './model.js';
import { entryNutrients } from './nutrition.js';

export const BACKUP_APP = 'MacroCaloriesTrack';
export const BACKUP_FORMAT = 1;

export interface BackupData {
  profile: Profile | null;
  foods: Food[];
  entries: Entry[];
  weights: Weight[];
}

export interface BackupFile {
  app: typeof BACKUP_APP;
  format: typeof BACKUP_FORMAT;
  exportedAt: string;
  data: BackupData;
}

export type ParseResult = { ok: true; data: BackupData; exportedAt: string } | { ok: false; error: string };

/** Il backup include i record eliminati, così l'import su un altro dispositivo propaga le cancellazioni. */
export function buildBackup(data: BackupData, now = new Date()): BackupFile {
  return { app: BACKUP_APP, format: BACKUP_FORMAT, exportedAt: now.toISOString(), data };
}

// ---- Validazione: ogni record viene ricostruito campo per campo; i campi sconosciuti sono scartati.

class Invalid extends Error {}
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function need(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Invalid(msg);
}

function reqStr(o: Obj, k: string, max: number): string {
  const v = o[k];
  need(typeof v === 'string' && v.trim().length > 0 && v.length <= max, `campo “${k}” non valido`);
  return v;
}

function optStr(o: Obj, k: string, max: number): string | undefined {
  const v = o[k];
  if (v === undefined || v === null || v === '') return undefined;
  need(typeof v === 'string' && v.length <= max, `campo “${k}” non valido`);
  return v;
}

function reqNum(o: Obj, k: string, min: number, max: number): number {
  const v = o[k];
  need(typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max, `campo “${k}” fuori intervallo`);
  return v;
}

function optNum(o: Obj, k: string, min: number, max: number): number | undefined {
  return o[k] === undefined || o[k] === null ? undefined : reqNum(o, k, min, max);
}

function base(o: Obj): SyncRecord {
  need(o.deleted === undefined || typeof o.deleted === 'boolean', 'campo “deleted” non valido');
  return clean({ id: reqStr(o, 'id', 100), updatedAt: reqNum(o, 'updatedAt', 0, 1e15), deleted: o.deleted === true ? true : undefined });
}

function nutrients(v: unknown): Nutrients {
  need(isObj(v), 'valori nutrizionali mancanti');
  const opt = (k: NutrientKey) => optNum(v, k, 0, 1000);
  return clean({
    kcal: reqNum(v, 'kcal', 0, 1000),
    fat: reqNum(v, 'fat', 0, 1000),
    carbs: reqNum(v, 'carbs', 0, 1000),
    protein: reqNum(v, 'protein', 0, 1000),
    satFat: opt('satFat'),
    sugars: opt('sugars'),
    fiber: opt('fiber'),
    salt: opt('salt'),
  });
}

function unit(o: Obj): 'g' | 'ml' {
  need(o.unit === 'g' || o.unit === 'ml', 'unità non valida');
  return o.unit;
}

function servings(v: unknown): Serving[] {
  if (v === undefined) return [];
  need(Array.isArray(v) && v.length <= 50, 'porzioni non valide');
  return v.map((s) => {
    need(isObj(s), 'porzione non valida');
    return { label: reqStr(s, 'label', 60), qty: reqNum(s, 'qty', 0.001, 100000) };
  });
}

function entryServing(v: unknown): EntryServing | undefined {
  if (v === undefined || v === null) return undefined;
  need(isObj(v), 'porzione non valida');
  return { label: reqStr(v, 'label', 60), qty: reqNum(v, 'qty', 0.001, 100000), count: reqNum(v, 'count', 0, 10000) };
}

function food(o: unknown): Food {
  need(isObj(o), 'record non valido');
  // Backup precedenti alla Fase 2: source mancante o 'custom'.
  const source: FoodSource = o.source === undefined ? 'custom' : (o.source as FoodSource);
  need(FOOD_SOURCES.includes(source), 'campo “source” non valido');
  const sourceId = optStr(o, 'sourceId', 32);
  need(source === 'custom' ? sourceId === undefined : sourceId !== undefined && /^\d{1,14}$/.test(sourceId), 'campo “sourceId” non valido');
  need(o.favorite === undefined || typeof o.favorite === 'boolean', 'campo “favorite” non valido');
  return clean({
    ...base(o),
    name: reqStr(o, 'name', 200),
    brand: optStr(o, 'brand', 200),
    barcode: optStr(o, 'barcode', 32),
    unit: unit(o),
    per100: nutrients(o.per100),
    servings: servings(o.servings),
    source,
    sourceId,
    favorite: o.favorite === true ? true : undefined,
    createdAt: reqNum(o, 'createdAt', 0, 1e15),
  });
}

function entry(o: unknown): Entry {
  need(isObj(o), 'record non valido');
  need(isISODate(o.date), 'data non valida');
  need(isMeal(o.meal), 'pasto non valido');
  return clean({
    ...base(o),
    date: o.date,
    meal: o.meal,
    foodId: reqStr(o, 'foodId', 100),
    name: reqStr(o, 'name', 200),
    brand: optStr(o, 'brand', 200),
    unit: unit(o),
    qty: reqNum(o, 'qty', 0, 100000),
    per100: nutrients(o.per100),
    serving: entryServing(o.serving),
    createdAt: reqNum(o, 'createdAt', 0, 1e15),
  });
}

function weight(o: unknown): Weight {
  need(isObj(o), 'record non valido');
  need(isISODate(o.date) && o.id === o.date, 'data non valida');
  return clean({ ...base(o), date: o.date, kg: reqNum(o, 'kg', 20, 400) });
}

function targets(v: unknown): Targets | undefined {
  if (v === undefined || v === null) return undefined;
  need(isObj(v), 'obiettivi non validi');
  return {
    kcal: reqNum(v, 'kcal', 0, 20000),
    protein: reqNum(v, 'protein', 0, 2000),
    carbs: reqNum(v, 'carbs', 0, 2000),
    fat: reqNum(v, 'fat', 0, 2000),
  };
}

function profile(o: unknown): Profile {
  need(isObj(o), 'profilo non valido');
  need(o.id === 'profile', 'profilo non valido');
  need(o.sex === 'm' || o.sex === 'f', 'sesso non valido');
  need(isISODate(o.birthDate), 'data di nascita non valida');
  need(o.goal === 'lose' || o.goal === 'maintain' || o.goal === 'gain', 'obiettivo non valido');
  need(typeof o.manual === 'boolean', 'campo “manual” non valido');
  return clean({
    ...base(o),
    id: 'profile' as const,
    sex: o.sex,
    birthDate: o.birthDate,
    heightCm: reqNum(o, 'heightCm', 50, 280),
    activity: reqNum(o, 'activity', 1, 2.5),
    goal: o.goal as Goal,
    rateKgWeek: reqNum(o, 'rateKgWeek', 0, 2),
    targetKg: optNum(o, 'targetKg', 20, 400),
    proteinPerKg: reqNum(o, 'proteinPerKg', 0, 5),
    fatPct: reqNum(o, 'fatPct', 0, 100),
    manual: o.manual,
    manualTargets: targets(o.manualTargets),
  });
}

function list<T>(v: unknown, name: string, fn: (o: unknown) => T, errs: string[]): T[] {
  if (!Array.isArray(v)) {
    errs.push(`“${name}” mancante`);
    return [];
  }
  const out: T[] = [];
  v.forEach((o, i) => {
    try {
      out.push(fn(o));
    } catch (e) {
      if (!(e instanceof Invalid)) throw e;
      errs.push(`${name}[${i}]: ${e.message}`);
    }
  });
  return out;
}

export function parseBackup(text: string): ParseResult {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Il file non è un JSON valido.' };
  }
  if (!isObj(obj) || obj.app !== BACKUP_APP) return { ok: false, error: 'Il file non è un backup di MacroCaloriesTrack.' };
  if (obj.format !== BACKUP_FORMAT) return { ok: false, error: `Versione del backup non supportata (${String(obj.format)}).` };
  if (!isObj(obj.data)) return { ok: false, error: 'Il backup non contiene dati.' };
  const d = obj.data;
  const errs: string[] = [];
  let prof: Profile | null = null;
  if (d.profile !== null && d.profile !== undefined) {
    try {
      prof = profile(d.profile);
    } catch (e) {
      if (!(e instanceof Invalid)) throw e;
      errs.push(`profilo: ${e.message}`);
    }
  }
  const data: BackupData = {
    profile: prof,
    foods: list(d.foods, 'alimenti', food, errs),
    entries: list(d.entries, 'diario', entry, errs),
    weights: list(d.weights, 'pesi', weight, errs),
  };
  if (errs.length) {
    const more = errs.length > 3 ? ` e altri ${errs.length - 3}` : '';
    return { ok: false, error: `Il file contiene dati non validi: ${errs.slice(0, 3).join('; ')}${more}. Nessun dato importato.` };
  }
  const exportedAt = typeof obj.exportedAt === 'string' ? obj.exportedAt : '';
  return { ok: true, data, exportedAt };
}

export function countAlive(data: BackupData): { foods: number; entries: number; weights: number; profile: boolean } {
  const n = (a: ReadonlyArray<SyncRecord>) => a.filter((r) => !r.deleted).length;
  return { foods: n(data.foods), entries: n(data.entries), weights: n(data.weights), profile: !!data.profile && !data.profile.deleted };
}

// ---- CSV per Excel in italiano: separatore ";" e virgola decimale.

function csvCell(v: string | number | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'number') return String(Math.round(v * 10) / 10).replace('.', ',');
  // Blocca l'interpretazione come formula all'apertura nel foglio di calcolo.
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function diaryCSV(entries: ReadonlyArray<Entry>): string {
  const order = new Map(MEALS.map((m, i) => [m.id, i]));
  const rows = entries
    .filter((e) => !e.deleted)
    .sort((a, b) => a.date.localeCompare(b.date) || (order.get(a.meal)! - order.get(b.meal)!) || a.createdAt - b.createdAt);
  const head = ['Data', 'Pasto', 'Alimento', 'Marca', 'Quantità', 'Unità', 'kcal', 'Proteine g', 'Carboidrati g', 'Grassi g', 'Grassi saturi g', 'Zuccheri g', 'Fibre g', 'Sale g'];
  const lines = rows.map((e) => {
    const n = entryNutrients(e);
    return [e.date, mealLabel(e.meal), e.name, e.brand, e.qty, e.unit, n.kcal, n.protein, n.carbs, n.fat, n.satFat, n.sugars, n.fiber, n.salt]
      .map(csvCell)
      .join(';');
  });
  return '\uFEFF' + [head.join(';'), ...lines].join('\r\n') + '\r\n';
}
