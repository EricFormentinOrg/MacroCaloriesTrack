import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimiter, isBarcode, offFood, parseOffProduct, parseProductResponse, parseSearchResponse, productUrl, reviewNotes, searchUrl, userAgent, parseSalResponse, salQuery, salSearchUrl } from '../dist/js/off.js';

// Prodotti sintetici con la struttura delle risposte reali (campi verificati su world.openfoodfacts.org).
const pasta = {
  code: '8000000000017', product_name: 'Spaghetti n.5 IT-EN', product_name_it: 'Spaghetti n.5', brands: 'Pastificio Esempio, Altro marchio',
  product_quantity_unit: 'g', quantity: '500 g', serving_quantity: 85, nutrition_data: 'on',
  nutriments: { 'energy-kcal_100g': 359, 'energy-kj_100g': 1521, fat_100g: 2, 'saturated-fat_100g': 0.5, carbohydrates_100g: 71,
    sugars_100g: 3.5, fiber_100g: 3, proteins_100g: 13, salt_100g: 0.01, sodium_100g: 0.004 },
};

test('prodotto completo', () => {
  const p = parseOffProduct(pasta);
  assert.deepEqual(p, {
    code: '8000000000017', name: 'Spaghetti n.5', brand: 'Pastificio Esempio', unit: 'g', complete: true,
    per100: { kcal: 359, fat: 2, satFat: 0.5, carbs: 71, sugars: 3.5, fiber: 3, protein: 13, salt: 0.01 },
    serving: { label: 'porzione', qty: 85 },
  });
  assert.deepEqual(reviewNotes(p), []);
  const f = offFood(p);
  assert.equal(f.source, 'off');
  assert.equal(f.sourceId, '8000000000017');
  assert.equal(f.barcode, '8000000000017');
  assert.deepEqual(f.servings, [{ label: 'porzione', qty: 85 }]);
});

test('energia da kJ, sale dal sodio, numeri come stringhe, liquidi in ml', () => {
  const p = parseOffProduct({
    code: 8000000000024, product_name: 'Latte parzialmente scremato', brands: ['Latteria Esempio'], quantity: '1 l',
    nutriments: { 'energy-kj_100g': '195', fat_100g: '1.6', carbohydrates_100g: 4.9, proteins_100g: 3.3, sodium_100g: 0.052 },
  });
  assert.equal(p.code, '8000000000024');
  assert.equal(p.brand, 'Latteria Esempio');
  assert.equal(p.unit, 'ml');
  assert.equal(p.per100.kcal, 47);
  assert.equal(p.per100.fat, 1.6);
  assert.equal(p.per100.salt, 0.13);
  assert.equal(p.complete, true);
});

test('dati mancanti, incoerenti o pericolosi', () => {
  const incomplete = parseOffProduct({ code: '8000000000031', product_name: 'Biscotti', nutriments: { 'energy-kcal_100g': 450, fat_100g: 18 } });
  assert.equal(incomplete.complete, false);
  assert.match(reviewNotes(incomplete)[0], /Mancano/);
  const wrong = parseOffProduct({ ...pasta, nutriments: { ...pasta.nutriments, 'energy-kcal_100g': 120 } });
  assert.match(reviewNotes(wrong)[0], /circa 360 kcal/);
  const off = parseOffProduct({ ...pasta, nutrition_data: 'off' });
  assert.deepEqual(off.per100, {});
  // Valori fuori intervallo, tipi sbagliati, testo con controlli e direzione invertita.
  const evil = parseOffProduct({
    code: '8000000000048', product_name: '  Nome\u0000 con' + String.fromCodePoint(0x202e) + ' controlli\n e  spazi  ' + 'x'.repeat(300), brands: { a: 1 },
    nutriments: { 'energy-kcal_100g': 5000, fat_100g: -1, carbohydrates_100g: 'molti', proteins_100g: 1e9, '__proto__': { kcal: 1 } },
    serving_quantity: 'tanta', extra: '<img src=x onerror=alert(1)>',
  });
  assert.ok(evil.name.startsWith('Nome con controlli e spazi x'));
  assert.equal(evil.name.length, 200);
  assert.equal(evil.brand, undefined);
  assert.deepEqual(evil.per100, {});
  assert.equal(evil.serving, undefined);
  assert.equal('extra' in evil, false);
  assert.equal(parseOffProduct({ ...pasta, code: '12ab' }), undefined);
  assert.equal(parseOffProduct({ ...pasta, product_name: '', product_name_it: '   ' }), undefined);
  assert.equal(parseOffProduct(null), undefined);
});

test('risposte: prodotto, prodotto assente, ricerca', () => {
  assert.equal(parseProductResponse({ code: '00000000', status: 0, status_verbose: 'no code or invalid code' }), null);
  assert.equal(parseProductResponse({ status: 1, product: pasta }).name, 'Spaghetti n.5');
  assert.throws(() => parseProductResponse('<!DOCTYPE html>'));
  assert.throws(() => parseProductResponse({ status: 'x' }));
  const r = parseSearchResponse({ count: 1532, page: 1, page_size: 24, products: [pasta, { code: 'x' }, pasta, { ...pasta, code: '8000000000055' }] });
  assert.equal(r.count, 1532);
  assert.deepEqual(r.products.map((p) => p.code), ['8000000000017', '8000000000055'], 'scarta non validi e doppioni');
  assert.throws(() => parseSearchResponse({ products: 'tutti' }));
  assert.throws(() => parseSearchResponse({ products: new Array(201).fill(pasta) }));
});

