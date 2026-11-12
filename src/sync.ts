// Motore di sincronizzazione: puro, senza DOM né rete. Locale e remoto arrivano come adattatori,
// così lo stesso codice gira nell'app (IndexedDB + Dropbox) e nei test in Node (memoria).
//
// File remoti (cartella dell'app su Dropbox):
//   /meta.json            in chiaro: salt e parametri della derivazione, valore di controllo
//   /profile.enc /foods.enc /weights.enc /diary/AAAA-MM.enc   cifrati, contesto = percorso
// Ogni file contiene tutti i record della sua parte, tombstone compresi. Il merge è per record
// (updatedAt, poi confronto deterministico); ogni scrittura è condizionata alla revisione letta.
import { parseRecords } from './backup.js';
import type { RecordKind } from './backup.js';
import { decryptJSON, deriveKey, encryptJSON, fromBase64, KDF_ITERATIONS, makeKeyCheck, randomBytes, toBase64, verifyKeyCheck } from './crypto.js';
import type { EncryptedBlob } from './crypto.js';
import { mergeById, stableStringify } from './merge.js';
import type { SyncRecord } from './model.js';

export const APP_ID = 'MacroCaloriesTrack';
export const SYNC_FORMAT = 1;
export const META_PATH = '/meta.json';
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_ATTEMPTS = 4;

// ---- Adattatori

export interface RemoteFile {
  path: string;
  rev: string;
}

export class ConflictError extends Error {}

export interface Remote {
  list(): Promise<RemoteFile[]>;
  read(path: string): Promise<{ rev: string; data: Uint8Array<ArrayBuffer> } | undefined>;
  /** rev null = crea solo se non esiste. Lancia ConflictError se il file remoto non è più quella revisione. */
  write(path: string, data: Uint8Array<ArrayBuffer>, rev: string | null): Promise<string>;
}

export interface Local {
  /** Percorsi logici con dati locali (profilo, alimenti, pesi, mesi del diario). */
  paths(): Promise<string[]>;
  read(path: string): Promise<SyncRecord[]>;
  /** Scrive i record vincenti del merge (inserimento o sostituzione per id). */
  write(path: string, records: SyncRecord[]): Promise<void>;
}

/** Per ogni file: revisione e impronta del contenuto remoto noti all'ultima sincronizzazione. */
export interface SyncState {
  files: Record<string, { rev: string; hash: string }>;
}

// ---- Percorsi

const DIARY_RE = /^\/diary\/(\d{4})-(0[1-9]|1[0-2])\.enc$/;

export function kindOf(path: string): RecordKind | undefined {
  if (path === '/profile.enc') return 'profile';
  if (path === '/foods.enc') return 'foods';
  if (path === '/weights.enc') return 'weights';
  if (DIARY_RE.test(path)) return 'entries';
  return undefined;
}

export const diaryPath = (date: string): string => `/diary/${date.slice(0, 7)}.enc`;

// ---- Meta e chiave

export interface Meta {
  app: typeof APP_ID;
  format: number;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  check: EncryptedBlob;
  createdAt: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function blob(v: unknown): EncryptedBlob {
  if (!isObj(v) || v.v !== 1 || v.alg !== 'A256GCM' || typeof v.iv !== 'string' || typeof v.ct !== 'string'
    || !/^[A-Za-z0-9+/]+=*$/.test(v.iv) || !/^[A-Za-z0-9+/]+=*$/.test(v.ct)) {
    throw new Error('formato cifrato non valido');
  }
  return { v: 1, alg: 'A256GCM', iv: v.iv, ct: v.ct };
}

/** minIterations più basso solo nei test: in produzione un meta.json con pochi giri di PBKDF2 è rifiutato. */
export function parseMeta(bytes: Uint8Array, minIterations = 100_000): Meta {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('meta.json non è un JSON valido');
  }
  if (!isObj(v) || v.app !== APP_ID) throw new Error('meta.json non appartiene a MacroCaloriesTrack');
  if (v.format !== SYNC_FORMAT) throw new Error(`versione dei dati su Dropbox non supportata (${String(v.format)}): aggiorna l'app`);
  const k = v.kdf;
  if (!isObj(k) || k.name !== 'PBKDF2' || k.hash !== 'SHA-256' || typeof k.iterations !== 'number'
    || !Number.isInteger(k.iterations) || k.iterations < minIterations || k.iterations > 10_000_000
    || typeof k.salt !== 'string' || !/^[A-Za-z0-9+/]{20,100}=*$/.test(k.salt)) {
    throw new Error('parametri della chiave non validi in meta.json');
  }
  return {
    app: APP_ID,
    format: SYNC_FORMAT,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: k.iterations, salt: k.salt },
    check: blob(v.check),
    createdAt: typeof v.createdAt === 'string' ? v.createdAt.slice(0, 40) : '',
  };
}

const json = (v: unknown): Uint8Array<ArrayBuffer> => new TextEncoder().encode(JSON.stringify(v));

export class WrongPassphrase extends Error {
  constructor() {
    super('Passphrase errata: non corrisponde a quella usata per i dati su questo Dropbox.');
  }
}

/**
 * Prima configurazione: crea meta.json con un salt nuovo. Restituisce undefined se nel frattempo
 * un altro dispositivo l'ha creato: in quel caso va usata joinRemote.
 */
