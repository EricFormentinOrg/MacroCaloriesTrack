import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dailyTotals, dayState, niceScale, rangeDates, sortedWeights, weekDates, weekStart, weeklySummary, weightAt, weightTrend } from '../dist/js/stats.js';

const e = (id, date, qty, extra = {}) => ({ id, date, meal: 'lunch', foodId: 'f', name: 'x', unit: 'g', qty, per100: { kcal: 100, fat: 1, carbs: 10, protein: 5 }, createdAt: 1, updatedAt: 1, ...extra });
const w = (date, kg, extra = {}) => ({ id: date, date, kg, updatedAt: 1, ...extra });

test('settimane da lunedì, intervalli di date', () => {
  assert.equal(weekStart('2026-11-12'), '2026-11-09', 'giovedì → lunedì');
  assert.equal(weekStart('2026-11-09'), '2026-11-09');
  assert.equal(weekStart('2026-11-15'), '2026-11-09', 'domenica appartiene alla settimana iniziata lunedì');
  assert.deepEqual(weekDates('2026-11-01'), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.deepEqual(rangeDates('2026-02-27', '2026-03-02'), ['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  assert.deepEqual(rangeDates('2026-03-02', '2026-03-01'), []);
});

test('totali per giorno senza voci eliminate', () => {
  const t = dailyTotals([e('a', '2026-11-12', 100), e('b', '2026-11-12', 50), e('c', '2026-11-11', 200), e('d', '2026-11-11', 999, { deleted: true })]);
  assert.equal(t.get('2026-11-12').kcal, 150);
  assert.equal(t.get('2026-11-11').kcal, 200);
});

test('peso: ordine, valore valido in una data, tendenza a 7 giorni', () => {
  const ws = sortedWeights([w('2026-11-05', 82), w('2026-11-01', 83), w('2026-11-03', 99, { deleted: true }), w('2026-11-07', 81)]);
  assert.deepEqual(ws.map((x) => x.date), ['2026-11-01', '2026-11-05', '2026-11-07']);
  assert.equal(weightAt(ws, '2026-11-04').kg, 83);
  assert.equal(weightAt(ws, '2026-10-30'), undefined);
  assert.deepEqual(weightTrend(ws).map((p) => p.kg), [83, 82.5, 82], 'media delle pesate negli ultimi 7 giorni');
});

test('stato del giorno rispetto all’obiettivo', () => {
  assert.equal(dayState(0, 2000), 'empty');
  assert.equal(dayState(1500, 2000), 'under');
  assert.equal(dayState(1850, 2000), 'ok');
  assert.equal(dayState(2100, 2000), 'ok', 'entro il 5% non è oltre');
  assert.equal(dayState(2200, 2000), 'over');
  assert.equal(dayState(1200, undefined), 'ok', 'senza obiettivo: registrato');
});

test('riepilogo settimanale: medie sui giorni registrati e variazione del peso', () => {
  const totals = dailyTotals([e('a', '2026-11-10', 2000), e('b', '2026-11-11', 1000), e('c', '2026-11-03', 1500)]);
  const ws = sortedWeights([w('2026-11-02', 84), w('2026-11-09', 83), w('2026-11-12', 82)]);
  const s = weeklySummary('2026-11-01', '2026-11-12', totals, ws);
  assert.deepEqual(s.map((x) => x.start), ['2026-11-09', '2026-11-02', '2026-10-26']);
  assert.equal(s[0].logged, 2);
  assert.equal(s[0].avg.kcal, 1500, '(2000 + 1000) / 2 giorni registrati');
  assert.equal(s[1].logged, 1);
  assert.equal(s[2].logged, 0);
  assert.equal(s[2].avg, undefined);
  assert.equal(typeof s[0].weightChange, 'number');
  assert.ok(s[0].weightChange < 0);
});

test('scala degli assi', () => {
  assert.deepEqual(niceScale(81.3, 84.9), { min: 81, max: 85, step: 1 });
  assert.deepEqual(niceScale(0, 2350), { min: 0, max: 3000, step: 1000 });
  assert.deepEqual(niceScale(0, 2350, 6), { min: 0, max: 2500, step: 500 });
  const flat = niceScale(80, 80);
  assert.ok(flat.min < 80 && flat.max > 80);
});
