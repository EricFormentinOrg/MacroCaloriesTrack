// Statistiche per diario e andamento: totali per giorno, settimane, serie del peso. Modulo puro.
import { addDays, parseISODate, toISODate } from './dates.js';
import type { Entry, Nutrients, Weight } from './model.js';
import { entryNutrients, sum } from './nutrition.js';

/** Totali per giorno, solo voci vive. */
export function dailyTotals(entries: ReadonlyArray<Entry>): Map<string, Nutrients> {
  const byDay = new Map<string, Entry[]>();
  for (const e of entries) {
    if (e.deleted) continue;
    const list = byDay.get(e.date);
    if (list) list.push(e);
    else byDay.set(e.date, [e]);
  }
  return new Map([...byDay].map(([d, list]) => [d, sum(list.map(entryNutrients))]));
}

/** Lunedì della settimana che contiene la data. */
export function weekStart(date: string): string {
  const d = parseISODate(date);
  const dow = (d.getDay() + 6) % 7; // 0 = lunedì
  d.setDate(d.getDate() - dow);
  return toISODate(d);
}

/** Le date da `from` a `to` comprese. */
export function rangeDates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 4000; d = addDays(d, 1)) out.push(d);
  return out;
}

export const weekDates = (date: string): string[] => rangeDates(weekStart(date), addDays(weekStart(date), 6));

/** Pesate vive, in ordine di data. */
export const sortedWeights = (ws: ReadonlyArray<Weight>): Weight[] =>
  ws.filter((w) => !w.deleted).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

/** Peso valido in una data: l'ultima pesata non successiva (pesate già ordinate). */
export function weightAt(sorted: ReadonlyArray<Weight>, date: string): Weight | undefined {
  let found: Weight | undefined;
  for (const w of sorted) {
    if (w.date > date) break;
    found = w;
  }
  return found;
}

export interface Point {
  date: string;
  kg: number;
}

/**
 * Tendenza del peso: media delle pesate degli ultimi `days` giorni (finestra mobile), per ogni pesata.
 * Attenua le oscillazioni di acqua e sale tra un giorno e l'altro.
 */
export function weightTrend(sorted: ReadonlyArray<Weight>, days = 7): Point[] {
  return sorted.map((w) => {
    const from = addDays(w.date, -(days - 1));
    const win = sorted.filter((x) => x.date >= from && x.date <= w.date);
    return { date: w.date, kg: Math.round((win.reduce((a, x) => a + x.kg, 0) / win.length) * 10) / 10 };
  });
}

export type DayState = 'empty' | 'under' | 'ok' | 'over';

/** Stato del giorno rispetto all'obiettivo: "ok" entro ±10%, "over" oltre il 5% (come i macronutrienti). */
export function dayState(kcal: number | undefined, target: number | undefined): DayState {
  if (!kcal) return 'empty';
  if (!target) return 'ok';
  if (kcal > target * 1.05) return 'over';
  return kcal >= target * 0.9 ? 'ok' : 'under';
}

export interface WeekSummary {
  start: string;
  /** Giorni con almeno una voce. */
  logged: number;
  /** Medie sui soli giorni registrati. */
  avg?: Nutrients;
  /** Variazione della tendenza del peso nella settimana, se ci sono almeno due pesate utili. */
  weightChange?: number;
}

/** Riepilogo per settimana (dalla più recente) tra `from` e `to`. */
export function weeklySummary(from: string, to: string, totals: Map<string, Nutrients>, sorted: ReadonlyArray<Weight>): WeekSummary[] {
  const trend = weightTrend(sorted);
  const out: WeekSummary[] = [];
  for (let start = weekStart(to); start >= weekStart(from); start = addDays(start, -7)) {
    const days = rangeDates(start, addDays(start, 6)).filter((d) => d >= from && d <= to);
    const logged = days.map((d) => totals.get(d)).filter((n): n is Nutrients => !!n && n.kcal > 0);
    const inWeek = trend.filter((p) => p.date >= start && p.date <= addDays(start, 6));
    const before = [...trend].reverse().find((p) => p.date < start);
    const first = before ?? inWeek[0];
    const last = inWeek[inWeek.length - 1];
    out.push({
      start,
      logged: logged.length,
      ...(logged.length ? { avg: scaleAvg(sum(logged), logged.length) } : {}),
      ...(first && last && first !== last ? { weightChange: Math.round((last.kg - first.kg) * 10) / 10 } : {}),
    });
  }
  return out;
}

function scaleAvg(n: Nutrients, count: number): Nutrients {
  const out = {} as Nutrients;
  for (const [k, v] of Object.entries(n) as Array<[keyof Nutrients, number | undefined]>) {
    if (v !== undefined) out[k] = v / count;
  }
  return out;
}

/** Scala "gradevole" per un asse: estremi arrotondati a un passo di 1, 2 o 5 × 10^n. */
export function niceScale(min: number, max: number, ticks = 4): { min: number; max: number; step: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 1 };
  if (max - min < 1e-9) {
    min -= 1;
    max += 1;
  }
  const raw = (max - min) / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step, step };
}