export async function createRemote(remote: Remote, passphrase: string, iterations = KDF_ITERATIONS, now = new Date()): Promise<CryptoKey | undefined> {
  const salt = randomBytes(16);
  const key = await deriveKey(passphrase, salt, iterations);
  const meta: Meta = {
    app: APP_ID,
    format: SYNC_FORMAT,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toBase64(salt) },
    check: await makeKeyCheck(key),
    createdAt: now.toISOString(),
  };
  try {
    await remote.write(META_PATH, json(meta), null);
    return key;
  } catch (e) {
    if (e instanceof ConflictError) return undefined;
    throw e;
  }
}

/** Dispositivo successivo: deriva la chiave dal salt remoto e la verifica col valore di controllo. */
export async function joinRemote(meta: Meta, passphrase: string): Promise<CryptoKey> {
  const key = await deriveKey(passphrase, fromBase64(meta.kdf.salt), meta.kdf.iterations);
  if (!(await verifyKeyCheck(key, meta.check))) throw new WrongPassphrase();
  return key;
}

// ---- File cifrati

interface Payload {
  app: typeof APP_ID;
  format: number;
  kind: RecordKind;
  records: SyncRecord[];
}

const byId = (a: SyncRecord, b: SyncRecord): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export async function encodeFile(key: CryptoKey, path: string, records: ReadonlyArray<SyncRecord>): Promise<Uint8Array<ArrayBuffer>> {
  const kind = kindOf(path);
  if (!kind) throw new Error(`percorso non valido: ${path}`);
  const payload: Payload = { app: APP_ID, format: SYNC_FORMAT, kind, records: [...records].sort(byId) };
  return json(await encryptJSON(key, payload, path));
}

/** Decifra e valida un file remoto. Il percorso entra nella cifratura: un file spostato non si apre. */
export async function decodeFile(key: CryptoKey, path: string, bytes: Uint8Array): Promise<SyncRecord[]> {
  const kind = kindOf(path);
  if (!kind) throw new Error(`percorso non valido: ${path}`);
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`${path}: file troppo grande`);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${path}: non è un file cifrato valido`);
  }
  const p = await decryptJSON<unknown>(key, blob(raw), path);
  if (!isObj(p) || p.app !== APP_ID || p.format !== SYNC_FORMAT || p.kind !== kind) throw new Error(`${path}: contenuto inatteso`);
  let records: SyncRecord[];
  try {
    records = parseRecords(kind, p.records);
  } catch (e) {
    throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (new Set(records.map((r) => r.id)).size !== records.length) throw new Error(`${path}: record duplicati`);
  if (kind === 'entries' && records.some((r) => diaryPath((r as SyncRecord & { date: string }).date) !== path)) {
    throw new Error(`${path}: voci di un altro mese`);
  }
  if (kind === 'profile' && records.length > 1) throw new Error(`${path}: più di un profilo`);
  return records;
}

/** Impronta del contenuto: SHA-256 del JSON canonico, record ordinati per id. */
export async function hashRecords(records: ReadonlyArray<SyncRecord>): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableStringify([...records].sort(byId))));
  return toBase64(new Uint8Array(d));
}

// ---- Sincronizzazione

export interface SyncResult {
  state: SyncState;
  /** Record arrivati da Dropbox e scritti in locale. */
  pulled: number;
  /** File caricati su Dropbox. */
  pushed: number;
}

/**
 * Un giro completo: per ogni file, scarica se la revisione remota è cambiata e unisce in locale,
 * poi carica se il contenuto locale è diverso da quello remoto noto. Una scrittura rifiutata per
 * conflitto (un altro dispositivo ha scritto nel frattempo) fa ripartire il file dal download.
 */
export async function syncOnce(local: Local, remote: Remote, key: CryptoKey, prev: SyncState): Promise<SyncResult> {
  const state: SyncState = { files: { ...prev.files } };
  const remoteRevs = new Map<string, string>();
  for (const f of await remote.list()) if (kindOf(f.path)) remoteRevs.set(f.path, f.rev);
  for (const p of Object.keys(state.files)) if (!remoteRevs.has(p)) delete state.files[p];
  const paths = [...new Set([...remoteRevs.keys(), ...(await local.paths()).filter((p) => kindOf(p))])].sort();
  let pulled = 0;
  let pushed = 0;

  for (const path of paths) {
    let forceRead = false;
    for (let attempt = 1; ; attempt++) {
      const known = state.files[path];
      const remoteRev = remoteRevs.get(path);
      if (remoteRev && (forceRead || remoteRev !== known?.rev)) {
        const got = await remote.read(path);
        if (got) {
          const incoming = await decodeFile(key, path, got.data);
          const winners = mergeById(await local.read(path), incoming);
          if (winners.length) {
            await local.write(path, winners);
            pulled += winners.length;
          }
          state.files[path] = { rev: got.rev, hash: await hashRecords(incoming) };
          remoteRevs.set(path, got.rev);
        } else {
          delete state.files[path];
          remoteRevs.delete(path);
        }
      }
      const current = state.files[path];
      const rev = remoteRevs.get(path);
      const mine = await local.read(path);
      if (!mine.length) break;
      const hash = await hashRecords(mine);
      if (rev && current && current.rev === rev && current.hash === hash) break;
      try {
        const newRev = await remote.write(path, await encodeFile(key, path, mine), rev ?? null);
        state.files[path] = { rev: newRev, hash };
        remoteRevs.set(path, newRev);
        pushed++;
        break;
      } catch (e) {
        if (!(e instanceof ConflictError) || attempt >= MAX_ATTEMPTS) throw e;
        // Un altro dispositivo ha scritto: rileggi la versione corrente e unisci di nuovo.
        forceRead = true;
        if (!remoteRevs.has(path)) remoteRevs.set(path, '');
      }
    }
  }
  return { state, pulled, pushed };
}
