// Client Gemini per la foto del piatto: impostazioni in IndexedDB, preparazione dell'immagine, chiamata.
import { toBase64 } from './crypto.js';
import * as db from './db.js';
import type { GeminiSettings } from './db.js';
import { DEFAULT_MODEL, GeminiError, fallbackFor, geminiError, isGeminiKey, isModelId, normalizeGeminiKey, parseDish, requestBody, requestUrl, responseText } from './dishAi.js';
import type { Dish } from './dishAi.js';

export async function getGemini(): Promise<GeminiSettings | undefined> {
  return (await db.get('kv', 'gemini')) as GeminiSettings | undefined;
}

export async function saveGemini(apiKey: string, model: string): Promise<void> {
  const key = normalizeGeminiKey(apiKey);
  if (!isGeminiKey(key)) {
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

/**
 * Attesa massima per tentativo. Con il servizio sovraccarico Google può tenere aperta la richiesta
 * per minuti senza rispondere (visto il 26/11/2026): meglio passare presto al modello di riserva.
 */
const TIMEOUT_MS = 50_000;

async function call(apiKey: string, model: string, img: PreparedImage, hint: string, withSchema: boolean): Promise<Response> {
  if (!navigator.onLine) throw new GeminiError('Sei offline: la stima da foto richiede la connessione.');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetch(requestUrl(model), {
      method: 'POST',
      // La chiave va nell'header, mai nell'URL: non finisce in cronologia o log di rete.
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(requestBody(img.base64, img.mimeType, hint, withSchema)),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
      signal: ctl.signal,
    });
  } catch {
    // Su iPhone anche una richiesta rimasta appesa a lungo finisce qui, come errore di rete.
    throw new GeminiError(
      ctl.signal.aborted ? 'Gemini non ha risposto in tempo: riprova tra qualche minuto.' : 'Connessione a Gemini non riuscita: controlla la rete e riprova.',
      { tryOtherModel: true },
    );
  } finally {
    clearTimeout(timer);
  }
}

async function attempt(apiKey: string, model: string, img: PreparedImage, hint: string): Promise<Dish> {
  let res = await call(apiKey, model, img, hint, true);
  if (!res.ok) {
    const err = geminiError(res.status, await res.text().catch(() => ''));
    // Se lo schema JSON non è accettato, la risposta resta JSON e viene comunque validata qui.
    if (!err.retryWithoutSchema) throw err;
    res = await call(apiKey, model, img, hint, false);
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

export interface DishResult extends Dish {
  /** Modello che ha prodotto la stima. */
  model: string;
  /** Presente se il modello scelto non era disponibile e ha risposto quello di riserva. */
  fallbackFrom?: string;
}

/**
 * Invia la foto e restituisce le voci stimate, già validate. Se il modello scelto è sovraccarico,
 * non risponde o ha esaurito il limite, riprova una volta con il modello di riserva.
 */
export async function analyzeDish(img: PreparedImage, hint: string, onFallback?: (from: string, to: string) => void): Promise<DishResult> {
  const s = await getGemini();
  if (!s) throw new GeminiError('Inserisci prima la chiave Gemini in Impostazioni.');
  try {
    return { ...(await attempt(s.apiKey, s.model, img, hint)), model: s.model };
  } catch (e) {
    const alt = fallbackFor(s.model, e);
    if (!alt) throw e;
    onFallback?.(s.model, alt);
    try {
      return { ...(await attempt(s.apiKey, alt, img, hint)), model: alt, fallbackFrom: s.model };
    } catch (e2) {
      if (e2 instanceof GeminiError && e2.tryOtherModel) {
        throw new GeminiError('Gemini non è disponibile in questo momento, nemmeno con il modello di riserva: riprova tra qualche minuto.');
      }
      throw e2;
    }
  }
}

export { DEFAULT_MODEL };
