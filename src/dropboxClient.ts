// Client Dropbox: login con codice (PKCE, nessun redirect), token in IndexedDB, rinnovo automatico,
// chiamate RPC, upload e download. Ogni utente usa la propria app Dropbox (App key inserita in Impostazioni).
import * as db from './db.js';
import type { DropboxAuth, DropboxPending } from './db.js';
import {
  API_URL, CONTENT_URL, TOKEN_URL, authorizeUrl, classifyError, headerJson, isAppKey, parseFileMeta, parseListFolder,
  parseTokenResponse, pkcePair, refreshRequestBody, tokenRequestBody,
} from './dropbox.js';
import type { ErrorKind, FileMeta } from './dropbox.js';

export class DropboxError extends Error {
  constructor(message: string, readonly kind: ErrorKind | 'offline' | 'not_connected' = 'other') {
    super(message);
  }
}

const PENDING_TTL = 30 * 60 * 1000;
const MESSAGES: Record<string, string> = {
  auth: 'Dropbox non riconosce più questo dispositivo: collegalo di nuovo.',
  scope: 'La tua app Dropbox non ha i permessi files.metadata.read, files.content.read e files.content.write: abilitali in Permissions e collegati di nuovo.',
  rate_limit: 'Troppe richieste a Dropbox: riprova tra qualche minuto.',
  space: 'Spazio Dropbox esaurito.',
};

export async function getAuth(): Promise<DropboxAuth | undefined> {
  return (await db.get('kv', 'dropbox')) as DropboxAuth | undefined;
}

export const isConnected = (a: DropboxAuth | undefined): boolean => !!a?.refreshToken;

async function getPending(): Promise<DropboxPending | undefined> {
  const p = (await db.get('kv', 'dropbox-pending')) as DropboxPending | undefined;
  return p && Date.now() - p.at < PENDING_TTL ? p : undefined;
}

/** Prepara il login: salva App key e verifier, restituisce l'indirizzo della pagina di consenso Dropbox. */
export async function beginLogin(appKeyInput: string): Promise<string> {
  const appKey = appKeyInput.trim();
  if (!isAppKey(appKey)) throw new DropboxError('L’App key non sembra valida: copiala dalla pagina Settings della tua app Dropbox (lettere minuscole e cifre).');
  const { verifier, challenge } = await pkcePair();
  await db.putBatch({ kv: [{ id: 'dropbox-pending', appKey, verifier, challenge, at: Date.now() }, { id: 'dropbox', appKey }] });
  return authorizeUrl(appKey, challenge);
}

/**
 * Indirizzo del login in corso, sempre con lo stesso challenge: se iOS ricarica l'app mentre
 * l'utente è su Dropbox, il codice ottenuto resta valido per il verifier salvato.
 */
export async function pendingLoginUrl(): Promise<string | undefined> {
  const p = await getPending();
  return p ? authorizeUrl(p.appKey, p.challenge) : undefined;
}

async function post(url: string, init: RequestInit): Promise<Response> {
  if (!navigator.onLine) throw new DropboxError('Sei offline: Dropbox non è raggiungibile.', 'offline');
  try {
    return await fetch(url, { ...init, method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
  } catch {
    throw new DropboxError('Connessione a Dropbox non riuscita.', 'offline');
  }
}

async function fail(res: Response): Promise<never> {
  const { kind, summary } = classifyError(res.status, await res.text().catch(() => ''));
  throw new DropboxError(MESSAGES[kind] ?? `Errore Dropbox (${res.status}${summary ? `: ${summary}` : ''}).`, kind);
}

/** Scambia il codice mostrato da Dropbox con i token. */
export async function finishLogin(codeInput: string): Promise<DropboxAuth> {
  const code = codeInput.trim();
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(code)) throw new DropboxError('Il codice non è valido: copialo per intero dalla pagina di Dropbox.');
  const pending = await getPending();
  if (!pending) throw new DropboxError('Il login è scaduto: premi di nuovo “Apri Dropbox”.');
  const res = await post(TOKEN_URL, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenRequestBody(pending.appKey, code, pending.verifier),
  });
  if (!res.ok) {
    const { summary } = classifyError(res.status, await res.text().catch(() => ''));
    throw new DropboxError(/invalid_grant/.test(summary)
      ? 'Codice non accettato da Dropbox: forse è scaduto o già usato. Premi di nuovo “Apri Dropbox”.'
      : /invalid_client|client_id/.test(summary)
        ? 'Dropbox non riconosce l’App key: controlla di averla copiata dalla tua app.'
        : `Login non riuscito (${res.status}${summary ? `: ${summary}` : ''}).`, 'auth');
  }
  const t = parseTokenResponse(await res.json(), Date.now());
  if (!t.refreshToken) throw new DropboxError('Dropbox non ha concesso l’accesso permanente: riprova.', 'auth');
  if (t.missingScopes.length) throw new DropboxError(`Alla tua app Dropbox mancano i permessi ${t.missingScopes.join(', ')}: abilitali in Permissions, poi collegati di nuovo.`, 'scope');
  const auth: DropboxAuth = {
    id: 'dropbox',
    appKey: pending.appKey,
    accessToken: t.accessToken,
    expiresAt: t.expiresAt,
    refreshToken: t.refreshToken,
    ...(t.accountId ? { accountId: t.accountId } : {}),
    connectedAt: Date.now(),
  };
  await db.putBatch({ kv: [auth] });
  await db.deleteKey('kv', 'dropbox-pending');
  return auth;
}

