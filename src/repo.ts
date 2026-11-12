import type { BackupData } from './backup.js';
import * as db from './db.js';
import { mergeById, pickNewer } from './merge.js';
import { clean } from './model.js';
import type { Entry, EntryServing, Food, FoodSource, Meal, Nutrients, Profile, Serving, Unit, Weight } from './model.js';

const now = (): number => Date.now();
const newId = (): string => crypto.randomUUID();
const alive = <T extends { deleted?: boolean }>(x: T | undefined): x is T => !!x && !x.deleted;

export async function ensureMeta(): Promise<db.Meta> {
  const m = (await db.get('kv', 'meta')) as db.Meta | undefined;
  if (m) return m;
  const meta: db.Meta = { id: 'meta', deviceId: newId(), createdAt: now() };
  await db.put('kv', meta);
  return meta;
}

// ---- Alimenti

export async function listFoods(): Promise<Food[]> {
  const all = await db.getAll('foods');
  return all.filter((f) => !f.deleted).sort((a, b) => a.name.localeCompare(b.name, 'it', { sensitivity: 'base' }));
}

export async function getFood(id: string): Promise<Food | undefined> {
  const f = await db.get('foods', id);
  return alive(f) ? f : undefined;
}

export interface FoodInput {
  id?: string;
  name: string;
  brand?: string;
  barcode?: string;
  unit: Unit;
  per100: Nutrients;
  servings: Serving[];
  source?: FoodSource;
  sourceId?: string;
  favorite?: boolean;
}

export async function saveFood(input: FoodInput): Promise<Food> {
  const existing = input.id ? await db.get('foods', input.id) : undefined;
  const t = now();
  // La provenienza resta quella della prima copia, anche dopo una modifica dei valori.
  const source = existing?.source ?? input.source ?? 'custom';
  const favorite = input.favorite ?? existing?.favorite;
  const food: Food = clean({
    id: existing?.id ?? newId(),
    createdAt: existing?.createdAt ?? t,
    updatedAt: t,
    source,
    sourceId: source === 'custom' ? undefined : existing?.sourceId ?? input.sourceId,
    favorite: favorite ? true : undefined,
    name: input.name,
    brand: input.brand,
    barcode: input.barcode,
    unit: input.unit,
    per100: clean(input.per100),
    servings: input.servings,
  });
  await db.put('foods', food);
  return food;
}

/** Copia personale ancora attiva di un alimento della banca dati o di Open Food Facts. */
export async function findBySource(source: Exclude<FoodSource, 'custom'>, sourceId: string): Promise<Food | undefined> {
  return (await db.getAll('foods')).find((f) => !f.deleted && f.source === source && f.sourceId === sourceId);
}

/**
 * Primo uso di un alimento esterno: lo copia tra gli alimenti personali, così lo storico
 * e le modifiche restano stabili. Se la copia esiste già, restituisce quella.
 */
export async function adoptFood(input: FoodInput & { source: Exclude<FoodSource, 'custom'>; sourceId: string }): Promise<Food> {
  const existing = await findBySource(input.source, input.sourceId);
  if (existing) {
    if (input.favorite && !existing.favorite) return setFavorite(existing.id, true).then((f) => f ?? existing);
    return existing;
  }
  return saveFood({ ...input, id: undefined });
}

export async function setFavorite(id: string, favorite: boolean): Promise<Food | undefined> {
  const f = await db.get('foods', id);
  if (!alive(f)) return undefined;
  const next = clean({ ...f, favorite: favorite ? true : undefined, updatedAt: now() });
  await db.put('foods', next);
  return next;
}

export async function deleteFood(id: string): Promise<void> {
  const f = await db.get('foods', id);
  if (f) await db.put('foods', { ...f, deleted: true, updatedAt: now() });
}

// ---- Diario

export async function entriesFor(date: string): Promise<Entry[]> {
  return (await db.entriesByDate(date)).filter((e) => !e.deleted);
}

export async function addEntry(date: string, meal: Meal, food: Food, qty: number, serving?: EntryServing): Promise<Entry> {
  const t = now();
  const e: Entry = clean({
    id: newId(),
    createdAt: t,
    updatedAt: t,
    date,
    meal,
    foodId: food.id,
    name: food.name,
    brand: food.brand,
    unit: food.unit,
    qty,
    per100: { ...food.per100 },
    serving,
  });
  await db.put('entries', e);
  return e;
}

export async function updateEntry(e: Entry, ch: { meal: Meal; qty: number; serving?: EntryServing }): Promise<void> {
  await db.put('entries', clean({ ...e, meal: ch.meal, qty: ch.qty, serving: ch.serving, updatedAt: now() }));
}

export async function deleteEntry(e: Entry): Promise<void> {
  await db.put('entries', { ...e, deleted: true, updatedAt: now() });
}

