import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decryptJSON, deriveKey, encryptJSON, fromBase64, makeKeyCheck, randomBytes, toBase64, verifyKeyCheck } from '../dist/js/crypto.js';

const salt = randomBytes(16);
const FAST = 1000; // iterazioni ridotte solo per velocità dei test

test('base64 su dati grandi', () => {
  const b = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
  assert.deepEqual(fromBase64(toBase64(b)), b);
});

test('cifra e decifra', async () => {
  const k = await deriveKey('passphrase lunga', salt, FAST);
  const data = { entries: [{ id: 'a', name: 'Yogurt greco' }] };
  const blob = await encryptJSON(k, data, 'diary/2026-11');
  assert.equal(blob.v, 1);
  assert.deepEqual(await decryptJSON(k, blob, 'diary/2026-11'), data);
});

test('IV diverso a ogni cifratura', async () => {
  const k = await deriveKey('x', salt, FAST);
  const a = await encryptJSON(k, 1, 'c');
  const b = await encryptJSON(k, 1, 'c');
  assert.notEqual(a.iv, b.iv);
});

test('passphrase errata, contesto errato e manomissione falliscono', async () => {
  const k = await deriveKey('giusta', salt, FAST);
  const wrong = await deriveKey('sbagliata', salt, FAST);
  const blob = await encryptJSON(k, { a: 1 }, 'diary/2026-11');
  await assert.rejects(decryptJSON(wrong, blob, 'diary/2026-11'));
  await assert.rejects(decryptJSON(k, blob, 'diary/2026-10'));
  const ct = fromBase64(blob.ct);
  ct[0] ^= 1;
  await assert.rejects(decryptJSON(k, { ...blob, ct: toBase64(ct) }, 'diary/2026-11'));
});

test('verifica della passphrase con valore di controllo', async () => {
  const k = await deriveKey('giusta', salt, FAST);
  const check = await makeKeyCheck(k);
  assert.equal(await verifyKeyCheck(k, check), true);
  assert.equal(await verifyKeyCheck(await deriveKey('sbagliata', salt, FAST), check), false);
});

test('normalizzazione Unicode della passphrase', async () => {
  const composed = 'caff\u00e8';
  const decomposed = 'caffe\u0300';
  const k1 = await deriveKey(composed, salt, FAST);
  const k2 = await deriveKey(decomposed, salt, FAST);
  const blob = await encryptJSON(k1, 'ok', 'c');
  assert.equal(await decryptJSON(k2, blob, 'c'), 'ok');
});

test('iterazioni di produzione', async () => {
  const k = await deriveKey('passphrase', salt);
  const blob = await encryptJSON(k, 'ok', 'c');
  assert.equal(await decryptJSON(k, blob, 'c'), 'ok');
});
