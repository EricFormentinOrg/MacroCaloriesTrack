// Client Gemini per la stima del pasto: impostazioni in IndexedDB, preparazione della foto, chiamata.
import { postAi, readJson } from './aiHttp.js';
import { toBase64 } from './crypto.js';
import * as db from './db.js';
import type { GeminiSettings } from './db.js';
import { DEFAULT_MODEL, GeminiError, geminiError, isApiKey, isModelId, normalizeApiKey, parseDish, requestBody, requestUrl, responseText } from './dishAi.js';
import type { Dish, DishInput } from './dishAi.js';

export async function getGemini(): Promise<GeminiSettings | undefined> {
  return (await db.get('kv', 'gemini')) as GeminiSettings | undefined;
}

export async function saveGemini(apiKey: string, model: string): Promise<void> {
  const key = normalizeApiKey(apiKey);
  if (!isApiKey(key)) {
    throw new GeminiError(key.length < 20
      ? 'La chiave è troppo corta: copiala per intero da Google AI Studio.'
      : 'La chiave contiene caratteri non validi: copiala di nuovo da Google AI Studio.');
  }
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

function call(apiKey: string, model: string, input: DishInput, withSchema: boolean): Promise<Response> {
  // La chiave va nell'header, mai nell'URL: non finisce in cronologia o log di rete.
  return postAi(requestUrl(model), { 'x-goog-api-key': apiKey }, requestBody(input, withSchema), 'Gemini');
}

/** Un tentativo con un modello Gemini: voci stimate e già validate, o un GeminiError. */
export async function geminiAttempt(apiKey: string, model: string, input: DishInput): Promise<Dish> {
  let res = await call(apiKey, model, input, true);
  if (!res.ok) {
    const err = geminiError(res.status, await res.text().catch(() => ''));
    // Se lo schema JSON non è accettato, la risposta resta JSON e viene comunque validata qui.
    if (!err.retryWithoutSchema) throw err;
    res = await call(apiKey, model, input, false);
    if (!res.ok) throw geminiError(res.status, await res.text().catch(() => ''));
  }
  return parseDish(responseText(await readJson(res, 'Gemini'), input.kind));
}

export { DEFAULT_MODEL };
