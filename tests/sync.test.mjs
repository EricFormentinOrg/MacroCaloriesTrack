import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encryptJSON } from '../dist/js/crypto.js';
import {
  ConflictError, META_PATH, WrongPassphrase, createRemote, decodeFile, diaryPath, encodeFile, joinRemote, kindOf, parseMeta, syncOnce,
} from '../dist/js/sync.js';

const FAST = 1000; // iterazioni ridotte solo per velocità dei test

/** Dropbox in memoria: revisioni crescenti e conflitti come upload con mode add/update + strict_conflict. */
function memoryRemote() {
  const files = new Map();
  let n = 0;
  const remote = {
    files,
    writes: 0,
    async list() { return [...files].map(([path, f]) => ({ path, rev: f.rev })); },
    async read(path) { const f = files.get(path); return f ? { rev: f.rev, data: f.data } : undefined; },
    async write(path, data, rev) {
      const cur = files.get(path);
      if (rev === null ? cur : !cur || cur.rev !== rev) throw new ConflictError('conflitto');
      const next = { rev: (++n).toString(16).padStart(9, '0'), data };
      files.set(path, next);
      remote.writes++;
      return next.rev;
    },
  };
  return remote;
}

/** Dispositivo in memoria: stesso partizionamento dell'adattatore IndexedDB. */
function memoryLocal() {
  const stores = { profile: new Map(), foods: new Map(), weights: new Map(), entries: new Map() };
  const which = (path) => ({ profile: stores.profile, foods: stores.foods, weights: stores.weights, entries: stores.entries })[kindOf(path)];
  return {
    stores,
    async paths() {
      const out = [];
      if (stores.profile.size) out.push('/profile.enc');
      if (stores.foods.size) out.push('/foods.enc');
      if (stores.weights.size) out.push('/weights.enc');
      for (const e of stores.entries.values()) out.push(diaryPath(e.date));
      return [...new Set(out)];
    },
    async read(path) {
      const s = which(path);
      const all = [...s.values()];
      return kindOf(path) === 'entries' ? all.filter((e) => diaryPath(e.date) === path) : all;
    },
    async write(path, records) { for (const r of records) which(path).set(r.id, r); },
  };
}

const food = (id, name, t) => ({ id, name, unit: 'g', per100: { kcal: 100, fat: 1, carbs: 10, protein: 5 }, servings: [], source: 'custom', createdAt: t, updatedAt: t });
const entry = (id, date, qty, t, extra = {}) => ({ id, date, meal: 'lunch', foodId: 'f1', name: 'Pasta', unit: 'g', qty, per100: { kcal: 350, fat: 2, carbs: 70, protein: 12 }, createdAt: t, updatedAt: t, ...extra });

async function setupTwoDevices() {
  const remote = memoryRemote();
  const a = memoryLocal();
  const b = memoryLocal();
  const keyA = await createRemote(remote, 'cavallo batteria graffetta corretta', FAST);
  assert.ok(keyA);
  assert.throws(() => parseMeta(remote.files.get(META_PATH).data), /parametri della chiave/, 'in produzione almeno 100.000 iterazioni');
  const meta = parseMeta(remote.files.get(META_PATH).data, FAST);
  assert.equal(meta.kdf.iterations, FAST);
  await assert.rejects(joinRemote(meta, 'passphrase sbagliata'), WrongPassphrase);
  const keyB = await joinRemote(meta, 'cavallo batteria graffetta corretta');
  return { remote, a, b, keyA, keyB };
}

test('meta.json: creazione, secondo dispositivo, creazione concorrente', async () => {
  const { remote } = await setupTwoDevices();
  assert.equal(await createRemote(remote, 'altra', FAST), undefined, 'meta già presente: usare joinRemote');
  const text = new TextDecoder().decode(remote.files.get(META_PATH).data);
  assert.doesNotMatch(text, /cavallo/, 'la passphrase non va mai su Dropbox');
  for (const bad of [{}, { app: 'MacroCaloriesTrack', format: 2 }, { ...JSON.parse(text), kdf: { ...JSON.parse(text).kdf, iterations: 10 } }]) {
    assert.throws(() => parseMeta(new TextEncoder().encode(JSON.stringify(bad)), FAST));
  }
});

test('due dispositivi: invio, ricezione, modifiche e cancellazioni', async () => {
  const { remote, a, b, keyA, keyB } = await setupTwoDevices();
  a.stores.foods.set('f1', food('f1', 'Pasta', 1));
  a.stores.entries.set('e1', entry('e1', '2026-11-12', 80, 1));
  a.stores.entries.set('e2', entry('e2', '2026-10-31', 90, 1));
  let sa = await syncOnce(a, remote, keyA, { files: {} });
  assert.equal(sa.pushed, 3);
  assert.deepEqual([...remote.files.keys()].sort(), ['/diary/2026-10.enc', '/diary/2026-11.enc', '/foods.enc', META_PATH]);
  // Nessuna modifica: nessuna scrittura.
  const writes = remote.writes;
  sa = await syncOnce(a, remote, keyA, sa.state);
  assert.equal(remote.writes, writes);
  assert.equal(sa.pushed + sa.pulled, 0);

  let sb = await syncOnce(b, remote, keyB, { files: {} });
  assert.equal(sb.pulled, 3);
  assert.equal(sb.pushed, 0, 'ha ricevuto e basta');
  assert.deepEqual(b.stores.entries.get('e1'), a.stores.entries.get('e1'));

  // B modifica una voce e cancella l'alimento (tombstone); A riceve.
  b.stores.entries.set('e1', entry('e1', '2026-11-12', 120, 1, { updatedAt: 5 }));
  b.stores.foods.set('f1', { ...food('f1', 'Pasta', 1), deleted: true, updatedAt: 6 });
  sb = await syncOnce(b, remote, keyB, sb.state);
  assert.equal(sb.pushed, 2);
  sa = await syncOnce(a, remote, keyA, sa.state);
  assert.equal(a.stores.entries.get('e1').qty, 120);
  assert.equal(a.stores.foods.get('f1').deleted, true);
});

