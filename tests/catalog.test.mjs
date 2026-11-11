import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { catalogFood, parseCatalog, searchCatalog } from '../dist/js/catalog.js';
import { checkFood } from '../dist/js/nutrition.js';
import { norm, rank, tokens } from '../dist/js/search.js';

const head = {
  format: 1, source: 'Banca dati svizzera dei valori nutritivi', publisher: 'USAV', version: '7.1', released: '2026-07-01',
  url: 'https://naehrwertdaten.ch', unit: 'g', nutrients: ['kcal', 'fat', 'satFat', 'carbs', 'sugars', 'fiber', 'protein', 'salt'],
};
const mini = (foods) => ({ ...head, foods });
const bresaola = ['705', 'Bresaola', '', 'Prodotti carnei e insaccati', [155, 2.6, 0.8, 0.4, 0, 0, 32.4, 6.8]];

test('ricerca senza accenti, per token e con punteggio', () => {
  assert.equal(norm('Caffè Ristretto'), 'caffe ristretto');
  assert.deepEqual(tokens(' pane,  integrale '), ['pane', 'integrale']);
  const t = tokens('pane');
  assert.ok(rank('Pane integrale', t) > rank('Pangrattato', t));
  assert.ok(rank('Pane bianco', t) > rank('Sandwich (pane bigio) con affettati', t));
});

test('catalogo: validazione rigorosa', () => {
  const c = parseCatalog(mini([bresaola, ['1', 'Acqua', 'Acqua potabile', 'Bevande', [0, 0, null, 0, null, null, 0, null]]]));
  assert.equal(c.items.length, 2);
  assert.equal(c.items[1].per100.satFat, undefined, 'null = valore non disponibile');
  assert.equal(c.items[1].synonyms, 'Acqua potabile');
  const bad = [
    { ...head, format: 2, foods: [bresaola] },
    { ...head, nutrients: ['kcal', 'fat'], foods: [bresaola] },
    mini([]),
    mini([['x1', 'Nome', '', 'Cat', [1, 1, 1, 1, 1, 1, 1, 1]]]),
    mini([['2', '', '', 'Cat', [1, 1, 1, 1, 1, 1, 1, 1]]]),
    mini([['2', 'Nome', '', 'Cat', [null, 1, 1, 1, 1, 1, 1, 1]]]),
    mini([['2', 'Nome', '', 'Cat', [1, 1, 1, 1, 1, 1, 1]]]),
    mini([['2', 'Nome', '', 'Cat', [1, -1, 1, 1, 1, 1, 1, 1]]]),
    mini([['2', 'Nome', '', 'Cat', [1, '1', 1, 1, 1, 1, 1, 1]]]),
    mini([bresaola, bresaola]),
  ];
  for (const b of bad) assert.throws(() => parseCatalog(b), /banca dati/);
});

test('catalogo: ricerca, esclusione delle copie e alimento personale', () => {
  const c = parseCatalog(mini([
    bresaola,
    ['10', 'Pane bigio', 'Pane semibianco', 'Pane', [240, 1.6, 0.3, 46, 2, 5, 8.5, 1.2]],
    ['11', 'Sandwich (pane bigio) con affettati', '', 'Cibi', [250, 10, 4, 25, 2, 2, 12, 1.5]],
  ]));
  assert.deepEqual(searchCatalog(c.items, tokens('pane')).map((x) => x.id), ['10', '11']);
  assert.deepEqual(searchCatalog(c.items, tokens('semibianco')).map((x) => x.id), ['10'], 'cerca anche nei sinonimi');
  assert.deepEqual(searchCatalog(c.items, tokens('pane'), 40, new Set(['10'])).map((x) => x.id), ['11']);
  assert.deepEqual(searchCatalog(c.items, []), []);
  const f = catalogFood(c.items[0]);
  assert.deepEqual(f, { name: 'Bresaola', unit: 'g', per100: { kcal: 155, fat: 2.6, satFat: 0.8, carbs: 0.4, sugars: 0, fiber: 0, protein: 32.4, salt: 6.8 }, servings: [], source: 'ch', sourceId: '705' });
  f.per100.kcal = 1;
  assert.equal(c.items[0].per100.kcal, 155, 'la copia non tocca il catalogo');
});

test('il dataset pubblicato è valido e completo', () => {
  const c = parseCatalog(JSON.parse(readFileSync('public/data/alimenti-ch.json', 'utf8')));
  assert.equal(c.version, '7.1');
  assert.equal(c.items.length, 1216);
  for (const x of c.items) {
    for (const k of ['kcal', 'fat', 'carbs', 'protein']) assert.equal(typeof x.per100[k], 'number', `${x.name}: ${k}`);
    assert.ok(x.per100.fat + x.per100.carbs + x.per100.protein <= 101, `${x.name}: macro oltre 100 g`);
  }
  assert.ok(searchCatalog(c.items, tokens('bresaola')).some((x) => x.name === 'Bresaola'));
  // Controlli di plausibilità dell'editor: quanti alimenti li violerebbero (alcol e polioli spiegano gli scarti energetici).
  const flagged = c.items.filter((x) => checkFood(x.per100, 'g').length);
  assert.ok(flagged.length < c.items.length * 0.1, `${flagged.length} alimenti con avvisi`);
});
