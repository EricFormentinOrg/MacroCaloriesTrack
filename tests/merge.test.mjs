import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeById, pickNewer } from '../dist/js/merge.js';

test('vince il più recente', () => {
  const a = { id: '1', updatedAt: 1, v: 'a' };
  const b = { id: '1', updatedAt: 2, v: 'b' };
  assert.equal(pickNewer(a, b), b);
  assert.equal(pickNewer(b, a), b);
});

test('parità deterministica, indipendente dall\'ordine delle chiavi', () => {
  const a = { id: '1', updatedAt: 5, v: 'a' };
  const b = { v: 'b', updatedAt: 5, id: '1' };
  assert.equal(pickNewer(a, b).v, pickNewer(b, a).v);
});

test('merge: nuovi, più recenti, più vecchi, identici, tombstone', () => {
  const local = [
    { id: 'old', updatedAt: 1, v: 1 },
    { id: 'newer-local', updatedAt: 9, v: 1 },
    { id: 'same', updatedAt: 3, v: 1 },
    { id: 'del', updatedAt: 1, v: 1 },
  ];
  const incoming = [
    { id: 'old', updatedAt: 2, v: 2 },
    { id: 'newer-local', updatedAt: 3, v: 2 },
    { id: 'same', updatedAt: 3, v: 1 },
    { id: 'del', updatedAt: 4, v: 1, deleted: true },
    { id: 'fresh', updatedAt: 1, v: 1 },
  ];
  const w = mergeById(local, incoming).map((r) => r.id).sort();
  assert.deepEqual(w, ['del', 'fresh', 'old']);
});
