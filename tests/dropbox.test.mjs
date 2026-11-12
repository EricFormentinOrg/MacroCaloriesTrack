import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  authorizeUrl, base64url, classifyError, headerJson, isAppKey, parseFileMeta, parseListFolder, parseTokenResponse,
  pkcePair, refreshRequestBody, tokenRequestBody,
} from '../dist/js/dropbox.js';

test('PKCE: verifier e challenge S256 conformi a RFC 7636', async () => {
  const { verifier, challenge } = await pkcePair();
  assert.match(verifier, /^[A-Za-z0-9_-]{43,128}$/);
  const expected = createHash('sha256').update(verifier).digest('base64url');
  assert.equal(challenge, expected);
  const other = await pkcePair();
  assert.notEqual(other.verifier, verifier, 'casuale a ogni login');
  assert.equal(base64url(new Uint8Array([251, 255, 191])), '-_-_');
});

test('URL di autorizzazione e corpi delle richieste di token', () => {
  const u = new URL(authorizeUrl(' abc123def456ghi ', 'CHALLENGE'));
  assert.equal(u.origin + u.pathname, 'https://dropbox.com/oauth2/authorize');
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    response_type: 'code', client_id: 'abc123def456ghi', code_challenge: 'CHALLENGE', code_challenge_method: 'S256', token_access_type: 'offline',
  });
  assert.equal(u.searchParams.has('redirect_uri'), false, 'nessun redirect: Dropbox mostra il codice');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(tokenRequestBody('k1234567', ' cod&ice ', 'ver'))), {
    grant_type: 'authorization_code', code: 'cod&ice', client_id: 'k1234567', code_verifier: 'ver',
  });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(refreshRequestBody('k1234567', 'rt'))), {
    grant_type: 'refresh_token', refresh_token: 'rt', client_id: 'k1234567',
  });
  assert.equal(isAppKey('abc123def456ghi'), true);
  assert.equal(isAppKey('ABC 123'), false);
  assert.equal(isAppKey('abc'), false);
});

test('Dropbox-API-Arg solo ASCII', () => {
  const s = headerJson({ path: '/diario/caffè.enc' });
  assert.match(s, /^[\x20-\x7e]+$/);
  assert.deepEqual(JSON.parse(s), { path: '/diario/caffè.enc' });
});

test('risposta del token: validazione e permessi mancanti', () => {
  const ok = { access_token: 'sl.abc', token_type: 'bearer', expires_in: 14400, refresh_token: 'rt.xyz', account_id: 'dbid:1', scope: 'account_info.read files.content.read files.content.write files.metadata.read' };
  const t = parseTokenResponse(ok, 1_000_000);
  assert.equal(t.accessToken, 'sl.abc');
  assert.equal(t.refreshToken, 'rt.xyz');
  assert.equal(t.expiresAt, 1_000_000 + (14400 - 60) * 1000, 'un minuto di margine');
  assert.deepEqual(t.missingScopes, []);
  assert.deepEqual(parseTokenResponse({ ...ok, scope: 'files.metadata.read' }, 0).missingScopes, ['files.content.read', 'files.content.write']);
  const noRefresh = parseTokenResponse({ ...ok, refresh_token: undefined }, 0);
  assert.equal('refreshToken' in noRefresh, false);
  for (const bad of [null, { ...ok, access_token: '' }, { ...ok, access_token: 'a b' }, { ...ok, token_type: 'mac' }, { ...ok, expires_in: '14400' }, { ...ok, expires_in: 5 }, { ...ok, refresh_token: 42 }]) {
    assert.throws(() => parseTokenResponse(bad, 0), undefined, JSON.stringify(bad));
  }
});

test('metadati ed elenco dei file', () => {
  const file = { '.tag': 'file', name: 'meta.json', path_lower: '/meta.json', rev: '015f2a3b4c5d', size: 312, server_modified: '2026-11-12T08:00:00Z', id: 'id:x' };
  assert.deepEqual(parseFileMeta(file), { name: 'meta.json', pathLower: '/meta.json', rev: '015f2a3b4c5d', size: 312, serverModified: '2026-11-12T08:00:00Z' });
  const { ['.tag']: _tag, ...uploadResult } = file;
  assert.equal(parseFileMeta(uploadResult).rev, '015f2a3b4c5d', 'upload e download non hanno .tag');
  for (const bad of [{ ...file, '.tag': 'folder' }, { ...file, rev: 'zz' }, { ...file, size: -1 }, { ...file, path_lower: '' }]) assert.throws(() => parseFileMeta(bad));
  const l = parseListFolder({ entries: [file, { '.tag': 'folder', name: 'diary', path_lower: '/diary' }, { '.tag': 'deleted', name: 'x', path_lower: '/x' }], cursor: 'c1', has_more: false });
  assert.equal(l.files.length, 1);
  assert.deepEqual(l.folders, ['/diary']);
  assert.throws(() => parseListFolder({ entries: [], has_more: 'no', cursor: 'c' }));
});

test('classificazione degli errori', () => {
  assert.equal(classifyError(409, JSON.stringify({ error_summary: 'path/conflict/file/..', error: {} })).kind, 'conflict');
  assert.equal(classifyError(409, JSON.stringify({ error_summary: 'path/not_found/.' })).kind, 'not_found');
  assert.equal(classifyError(409, JSON.stringify({ error_summary: 'path/insufficient_space/..' })).kind, 'space');
  assert.equal(classifyError(401, JSON.stringify({ error_summary: 'expired_access_token/' })).kind, 'auth');
  assert.equal(classifyError(401, JSON.stringify({ error_summary: 'missing_scope/.' })).kind, 'scope');
  assert.equal(classifyError(400, JSON.stringify({ error: 'invalid_grant', error_description: 'code doesn\'t exist or has expired' })).kind, 'auth');
  assert.equal(classifyError(429, '').kind, 'rate_limit');
  assert.equal(classifyError(500, '<html>').kind, 'other');
});
