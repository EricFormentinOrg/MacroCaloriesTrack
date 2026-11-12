// Dropbox: URL, PKCE e validazione delle risposte. Modulo puro, testato in Node.
// Verificato il 12/11/2026 su: SDK ufficiale dropbox-sdk-js (src/auth.js, utils.js, dropbox.js),
// specifica dropbox-api-spec (files.stone), guida OAuth su docs.dropboxapi.com e preflight CORS reali.
// - autorizzazione: https://dropbox.com/oauth2/authorize, response_type=code, PKCE S256,
//   token_access_type=offline per avere il refresh token; senza redirect_uri Dropbox mostra
//   un codice da copiare nell'app;
// - token: POST https://api.dropboxapi.com/oauth2/token, form-urlencoded;
// - RPC su api.dropboxapi.com/2/, upload e download su content.dropboxapi.com/2/ con l'header
//   Dropbox-API-Arg (JSON con i caratteri non ASCII in forma \u....) e il risultato del download
//   nell'header Dropbox-API-Result, esposto in CORS.
import { randomBytes, toBase64 } from './crypto.js';

export const AUTHORIZE_URL = 'https://dropbox.com/oauth2/authorize';
export const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
export const API_URL = 'https://api.dropboxapi.com/2/';
export const CONTENT_URL = 'https://content.dropboxapi.com/2/';
export const SCOPES: ReadonlyArray<string> = ['files.metadata.read', 'files.content.read', 'files.content.write'];

/** Le App key di Dropbox sono stringhe alfanumeriche minuscole (formato esatto non documentato). */
export const isAppKey = (s: string): boolean => /^[a-z0-9]{8,40}$/.test(s.trim());

export const base64url = (bytes: Uint8Array): string => toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** PKCE (RFC 7636): verifier di 86 caratteri, challenge = base64url(SHA-256(verifier)). */
export async function pkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(randomBytes(64));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export function authorizeUrl(appKey: string, challenge: string): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: appKey.trim(),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
  });
  return `${AUTHORIZE_URL}?${q.toString()}`;
}

export function tokenRequestBody(appKey: string, code: string, verifier: string): string {
  return new URLSearchParams({ grant_type: 'authorization_code', code: code.trim(), client_id: appKey.trim(), code_verifier: verifier }).toString();
}

export function refreshRequestBody(appKey: string, refreshToken: string): string {
  return new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: appKey.trim() }).toString();
}

/** JSON per l'header Dropbox-API-Arg: gli header HTTP accettano solo ASCII. */
export function headerJson(args: unknown): string {
  return JSON.stringify(args).replace(/[^\x00-\x7e]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

// ---- Validazione

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export interface TokenSet {
  accessToken: string;
  /** Millisecondi epoch. */
  expiresAt: number;
  refreshToken?: string;
  accountId?: string;
  /** Permessi richiesti ma non concessi dall'app Dropbox dell'utente. */
  missingScopes: string[];
}

export function parseTokenResponse(v: unknown, now: number): TokenSet {
  if (!isObj(v)) throw new Error('Risposta di Dropbox non valida.');
  if (!str(v.access_token, 4000) || /\s/.test(v.access_token)) throw new Error('Dropbox non ha restituito un token valido.');
  if (typeof v.token_type !== 'string' || v.token_type.toLowerCase() !== 'bearer') throw new Error('Tipo di token inatteso.');
  const exp = v.expires_in;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp < 60 || exp > 30 * 86400) throw new Error('Scadenza del token non valida.');
  if (v.refresh_token !== undefined && (!str(v.refresh_token, 4000) || /\s/.test(v.refresh_token))) throw new Error('Refresh token non valido.');
  const granted = typeof v.scope === 'string' ? v.scope.split(/\s+/) : undefined;
  return {
    accessToken: v.access_token,
    // Un minuto di margine: il token scade prima per noi che per Dropbox.
    expiresAt: now + (exp - 60) * 1000,
    ...(typeof v.refresh_token === 'string' ? { refreshToken: v.refresh_token } : {}),
    ...(str(v.account_id, 200) ? { accountId: v.account_id } : {}),
    missingScopes: granted ? SCOPES.filter((s) => !granted.includes(s)) : [],
  };
}

export interface FileMeta {
  name: string;
  pathLower: string;
  rev: string;
  size: number;
  serverModified: string;
}

/** Metadati di un file (upload, download, list_folder). Lancia un errore se non hanno la forma attesa. */
export function parseFileMeta(v: unknown): FileMeta {
  if (!isObj(v)) throw new Error('Metadati Dropbox non validi.');
  if (v['.tag'] !== undefined && v['.tag'] !== 'file') throw new Error('Non è un file.');
  if (!str(v.name, 255) || !str(v.path_lower, 1000) || !str(v.rev, 64) || !/^[0-9a-f]+$/.test(v.rev)) throw new Error('Metadati Dropbox non validi.');
  if (typeof v.size !== 'number' || !Number.isInteger(v.size) || v.size < 0) throw new Error('Dimensione del file non valida.');
  if (!str(v.server_modified, 40)) throw new Error('Data del file non valida.');
  return { name: v.name, pathLower: v.path_lower, rev: v.rev, size: v.size, serverModified: v.server_modified };
}

export function parseListFolder(v: unknown): { files: FileMeta[]; folders: string[]; cursor: string; hasMore: boolean } {
  if (!isObj(v) || !Array.isArray(v.entries) || typeof v.has_more !== 'boolean' || !str(v.cursor, 4000)) throw new Error('Elenco Dropbox non valido.');
  const files: FileMeta[] = [];
  const folders: string[] = [];
  for (const e of v.entries) {
    if (isObj(e) && e['.tag'] === 'folder' && str(e.path_lower, 1000)) folders.push(e.path_lower);
    else if (isObj(e) && e['.tag'] === 'file') files.push(parseFileMeta(e));
    // Altri tipi (eliminati) ignorati.
  }
  return { files, folders, cursor: v.cursor, hasMore: v.has_more };
}

export type ErrorKind = 'auth' | 'conflict' | 'not_found' | 'rate_limit' | 'scope' | 'space' | 'other';

/** Classifica un errore Dropbox dal codice HTTP e dal corpo (error_summary). */
export function classifyError(status: number, body: string): { kind: ErrorKind; summary: string } {
  let summary = '';
  try {
    const j: unknown = JSON.parse(body);
    if (isObj(j) && typeof j.error_summary === 'string') summary = j.error_summary.slice(0, 200);
    else if (isObj(j) && typeof j.error === 'string') summary = j.error.slice(0, 200);
  } catch {
    summary = body.slice(0, 200);
  }
  if (status === 401) return { kind: summary.includes('missing_scope') ? 'scope' : 'auth', summary };
  if (status === 429) return { kind: 'rate_limit', summary };
  if (status === 400 && /invalid_grant|invalid_client/.test(summary)) return { kind: 'auth', summary };
  if (status === 409) {
    if (/\/conflict/.test(summary)) return { kind: 'conflict', summary };
    if (/not_found/.test(summary)) return { kind: 'not_found', summary };
    if (/insufficient_space/.test(summary)) return { kind: 'space', summary };
  }
  return { kind: 'other', summary };
}