export async function restoreEntry(e: Entry): Promise<void> {
  await db.put('entries', clean({ ...e, deleted: undefined, updatedAt: now() }));
}

export async function entriesBetween(from: string, to: string): Promise<Entry[]> {
  return (await db.entriesBetween(from, to)).filter((e) => !e.deleted);
}

/**
 * Copia voci su un altro giorno (e, se indicato, su un altro pasto). Le copie hanno id nuovi e
 * gli stessi valori registrati: non dipendono dall'alimento attuale.
 */
export async function copyEntries(list: ReadonlyArray<Entry>, date: string, meal?: Meal): Promise<Entry[]> {
  const t = now();
  const copies = list.filter((e) => !e.deleted).map((e, i): Entry => clean({
    ...e,
    id: newId(),
    date,
    meal: meal ?? e.meal,
    createdAt: t + i,
    updatedAt: t,
    deleted: undefined,
  }));
  await db.putBatch({ entries: copies });
  return copies;
}

/** Elimina più voci insieme (tombstone): serve ad annullare una copia. */
export async function deleteEntries(list: ReadonlyArray<Entry>): Promise<void> {
  const t = now();
  await db.putBatch({ entries: list.map((e) => ({ ...e, deleted: true, updatedAt: t })) });
}

/** Ultima voce per alimento, dalla più recente: serve per "recenti" e per la quantità predefinita. */
export async function recentUsage(limit: number): Promise<Map<string, Entry>> {
  const rows = (await db.recentEntries(400)).filter((e) => !e.deleted);
  rows.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? 1 : -1) : b.createdAt - a.createdAt));
  const map = new Map<string, Entry>();
  for (const e of rows) {
    if (!map.has(e.foodId)) map.set(e.foodId, e);
    if (map.size >= limit) break;
  }
  return map;
}

// ---- Profilo e peso

export async function getProfile(): Promise<Profile | undefined> {
  const p = (await db.get('kv', 'profile')) as Profile | undefined;
  return alive(p) ? p : undefined;
}

export async function saveProfile(p: Omit<Profile, 'id' | 'updatedAt' | 'deleted'>): Promise<Profile> {
  const prof: Profile = clean({ ...p, id: 'profile' as const, updatedAt: now() });
  await db.put('kv', prof);
  return prof;
}

/** Peso valido in una data: l'ultima pesata non successiva a quel giorno. */
export async function weightOn(date: string): Promise<Weight | undefined> {
  const ws = (await db.getAll('weights')).filter((w) => !w.deleted && w.date <= date);
  ws.sort((a, b) => (a.date < b.date ? 1 : -1));
  return ws[0];
}

export async function setWeight(date: string, kg: number): Promise<void> {
  await db.put('weights', { id: date, date, kg, updatedAt: now() });
}

export async function deleteWeight(date: string): Promise<void> {
  const w = await db.get('weights', date);
  if (w && !w.deleted) await db.put('weights', { ...w, deleted: true, updatedAt: now() });
}

/** Pesate vive, dalla più vecchia. */
export async function listWeights(): Promise<Weight[]> {
  return (await db.getAll('weights')).filter((w) => !w.deleted).sort((a, b) => (a.date < b.date ? -1 : 1));
}

export async function getWeight(date: string): Promise<Weight | undefined> {
  const w = await db.get('weights', date);
  return alive(w) ? w : undefined;
}

// ---- Backup

export async function exportAll(): Promise<BackupData> {
  const [foods, entries, weights, profile] = await Promise.all([
    db.getAll('foods'),
    db.getAll('entries'),
    db.getAll('weights'),
    db.get('kv', 'profile'),
  ]);
  return { profile: (profile as Profile | undefined) ?? null, foods, entries, weights };
}

/** Restituisce il numero di record scritti. */
export async function importData(data: BackupData, mode: 'merge' | 'replace'): Promise<number> {
  if (mode === 'replace') {
    await db.replaceAll({ foods: data.foods, entries: data.entries, weights: data.weights, kv: data.profile ? [data.profile] : [] });
    return data.foods.length + data.entries.length + data.weights.length + (data.profile ? 1 : 0);
  }
  const cur = await exportAll();
  const batch: db.Batch = {
    foods: mergeById(cur.foods, data.foods),
    entries: mergeById(cur.entries, data.entries),
    weights: mergeById(cur.weights, data.weights),
  };
  if (data.profile && (!cur.profile || pickNewer(cur.profile, data.profile) === data.profile)) batch.kv = [data.profile];
  await db.putBatch(batch);
  return (batch.foods?.length ?? 0) + (batch.entries?.length ?? 0) + (batch.weights?.length ?? 0) + (batch.kv?.length ?? 0);
}

export async function wipeAll(): Promise<void> {
  await db.clearAll();
  await ensureMeta();
}
