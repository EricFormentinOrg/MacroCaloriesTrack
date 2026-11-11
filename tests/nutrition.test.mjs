import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ageOn, addDays, isISODate } from '../dist/js/dates.js';
import { parseDecimal } from '../dist/js/format.js';
import { bmr, checkFood, computePlan, scale, sum } from '../dist/js/nutrition.js';

const profile = (over = {}) => ({
  id: 'profile', updatedAt: 0, sex: 'm', birthDate: '1991-01-01', heightCm: 180,
  activity: 1.55, goal: 'lose', rateKgWeek: 0.5, proteinPerKg: 1.8, fatPct: 25, manual: false, ...over,
});

test('Mifflin-St Jeor', () => {
  assert.equal(bmr('m', 80, 180, 35), 1755);
  assert.equal(bmr('f', 60, 165, 30), 1320.25);
});

test('obiettivi calcolati: deficit di 0,5 kg/settimana', () => {
  const p = computePlan(profile(), 80, '2026-11-11'); // 35 anni
  assert.equal(p.bmr, 1755);
  assert.equal(p.targets.kcal, 2170); // 1755 × 1,55 − 550
  assert.equal(p.targets.protein, 144);
  assert.equal(p.targets.fat, 60);
  assert.equal(p.targets.carbs, 264);
  assert.deepEqual(p.warnings, []);
});

test('obiettivi manuali e avviso sotto il basale', () => {
  const p = computePlan(profile({ manual: true, manualTargets: { kcal: 1500, protein: 150, carbs: 120, fat: 50 } }), 80, '2026-11-11');
  assert.equal(p.targets.kcal, 1500);
  assert.equal(p.warnings.length, 1);
});

test('settimane al peso obiettivo e direzione incoerente', () => {
  assert.equal(computePlan(profile({ targetKg: 75 }), 80, '2026-11-11').weeksToTarget, 10);
  const bad = computePlan(profile({ targetKg: 85 }), 80, '2026-11-11');
  assert.equal(bad.weeksToTarget, undefined);
  assert.equal(bad.warnings.length, 1);
});

test('età al compleanno', () => {
  assert.equal(ageOn('1990-11-12', '2026-11-11'), 35);
  assert.equal(ageOn('1990-11-12', '2026-11-12'), 36);
});

test('date locali', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29');
  assert.equal(isISODate('2026-02-30'), false);
  assert.equal(isISODate('2026-11-11'), true);
});

test('scala e somma, facoltativi assenti restano undefined', () => {
  const n = scale({ kcal: 59, protein: 10, carbs: 3.6, fat: 0.4 }, 170);
  assert.ok(Math.abs(n.kcal - 100.3) < 1e-9);
  assert.equal(n.fiber, undefined);
  const s = sum([n, { kcal: 10, protein: 1, carbs: 1, fat: 1, fiber: 2 }]);
  assert.ok(Math.abs(s.kcal - 110.3) < 1e-9);
  assert.equal(s.fiber, 2);
});

test('controlli di plausibilità', () => {
  assert.deepEqual(checkFood({ kcal: 59, protein: 10, carbs: 3.6, fat: 0.4 }, 'g'), []);
  assert.equal(checkFood({ kcal: 300, protein: 10, carbs: 3.6, fat: 0.4 }, 'g').length, 1);
  assert.equal(checkFood({ kcal: 330, protein: 10, carbs: 50, fat: 10, sugars: 60 }, 'g').length, 1);
  assert.equal(checkFood({ kcal: 900, protein: 0, carbs: 0, fat: 100, satFat: 120 }, 'g').length, 1);
});

test('parsing numeri all\'italiana', () => {
  assert.equal(parseDecimal('12,5'), 12.5);
  assert.equal(parseDecimal('12.5'), 12.5);
  assert.equal(parseDecimal('1.240,5'), 1240.5);
  assert.equal(parseDecimal(' 0 '), 0);
  assert.ok(Number.isNaN(parseDecimal('')));
  assert.ok(Number.isNaN(parseDecimal('abc')));
  assert.ok(Number.isNaN(parseDecimal('1,2,3')));
});
