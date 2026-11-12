// Sincronizzazione nell'app: adattatori IndexedDB e Dropbox per il motore puro (sync.ts),
// chiave in IndexedDB, avvio automatico dopo le modifiche, al ritorno online e all'apertura.
import * as db from './db.js';
import type { SyncKeyRecord, SyncStateRecord } from './db.js';
import { DropboxError, download, getAuth, isConnected, listFolder, upload } from './dropboxClient.js';
import type { Entry, Profile, SyncRecord } from './model.js';
import { refresh } from './nav.js';
import { ConflictError, META_PATH, createRemote, diaryPath, joinRemote, kindOf, parseMeta, syncOnce } from './sync.js';
import type { Local, Remote } from './sync.js';
import { toast } from './ui.js';

// ---- Adattatori

const local: Local = {
  async paths() {
    const [profile, foods, weights, entries] = await Promise.all([db.get('kv', 'profile'), db.getAll('foods'), db.getAll('weights'), db.getAll('entries')]);
    const out = new Set<string>();
    if (profile) out.add('/profile.enc');
    if (foods.length) out.add('/foods.enc');
    if (weights.length) out.add('/weights.enc');
    for (const e of entries) out.add(diaryPath(e.date));
    return [...out];
  },
  async read(path) {
    switch (kindOf(path)) {
      case 'profile': {
        const p = await db.get('kv', 'profile');
        return p ? [p as Profile] : [];
      }
      case 'foods': return db.getAll('foods');
      case 'weights': return db.getAll('weights');
      case 'entries': return db.entriesByMonth(path.slice(7, 14));
      default: return [];
    }
  },
  async write(path, records) {
    const kind = kindOf(path);
    if (kind === 'profile') await db.putBatch({ kv: records as Profile[] }, true);
    else if (kind === 'foods') await db.putBatch({ foods: records as db.Stores['foods'][] }, true);
    else if (kind === 'weights') await db.putBatch({ weights: records as db.Stores['weights'][] }, true);
    else if (kind === 'entries') await db.putBatch({ entries: records as Entry[] }, true);
  },
};

const remote: Remote = {
  async list() {
    return (await listFolder('')).files.map((f) => ({ path: f.pathLower, rev: f.rev }));
  },
  async read(path) {
    const r = await download(path);
    return r ? { rev: r.meta.rev, data: r.data } : undefined;
  },
  async write(path, data, rev) {
    try {
      return (await upload(path, data, rev)).rev;
    } catch (e) {
      if (e instanceof DropboxError && e.kind === 'conflict') throw new ConflictError(e.message);
      throw e;
    }
  },
};

// ---- Chiave e stato

/** Se il browser non sa salvare una CryptoKey in IndexedDB, la chiave resta solo in memoria. */
let memoryKey: CryptoKey | undefined;

async function getKey(): Promise<CryptoKey | undefined> {
  if (memoryKey) return memoryKey;
  const r = (await db.get('kv', 'sync-key')) as SyncKeyRecord | undefined;
  return r?.key;
}

async function storeKey(key: CryptoKey): Promise<boolean> {
  memoryKey = key;
  try {
    await db.put('kv', { id: 'sync-key', key, at: Date.now() });
    return true;
  } catch {
    return false;
  }
}

async function getState(): Promise<SyncStateRecord> {
  return ((await db.get('kv', 'sync-state')) as SyncStateRecord | undefined) ?? { id: 'sync-state', files: {} };
}

export interface SyncStatus {
  connected: boolean;
  enabled: boolean;
  running: boolean;
  keyInMemoryOnly: boolean;
  lastSync?: number;
  lastError?: string;
}

let running = false;
const statusListeners = new Set<() => void>();
const notify = () => { for (const fn of statusListeners) fn(); };

export function onStatus(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

export async function status(): Promise<SyncStatus> {
  const [auth, stored, st] = await Promise.all([getAuth(), db.get('kv', 'sync-key'), getState()]);
  return {
    connected: isConnected(auth),
    enabled: !!(memoryKey || stored),
    running,
    keyInMemoryOnly: !!memoryKey && !stored,
    lastSync: st.lastSync,
    lastError: st.lastError,
  };
}

// ---- Configurazione

/** 'new' se su Dropbox non ci sono ancora dati dell'app, altrimenti 'existing'. Elenco e non download: niente 409 per un file assente. */
export async function remoteSetupState(): Promise<'new' | 'existing'> {
  return (await listFolder('')).files.some((f) => f.pathLower === META_PATH) ? 'existing' : 'new';
}

export const MIN_PASSPHRASE = 12;

/** Primo dispositivo: crea meta.json. Restituisce false se un altro dispositivo l'ha appena creato. */
export async function enableNew(passphrase: string): Promise<{ created: boolean; keyStored: boolean }> {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`La passphrase deve avere almeno ${MIN_PASSPHRASE} caratteri.`);
  const key = await createRemote(remote, passphrase);
  if (!key) return { created: false, keyStored: false };
  const keyStored = await storeKey(key);
  await db.put('kv', { id: 'sync-state', files: {} });
  return { created: true, keyStored };
}

/** Dispositivo successivo: verifica la passphrase con il valore di controllo di meta.json. */
export async function enableExisting(passphrase: string): Promise<{ keyStored: boolean }> {
  const m = await download(META_PATH);
  if (!m) throw new Error('Su Dropbox non ci sono ancora dati: crea la passphrase.');
  const key = await joinRemote(parseMeta(m.data), passphrase);
  const keyStored = await storeKey(key);
  await db.put('kv', { id: 'sync-state', files: {} });
  return { keyStored };
}

/** Ferma la sincronizzazione su questo dispositivo: dimentica chiave e stato. Dati locali e remoti restano. */
export async function disable(): Promise<void> {
  memoryKey = undefined;
  await db.deleteKey('kv', 'sync-key');
  await db.deleteKey('kv', 'sync-state');
  notify();
}

// ---- Esecuzione

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Un giro di sincronizzazione. Restituisce il numero di record ricevuti, o undefined se non è partito. */
export async function syncNow(): Promise<number | undefined> {
  if (running) return undefined;
  const key = await getKey();
  const auth = await getAuth();
  if (!key || !isConnected(auth)) return undefined;
  if (!navigator.onLine) return undefined;
  running = true;
  notify();
  const st = await getState();
  try {
    const r = await syncOnce(local, remote, key, { files: st.files });
    await db.put('kv', { id: 'sync-state', files: r.state.files, lastSync: Date.now() });
    if (r.pulled) {
      // Ridisegna solo le viste di sola lettura: in Aggiungi, editor o Impostazioni cancellerebbe ciò che si sta scrivendo.
      if (/^#?\/?(diario(\/.*)?|alimenti)?$/.test(location.hash)) refresh();
      toast(r.pulled === 1 ? 'Arrivata 1 modifica da un altro dispositivo' : `Arrivate ${r.pulled} modifiche da altri dispositivi`);
    }
    return r.pulled;
  } catch (e) {
    console.warn('Sincronizzazione non riuscita', e);
    await db.put('kv', { ...st, lastError: errorText(e) });
    throw e;
  } finally {
    running = false;
    notify();
  }
}

let timer: number | undefined;

/** Avvia una sincronizzazione poco dopo l'ultima modifica, così più tocchi diventano un solo giro. */
export function scheduleSync(delayMs = 3000): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void syncNow().catch(() => {}), delayMs);
}

export function startAutoSync(): void {
  db.onDataChange(() => scheduleSync());
  window.addEventListener('online', () => scheduleSync(500));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') scheduleSync(500);
  });
  scheduleSync(1000);
}
