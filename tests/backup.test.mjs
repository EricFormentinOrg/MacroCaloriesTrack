import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBackup, countAlive, diaryCSV, parseBackup } from '../dist/js/backup.js';

const food = { id: 'f1', updatedAt: 10, createdAt: 10, name: 'Yogurt greco 0%', brand: 'Fage', unit: 'g', source: 'custom',
  per100: { kcal: 54, fat: 0, carbs: 3, sugars: 3, protein: 10.3, salt: 0.1 }, servings: [{ label: 'vasetto', qty: 170 }] };
const entry = { id: 'e1', updatedAt: 11, createdAt: 11, date: '2026-11-11', meal: 'breakfast', foodId: 'f1', name: 'Yogurt greco 0%',
  unit: 'g', qty: 170, per100: food.per100, serving: { label: 'vasetto', qty: 170, count: 1 } };
const data = { profile: null, foods: [food], entries: [entry], weights: [{ id: '2026-11-11', date: '2026-11-11', kg: 82.4, updatedAt: 1 }] };

test('esporta e reimporta senza perdite', () => {
  const r = parseBackup(JSON.stringify(buildBackup(data)));
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, data);
});

test('scarta i campi sconosciuti', () => {
  const b = buildBackup({ ...data, foods: [{ ...food, evil: '<img src=x onerror=alert(1)>' }] });
  const r = parseBackup(JSON.stringify(b));
  assert.equal(r.ok, true);
  assert.equal('evil' in r.data.foods[0], false);
});

test('rifiuta file non validi senza importare nulla', () => {
  assert.equal(parseBackup('{').ok, false);
  assert.equal(parseBackup(JSON.stringify({ app: 'Altro' })).ok, false);
  assert.equal(parseBackup(JSON.stringify({ ...buildBackup(data), format: 99 })).ok, false);
  const bad = buildBackup({ ...data, entries: [{ ...entry, qty: -5 }, { ...entry, id: 'e2', date: '2026-13-01' }] });
  const r = parseBackup(JSON.stringify(bad));
  assert.equal(r.ok, false);
  assert.match(r.error, /diario\[0\]/);
  assert.match(r.error, /diario\[1\]/);
});

test('conteggio esclude i record eliminati', () => {
  const c = countAlive({ ...data, entries: [entry, { ...entry, id: 'e2', deleted: true }] });
  assert.equal(c.entries, 1);
});

test('CSV: separatore, virgola decimale, escaping e formule neutralizzate', () => {
  const csv = diaryCSV([entry, { ...entry, id: 'e3', name: '=HYPERLINK("x")', createdAt: 12 }, { ...entry, id: 'e4', name: 'Pane; integrale', createdAt: 13 }]);
  const lines = csv.replace('\uFEFF', '').trim().split('\r\n');
  assert.equal(lines.length, 4);
  assert.match(lines[1], /^2026-11-11;Colazione;Yogurt greco 0%;;170;g;91,8;17,5;5,1;0;;5,1;;0,2$/);
  assert.ok(lines[2].startsWith(`2026-11-11;Colazione;"'=HYPERLINK(""x"")"`));
  assert.ok(lines[3].includes('"Pane; integrale"'));
});

test('provenienza e preferiti: validati e conservati', () => {
  const ch = { ...food, id: 'f2', name: 'Bresaola', brand: undefined, source: 'ch', sourceId: '705', favorite: true };
  delete ch.brand;
  const off = { ...food, id: 'f3', source: 'off', sourceId: '8000000000017', barcode: '8000000000017' };
  const r = parseBackup(JSON.stringify(buildBackup({ ...data, foods: [food, ch, off] })));
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.foods, [food, ch, off]);
  // Backup della Fase 1, senza "source": resta un alimento personale.
  const legacy = { ...food };
  delete legacy.source;
  const r2 = parseBackup(JSON.stringify(buildBackup({ ...data, foods: [legacy] })));
  assert.equal(r2.ok, true);
  assert.equal(r2.data.foods[0].source, 'custom');
  for (const bad of [
    { ...food, source: 'web' },
    { ...food, source: 'ch' },
    { ...food, source: 'ch', sourceId: '../x' },
    { ...food, sourceId: '705' },
    { ...food, favorite: 'sì' },
  ]) assert.equal(parseBackup(JSON.stringify(buildBackup({ ...data, foods: [bad] }))).ok, false, JSON.stringify(bad));
});