test('URL e User-Agent', () => {
  assert.equal(isBarcode('8076800195057'), true);
  assert.equal(isBarcode('1234567'), false);
  assert.equal(isBarcode('80768001950a7'), false);
  assert.match(productUrl('8076800195057'), /^https:\/\/world\.openfoodfacts\.org\/api\/v2\/product\/8076800195057\.json\?fields=/);
  assert.throws(() => productUrl('../../etc'));
  const u = new URL(searchUrl('  latte & miele #1 '));
  assert.equal(u.origin, 'https://world.openfoodfacts.org');
  assert.equal(u.pathname, '/cgi/search.pl');
  assert.equal(u.searchParams.get('search_terms'), 'latte & miele #1');
  assert.equal(u.searchParams.get('json'), '1');
  assert.equal(userAgent('abc123', 'https://utente.github.io/macro/'), 'MacroCaloriesTrack/abc123 (+https://utente.github.io/macro/)');
  assert.equal(userAgent('1', 'https://x.test/à\r\nX-Evil: 1'), 'MacroCaloriesTrack/1 (+https://x.test/X-Evil: 1)');
});

test('limite di frequenza', () => {
  let t = 0;
  const lim = new RateLimiter(2, 60_000, () => t);
  assert.equal(lim.take(), 0);
  t = 10_000;
  assert.equal(lim.take(), 0);
  t = 20_000;
  assert.equal(lim.take(), 40_000, 'aspetta che esca la prima richiesta');
  t = 60_000;
  assert.equal(lim.take(), 0);
  assert.equal(lim.take(), 10_000);
});

test('Search-a-licious: query ripulita dalla sintassi Lucene, URL, campi', () => {
  // Verificato dal vivo il 27/11/2026: "yogurt: greco", '"pasta', "pasta AND", "pasta (fresca" davano 400.
  assert.equal(salQuery('yogurt: greco'), 'yogurt greco');
  assert.equal(salQuery('"pasta'), 'pasta');
  assert.equal(salQuery('Pasta AND'), 'pasta and', 'operatori in minuscolo: restano parole');
  assert.equal(salQuery('pasta (fresca'), 'pasta fresca');
  assert.equal(salQuery('coca-cola 1/2 l*'), 'coca cola 1 2 l');
  assert.equal(salQuery("caffè d'orzo"), "caffè d'orzo", 'apostrofo e accenti restano');
  assert.equal(salQuery(' :: '), '');
  const u = new URL(salSearchUrl('Yogurt: Greco'));
  assert.equal(u.origin, 'https://search.openfoodfacts.org');
  assert.equal(u.pathname, '/search');
  assert.equal(u.searchParams.get('q'), 'yogurt greco');
  assert.equal(u.searchParams.get('langs'), 'it');
  assert.equal(u.searchParams.get('page_size'), '24');
  assert.match(u.searchParams.get('fields'), /^code,product_name,.*nutriments/);
  assert.throws(() => salSearchUrl('***'));
});

test('Search-a-licious: risultati validati, marchi senza prefisso, tutti da completare', () => {
  // Forma delle risposte vere del 27/11/2026 (campi ridotti).
  const res = parseSalResponse({
    hits: [
      { code: '8004690611500', product_name: 'Spaghetti n°15 (Le Integrali)', product_name_it: 'Spaghetti n°15 (Le Integrali)', brands: ['xx:La Molisana'], quantity: '500 gram', product_quantity_unit: 'g', serving_quantity: 100.0, nutriments: null },
      { code: '7709665301769', product_name: 'Nutella', product_name_it: null, brands: ['nutella', 'ferrero'], serving_quantity: 25.0,
        nutriments: { 'energy-kcal_100g': 520.0, fat_100g: 32.0, 'saturated-fat_100g': 10.0, carbohydrates_100g: 56.0, sugars_100g: 56.0, proteins_100g: 8.0, fiber_100g: 4.0, salt_100g: 0.1 } },
      { code: '5000112557664', product_name: 'Coca Cola', brands: ['xx:Coca-Cola'], quantity: '33', serving_quantity: 330.0, serving_quantity_unit: 'ml' },
      { code: '8004690611500', product_name: 'doppione' },
      { code: 'abc', product_name: 'codice non valido' },
      'testo',
    ],
    count: 123, page: 1, page_size: 24, page_count: 6, took: 7, timed_out: false, is_count_exact: true,
  });
  assert.equal(res.count, 123);
  assert.deepEqual(res.products.map((p) => p.code), ['8004690611500', '7709665301769', '5000112557664']);
  assert.ok(res.products.every((p) => p.partial === true), 'valori sempre dalla scheda prodotto');
  assert.equal(res.products[0].brand, 'La Molisana', 'prefisso di lingua tolto');
  assert.equal(res.products[0].complete, false);
  assert.equal(res.products[1].brand, 'nutella');
  assert.equal(res.products[1].complete, true);
  assert.equal(res.products[1].per100.kcal, 520);
  assert.equal(res.products[2].unit, 'ml', 'quantità senza unità: vale quella della porzione');
  assert.equal(res.products[0].unit, 'g');
  assert.throws(() => parseSalResponse({ products: [] }), /non valida/, 'forma di search.pl, non di Search-a-licious');
  assert.throws(() => parseSalResponse({ hits: new Array(201).fill({}) }), /non valida/);
  assert.throws(() => parseSalResponse('<html>'), /non valida/);
});
