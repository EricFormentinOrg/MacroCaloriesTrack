// Accesso alle fonti esterne: banca dati svizzera (JSON statico, in precache) e Open Food Facts (rete, con cache locale).
import { CATALOG_URL, parseCatalog } from './catalog.js';
import type { Catalog } from './catalog.js';
import * as db from './db.js';
import { OFF_PRODUCT_LIMIT, OFF_SEARCH_LIMIT, RateLimiter, parseProductResponse, parseSearchResponse, productUrl, searchUrl, userAgent } from './off.js';
import type { OffProduct } from './off.js';
import { norm } from './search.js';
import { VERSION } from './version.js';

// ---- Banca dati svizzera

let catalogP: Promise<Catalog> | undefined;

export function loadCatalog(): Promise<Catalog> {
  catalogP ??= fetch(CATALOG_URL)
    .then((r) => {
      if (!r.ok) throw new Error(`banca dati non disponibile (${r.status})`);
      return r.json() as Promise<unknown>;
    })
    .then(parseCatalog)
    .catch((e: unknown) => {
      catalogP = undefined; // riprova alla prossima richiesta
      throw e;
    });
  return catalogP;
}

// ---- Open Food Facts

export class OffError extends Error {}

const DAY = 24 * 60 * 60 * 1000;
const SEARCH_TTL = 7 * DAY;
const PRODUCT_TTL = 30 * DAY;
const CACHE_MAX = 300;

// Un margine sotto i limiti documentati (15 e 10 al minuto per IP).
const productLimiter = new RateLimiter(OFF_PRODUCT_LIMIT - 3, 60_000);
const searchLimiter = new RateLimiter(OFF_SEARCH_LIMIT - 2, 60_000);

const UNAVAILABLE = 'Open Food Facts non accetta ricerche in questo momento (servizio sovraccarico o limitato agli utenti registrati). Riprova più tardi o cerca il codice a barre.';

async function getJson(url: string, limiter: RateLimiter): Promise<unknown> {
  if (!navigator.onLine) throw new OffError('Sei offline: Open Food Facts non è raggiungibile.');
  const wait = limiter.take();
  if (wait > 0) throw new OffError(`Troppe richieste a Open Food Facts: riprova tra ${Math.ceil(wait / 1000)} secondi.`);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12_000);
  let res: Response;
  try {
    res = await fetch(url, {
      // User-Agent non è impostabile da fetch nei browser: il server accetta X-User-Agent.
      headers: { 'X-User-Agent': userAgent(VERSION, `${location.origin}${location.pathname}`) },
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: ctl.signal,
    });
  } catch {
    // Il 503 di OFF arriva senza header CORS: per il browser è indistinguibile da un errore di rete.
    throw new OffError(ctl.signal.aborted ? 'Open Food Facts non risponde: riprova più tardi.' : `Nessuna risposta utilizzabile da Open Food Facts. ${UNAVAILABLE}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429 || res.status === 503) throw new OffError(UNAVAILABLE);
  if (!res.ok) throw new OffError(`Open Food Facts ha risposto con un errore (${res.status}).`);
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) throw new OffError(UNAVAILABLE);
  const text = await res.text();
  if (text.length > 3_000_000) throw new OffError('Risposta di Open Food Facts troppo grande.');
  try {
    return JSON.parse(text);
  } catch {
    throw new OffError('Risposta di Open Food Facts non valida.');
  }
}

async function cached<T>(key: string, ttl: number): Promise<{ data: T; fresh: boolean } | undefined> {
  const r = await db.get('cache', key);
  return r ? { data: r.data as T, fresh: Date.now() - r.at < ttl } : undefined;
}

async function store(key: string, data: unknown): Promise<void> {
  await db.put('cache', { key, at: Date.now(), data });
  await db.pruneCache(PRODUCT_TTL, CACHE_MAX);
}

export interface OffResult {
  products: OffProduct[];
  count: number;
  /** Risultato preso dalla cache perché la rete non ha risposto. */
  stale?: string;
}

/** Cache prima, poi rete; se la rete fallisce, una copia scaduta è meglio di niente. */
async function withCache<T>(key: string, ttl: number, load: () => Promise<T>): Promise<{ data: T; stale?: string }> {
  const c = await cached<T>(key, ttl);
  if (c?.fresh) return { data: c.data };
  try {
    const data = await load();
    if (data !== null) await store(key, data); // un prodotto non trovato oggi può comparire domani
    return { data };
  } catch (e) {
    if (c && e instanceof OffError) return { data: c.data, stale: `${e.message} Risultati salvati in precedenza.` };
    throw e;
  }
}

export async function searchOff(query: string): Promise<OffResult> {
  const r = await withCache(`s:${norm(query).trim()}`, SEARCH_TTL, async () => {
    const res = parseSearchResponse(await getJson(searchUrl(query), searchLimiter));
    // Ogni prodotto trovato finisce anche nella cache per codice.
    for (const p of res.products) await db.put('cache', { key: `p:${p.code}`, at: Date.now(), data: p });
    return res;
  });
  return { ...r.data, stale: r.stale };
}

export async function productOff(code: string): Promise<OffResult> {
  const r = await withCache(`p:${code.trim()}`, PRODUCT_TTL, async () => parseProductResponse(await getJson(productUrl(code), productLimiter)));
  const products = r.data ? [r.data] : [];
  return { products, count: products.length, stale: r.stale };
}

export function clearOffCache(): Promise<void> {
  return db.clearStore('cache');
}
