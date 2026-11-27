// Accesso alle fonti esterne: banca dati svizzera (JSON statico, in precache) e Open Food Facts (rete, con cache locale).
import { CATALOG_URL, parseCatalog } from './catalog.js';
import type { Catalog } from './catalog.js';
import * as db from './db.js';
import { OFF_PRODUCT_LIMIT, OFF_SEARCH_LIMIT, RateLimiter, parseProductResponse, parseSalResponse, parseSearchResponse, productUrl, salQuery, salSearchUrl, searchUrl, userAgent } from './off.js';
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

export class OffError extends Error {
  /** Il servizio non risponde o rifiuta per carico (rete, CORS, 429, 5xx, pagina HTML): si può provare la riserva. */
  readonly unavailable: boolean;
  constructor(message: string, unavailable = false) {
    super(message);
    this.unavailable = unavailable;
  }
}

const DAY = 24 * 60 * 60 * 1000;
const SEARCH_TTL = 7 * DAY;
/** Risultati della ricerca di riserva: senza valori nell'elenco, meglio riprovare presto quella principale. */
const ALT_SEARCH_TTL = 60 * 60 * 1000;
/** Dopo un errore della ricerca principale si va dritti alla riserva per qualche minuto. */
const MAIN_PAUSE = 5 * 60 * 1000;
const PRODUCT_TTL = 30 * DAY;
const CACHE_MAX = 300;

// Un margine sotto i limiti documentati (15 e 10 al minuto per IP).
const productLimiter = new RateLimiter(OFF_PRODUCT_LIMIT - 3, 60_000);
const searchLimiter = new RateLimiter(OFF_SEARCH_LIMIT - 2, 60_000);
// Search-a-licious: stesso margine. Il limite di 10 ricerche al minuto per IP è riportato per le ricerche di OFF,
// non l'ho verificato sulla documentazione di Search-a-licious.
const salLimiter = new RateLimiter(OFF_SEARCH_LIMIT - 2, 60_000);
let mainDownUntil = 0;

const UNAVAILABLE = 'Open Food Facts non accetta ricerche in questo momento: il loro servizio è sovraccarico o limitato agli utenti registrati, non è un problema dell’app. Riprova tra qualche minuto, cerca il codice a barre o crea l’alimento dall’etichetta.';

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
    throw new OffError(ctl.signal.aborted ? 'Open Food Facts non risponde: riprova più tardi.' : `Nessuna risposta utilizzabile da Open Food Facts. ${UNAVAILABLE}`, true);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429 || res.status >= 500) throw new OffError(UNAVAILABLE, true);
  if (!res.ok) throw new OffError(`Open Food Facts ha risposto con un errore (${res.status}).`);
  if (!(res.headers.get('content-type') ?? '').includes('application/json')) throw new OffError(UNAVAILABLE, true);
  const text = await res.text();
  if (text.length > 3_000_000) throw new OffError('Risposta di Open Food Facts troppo grande.');
  try {
    return JSON.parse(text);
  } catch {
    throw new OffError('Risposta di Open Food Facts non valida.');
  }
}

async function cached<T>(key: string, ttl: number | ((data: T) => number)): Promise<{ data: T; fresh: boolean } | undefined> {
  const r = await db.get('cache', key);
  if (!r) return undefined;
  const data = r.data as T;
  return { data, fresh: Date.now() - r.at < (typeof ttl === 'function' ? ttl(data) : ttl) };
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
  /** Risultato della ricerca di riserva (Search-a-licious): i valori arrivano con la scheda prodotto. */
  alt?: boolean;
}

interface SearchData {
  products: OffProduct[];
  count: number;
  alt?: boolean;
}

/**
 * Cache prima, poi rete; se la rete fallisce, una copia scaduta è meglio di niente.
 * `keep` decide se il risultato va in cache: un risultato vuoto no, perché un prodotto non trovato oggi
 * può comparire domani, e una risposta vuota di un servizio in difficoltà non deve restare per giorni.
 */
async function withCache<T>(key: string, ttl: number | ((data: T) => number), load: () => Promise<T>, keep: (data: T) => boolean): Promise<{ data: T; stale?: string }> {
  const c = await cached<T>(key, ttl);
  if (c?.fresh) return { data: c.data };
  try {
    const data = await load();
    if (keep(data)) await store(key, data);
    return { data };
  } catch (e) {
    if (c && e instanceof OffError) return { data: c.data, stale: `${e.message} Risultati salvati in precedenza.` };
    throw e;
  }
}

/**
 * Ricerca per nome: /cgi/search.pl, che il 27/11/2026 rispondeva 503 a 3 richieste su 4; se non risponde,
 * Search-a-licious. Dopo un errore la ricerca principale resta in pausa per MAIN_PAUSE.
 */
async function searchRemote(query: string): Promise<SearchData> {
  let mainError: OffError | undefined;
  if (Date.now() >= mainDownUntil) {
    try {
      return parseSearchResponse(await getJson(searchUrl(query), searchLimiter));
    } catch (e) {
      if (!(e instanceof OffError) || !e.unavailable) throw e;
      mainDownUntil = Date.now() + MAIN_PAUSE;
      mainError = e;
    }
  }
  try {
    if (!salQuery(query)) throw new OffError(UNAVAILABLE, true);
    return { ...parseSalResponse(await getJson(salSearchUrl(query), salLimiter)), alt: true };
  } catch (e) {
    if (!(e instanceof OffError)) console.warn(e);
    // Il messaggio utile resta quello della ricerca principale.
    if (mainError) throw mainError;
    // La principale era in pausa: un tentativo prima di arrendersi.
    mainDownUntil = 0;
    return parseSearchResponse(await getJson(searchUrl(query), searchLimiter));
  }
}

export async function searchOff(query: string): Promise<OffResult> {
  const r = await withCache<SearchData>(`s:${norm(query).trim()}`, (d) => (d.alt ? ALT_SEARCH_TTL : SEARCH_TTL), async () => {
    const res = await searchRemote(query);
    // Ogni prodotto completo finisce anche nella cache per codice; quelli della riserva no, senza valori.
    for (const p of res.products) if (!p.partial) await db.put('cache', { key: `p:${p.code}`, at: Date.now(), data: p });
    return res;
  }, (res) => res.products.length > 0);
  return { ...r.data, stale: r.stale };
}

export async function productOff(code: string): Promise<OffResult> {
  const r = await withCache(`p:${code.trim()}`, PRODUCT_TTL, async () => parseProductResponse(await getJson(productUrl(code), productLimiter)), (p) => p !== null);
  const products = r.data ? [r.data] : [];
  return { products, count: products.length, stale: r.stale };
}

export function clearOffCache(): Promise<void> {
  return db.clearStore('cache');
}
