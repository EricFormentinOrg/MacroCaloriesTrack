import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GeminiError, parseDish } from '../dist/js/dishAi.js';
import { OPENROUTER_URL, OR_DEFAULT_MODEL, OR_MODELS, OR_RETRIES, isOrModelId, orError, orModelLabel, orRequestBody, orResponseText, orRetryDelay } from '../dist/js/openrouter.js';

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

test('errori veri del 26/11/2026: privacy, parametri, limite del fornitore', () => {
  const privacy = JSON.stringify({ error: { code: 404, message: '0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. We removed them for the following reasons (an endpoint may have matched multiple reasons):\nFree model training violation (account settings): 1 endpoint excluded; configurable at https://openrouter.ai/settings/privacy' } });
  assert.match(orError(404, privacy).message, /impostazioni privacy.*Settings → Privacy/);
  const params = JSON.stringify({ error: { code: 404, message: 'No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection' } });
  assert.match(orError(404, params).message, /non accetta foto con risposta JSON/);
  const upstream = JSON.stringify({ error: { message: 'Provider returned error', code: 429, metadata: {
    raw: 'inclusionai/ling-3.2-flash:free is temporarily rate-limited upstream. Please retry shortly, or add your own provider key to use your own limits',
    provider_name: 'Ant Digital', is_byok: false, provider_error_code: 'rpm_limit_exceeded', limit_source: 'upstream_provider_shared_pool' } } });
  const e = orError(429, upstream);
  assert.match(e.message, /al limite presso il suo fornitore/);
  assert.equal(e.tryOtherModel, true);
  const own = JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded: free-models-per-day' } });
  assert.match(orError(429, own).message, /20 al minuto/, 'limite del proprio account');
});

test('nuovi tentativi: solo per limiti e errori temporanei, attese brevi', () => {
  assert.equal(OR_RETRIES, 2);
  assert.equal(orRetryDelay(429, null, 0), 3000);
  assert.equal(orRetryDelay(429, null, 1), 6000);
  assert.equal(orRetryDelay(429, null, 2), undefined, 'al massimo due nuovi tentativi');
  assert.equal(orRetryDelay(502, null, 0), 3000);
  assert.equal(orRetryDelay(503, null, 0), 3000);
  assert.equal(orRetryDelay(429, '4', 0), 4000, 'Retry-After rispettato');
  assert.equal(orRetryDelay(429, '0', 0), 1000);
  assert.equal(orRetryDelay(429, '120', 0), undefined, 'attesa troppo lunga: niente nuovo tentativo');
  assert.equal(orRetryDelay(429, 'domani', 0), 3000, 'Retry-After non numerico ignorato');
  for (const s of [400, 401, 402, 403, 404, 408]) assert.equal(orRetryDelay(s, null, 0), undefined, `stato ${s}`);
});