test('modifiche offline sullo stesso mese: conflitto risolto senza perdite', async () => {
  const { remote, a, b, keyA, keyB } = await setupTwoDevices();
  a.stores.entries.set('e1', entry('e1', '2026-11-12', 80, 1));
  let sa = await syncOnce(a, remote, keyA, { files: {} });
  let sb = await syncOnce(b, remote, keyB, { files: {} });
  // Entrambi offline: A aggiunge e2, B aggiunge e3 e modifica e1.
  a.stores.entries.set('e2', entry('e2', '2026-11-13', 50, 10));
  b.stores.entries.set('e3', entry('e3', '2026-11-14', 60, 11));
  b.stores.entries.set('e1', entry('e1', '2026-11-12', 99, 1, { updatedAt: 12 }));
  sa = await syncOnce(a, remote, keyA, sa.state);
  // B scrive con una revisione vecchia: conflitto, rilettura, unione, nuovo invio.
  sb = await syncOnce(b, remote, keyB, sb.state);
  sa = await syncOnce(a, remote, keyA, sa.state);
  for (const dev of [a, b]) {
    assert.deepEqual([...dev.stores.entries.keys()].sort(), ['e1', 'e2', 'e3']);
    assert.equal(dev.stores.entries.get('e1').qty, 99);
  }
  // Conflitto forzato a metà scrittura: un altro dispositivo scrive tra lettura e invio.
  const realWrite = remote.write;
  let injected = false;
  remote.write = async (path, data, rev) => {
    if (!injected && path === '/diary/2026-11.enc') {
      injected = true;
      const other = await encodeFile(keyB, path, [...b.stores.entries.values(), entry('e4', '2026-11-15', 70, 20)]);
      await realWrite(path, other, remote.files.get(path).rev);
    }
    return realWrite(path, data, rev);
  };
  a.stores.entries.set('e5', entry('e5', '2026-11-16', 40, 21));
  await syncOnce(a, remote, keyA, sa.state);
  remote.write = realWrite;
  assert.deepEqual([...a.stores.entries.keys()].sort(), ['e1', 'e2', 'e3', 'e4', 'e5'], 'unione dopo il conflitto');
  const remoteNow = await decodeFile(keyA, '/diary/2026-11.enc', remote.files.get('/diary/2026-11.enc').data);
  assert.deepEqual(remoteNow.map((r) => r.id).sort(), ['e1', 'e2', 'e3', 'e4', 'e5']);
});

test('file alterati, spostati o con dati non validi vengono rifiutati', async () => {
  const { remote, a, keyA } = await setupTwoDevices();
  a.stores.entries.set('e1', entry('e1', '2026-11-12', 80, 1));
  a.stores.foods.set('f1', food('f1', 'Pasta', 1));
  await syncOnce(a, remote, keyA, { files: {} });
  const fresh = memoryLocal();
  // Alterato: un byte del testo cifrato cambiato.
  const f = remote.files.get('/foods.enc');
  const blob = JSON.parse(new TextDecoder().decode(f.data));
  const ct = Buffer.from(blob.ct, 'base64');
  ct[0] ^= 1;
  const tampered = new TextEncoder().encode(JSON.stringify({ ...blob, ct: ct.toString('base64') }));
  await assert.rejects(decodeFile(keyA, '/foods.enc', tampered), /Decifratura fallita/);
  // Spostato: il contenuto di foods.enc copiato su weights.enc non si decifra (il percorso è dato autenticato).
  await assert.rejects(decodeFile(keyA, '/weights.enc', f.data), /Decifratura fallita/);
  // Cifrato con la chiave giusta ma con record non validi o di un altro mese.
  const bad = async (path, records) => new TextEncoder().encode(JSON.stringify(await encryptJSON(keyA, { app: 'MacroCaloriesTrack', format: 1, kind: kindOf(path), records }, path)));
  await assert.rejects(decodeFile(keyA, '/diary/2026-11.enc', await bad('/diary/2026-11.enc', [{ ...entry('x', '2026-11-12', 1, 1), qty: -5 }])), /non validi/);
  await assert.rejects(decodeFile(keyA, '/diary/2026-11.enc', await bad('/diary/2026-11.enc', [entry('x', '2026-12-01', 1, 1)])), /altro mese/);
  await assert.rejects(decodeFile(keyA, '/diary/2026-11.enc', await bad('/foods.enc', [])), /Decifratura fallita/);
  // Una sync con un file alterato si ferma senza toccare i dati locali.
  remote.files.set('/foods.enc', { rev: 'ffffffff1', data: tampered });
  await assert.rejects(syncOnce(fresh, remote, keyA, { files: {} }));
  assert.equal(fresh.stores.foods.size, 0);
});
