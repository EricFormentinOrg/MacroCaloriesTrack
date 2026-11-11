import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RateLimiter, isBarcode, offFood, parseOffProduct, parseProductResponse, parseSearchResponse, productUrl, reviewNotes, searchUrl, userAgent } from '../dist/js/off.js';

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
