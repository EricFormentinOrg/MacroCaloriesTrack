import { ageOn } from './dates.js';
import { fmtInt } from './format.js';
import type { Entry, NutrientKey, Nutrients, Profile, Sex, Targets, Unit } from './model.js';

/** Approssimazione corrente: ~7700 kcal per kg di massa corporea persa o guadagnata. */
export const KCAL_PER_KG = 7700;

/** Mifflin-St Jeor (1990). Peso in kg, altezza in cm, età in anni. */
export function bmr(sex: Sex, kg: number, cm: number, age: number): number {
  return 10 * kg + 6.25 * cm - 5 * age + (sex === 'm' ? 5 : -161);
}

export interface Plan {
  bmr: number;
  tdee: number;
  targets: Targets;
  computed: Targets;
  warnings: string[];
  weeksToTarget?: number;
}

export function computeTargets(kcalTarget: number, kg: number, proteinPerKg: number, fatPct: number): Targets {
  const kcal = Math.round(kcalTarget);
  const protein = Math.round(proteinPerKg * kg);
  const fat = Math.round((kcal * fatPct) / 100 / 9);
  const carbs = Math.round((kcal - protein * 4 - fat * 9) / 4);
  return { kcal, protein, fat, carbs };
}

export function computePlan(p: Profile, kg: number, onDate: string): Plan {
  const age = ageOn(p.birthDate, onDate);
  const b = bmr(p.sex, kg, p.heightCm, age);
  const tdee = b * p.activity;
  const sign = p.goal === 'lose' ? -1 : p.goal === 'gain' ? 1 : 0;
  const delta = (sign * p.rateKgWeek * KCAL_PER_KG) / 7;
  const computed = computeTargets(tdee + delta, kg, p.proteinPerKg, p.fatPct);
  const warnings: string[] = [];

  if (age < 18) warnings.push('La formula è pensata per adulti: per età inferiori la stima non è affidabile.');
  if (!p.manual && computed.carbs < 0) {
    warnings.push('Proteine e grassi superano già le calorie dell’obiettivo: riduci uno dei due.');
  }
  const targets: Targets = p.manual && p.manualTargets ? { ...p.manualTargets } : { ...computed, carbs: Math.max(0, computed.carbs) };
  if (targets.kcal < b) warnings.push(`L’obiettivo è sotto il metabolismo basale stimato (${fmtInt(b)} kcal).`);

  let weeksToTarget: number | undefined;
  if (p.targetKg !== undefined && p.goal !== 'maintain' && p.rateKgWeek > 0) {
    const diff = p.targetKg - kg;
    if ((p.goal === 'lose' && diff < 0) || (p.goal === 'gain' && diff > 0)) {
      weeksToTarget = Math.ceil(Math.abs(diff) / p.rateKgWeek);
    } else if (diff !== 0) {
      warnings.push(p.goal === 'lose' ? 'Il peso obiettivo è sopra il peso attuale.' : 'Il peso obiettivo è sotto il peso attuale.');
    }
  }
  return { bmr: b, tdee, targets, computed, warnings, weeksToTarget };
}

const KEYS: ReadonlyArray<NutrientKey> = ['kcal', 'fat', 'satFat', 'carbs', 'sugars', 'fiber', 'protein', 'salt'];

/** Valori per 100 → valori per la quantità indicata. */
export function scale(per100: Nutrients, qty: number): Nutrients {
  const f = qty / 100;
  const out: Nutrients = { kcal: 0, fat: 0, carbs: 0, protein: 0 };
  for (const k of KEYS) {
    const v = per100[k];
    if (v !== undefined) out[k] = v * f;
  }
  return out;
}

/** Somma; un nutriente facoltativo resta undefined se nessuna voce lo riporta. */
export function sum(list: ReadonlyArray<Nutrients>): Nutrients {
  const out: Nutrients = { kcal: 0, fat: 0, carbs: 0, protein: 0 };
  for (const n of list) {
    for (const k of KEYS) {
      const v = n[k];
      if (v !== undefined) out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}

export const entryNutrients = (e: Pick<Entry, 'per100' | 'qty'>): Nutrients => scale(e.per100, e.qty);

/** Energia attesa dai macronutrienti (fattori UE: 4/4/9, fibre 2 kcal/g). */
export function kcalFromMacros(n: Nutrients): number {
  return 4 * n.protein + 4 * n.carbs + 9 * n.fat + 2 * (n.fiber ?? 0);
}

/**
 * Controlli di plausibilità su valori per 100 g/ml. Solo avvisi: alcol,
 * polioli o etichette extra-UE possono giustificare scostamenti reali.
 */
export function checkFood(n: Nutrients, unit: Unit): string[] {
  const w: string[] = [];
  const atw = kcalFromMacros(n);
  const ref = Math.max(n.kcal, atw);
  if (ref > 0 && Math.abs(n.kcal - atw) > Math.max(20, 0.15 * ref)) {
    w.push(`Dai macronutrienti risultano circa ${fmtInt(atw)} kcal, non ${fmtInt(n.kcal)}: controlla i valori.`);
  }
  if (n.satFat !== undefined && n.satFat > n.fat + 0.05) w.push('I grassi saturi superano i grassi totali.');
  if (n.sugars !== undefined && n.sugars > n.carbs + 0.05) w.push('Gli zuccheri superano i carboidrati totali.');
  if (unit === 'g') {
    const mass = n.fat + n.carbs + n.protein + (n.fiber ?? 0) + (n.salt ?? 0);
    if (mass > 101) w.push(`La somma dei nutrienti è ${fmtInt(mass)} g su 100 g.`);
  }
  return w;
}
