import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeminiError, parseDish } from '../dist/js/dishAi.js';
import { OPENROUTER_URL, OR_DEFAULT_MODEL, OR_MODELS, isOrModelId, orError, orModelLabel, orRequestBody, orResponseText } from '../dist/js/openrouter.js';

const completion = (content, extra = {}) => ({
  id: 'gen-1',
  model: 'nvidia/nemotron-3.5-super-vl:free',
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
  ...extra,
});

test('richiesta: Chat Completions, foto come data URL, schema e fornitori compatibili', () => {
  assert.equal(OPENROUTER_URL, 'https://openrouter.ai/api/v1/chat/completions');
  const b = orRequestBody('QUJD', 'image/jpeg', '  pasta  ', OR_DEFAULT_MODEL);
  assert.equal(b.model, 'openrouter/free');
  const [text, image] = b.messages[0].content;
  assert.equal(b.messages[0].role, 'user');
  assert.match(text.text, /Indicazioni dell’utente: pasta$/);
  assert.deepEqual(image, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } });
  assert.equal(b.response_format.type, 'json_schema');
  assert.equal(b.response_format.json_schema.strict, false, 'lo schema ha campi facoltativi');
  assert.ok(b.response_format.json_schema.schema.properties.items);
  assert.equal(b.provider.require_parameters, true);
  assert.deepEqual(orRequestBody('QUJD', 'image/jpeg', '', OR_DEFAULT_MODEL, false).response_format, { type: 'json_object' });
  assert.doesNotMatch(JSON.stringify(b), /Bearer|sk-or/, 'la chiave non è nel corpo');
  assert.throws(() => orRequestBody('QUJD', 'image/jpeg', '', '../x'));
});

test('modelli: id validi ed etichette', () => {
  for (const m of OR_MODELS) assert.equal(isOrModelId(m.id), true, m.id);
  assert.equal(isOrModelId('nvidia/nemotron-3.5-super-vl:free'), true);
  assert.equal(isOrModelId('~anthropic/claude-sonnet-latest'), false, 'alias con tilde non proposti');
  assert.equal(isOrModelId('Anthropic/Claude'), false);
  assert.equal(isOrModelId('x'), false);
  assert.equal(isOrModelId('a/b c'), false);
  assert.equal(orModelLabel('openrouter/free'), 'Modelli gratuiti');
  assert.equal(orModelLabel('anthropic/claude-haiku-5.5'), 'Claude Haiku 5.5');
  assert.equal(orModelLabel('nvidia/nemotron-3.5-super-vl:free'), 'nvidia/nemotron-3.5-super-vl:free');
});

test('risposta: testo, modello usato, motivi di fine', () => {
  const dish = { items: [{ name: 'Mela', search: 'mela cruda', grams: 150, unit: 'g', confidence: 'alta', per100: { kcal: 52, fat: 0.2, carbs: 12, protein: 0.3 } }] };
  const r = orResponseText(completion(JSON.stringify(dish)));
  assert.equal(r.model, 'nvidia/nemotron-3.5-super-vl:free');
  assert.equal(parseDish(r.text).items[0].name, 'Mela');
  assert.equal(orResponseText(completion([{ type: 'text', text: '{"items":' }, { type: 'text', text: '[]}' }])).text, '{"items":[]}', 'contenuto a parti');
  assert.equal(orResponseText(completion('{"items":[]}', { model: '<script>' })).model, '', 'modello non valido scartato');
  const finish = (reason) => ({ choices: [{ finish_reason: reason, message: { content: '{"ite' } }] });
  assert.throws(() => orResponseText(finish('content_filter')), /rifiutato/);
  assert.throws(() => orResponseText(finish('length')), /troncata/);
  const interrupted = (() => { try { orResponseText(finish('error')); } catch (e) { return e; } })();
  assert.equal(interrupted.tryOtherModel, true);
  assert.throws(() => orResponseText(completion('   ')), /non ha restituito/);
  assert.throws(() => orResponseText({ choices: [] }), GeminiError);
  assert.throws(() => orResponseText('<html>'), GeminiError);
  const midStream = { error: { code: 429, message: 'Rate limit exceeded', metadata: { error_type: 'rate_limit_exceeded' } }, choices: [] };
  assert.throws(() => orResponseText(midStream), /Limite di richieste OpenRouter/, 'errore del fornitore con stato 200');
});

test('errori HTTP tradotti in istruzioni, con o senza tentativo successivo', () => {
  const body = (code, message) => JSON.stringify({ error: { code, message, metadata: {} } });
  const e401 = orError(401, body(401, 'No auth credentials found'));
  assert.match(e401.message, /chiave OpenRouter non è valida/);
  assert.equal(e401.tryOtherModel, false);
  assert.match(orError(402, body(402, 'Insufficient credits')).message, /Credito OpenRouter esaurito/);
  assert.match(orError(403, body(403, 'Flagged by moderation')).message, /bloccato la richiesta: Flagged by moderation/);
  for (const s of [408, 429, 502, 503]) assert.equal(orError(s, '').tryOtherModel, true, `stato ${s}`);
  assert.match(orError(429, '').message, /20 al minuto e 50 al giorno/);
  const schema = orError(400, body(400, 'response_format json_schema is not supported by this model'));
  assert.equal(schema.retryWithoutSchema, true);
  assert.match(orError(404, body(404, 'No endpoints found')).message, /OpenRouter non riuscita \(404: No endpoints found\)/);
  assert.match(orError(418, '<html>').message, /\(418\)/);
});
