// Cifratura lato client per i file su Dropbox (Fase 3).
// PBKDF2-SHA256 (600.000 iterazioni, valore OWASP per questo algoritmo)
// e AES-GCM 256 con IV casuale a ogni scrittura. Il "context" (es. il
// percorso del file) entra come dato autenticato: un file spostato o
// scambiato con un altro non si decifra.

export const KDF_ITERATIONS = 600_000;

export interface EncryptedBlob {
  v: 1;
  alg: 'A256GCM';
  iv: string;
  ct: string;
}

const te = new TextEncoder();
const td = new TextDecoder();

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(n));
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Chiave non estraibile: può essere salvata in IndexedDB ma non esportata. */
export async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number = KDF_ITERATIONS,
): Promise<CryptoKey> {
  if (!passphrase) throw new Error('Passphrase vuota');
  const base = await crypto.subtle.importKey('raw', te.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJSON(key: CryptoKey, value: unknown, context: string): Promise<EncryptedBlob> {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: te.encode(context) },
    key,
    te.encode(JSON.stringify(value)),
  );
  return { v: 1, alg: 'A256GCM', iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

export async function decryptJSON<T = unknown>(key: CryptoKey, blob: EncryptedBlob, context: string): Promise<T> {
  if (blob?.v !== 1 || blob.alg !== 'A256GCM') throw new Error('Formato cifrato non supportato');
  let pt: ArrayBuffer;
  try {
    pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(blob.iv), additionalData: te.encode(context) },
      key,
      fromBase64(blob.ct),
    );
  } catch {
    throw new Error('Decifratura fallita: passphrase errata o file alterato');
  }
  return JSON.parse(td.decode(pt)) as T;
}

const CHECK_VALUE = 'macro-calories-track:key-check';
const CHECK_CONTEXT = 'key-check';

/** Valore di controllo salvato in chiaro accanto al salt: verifica la passphrase senza toccare i dati. */
export const makeKeyCheck = (key: CryptoKey): Promise<EncryptedBlob> => encryptJSON(key, CHECK_VALUE, CHECK_CONTEXT);

export async function verifyKeyCheck(key: CryptoKey, blob: EncryptedBlob): Promise<boolean> {
  try {
    return (await decryptJSON(key, blob, CHECK_CONTEXT)) === CHECK_VALUE;
  } catch {
    return false;
  }
}
