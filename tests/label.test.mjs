import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLabel } from '../dist/js/label.js';

// Testi sintetici con la forma tipica delle tabelle UE copiate con Testo live o OCR.
const vals = (r) => Object.fromEntries(Object.entries(r.values).map(([k, v]) => [k, v.value]));

test('italiano, una voce per riga, colonne per 100 g / porzione / %AR', () => {
  const r = parseLabel(`Dichiarazione nutrizionale
Valori medi per 100 g per porzione (85 g) %AR*
Energia 1521 kJ / 359 kcal 1293 kJ / 305 kcal 15%
Grassi 2,0 g 1,7 g 2%
di cui acidi grassi saturi 0,5 g 0,4 g 2%
di cui acidi grassi monoinsaturi 0,3 g
Carboidrati 71 g 60 g 23%
di cui zuccheri 3,5 g 3,0 g 3%
Fibre 3,0 g 2,6 g
Proteine 13 g 11 g 22%
Sale 0,01 g <0,01 g 0%`);
  assert.equal(r.unit, 'g');
  assert.deepEqual(vals(r), { kcal: 359, fat: 2, satFat: 0.5, carbs: 71, sugars: 3.5, fiber: 3, protein: 13, salt: 0.01 });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(Object.values(r.values).filter((v) => v.doubt), []);
  assert.deepEqual(r.notes, []);
  assert.deepEqual(r.warnings, [], 'valori coerenti');
});

test('inglese, tedesco, francese', () => {
  const en = parseLabel('Nutrition per 100g\nEnergy 2252kJ/539kcal\nFat 30.9g\nof which saturates 10.6g\nCarbohydrate 57.5g\nof which sugars 56.3g\nProtein 6.3g\nSalt 0.107g');
  assert.deepEqual(vals(en), { kcal: 539, fat: 30.9, satFat: 10.6, carbs: 57.5, sugars: 56.3, protein: 6.3, salt: 0.11 });
  const de = parseLabel('Nährwerte pro 100 g\nBrennwert 1569 kJ / 375 kcal\nFett 8,2 g\ndavon gesättigte Fettsäuren 1,1 g\nKohlenhydrate 59 g\ndavon Zucker 1,2 g\nBallaststoffe 9,7 g\nEiweiß 11 g\nSalz 0,02 g');
  assert.deepEqual(vals(de), { kcal: 375, fat: 8.2, satFat: 1.1, carbs: 59, sugars: 1.2, fiber: 9.7, protein: 11, salt: 0.02 });
  const fr = parseLabel('Valeurs nutritionnelles pour 100 g\nÉnergie 1680 kJ / 400 kcal\nMatières grasses 12 g\ndont acides gras saturés 6,5 g\nGlucides 63 g\ndont sucres 25 g\nProtéines 7,5 g\nSel 0,5 g');
  assert.deepEqual(vals(fr), { kcal: 400, fat: 12, satFat: 6.5, carbs: 63, sugars: 25, protein: 7.5, salt: 0.5 });
});

test('liquidi per 100 ml, energia su due righe, kJ/kcal senza unità', () => {
  const milk = parseLabel('Valori nutrizionali medi per 100 ml\nEnergia 195 kJ\n46 kcal\nGrassi 1,6 g\ndi cui saturi 1,0 g\nCarboidrati 4,9 g\ndi cui zuccheri 4,9 g\nProteine 3,3 g\nSale 0,13 g');
  assert.equal(milk.unit, 'ml');
  assert.equal(milk.values.kcal.value, 46);
  const bare = parseLabel('Energia kJ/kcal 1521/359\nGrassi 2 g\nCarboidrati 71 g\nProteine 13 g');
  assert.equal(bare.values.kcal.value, 359);
  const onlyKj = parseLabel('Energia 1521 kJ\nGrassi 2 g\nCarboidrati 71 g\nProteine 13 g');
  assert.equal(onlyKj.values.kcal.value, 364);
  assert.match(onlyKj.values.kcal.doubt, /dai kJ/);
});

test('valori dubbi, mancanti e confusioni dell’OCR', () => {
  const r = parseLabel('Energia 1521 kJ / 359 kcal\nGrassi <0,5 g\nCarboidrati 7l g\nProteine 1O g\nSale 400 mg');
  assert.equal(r.values.fat.value, 0);
  assert.match(r.values.fat.doubt, /< 0,5/);
  assert.equal(r.values.carbs.value, 71, 'l letta come 1');
  assert.equal(r.values.protein.value, 10, 'O letta come 0');
  assert.equal(r.values.salt.value, 0.4, 'mg convertiti in g');
  const missing = parseLabel('Energia 200 kcal\nProteine 5 g');
  assert.deepEqual(missing.missing, ['fat', 'carbs']);
  assert.match(missing.notes[0], /completali/);
  const none = parseLabel('Ingredienti: farina, acqua, sale.');
  assert.deepEqual(none.values, {}, 'la parola "sale" negli ingredienti non porta valori');
  assert.match(none.notes[0], /Nessun valore/);
  assert.equal(parseLabel('Grassi 250 g').values.fat, undefined, 'oltre 100 g per 100 g: scartato');
  const incoherent = parseLabel('Energia 100 kcal\nGrassi 20 g\nCarboidrati 30 g\nProteine 10 g');
  assert.match(incoherent.warnings[0], /circa 340 kcal/);
  // "< 0,5" più piccolo della sua parte "di cui": prende il valore della parte, resta dubbio.
  const lt = parseLabel(['Energia 46 kcal', 'Grassi <0,5 g', 'di cui saturi 0,3 g', 'Carboidrati 4,9 g', 'Proteine 3,3 g'].join('\n'));
  assert.equal(lt.values.fat.value, 0.3);
  assert.match(lt.values.fat.doubt, /come la voce/);
  assert.deepEqual(lt.warnings, []);
});

test('testo copiato per colonne: abbinamento per posizione, sempre dubbio', () => {
  const r = parseLabel('Energia\nGrassi\ndi cui saturi\nCarboidrati\ndi cui zuccheri\nProteine\nSale\n1521 kJ/359 kcal\n2,0 g\n0,5 g\n71 g\n3,5 g\n13 g\n0,01 g');
  assert.deepEqual(vals(r), { kcal: 359, fat: 2, satFat: 0.5, carbs: 71, sugars: 3.5, protein: 13, salt: 0.01 });
  assert.ok(Object.values(r.values).every((v) => /posizione/.test(v.doubt)));
});

test('input lungo o ostile: limiti e nessun crash', () => {
  const long = 'Grassi 1 g\n'.repeat(5000) + 'x'.repeat(100000);
  const r = parseLabel(long);
  assert.equal(r.values.fat.value, 1);
  assert.doesNotThrow(() => parseLabel('<script>alert(1)</script>\nEnergia NaN kcal'));
});