async function accessToken(force = false): Promise<string> {
  const a = await getAuth();
  if (!a?.refreshToken) throw new DropboxError('Dropbox non è collegato.', 'not_connected');
  if (!force && a.accessToken && a.expiresAt && a.expiresAt > Date.now()) return a.accessToken;
  const res = await post(TOKEN_URL, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: refreshRequestBody(a.appKey, a.refreshToken),
  });
  if (!res.ok) await fail(res);
  const t = parseTokenResponse(await res.json(), Date.now());
  await db.put('kv', { ...a, accessToken: t.accessToken, expiresAt: t.expiresAt });
  return t.accessToken;
}

/** Esegue una richiesta autenticata; con un 401 rinnova il token una volta e riprova. */
async function authed(url: string, init: (token: string) => RequestInit): Promise<Response> {
  let res = await post(url, init(await accessToken()));
  if (res.status === 401) res = await post(url, init(await accessToken(true)));
  if (!res.ok) await fail(res);
  return res;
}

/** Chiamata RPC; senza argomenti (rotte "Void") non invia corpo né Content-Type, come l'SDK ufficiale. */
export async function rpc(route: string, args?: unknown): Promise<unknown> {
  const res = await authed(API_URL + route, (t): RequestInit => {
    const headers: Record<string, string> = { Authorization: `Bearer ${t}` };
    if (args === undefined) return { headers };
    headers['Content-Type'] = 'application/json';
    return { headers, body: JSON.stringify(args) };
  });
  const text = await res.text();
  return text ? (JSON.parse(text) as unknown) : null;
}

export async function listFolder(path = ''): Promise<{ files: FileMeta[]; folders: string[] }> {
  const files: FileMeta[] = [];
  const folders: string[] = [];
  let r = parseListFolder(await rpc('files/list_folder', { path, recursive: true, limit: 2000 }));
  for (;;) {
    files.push(...r.files);
    folders.push(...r.folders);
    if (!r.hasMore) return { files, folders };
    r = parseListFolder(await rpc('files/list_folder/continue', { cursor: r.cursor }));
  }
}

/** Upload; con `rev` scrive solo se il file remoto è ancora quella versione (altrimenti errore 'conflict'). */
export async function upload(path: string, data: Uint8Array<ArrayBuffer>, rev?: string | null): Promise<FileMeta> {
  const mode = rev === undefined ? 'overwrite' : rev === null ? 'add' : { '.tag': 'update', update: rev };
  const res = await authed(CONTENT_URL + 'files/upload', (t) => ({
    headers: {
      Authorization: `Bearer ${t}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': headerJson({ path, mode, autorename: false, mute: true, strict_conflict: true }),
    },
    body: data,
  }));
  return parseFileMeta(await res.json());
}

/** Download; restituisce undefined se il file non esiste. */
export async function download(path: string): Promise<{ meta: FileMeta; data: Uint8Array<ArrayBuffer> } | undefined> {
  try {
    const res = await authed(CONTENT_URL + 'files/download', (t) => ({
      headers: { Authorization: `Bearer ${t}`, 'Dropbox-API-Arg': headerJson({ path }) },
    }));
    const raw = res.headers.get('Dropbox-API-Result');
    if (!raw) throw new DropboxError('Risposta di Dropbox senza metadati.');
    const meta = parseFileMeta(JSON.parse(raw));
    return { meta, data: new Uint8Array(await res.arrayBuffer()) };
  } catch (e) {
    if (e instanceof DropboxError && e.kind === 'not_found') return undefined;
    throw e;
  }
}

export async function remove(path: string): Promise<void> {
  try {
    await rpc('files/delete_v2', { path });
  } catch (e) {
    if (!(e instanceof DropboxError && e.kind === 'not_found')) throw e;
  }
}

/** Prova completa: elenco, scrittura, lettura e cancellazione di un file nella cartella dell'app. */
export async function testConnection(): Promise<string> {
  const before = await listFolder('');
  const path = '/prova-connessione.txt';
  const payload = new TextEncoder().encode(`MacroCaloriesTrack ${new Date().toISOString()} ${crypto.randomUUID()}`);
  const up = await upload(path, payload);
  const got = await download(path);
  await remove(path);
  if (!got || got.meta.rev !== up.rev || new TextDecoder().decode(got.data) !== new TextDecoder().decode(payload)) {
    throw new DropboxError('Il file di prova riletto da Dropbox non corrisponde a quello scritto.');
  }
  return `Connessione riuscita: scrittura, lettura e cancellazione funzionano. File già presenti nella cartella dell’app: ${before.files.length}.`;
}

/** Scollega: revoca il token presso Dropbox (se possibile) e lo cancella da questo dispositivo. */
export async function disconnect(): Promise<void> {
  const a = await getAuth();
  if (a?.refreshToken) {
    try {
      await rpc('auth/token/revoke');
    } catch {
      // Offline o token già revocato: si cancella comunque in locale.
    }
  }
  await db.deleteKey('kv', 'dropbox');
  await db.deleteKey('kv', 'dropbox-pending');
}
