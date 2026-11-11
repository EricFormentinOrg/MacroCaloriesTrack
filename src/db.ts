// IndexedDB senza dipendenze. Fonte primaria dei dati sul dispositivo.
import type { Entry, Food, Profile, Weight } from './model.js';

export interface Meta {
  id: 'meta';
  deviceId: string;
  createdAt: number;
}

/** Cache locale di Open Food Facts: non è un dato utente, non va nel backup né in sincronizzazione. */
export interface CacheRecord {
  key: string;
  at: number;
  data: unknown;
}

export interface Stores {
  foods: Food;
  entries: Entry;
  weights: Weight;
  kv: Profile | Meta;
  cache: CacheRecord;
}

export type StoreName = keyof Stores;
export type Batch = { [K in StoreName]?: Stores[K][] };

const DB_NAME = 'macro-calories-track';
// 2: store "cache" per Open Food Facts.
const DB_VERSION = 2;
let dbp: Promise<IDBDatabase> | undefined;

export function openDb(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('foods')) d.createObjectStore('foods', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('entries')) d.createObjectStore('entries', { keyPath: 'id' }).createIndex('date', 'date');
      if (!d.objectStoreNames.contains('weights')) d.createObjectStore('weights', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache', { keyPath: 'key' }).createIndex('at', 'at');
    };
    r.onsuccess = () => {
      const d = r.result;
      // Un'altra scheda ha aggiornato lo schema: chiudi e ricarica con il codice nuovo.
      d.onversionchange = () => {
        d.close();
        location.reload();
      };
      resolve(d);
    };
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('Il database è aperto in un’altra scheda con una versione precedente: chiudila e ricarica.'));
  });
  return dbp;
}

function wrap<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(t: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error('Transazione annullata'));
  });
}

export async function get<K extends StoreName>(store: K, id: string): Promise<Stores[K] | undefined> {
  const d = await openDb();
  return wrap(d.transaction(store).objectStore(store).get(id)) as Promise<Stores[K] | undefined>;
}

export async function getAll<K extends StoreName>(store: K): Promise<Stores[K][]> {
  const d = await openDb();
  return wrap(d.transaction(store).objectStore(store).getAll()) as Promise<Stores[K][]>;
}

/** Scrive più store in un'unica transazione: o tutto o niente. */
export async function putBatch(batch: Batch): Promise<void> {
  const names = (Object.keys(batch) as StoreName[]).filter((n) => (batch[n]?.length ?? 0) > 0);
  if (!names.length) return;
  const d = await openDb();
  const t = d.transaction(names, 'readwrite');
  for (const n of names) {
    const s = t.objectStore(n);
    for (const v of batch[n] ?? []) s.put(v);
  }
  await done(t);
}

export function put<K extends StoreName>(store: K, value: Stores[K]): Promise<void> {
  return putBatch({ [store]: [value] } as Batch);
}

/** Sostituzione completa (import "Sostituisci"): conserva solo i metadati del dispositivo. */
export async function replaceAll(batch: Batch): Promise<void> {
  const d = await openDb();
  const t = d.transaction(['foods', 'entries', 'weights', 'kv'], 'readwrite');
  for (const n of ['foods', 'entries', 'weights'] as const) t.objectStore(n).clear();
  t.objectStore('kv').delete('profile');
  for (const n of Object.keys(batch) as StoreName[]) {
    const s = t.objectStore(n);
    for (const v of batch[n] ?? []) s.put(v);
  }
  await done(t);
}

export async function clearAll(): Promise<void> {
  const d = await openDb();
  const names: StoreName[] = ['foods', 'entries', 'weights', 'kv', 'cache'];
  const t = d.transaction(names, 'readwrite');
  for (const n of names) t.objectStore(n).clear();
  await done(t);
}

export async function entriesByDate(date: string): Promise<Entry[]> {
  const d = await openDb();
  const idx = d.transaction('entries').objectStore('entries').index('date');
  return wrap(idx.getAll(IDBKeyRange.only(date))) as Promise<Entry[]>;
}

/** Le voci più recenti per data, senza leggere tutto lo storico. */
export async function recentEntries(max: number): Promise<Entry[]> {
  const d = await openDb();
  const idx = d.transaction('entries').objectStore('entries').index('date');
  const out: Entry[] = [];
  await new Promise<void>((resolve, reject) => {
    const r = idx.openCursor(null, 'prev');
    r.onsuccess = () => {
      const c = r.result;
      if (!c || out.length >= max) return resolve();
      out.push(c.value as Entry);
      c.continue();
    };
    r.onerror = () => reject(r.error);
  });
  return out;
}

export async function clearStore(store: StoreName): Promise<void> {
  const d = await openDb();
  const t = d.transaction(store, 'readwrite');
  t.objectStore(store).clear();
  await done(t);
}

/** Tiene in cache solo i record più recenti di maxAge, al massimo maxCount. */
export async function pruneCache(maxAge: number, maxCount: number, now = Date.now()): Promise<void> {
  const d = await openDb();
  const t = d.transaction('cache', 'readwrite');
  const idx = t.objectStore('cache').index('at');
  let kept = 0;
  const r = idx.openCursor(null, 'prev');
  r.onsuccess = () => {
    const c = r.result;
    if (!c) return;
    const rec = c.value as CacheRecord;
    if (now - rec.at > maxAge || kept >= maxCount) c.delete();
    else kept++;
    c.continue();
  };
  await done(t);
}
