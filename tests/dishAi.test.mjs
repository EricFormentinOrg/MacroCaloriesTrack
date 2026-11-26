import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCatalog } from '../dist/js/catalog.js';
import { DEFAULT_MODEL, GeminiError, geminiError, isGeminiKey, matchCatalog, normalizeGeminiKey, parseDish, prompt, requestBody, requestUrl, responseText, totalKcal } from '../dist/js/dishAi.js';

const geminiResponse = (text, extra = {}) => ({ candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP' }], usageMetadata: {}, ...extra });
const dish = {
  items: [
    { name: 'Spaghetti al pomodoro', search: 'pasta cotta', grams: 250, unit: 'g', confidence: 'media',
      per100: { kcal: 150, fat: 4, satFat: 0.7, carbs: 24, sugars: 3, fiber: 2, protein: 5, salt: 0.6 } },
    { name: 'Mela', search: 'mela cruda', grams: 150, unit: 'g', confidence: 'alta', per100: { kcal: 52, fat: 0.2, carbs: 12, protein: 0.3 } },
  ],
  notes: 'Olio non visibile, stimato.',
};

test('richiesta: URL senza chiave, immagine inline, JSON con schema', () => {
  const url = requestUrl(DEFAULT_MODEL);
  assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
  assert.doesNotMatch(url, /key=/, 'la chiave va nell’header, mai nell’URL');
  assert.throws(() => requestUrl('../../x'));
  const b = requestBody('QUJD', 'image/jpeg', '  porzione abbondante  ');
  assert.equal(b.contents[0].parts[1].inline_data.mime_type, 'image/jpeg');
  assert.equal(b.contents[0].parts[1].inline_data.data, 'QUJD');
  assert.equal(b.generationConfig.responseMimeType, 'application/json');
  assert.ok(b.generationConfig.responseJsonSchema.properties.items);
  assert.match(b.contents[0].parts[0].text, /Indicazioni dell’utente: porzione abbondante$/);
  assert.equal(requestBody('QUJD', 'image/jpeg', '', false).generationConfig.responseJsonSchema, undefined);
  assert.doesNotMatch(prompt(''), /Indicazioni/);
  assert.equal(prompt('x'.repeat(1000)).length < 1400, true, 'indicazioni limitate');
  assert.equal(isGeminiKey('AIzaSyA-abcdefghijklmnopqrstuvwxyz0123'), true, 'chiave standard');
  assert.equal(isGeminiKey('AQ.Ab8RN6Lx9-fake_auth.key/with+other=chars_0123456789'), true, 'formato diverso: accettato, lo verifica Google');
  assert.equal(isGeminiKey('x'.repeat(300)), true);
  assert.equal(isGeminiKey('corta'), false);
  assert.equal(isGeminiKey('chiave con spazi 0123456789'), false);
  assert.equal(isGeminiKey('chiave-accentata-èèèèèèèèèèèèèè'), false, 'un header HTTP non la accetterebbe');
  assert.equal(normalizeGeminiKey(['  "AIzaSyA-abc', 'def"  '].join('\n')), 'AIzaSyA-abcdef', 'spazi, a capo e virgolette incollati per errore');
});

test('risposta: testo, rifiuti e troncamenti', () => {
  assert.equal(responseText(geminiResponse('{"items":[]}')), '{"items":[]}');
  const withThought = { candidates: [{ content: { parts: [{ text: 'ragionamento', thought: true }, { text: '{"items":[]}' }] }, finishReason: 'STOP' }] };
  assert.equal(responseText(withThought), '{"items":[]}', 'le parti di ragionamento non entrano nel JSON');
  assert.throws(() => responseText({ promptFeedback: { blockReason: 'SAFETY' } }), /rifiutato/);
  assert.throws(() => responseText({ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }), /rifiutato/);
  assert.throws(() => responseText({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"ite' }] } }] }), /troncata/);
  assert.throws(() => responseText({ candidates: [] }), GeminiError);
  assert.throws(() => responseText('<html>'), GeminiError);
});

test('errori HTTP tradotti in istruzioni', () => {
  const body = (message) => JSON.stringify({ error: { code: 400, message, status: 'INVALID_ARGUMENT' } });
  assert.match(geminiError(400, body('API key not valid. Please pass a valid API key.')).message, /chiave Gemini non è valida/);
  const schema = geminiError(400, body('Invalid JSON payload received. Unknown name "responseJsonSchema"'));
  assert.equal(schema.retryWithoutSchema, true, 'schema rifiutato: si riprova senza');
  assert.match(geminiError(429, '').message, /Limite/);
  assert.match(geminiError(403, '').message, /abilitala/);
  assert.match(geminiError(404, '').message, /Modello/);
  assert.match(geminiError(503, '<html>').message, /non risponde/);
});

test('piatto: validazione rigorosa e voci scartate', () => {
  const d = parseDish(JSON.stringify(dish));
  assert.equal(d.items.length, 2);
  assert.equal(d.dropped, 0);
  assert.equal(d.items[0].qty, 250);
  assert.deepEqual(d.items[0].per100, dish.items[0].per100);
  assert.equal(d.notes, 'Olio non visibile, stimato.');
  assert.equal(totalKcal(d.items[0].per100, d.items[0].qty), 375);
  assert.equal(parseDish('```json\n{"items":[]}\n```').items.length, 0, 'blocco di codice tollerato');
  const bad = parseDish(JSON.stringify({ items: [
    dish.items[0],
    { ...dish.items[0], grams: -5 },
    { ...dish.items[0], per100: { kcal: 5000, fat: 1, carbs: 1, protein: 1 } },
    { ...dish.items[0], per100: { kcal: 100, fat: 1, carbs: 1 } },
    { ...dish.items[0], name: '' },
    'testo',
  ] }));
  assert.equal(bad.items.length, 1);
  assert.equal(bad.dropped, 5);
  const evil = parseDish(JSON.stringify({ items: [{ ...dish.items[0], name: 'Pasta\u0000<img src=x onerror=alert(1)>'.padEnd(300, 'x'), confidence: 'certissima', unit: 'litri', extra: 1 }] }));
  assert.equal(evil.items[0].name.length, 120);
  assert.equal(evil.items[0].confidence, 'media');
  assert.equal(evil.items[0].unit, 'g');
  assert.equal('extra' in evil.items[0], false);
  const incoherent = parseDish(JSON.stringify({ items: [{ ...dish.items[0], per100: { kcal: 50, fat: 20, carbs: 30, protein: 10 } }] }));
  assert.match(incoherent.items[0].warnings[0], /kcal/);
  assert.throws(() => parseDish('non è json'), /non leggibile/);
  assert.throws(() => parseDish('{"piatto":1}'), /non valida/);
});

test('abbinamento con la banca dati: solo se il nome corrisponde', () => {
  const head = { format: 1, source: 'x', publisher: 'x', version: '1', released: '2026-07-01', url: 'https://x', unit: 'g', nutrients: ['kcal', 'fat', 'satFat', 'carbs', 'sugars', 'fiber', 'protein', 'salt'] };
  const v = [52, 0.3, 0.1, 11.6, 11.5, 1.4, 0.3, 0];
  const cat = parseCatalog({ ...head, foods: [
    ['378', 'Mela, cruda', '', 'Frutta', v],
    ['476', 'Mela cotogna, cruda', '', 'Frutta', v],
    ['900', 'Riso, bollito', '', 'Cereali', v],
    ['901', 'Insalata di riso con verdure e tonno', '', 'Cibi', v],
  ] });
  assert.equal(matchCatalog('mela cruda', cat.items).item.id, '378');
  assert.equal(matchCatalog('riso bollito', cat.items).item.id, '900');
  assert.equal(matchCatalog('lasagne alla bolognese', cat.items), undefined, 'piatto composto: resta la stima');
  assert.equal(matchCatalog('riso', cat.items)?.item.id, '900', 'parola singola: il nome più corto');
  assert.equal(matchCatalog('con', cat.items), undefined);
});
