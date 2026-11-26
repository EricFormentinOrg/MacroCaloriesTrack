// Client OpenRouter per la foto del piatto: chiave e modello in IndexedDB, chiamata.
import { postAi, readJson } from './aiHttp.js';
import * as db from './db.js';
import type { OpenRouterSettings } from './db.js';
import { GeminiError, isApiKey, normalizeApiKey, parseDish } from './dishAi.js';
import type { Dish } from './dishAi.js';
import type { PreparedImage } from './gemini.js';
import { OPENROUTER_URL, isOrModelId, orError, orRequestBody, orResponseText } from './openrouter.js';

export async function getOpenRouter(): Promise<OpenRouterSettings | undefined> {
  return (await db.get('kv', 'openrouter')) as OpenRouterSettings | undefined;
}

export async function saveOpenRouter(apiKey: string, model: string): Promise<void> {
  const key = normalizeApiKey(apiKey);
  if (!isApiKey(key)) {
    throw new GeminiError(key.length < 20
      ? 'La chiave è troppo corta: copiala per intero da OpenRouter.'
      : 'La chiave contiene caratteri non validi: copiala di nuovo da OpenRouter.');
  }
  if (!isOrModelId(model)) throw new GeminiError('Modello non valido.');
  await db.put('kv', { id: 'openrouter', apiKey: key, model });
}

export async function setOpenRouterModel(model: string): Promise<void> {
  const s = await getOpenRouter();
  if (s && isOrModelId(model)) await db.put('kv', { ...s, model });
}

export const clearOpenRouter = (): Promise<void> => db.deleteKey('kv', 'openrouter');

function call(s: OpenRouterSettings, img: PreparedImage, hint: string, withSchema: boolean): Promise<Response> {
  // Chiave solo nell'header Authorization. Niente HTTP-Referer o titolo dell'app: non servono.
  return postAi(OPENROUTER_URL, { Authorization: `Bearer ${s.apiKey}` }, orRequestBody(img.base64, img.mimeType, hint, s.model, withSchema), 'OpenRouter');
}

/** Un tentativo con OpenRouter: voci validate e il modello che ha risposto (vuoto se non indicato). */
export async function openRouterAttempt(s: OpenRouterSettings, img: PreparedImage, hint: string): Promise<{ dish: Dish; model: string }> {
  let res = await call(s, img, hint, true);
  if (!res.ok) {
    const err = orError(res.status, await res.text().catch(() => ''));
    if (!err.retryWithoutSchema) throw err;
    res = await call(s, img, hint, false);
    if (!res.ok) throw orError(res.status, await res.text().catch(() => ''));
  }
  const r = orResponseText(await readJson(res, 'OpenRouter'));
  return { dish: parseDish(r.text), model: r.model };
}
