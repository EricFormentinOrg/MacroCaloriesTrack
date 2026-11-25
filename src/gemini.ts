// Client Gemini per la foto del piatto: impostazioni in IndexedDB, preparazione dell'immagine, chiamata.
import { toBase64 } from './crypto.js';
import * as db from './db.js';
import type { GeminiSettings } from './db.js';
import { DEFAULT_MODEL, GeminiError, geminiError, isGeminiKey, isModelId, parseDish, requestBody, requestUrl, responseText } from './dishAi.js';
import type { Dish } from './dishAi.js';

export async function getGemini(): Promise<GeminiSettings | undefined> {
  return (await db.get('kv', 'gemini')) as GeminiSettings | undefined;
}

export async function saveGemini(apiKey: string, model: string): Promise<void> {
  const key = apiKey.trim();
  if (!isGeminiKey(key)) throw new GeminiError('La chiave non sembra valida: copiala per intero da Google AI Studio.');
  if (!isModelId(model)) throw new GeminiError('Modello non valido.');
  await db.put('kv', { id: 'gemini', apiKey: key, model });
}

export async function setGeminiModel(model: string): Promise<void> {
  const g = await getGemini();
  if (g && isModelId(model)) await db.put('kv', { ...g, model });
}

export const clearGemini = (): Promise<void> => db.deleteKey('kv', 'gemini');

export interface PreparedImage {
  blob: Blob;
  base64: string;
  mimeType: 'image/jpeg';
}

const MAX_SIDE = 1280;

/** Apre la foto rispettando l'orientamento EXIF; se createImageBitmap non basta, usa un elemento <img>. */
async function decode(file: Blob): Promise<{ image: CanvasImageSource; width: number; height: number; done: () => void }> {
  try {
    const b = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { image: b, width: b.width, height: b.height, done: () => b.close() };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return { image: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
    } catch {
      URL.revokeObjectURL(url);
      throw new GeminiError('Non riesco ad aprire questa foto: prova a scattarla di nuovo.');
    }
  }
}

/**
 * Ridimensiona (lato lungo 1280 px) e ricodifica in JPEG sul dispositivo: meno dati da inviare e
 * nessun metadato EXIF, quindi niente posizione GPS né modello del telefono nella foto inviata.
 */
export async function prepareImage(file: Blob): Promise<PreparedImage> {
  if (!/^image\//.test(file.type) && file.type !== '') throw new GeminiError('Il file scelto non è un’immagine.');
  if (file.size > 40 * 1024 * 1024) throw new GeminiError('Foto troppo grande.');
  const source = await decode(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(source.width, source.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(source.width * scale));
  canvas.height = Math.max(1, Math.round(source.height * scale));
  const g = canvas.getContext('2d');
  if (!g) throw new GeminiError('Il browser non permette di elaborare la foto.');
  g.drawImage(source.image, 0, 0, canvas.width, canvas.height);
  source.done();
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.82));
  if (!blob) throw new GeminiError('Il browser non permette di elaborare la foto.');
  return { blob, base64: toBase64(new Uint8Array(await blob.arrayBuffer())), mimeType: 'image/jpeg' };
}

async function call(s: GeminiSettings, img: PreparedImage, hint: string, withSchema: boolean): Promise<Response> {
  if (!navigator.onLine) throw new GeminiError('Sei offline: la stima da foto richiede la connessione.');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 90_000);
  try {
    return await fetch(requestUrl(s.model), {
      method: 'POST',
      // La chiave va nell'header, mai nell'URL: non finisce in cronologia o log di rete.
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.apiKey },
      body: JSON.stringify(requestBody(img.base64, img.mimeType, hint, withSchema)),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: ctl.signal,
    });
  } catch {
    throw new GeminiError(ctl.signal.aborted ? 'Gemini non ha risposto in tempo: riprova.' : 'Connessione a Gemini non riuscita.');
  } finally {
    clearTimeout(timer);
  }
}

/** Invia la foto e restituisce le voci stimate, già validate. */
export async function analyzeDish(img: PreparedImage, hint: string): Promise<Dish> {
  const s = await getGemini();
  if (!s) throw new GeminiError('Inserisci prima la chiave Gemini in Impostazioni.');
  let res = await call(s, img, hint, true);
  if (!res.ok) {
    const err = geminiError(res.status, await res.text().catch(() => ''));
    // Se lo schema JSON non è accettato, la risposta resta JSON e viene comunque validata qui.
    if (!err.retryWithoutSchema) throw err;
    res = await call(s, img, hint, false);
    if (!res.ok) throw geminiError(res.status, await res.text().catch(() => ''));
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new GeminiError('Risposta di Gemini non valida.');
  }
  return parseDish(responseText(json));
}

export { DEFAULT_MODEL };
